-- Market-profile engine, part 2: scopes and Phase 1 stub scope tables (build outline 3.3.2;
-- ADR 0008 decision 6; control IN-52 "stub scopes"; invariant INV-28).
--
-- A rule is resolved for a scope, and the scope decides the market set:
--   PRODUCT      scope id = a batch: the batch's market set (and the product's predicates)
--   PACK         scope id = a pack: its batch's market set; the pack destination is recorded
--   SITE         the site's declared markets plus the markets of every product qualified there
--   LINE, ROOM, EQUIPMENT
--                the union of the markets of every product qualified on it; a product with a
--                PIC/S-member destination counts as EU for sterile (line-level) rules
--   PERSON       the union over the lines and rooms the person is qualified for
--   MATERIAL_LOT resolved per consuming batch: the consuming batch's market set
-- India is always in the set (INV-28).
--
-- Lines, rooms, equipment, lots and qualifications are edition entities. The editions answer
-- these questions through the ResolutionContextProvider port (src/market/context.ts). Until they
-- exist, the stub_* tables below stand in for them; they are clearly stubs and are replaced, not
-- extended, when the editions arrive.

set local role ebmr_owner;

create table market.stub_site (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  markets     text[] not null default '{IN}',
  predicates  jsonb not null default '{}' check (jsonb_typeof(predicates) = 'object')
);

create table market.stub_product (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  edition           text not null check (edition in ('tablets', 'injectables')),
  markets           text[] not null,
  pics_destination  boolean not null default false,
  predicates        jsonb not null default '{}' check (jsonb_typeof(predicates) = 'object')
);
comment on column market.stub_product.pics_destination is 'The product also goes to a PIC/S-member destination outside the modelled markets; counts as EU for sterile line-level rules.';

create table market.stub_batch (
  id            uuid primary key default gen_random_uuid(),
  batch_number  text not null unique,
  product_id    uuid not null references market.stub_product (id),
  site_id       uuid references market.stub_site (id),
  markets       text[] not null,
  issued_at     timestamptz not null default clock_timestamp()
);

create table market.stub_pack (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  batch_id     uuid not null references market.stub_batch (id),
  destination  text not null references market.market (code)
);

create table market.stub_line (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  site_id  uuid references market.stub_site (id),
  edition  text not null check (edition in ('tablets', 'injectables'))
);

create table market.stub_room (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  site_id  uuid references market.stub_site (id),
  edition  text not null check (edition in ('tablets', 'injectables'))
);

create table market.stub_equipment (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  site_id  uuid references market.stub_site (id),
  room_id  uuid references market.stub_room (id),
  edition  text not null check (edition in ('tablets', 'injectables'))
);

create table market.stub_product_qualification (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references market.stub_product (id),
  scope_kind  text not null check (scope_kind in ('LINE', 'ROOM', 'EQUIPMENT')),
  scope_id    uuid not null,
  unique (product_id, scope_kind, scope_id)
);

create table market.stub_person_qualification (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null,
  scope_kind  text not null check (scope_kind in ('LINE', 'ROOM')),
  scope_id    uuid not null,
  unique (person_id, scope_kind, scope_id)
);

create table market.stub_material_lot (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  site_id  uuid references market.stub_site (id)
);

-- Stub MBR references that pin a value for a rule key (for the change-impact list, 0340).
create table market.stub_mbr_limit (
  id           uuid primary key default gen_random_uuid(),
  mbr_code     text not null,
  mbr_version  integer not null check (mbr_version >= 1),
  key          text not null,
  value        jsonb not null,
  markets      text[] not null,
  predicates   jsonb not null default '{}' check (jsonb_typeof(predicates) = 'object'),
  unique (mbr_code, mbr_version, key)
);

-- Every stored market set is valid and contains India (INV-28); a batch serves only markets its
-- product is made for; a pack goes only to a destination inside its batch's market set.
create function market.check_market_columns() returns trigger
language plpgsql security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_product text[];
  v_batch text[];
begin
  if tg_table_name = 'stub_pack' then
    select b.markets into v_batch from market.stub_batch b where b.id = new.batch_id;
    if not (new.destination = any(v_batch)) then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-050 pack destination %s is outside its batch''s market set %s; a market-add evaluation must run first', new.destination, v_batch::text);
    end if;
    return new;
  end if;
  new.markets := market.checked_market_set(new.markets);
  if tg_table_name = 'stub_batch' then
    select p.markets into v_product from market.stub_product p where p.id = new.product_id;
    if not (new.markets <@ v_product) then
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-050 batch market set %s includes a market the product is not made for (%s)', new.markets::text, v_product::text);
    end if;
  end if;
  return new;
end
$$;

create trigger check_markets before insert or update on market.stub_site for each row execute function market.check_market_columns();
create trigger check_markets before insert or update on market.stub_product for each row execute function market.check_market_columns();
create trigger check_markets before insert or update on market.stub_batch for each row execute function market.check_market_columns();
create trigger check_markets before insert or update on market.stub_pack for each row execute function market.check_market_columns();
create trigger check_markets before insert or update on market.stub_mbr_limit for each row execute function market.check_market_columns();

-- ---------------------------------------------------------------------------------------------
-- Scope derivation from the stubs
-- ---------------------------------------------------------------------------------------------

-- Markets of the products qualified on a line, room or equipment item, as derivation entries.
create function market.stub_qualified_products(p_kind text, p_id uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, market, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('source', 'PRODUCT_QUALIFIED', 'scopeKind', p_kind, 'scopeId', p_id,
                                               'productId', p.id, 'productCode', p.code, 'markets', to_jsonb(p.markets),
                                               'picsDestination', p.pics_destination) order by p.code collate "C"), '[]'::jsonb)
  from market.stub_product_qualification q join market.stub_product p on p.id = q.product_id
  where q.scope_kind = p_kind and q.scope_id = p_id
$$;

-- Returns {markets, derivation, predicates, siteId, edition, destination}. p_table is the rule
-- table of the key being resolved (the PIC/S rule applies to sterile keys only).
create function market.scope_markets(p_kind text, p_id uuid, p_table text, p_consuming_batch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, market, pg_temp as $$
declare
  v_deriv     jsonb := '[]'::jsonb;
  v_markets   text[] := '{}';
  v_pred      jsonb := '{}'::jsonb;
  v_site      uuid;
  v_edition   text;
  v_dest      text;
  v_line      boolean := p_kind in ('LINE', 'ROOM', 'EQUIPMENT', 'PERSON');
  b           market.stub_batch;
  p           market.stub_product;
  q           record;
  d           jsonb;
begin
  if p_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-MKT-051 a scope id is required';
  end if;
  if p_table is null or not exists (select 1 from market.rule_table t where t.code = p_table) then
    raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown rule table %s', coalesce(p_table, '(missing)'));
  end if;
  case p_kind
    when 'PRODUCT', 'PACK' then
      if p_kind = 'PACK' then
        select pk.batch_id, pk.destination into b.id, v_dest from market.stub_pack pk where pk.id = p_id;
        if b.id is null then
          raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown pack %s', p_id);
        end if;
        v_deriv := v_deriv || jsonb_build_array(jsonb_build_object('source', 'PACK', 'packId', p_id, 'destination', v_dest));
        select * into b from market.stub_batch where id = b.id;
      else
        select * into b from market.stub_batch where id = p_id;
        if not found then
          raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown batch %s', p_id);
        end if;
      end if;
      select * into p from market.stub_product where id = b.product_id;
      v_markets := b.markets;
      v_deriv := v_deriv || jsonb_build_array(jsonb_build_object('source', 'BATCH', 'batchId', b.id, 'batchNumber', b.batch_number, 'markets', to_jsonb(b.markets)));
      v_pred := p.predicates;
      v_site := b.site_id;
      v_edition := p.edition;
    when 'MATERIAL_LOT' then
      if not exists (select 1 from market.stub_material_lot l where l.id = p_id) then
        raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown material lot %s', p_id);
      end if;
      if p_consuming_batch is null then
        raise exception using errcode = 'P0001', message =
          'EBMR-MKT-052 a MATERIAL_LOT rule is resolved at each consumption against the consuming batch; name the consuming batch';
      end if;
      select * into b from market.stub_batch where id = p_consuming_batch;
      if not found then
        raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown consuming batch %s', p_consuming_batch);
      end if;
      select * into p from market.stub_product where id = b.product_id;
      v_markets := b.markets;
      v_deriv := jsonb_build_array(jsonb_build_object('source', 'MATERIAL_LOT', 'lotId', p_id),
                                   jsonb_build_object('source', 'CONSUMING_BATCH', 'batchId', b.id, 'batchNumber', b.batch_number, 'markets', to_jsonb(b.markets)));
      v_pred := p.predicates;
      v_site := b.site_id;
      v_edition := p.edition;
    when 'SITE' then
      select s.markets, s.predicates into v_markets, v_pred from market.stub_site s where s.id = p_id;
      if v_markets is null then
        raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown site %s', p_id);
      end if;
      v_site := p_id;
      v_deriv := jsonb_build_array(jsonb_build_object('source', 'SITE_DECLARED', 'siteId', p_id, 'markets', to_jsonb(v_markets)));
      for q in
        select 'LINE' as kind, l.id from market.stub_line l where l.site_id = p_id
        union all select 'ROOM', r.id from market.stub_room r where r.site_id = p_id
        union all select 'EQUIPMENT', e.id from market.stub_equipment e where e.site_id = p_id
        order by 1, 2
      loop
        v_deriv := v_deriv || market.stub_qualified_products(q.kind, q.id);
      end loop;
    when 'LINE', 'ROOM', 'EQUIPMENT' then
      if p_kind = 'LINE' then
        select l.site_id, l.edition into v_site, v_edition from market.stub_line l where l.id = p_id;
      elsif p_kind = 'ROOM' then
        select r.site_id, r.edition into v_site, v_edition from market.stub_room r where r.id = p_id;
      else
        select e.site_id, e.edition into v_site, v_edition from market.stub_equipment e where e.id = p_id;
      end if;
      if v_edition is null then
        raise exception using errcode = 'P0001', message = format('EBMR-MKT-051 unknown %s %s', lower(p_kind), p_id);
      end if;
      v_deriv := market.stub_qualified_products(p_kind, p_id);
    when 'PERSON' then
      for q in select pq.scope_kind as kind, pq.scope_id as id from market.stub_person_qualification pq where pq.person_id = p_id order by 1, 2 loop
        v_deriv := v_deriv || jsonb_build_array(jsonb_build_object('source', 'PERSON_QUALIFIED', 'personId', p_id, 'scopeKind', q.kind, 'scopeId', q.id))
                           || market.stub_qualified_products(q.kind, q.id);
      end loop;
    else
      raise exception using errcode = 'P0001', message = format(
        'EBMR-MKT-051 unknown scope kind %s (PRODUCT, PACK, SITE, LINE, ROOM, EQUIPMENT, PERSON or MATERIAL_LOT)', coalesce(p_kind, '(missing)'));
  end case;

  -- Union of every market named in the derivation.
  select coalesce(array_agg(distinct x), '{}') into v_markets
    from (select unnest(v_markets) as x
          union all
          select jsonb_array_elements_text(dd -> 'markets') from jsonb_array_elements(v_deriv) dd where dd ? 'markets') s;
  -- A PIC/S-member destination counts as EU for sterile line-level rules.
  if v_line and p_table = 'sterile' and not ('EU' = any(v_markets)) then
    for d in select dd from jsonb_array_elements(v_deriv) dd where (dd ->> 'picsDestination')::boolean loop
      v_deriv := v_deriv || jsonb_build_array(jsonb_build_object('source', 'PICS_DESTINATION_COUNTS_AS_EU', 'productId', d -> 'productId', 'markets', '["EU"]'::jsonb));
      v_markets := array_append(v_markets, 'EU');
      exit;
    end loop;
  end if;
  if not ('IN' = any(v_markets)) then
    v_deriv := v_deriv || jsonb_build_array(jsonb_build_object('source', 'INDIA_ALWAYS_APPLIES', 'markets', '["IN"]'::jsonb));
    v_markets := array_append(v_markets, 'IN');
  end if;
  v_markets := market.checked_market_set(v_markets);
  return jsonb_build_object('scopeKind', p_kind, 'scopeId', p_id, 'consumingBatchId', p_consuming_batch, 'markets', to_jsonb(v_markets),
                            'derivation', v_deriv, 'predicates', v_pred, 'siteId', v_site, 'edition', v_edition, 'destination', v_dest);
end
$$;

-- Stub tables stand in for GMP master data, so every change to them is audited like one.
select kernel.register_audited_table('market.stub_site', 'market_stub_site', 'id', false);
select kernel.register_audited_table('market.stub_product', 'market_stub_product', 'id', false);
select kernel.register_audited_table('market.stub_batch', 'market_stub_batch', 'id', false);
select kernel.register_audited_table('market.stub_pack', 'market_stub_batch', 'batch_id', false);
select kernel.register_audited_table('market.stub_line', 'market_stub_line', 'id', false);
select kernel.register_audited_table('market.stub_room', 'market_stub_room', 'id', false);
select kernel.register_audited_table('market.stub_equipment', 'market_stub_equipment', 'id', false);
select kernel.register_audited_table('market.stub_product_qualification', 'market_stub_product', 'product_id', false);
select kernel.register_audited_table('market.stub_person_qualification', 'market_stub_person', 'person_id', false);
select kernel.register_audited_table('market.stub_material_lot', 'market_stub_material_lot', 'id', false);
select kernel.register_audited_table('market.stub_mbr_limit', 'market_stub_mbr', 'mbr_code', false);

-- The application writes the stubs directly, so the authority check is a statement trigger that runs
-- before any row trigger: MASTERDATA.CHANGE installation-wide (DI-17), never an administrator (DI-18).
create function market.authorize_stub_write() returns trigger
language plpgsql volatile security definer set search_path = pg_catalog, market, kernel, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  return null;
end
$$;
create trigger a0_authorize before insert or update on market.stub_site for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_product for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_batch for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_pack for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_line for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_room for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_equipment for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_product_qualification for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_person_qualification for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_material_lot for each statement execute function market.authorize_stub_write();
create trigger a0_authorize before insert or update on market.stub_mbr_limit for each statement execute function market.authorize_stub_write();

grant select, insert, update on market.stub_site, market.stub_product, market.stub_batch, market.stub_pack, market.stub_line,
                                market.stub_room, market.stub_equipment, market.stub_product_qualification,
                                market.stub_person_qualification, market.stub_material_lot, market.stub_mbr_limit to ebmr_app;
grant execute on function market.scope_markets(text, uuid, text, uuid) to ebmr_app;

reset role;
