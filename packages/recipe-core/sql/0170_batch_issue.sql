-- Recipe core, MBR life cycle (A3), part 7: what batch issue needs from the MBR life cycle
-- (outline 5.2.2 PLANNED -> ISSUED, 5.8; ADR 0014 items 6-7; INV-01, INV-02; PR-04, PR-05).
--
-- Batches arrive in Phase 3. Until then recipe.stub_batch stands in for them: batch number, family,
-- market set, scope (site, line, batch size) and a status.
--
--   select_version_for_issue(family, markets, scope, at)
--       the newest version CURRENT for every market of the set; otherwise the newest version CURRENT
--       or BRIDGING for every market (a BRIDGING only while the batch's set includes a market where
--       its successor is not CURRENT); otherwise a refusal naming each market. India must be in
--       every set (INV-28); a market no approved version lists is refused (PR-04).
--   batch_mbr_pin     exactly one per batch (INV-01): version, content hash, markets, scope, the
--                     selection as the database computed it at the issue instant, and the rule-table
--                     versions in force. A BEFORE INSERT trigger recomputes the selection at the
--                     issue instant and refuses any other version, whoever inserts it.
--   control_recipe    the issued snapshot (INV-02): built by the database from the pinned version's
--                     content and the batch header, hashed, insert-only for every role;
--                     verify_control_recipe recomputes the hash.
--   in_flight_disposition
--                     CONTINUE, HOLD_FOR_ASSESSMENT or CANCEL_UNSTARTED for each issued or running
--                     batch of an earlier version, recorded before a successor is approved (L-24).

set local role ebmr_owner;

create table recipe.stub_batch (
  id                  uuid primary key default gen_random_uuid(),
  batch_number        text not null unique check (batch_number ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$'),
  family_id           uuid not null references recipe.mbr_family (id),
  markets             text[] not null check (cardinality(markets) >= 1),
  site                text not null check (btrim(site) <> ''),
  line                text not null check (btrim(line) <> ''),
  batch_size          text not null check (btrim(batch_size) <> ''),
  purpose             text not null default 'GMP' check (purpose = 'GMP'),
  status              text not null default 'PLANNED' check (status in ('PLANNED', 'ISSUED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  created_by_person   uuid not null,
  created_by_account  uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);

create table recipe.batch_mbr_pin (
  id                   uuid primary key default gen_random_uuid(),
  batch_id             uuid not null unique references recipe.stub_batch (id),
  family_id            uuid not null references recipe.mbr_family (id),
  version_id           uuid not null references recipe.mbr_version (id),
  version_number       integer not null,
  content_hash         text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  markets              text[] not null,
  scope                jsonb not null,
  selection            jsonb not null,
  rule_table_versions  jsonb not null,
  person_id            uuid not null,
  account_id           uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
create index batch_mbr_pin_version on recipe.batch_mbr_pin (version_id);

create table recipe.control_recipe (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null unique references recipe.stub_batch (id),
  pin_id            uuid not null unique references recipe.batch_mbr_pin (id),
  version_id        uuid not null references recipe.mbr_version (id),
  mbr_content_hash  text not null check (mbr_content_hash ~ '^[0-9a-f]{64}$'),
  snapshot          jsonb not null,
  snapshot_hash     text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  person_id         uuid not null,
  account_id        uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);

create table recipe.in_flight_disposition (
  id                    uuid primary key default gen_random_uuid(),
  successor_version_id  uuid not null references recipe.mbr_version (id),
  batch_id              uuid not null references recipe.stub_batch (id),
  pinned_version_id     uuid not null references recipe.mbr_version (id),
  batch_status          text not null,
  disposition           text not null check (disposition in ('CONTINUE', 'HOLD_FOR_ASSESSMENT', 'CANCEL_UNSTARTED')),
  reason                text not null check (btrim(reason) <> ''),
  person_id             uuid not null,
  account_id            uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  unique (successor_version_id, batch_id),
  check (disposition <> 'CANCEL_UNSTARTED' or batch_status = 'ISSUED')
);

-- ---------------------------------------------------------------------------------------------
-- Selection at issue (INV-01)
-- ---------------------------------------------------------------------------------------------

-- Cells valid at an instant for a family, scope and market set: CURRENT cells, and BRIDGING cells
-- the set may use (it includes a market where the bridging's successor is not CURRENT-valid). A cell
-- counts only while its version was APPROVED and past its own effective date.
create function recipe.valid_cells(p_family uuid, p_markets text[], p_site text, p_line text, p_batch_size text, p_at timestamptz)
returns table (version_id uuid, version_number integer, market text, validity text, cell_id uuid, authorisation_id uuid, successor_version_id uuid)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  with valid as (
    select c.* from recipe.authorisation_cell c join recipe.mbr_version v on v.id = c.version_id
    where c.family_id = p_family and c.site = p_site and c.line = p_line and c.batch_size = p_batch_size and c.market = any (p_markets)
      and c.effective_from <= p_at and p_at < coalesce(c.valid_until, 'infinity'::timestamptz)
      and v.effective_from is not null and v.effective_from <= p_at
      and recipe.version_state_at(c.version_id, p_at) = 'APPROVED'
  )
  select c.version_id, c.version_number, c.market, 'CURRENT'::text, c.id, c.authorisation_id, null::uuid from valid c where c.kind = 'CURRENT'
  union all
  select b.version_id, b.version_number, b.market, 'BRIDGING'::text, b.id, b.authorisation_id, b.successor_version_id from valid b
  where b.kind = 'BRIDGING'
    and exists (select 1 from unnest(p_markets) m2
                where not exists (select 1 from valid s where s.kind = 'CURRENT' and s.version_id = b.successor_version_id and s.market = m2))
$$;

create function recipe.select_version_for_issue(p_family uuid, p_markets text[], p_scope jsonb, p_at timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_at      timestamptz := coalesce(p_at, clock_timestamp());
  f         recipe.mbr_family;
  v_markets text[] := array(select distinct m from unnest(coalesce(p_markets, '{}'::text[])) m where m is not null order by m);
  v_site    text := p_scope ->> 'site';
  v_line    text := p_scope ->> 'line';
  v_bs      text := p_scope ->> 'batch_size';
  v_base    jsonb;
  v_pick    record;
  v_rule    text;
  v_detail  jsonb;
  v_text    text;
begin
  v_base := jsonb_build_object('family_id', p_family, 'markets', to_jsonb(v_markets),
                               'scope', jsonb_build_object('site', v_site, 'line', v_line, 'batch_size', v_bs), 'at', recipe.utc_text(v_at));
  select * into f from recipe.mbr_family where id = p_family;
  if not found then
    return v_base || jsonb_build_object('ok', false, 'explanation', format('Unknown MBR family %s (INV-01)', p_family));
  end if;
  v_base := v_base || jsonb_build_object('family', f.code);
  if cardinality(v_markets) = 0 or exists (select 1 from unnest(v_markets) m where m !~ '^[A-Z]{2}$') then
    return v_base || jsonb_build_object('ok', false, 'explanation', 'A batch names its market set as two-letter market codes (INV-01)');
  end if;
  if not ('IN' = any (v_markets)) then
    return v_base || jsonb_build_object('ok', false,
      'explanation', 'India (IN) must be in every market set: every batch is made under an Indian licence (INV-28; INV-01)');
  end if;
  if coalesce(btrim(v_site), '') = '' or coalesce(btrim(v_line), '') = '' or coalesce(btrim(v_bs), '') = '' then
    return v_base || jsonb_build_object('ok', false, 'explanation', 'A batch names its scope: site, line and batch size (INV-01)');
  end if;
  if not exists (select 1 from jsonb_array_elements(f.batch_sizes) b where b ->> 'id' = v_bs) then
    return v_base || jsonb_build_object('ok', false,
      'explanation', format('Batch size %s is not an approved batch size of family %s (PR-01; INV-01)', v_bs, f.code));
  end if;

  select x.version_id, x.version_number into v_pick
  from recipe.valid_cells(p_family, v_markets, v_site, v_line, v_bs, v_at) x
  where x.validity = 'CURRENT'
  group by x.version_id, x.version_number having count(distinct x.market) = cardinality(v_markets)
  order by x.version_number desc limit 1;
  if found then
    v_rule := 'CURRENT_FOR_EVERY_MARKET';
  else
    select x.version_id, x.version_number into v_pick
    from recipe.valid_cells(p_family, v_markets, v_site, v_line, v_bs, v_at) x
    group by x.version_id, x.version_number having count(distinct x.market) = cardinality(v_markets)
    order by x.version_number desc limit 1;
    if found then
      v_rule := 'CURRENT_OR_BRIDGING';
    end if;
  end if;

  if v_rule is not null then
    return v_base || jsonb_build_object(
      'ok', true, 'rule', v_rule, 'version_id', v_pick.version_id, 'version_number', v_pick.version_number,
      'content_hash', recipe.content_hash_of(v_pick.version_id),
      'basis', (select jsonb_agg(jsonb_build_object('market', m, 'validity', y.validity, 'cell_id', y.cell_id, 'authorisation_id', y.authorisation_id)
                                 order by m)
                from unnest(v_markets) m
                cross join lateral (select x.validity, x.cell_id, x.authorisation_id
                                    from recipe.valid_cells(p_family, v_markets, v_site, v_line, v_bs, v_at) x
                                    where x.version_id = v_pick.version_id and x.market = m
                                    order by case x.validity when 'CURRENT' then 0 else 1 end limit 1) y));
  end if;

  -- Refused: explain each market.
  select jsonb_agg(jsonb_build_object(
           'market', m,
           'current', coalesce((select jsonb_agg(x.version_number order by x.version_number desc)
                                from recipe.valid_cells(p_family, v_markets, v_site, v_line, v_bs, v_at) x where x.market = m and x.validity = 'CURRENT'), '[]'::jsonb),
           'bridging', coalesce((select jsonb_agg(x.version_number order by x.version_number desc)
                                 from recipe.valid_cells(p_family, v_markets, v_site, v_line, v_bs, v_at) x where x.market = m and x.validity = 'BRIDGING'), '[]'::jsonb),
           'linked', exists (select 1 from recipe.mbr_version v
                             where v.family_id = p_family and recipe.version_was_approved(v.id)
                               and (recipe.current_content(v.id)).content -> 'header' -> 'marketSet' ? m))
         order by m)
  into v_detail from unnest(v_markets) m;
  select string_agg(format('%s: %s', d ->> 'market',
           case when jsonb_array_length(d -> 'current') > 0 then
                  'version ' || (select string_agg(x, ', ') from jsonb_array_elements_text(d -> 'current') x) || ' CURRENT'
                  || case when jsonb_array_length(d -> 'bridging') > 0
                          then ', version ' || (select string_agg(x, ', ') from jsonb_array_elements_text(d -> 'bridging') x) || ' BRIDGING' else '' end
                when jsonb_array_length(d -> 'bridging') > 0 then
                  'version ' || (select string_agg(x, ', ') from jsonb_array_elements_text(d -> 'bridging') x) || ' BRIDGING only'
                when not (d ->> 'linked')::boolean then 'the master is not linked to this market (no approved version lists it)'
                else 'no version is CURRENT or BRIDGING for this market and scope' end), '; ' order by d ->> 'market')
  into v_text from jsonb_array_elements(v_detail) d;
  return v_base || jsonb_build_object('ok', false, 'markets_detail', v_detail,
    'explanation', format('No single version of MBR family %s is CURRENT or BRIDGING for every market in {%s} at site %s, line %s, batch size %s: %s (INV-01; PR-04)',
                          f.code, array_to_string(v_markets, ', '), v_site, v_line, v_bs, v_text));
end
$$;

-- The rule-table versions in force (latest published) for the kernel table and the edition's table.
create function recipe.rule_table_versions(p_edition text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, market, pg_temp as $$
  select coalesce(jsonb_object_agg(t.code,
           (select jsonb_build_object('id', v.id, 'version', v.version, 'content_hash', encode(v.content_hash, 'hex'))
            from market.rule_table_version v where v.table_code = t.code order by v.version desc limit 1) order by t.code), '{}'::jsonb)
  from market.rule_table t
  where t.code in ('kernel', case p_edition when 'tablets' then 'tablets' else 'sterile' end)
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards on the tables
-- ---------------------------------------------------------------------------------------------

create function recipe.stub_batch_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
begin
  if tg_op = 'INSERT' then
    new.status := 'PLANNED';
    new.markets := array(select distinct m from unnest(new.markets) m order by m);
    new.created_by_person := (v_ctx ->> 'person_id')::uuid;
    new.created_by_account := (v_ctx ->> 'account_id')::uuid;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'Batches are never deleted (EBMR-RCP-120)';
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception using errcode = 'P0001', message = 'Only the status of a batch changes (EBMR-RCP-120)';
  end if;
  if not ((old.status = 'PLANNED' and new.status in ('ISSUED', 'CANCELLED')) or (old.status = 'ISSUED' and new.status in ('IN_PROGRESS', 'CANCELLED'))
          or (old.status = 'IN_PROGRESS' and new.status = 'COMPLETED') or old.status = new.status) then
    raise exception using errcode = 'P0001', message = format('A batch cannot go from %s to %s (EBMR-RCP-121)', old.status, new.status);
  end if;
  if new.status = 'ISSUED' and old.status = 'PLANNED'
     and not (exists (select 1 from recipe.batch_mbr_pin p where p.batch_id = new.id) and exists (select 1 from recipe.control_recipe c where c.batch_id = new.id)) then
    raise exception using errcode = 'P0001',
      message = 'A batch is ISSUED only with its pinned MBR version and control-recipe snapshot (INV-01; INV-02; EBMR-RCP-122)';
  end if;
  return new;
end
$$;
create trigger a1_guard before insert or update or delete on recipe.stub_batch for each row execute function recipe.stub_batch_guard();
create trigger aa_no_truncate before truncate on recipe.stub_batch for each statement execute function kernel.reject_mutation();

-- INV-01: the pin is exactly what the selection gives at the issue instant; nothing the caller
-- supplies is trusted except the version it asks for, which must be that version.
create function recipe.batch_mbr_pin_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx  jsonb := recipe.require_actor();
  b      recipe.stub_batch;
  f      recipe.mbr_family;
  v_sel  jsonb;
begin
  select * into b from recipe.stub_batch where id = new.batch_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-RCP-120)', new.batch_id);
  end if;
  if b.status <> 'PLANNED' then
    raise exception using errcode = 'P0001', message = format('Batch %s is %s; a batch is pinned once, at issue (INV-01; EBMR-RCP-102)', b.batch_number, b.status);
  end if;
  select * into f from recipe.mbr_family where id = b.family_id;
  v_sel := recipe.select_version_for_issue(b.family_id, b.markets, jsonb_build_object('site', b.site, 'line', b.line, 'batch_size', b.batch_size), new.recorded_at);
  if not (v_sel ->> 'ok')::boolean then
    raise exception using errcode = 'P0001', message = format('Batch %s cannot be issued. %s (EBMR-RCP-100)', b.batch_number, v_sel ->> 'explanation');
  end if;
  -- No version requested: the selection decides. A requested version must be that version.
  new.version_id := coalesce(new.version_id, (v_sel ->> 'version_id')::uuid);
  if new.version_id is distinct from (v_sel ->> 'version_id')::uuid then
    raise exception using errcode = 'P0001',
      message = format('Batch %s may use only version %s of %s at issue (%s); version %s is not valid for its markets now (PR-05; INV-01; EBMR-RCP-101)',
                       b.batch_number, v_sel ->> 'version_number', f.code, v_sel ->> 'rule',
                       coalesce((select v.version_number::text from recipe.mbr_version v where v.id = new.version_id), '(unknown)'));
  end if;
  new.family_id := b.family_id;
  new.version_number := (v_sel ->> 'version_number')::integer;
  new.content_hash := v_sel ->> 'content_hash';
  new.markets := b.markets;
  new.scope := jsonb_build_object('site', b.site, 'line', b.line, 'batch_size', b.batch_size);
  new.selection := v_sel;
  new.rule_table_versions := recipe.rule_table_versions(f.edition);
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.batch_mbr_pin for each row execute function recipe.batch_mbr_pin_guard();

-- The control recipe (INV-02), built by the database: the pinned version's content (whose hash must
-- still be the pinned hash), the batch header with its batch size, the selection basis and the
-- rule-table versions. Scaling to the batch size and the resolved rule values are added by batch
-- issue in Phase 3.
create function recipe.build_control_recipe(p_pin uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  p  recipe.batch_mbr_pin;
  b  recipe.stub_batch;
  f  recipe.mbr_family;
  v  recipe.mbr_version;
  c  recipe.mbr_content;
begin
  select * into p from recipe.batch_mbr_pin where id = p_pin;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown pin %s (EBMR-RCP-103)', p_pin);
  end if;
  select * into b from recipe.stub_batch where id = p.batch_id;
  select * into f from recipe.mbr_family where id = p.family_id;
  select * into v from recipe.mbr_version where id = p.version_id;
  c := recipe.current_content(v.id);
  if c.content_hash is distinct from p.content_hash or recipe.json_hash(c.content) is distinct from p.content_hash then
    raise exception using errcode = 'P0001', message = 'The pinned version''s content no longer has the pinned hash (INV-01; INV-02; EBMR-RCP-103)';
  end if;
  return jsonb_build_object(
    'format', 'ebmr.control-recipe', 'formatVersion', 1,
    'batch', jsonb_build_object('id', b.id, 'batch_number', b.batch_number, 'markets', to_jsonb(p.markets), 'site', b.site, 'line', b.line,
                                'purpose', b.purpose,
                                'batch_size', (select x from jsonb_array_elements(f.batch_sizes) x where x ->> 'id' = b.batch_size)),
    'mbr', jsonb_build_object('family', f.code, 'version_id', v.id, 'version_number', v.version_number, 'content_hash', c.content_hash,
                              'effective_from', recipe.utc_text(v.effective_from), 'content', c.content),
    'pin', jsonb_build_object('pin_id', p.id, 'rule', p.selection ->> 'rule', 'basis', p.selection -> 'basis',
                              'rule_table_versions', p.rule_table_versions),
    'issued_at', recipe.utc_text(p.recorded_at));
end
$$;

create function recipe.control_recipe_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx jsonb := recipe.require_actor();
  p     recipe.batch_mbr_pin;
begin
  select * into p from recipe.batch_mbr_pin where id = new.pin_id;
  if not found or p.batch_id <> new.batch_id then
    raise exception using errcode = 'P0001', message = 'A control recipe belongs to its batch''s pin (INV-02; EBMR-RCP-104)';
  end if;
  new.version_id := p.version_id;
  new.mbr_content_hash := p.content_hash;
  new.snapshot := recipe.build_control_recipe(p.id);
  new.snapshot_hash := recipe.json_hash(new.snapshot);
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.control_recipe for each row execute function recipe.control_recipe_guard();

create function recipe.in_flight_disposition_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ctx  jsonb := recipe.require_actor();
  s      recipe.mbr_version;
  pv     recipe.mbr_version;
  b      recipe.stub_batch;
  p      recipe.batch_mbr_pin;
begin
  select * into s from recipe.mbr_version where id = new.successor_version_id;
  select * into b from recipe.stub_batch where id = new.batch_id for update;
  select * into p from recipe.batch_mbr_pin where batch_id = new.batch_id;
  select * into pv from recipe.mbr_version where id = p.version_id;
  if s.id is null or b.id is null or p.id is null or pv.family_id <> s.family_id or pv.version_number >= s.version_number then
    raise exception using errcode = 'P0001',
      message = 'An in-flight disposition is recorded for a batch of an earlier version of the same family (ADR 0014; EBMR-RCP-070)';
  end if;
  if b.status not in ('ISSUED', 'IN_PROGRESS') then
    raise exception using errcode = 'P0001', message = format('Batch %s is %s: dispositions are for issued or running batches (ADR 0014; EBMR-RCP-070)', b.batch_number, b.status);
  end if;
  if recipe.version_state(s.id) in ('RETIRED', 'WITHDRAWN') then
    raise exception using errcode = 'P0001', message = format('Version %s is %s (EBMR-RCP-070)', s.version_number, recipe.version_state(s.id));
  end if;
  if new.disposition = 'CANCEL_UNSTARTED' and b.status <> 'ISSUED' then
    raise exception using errcode = 'P0001', message = format('Batch %s has started: CANCEL_UNSTARTED applies only to a batch not yet started (ADR 0014; EBMR-RCP-071)', b.batch_number);
  end if;
  new.pinned_version_id := pv.id;
  new.batch_status := b.status;
  new.person_id := (v_ctx ->> 'person_id')::uuid;
  new.account_id := (v_ctx ->> 'account_id')::uuid;
  return new;
end
$$;
create trigger a1_guard before insert on recipe.in_flight_disposition for each row execute function recipe.in_flight_disposition_guard();

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p_def: {batchNumber, familyId, markets: [..], site, line, batchSize}
create function recipe.create_stub_batch(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_family where id = (p_def ->> 'familyId')::uuid) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR family %s (EBMR-RCP-010)', p_def ->> 'familyId');
  end if;
  perform iam.require_permission('BATCH.ISSUE', recipe.family_scope((p_def ->> 'familyId')::uuid));
  insert into recipe.stub_batch (batch_number, family_id, markets, site, line, batch_size, created_by_person, created_by_account)
  values (p_def ->> 'batchNumber', (p_def ->> 'familyId')::uuid, array(select jsonb_array_elements_text(coalesce(p_def -> 'markets', '[]'::jsonb))),
          p_def ->> 'site', p_def ->> 'line', p_def ->> 'batchSize', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- Issues a planned stub batch: selection at the database clock, the pin, the control recipe and the
-- status ISSUED, in one transaction. p_version (optional) is the version the caller expects; any
-- other than the one the selection gives is refused (PR-05: after v2 is CURRENT, v1 is refused).
create function recipe.issue_stub_batch(p_batch uuid, p_version uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  b      recipe.stub_batch;
  v_sel  jsonb;
  p      recipe.batch_mbr_pin;
  cr     recipe.control_recipe;
  v_ctx  jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.stub_batch where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-RCP-120)', p_batch);
  end if;
  perform iam.require_permission('BATCH.ISSUE', recipe.family_scope(b.family_id));
  -- Wait for any market authorisation being activated for this family (INV-17 / INV-01 consistency).
  perform 1 from recipe.mbr_family where id = b.family_id for share;
  if b.status <> 'PLANNED' then
    raise exception using errcode = 'P0001', message = format('Batch %s is %s; only a PLANNED batch is issued (EBMR-RCP-102)', b.batch_number, b.status);
  end if;
  v_sel := recipe.select_version_for_issue(b.family_id, b.markets, jsonb_build_object('site', b.site, 'line', b.line, 'batch_size', b.batch_size), clock_timestamp());
  if not (v_sel ->> 'ok')::boolean then
    raise exception using errcode = 'P0001', message = format('Batch %s cannot be issued. %s (EBMR-RCP-100)', b.batch_number, v_sel ->> 'explanation');
  end if;
  insert into recipe.batch_mbr_pin (batch_id, family_id, version_id, version_number, content_hash, markets, scope, selection, rule_table_versions,
                                    person_id, account_id)
  values (b.id, b.family_id, p_version, 0, repeat('0', 64), '{}', '{}', '{}', '{}',
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into p;
  insert into recipe.control_recipe (batch_id, pin_id, version_id, mbr_content_hash, snapshot, snapshot_hash, person_id, account_id)
  values (b.id, p.id, p.version_id, p.content_hash, '{}', repeat('0', 64), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning * into cr;
  v_ctx := recipe.push_reason('BATCH_ISSUED', 'batch issued from its pinned MBR version');
  update recipe.stub_batch set status = 'ISSUED' where id = b.id;
  perform recipe.restore_actor(v_ctx);
  perform kernel.audit_business_event('batch:' || b.id,
    format('batch %s issued on MBR %s version %s (%s), control recipe %s', b.batch_number, v_sel ->> 'family', p.version_number, p.selection ->> 'rule', cr.snapshot_hash),
    jsonb_build_object('pin_id', p.id, 'version_id', p.version_id, 'content_hash', p.content_hash, 'snapshot_hash', cr.snapshot_hash));
  return jsonb_build_object('batch_id', b.id, 'pin_id', p.id, 'version_id', p.version_id, 'version_number', p.version_number,
                            'content_hash', p.content_hash, 'rule', p.selection ->> 'rule', 'basis', p.selection -> 'basis',
                            'control_recipe_id', cr.id, 'snapshot_hash', cr.snapshot_hash);
end
$$;

-- Stub batch progress (Phase 3 replaces this with the batch record machine).
create function recipe.set_stub_batch_status(p_batch uuid, p_status text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  b     recipe.stub_batch;
  v_ctx jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.stub_batch where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-RCP-120)', p_batch);
  end if;
  perform iam.require_permission('BATCH.ISSUE', recipe.family_scope(b.family_id));
  if p_status = 'ISSUED' then
    raise exception using errcode = 'P0001', message = 'A batch is issued through recipe.issue_stub_batch (INV-01; EBMR-RCP-122)';
  end if;
  v_ctx := recipe.push_reason('BATCH_STATUS', format('batch status set to %s', p_status));
  update recipe.stub_batch set status = p_status where id = p_batch;
  perform recipe.restore_actor(v_ctx);
end
$$;

create function recipe.record_in_flight_disposition(p_successor uuid, p_batch uuid, p_disposition text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.mbr_version where id = p_successor) then
    raise exception using errcode = 'P0001', message = format('Unknown MBR version %s (EBMR-RCP-020)', p_successor);
  end if;
  perform iam.require_permission('MBR.APPROVE', recipe.version_scope(p_successor));
  insert into recipe.in_flight_disposition (successor_version_id, batch_id, pinned_version_id, batch_status, disposition, reason, person_id, account_id)
  values (p_successor, p_batch, p_successor, 'ISSUED', p_disposition, coalesce(p_reason, ''),
          '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  returning id into v_id;
  return v_id;
end
$$;

-- INV-02: the stored snapshot still hashes to its stored hash, carries the pinned content and hash,
-- and the pinned version's content is unchanged.
create function recipe.verify_control_recipe(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  cr        recipe.control_recipe;
  p         recipe.batch_mbr_pin;
  v_comp    text;
  v_prob    text[] := '{}';
begin
  select * into cr from recipe.control_recipe where batch_id = p_batch;
  if not found then
    return jsonb_build_object('batch_id', p_batch, 'ok', false, 'problems', jsonb_build_array('the batch has no control recipe'));
  end if;
  select * into p from recipe.batch_mbr_pin where id = cr.pin_id;
  v_comp := recipe.json_hash(cr.snapshot);
  if v_comp <> cr.snapshot_hash then
    v_prob := v_prob || 'the snapshot does not hash to its stored hash (the issued control recipe changed)'::text;
  end if;
  if cr.snapshot -> 'mbr' ->> 'content_hash' is distinct from p.content_hash or cr.mbr_content_hash is distinct from p.content_hash
     or recipe.json_hash(cr.snapshot -> 'mbr' -> 'content') is distinct from p.content_hash then
    v_prob := v_prob || 'the snapshot does not carry the pinned MBR content'::text;
  end if;
  if recipe.content_hash_of(p.version_id) is distinct from p.content_hash then
    v_prob := v_prob || 'the pinned MBR version''s content changed after issue'::text;
  end if;
  return jsonb_build_object('batch_id', p_batch, 'ok', cardinality(v_prob) = 0, 'stored_hash', cr.snapshot_hash, 'computed_hash', v_comp,
                            'pinned_content_hash', p.content_hash, 'problems', to_jsonb(v_prob));
end
$$;

select platform.enforce_db_time('recipe.stub_batch', array['recorded_at']);
select platform.enforce_db_time('recipe.batch_mbr_pin', array['recorded_at']);
select platform.enforce_db_time('recipe.control_recipe', array['recorded_at']);
select platform.enforce_db_time('recipe.in_flight_disposition', array['recorded_at']);
select kernel.register_audited_table('recipe.stub_batch', 'batch', 'id', false);
select kernel.register_audited_table('recipe.batch_mbr_pin', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.control_recipe', 'batch', 'batch_id', true);
select kernel.register_audited_table('recipe.in_flight_disposition', 'mbr_version', 'successor_version_id', true);

grant select on recipe.stub_batch, recipe.batch_mbr_pin, recipe.control_recipe, recipe.in_flight_disposition to ebmr_app;
grant execute on function recipe.valid_cells(uuid, text[], text, text, text, timestamptz), recipe.select_version_for_issue(uuid, text[], jsonb, timestamptz),
                          recipe.rule_table_versions(text), recipe.build_control_recipe(uuid), recipe.create_stub_batch(jsonb),
                          recipe.issue_stub_batch(uuid, uuid), recipe.set_stub_batch_status(uuid, text),
                          recipe.record_in_flight_disposition(uuid, uuid, text, text), recipe.verify_control_recipe(uuid) to ebmr_app;

reset role;
