-- Recipe core: dual custody of a controlled API (Phase 6 slice 6e; draft control IN-53; defaults D-P6e-6 to D-P6e-8;
-- docs/build-plan/phase-6/slice-6e-0-interfaces.md).
--
-- Handbook: modules/recipe-core.md
--
--   recipe.controlled_custody            one custody act on a lot of a controlled API: DISPENSE (into a running batch),
--                                        TRANSFER (between two stock locations), RETURN (unused, from a batch to the
--                                        stores) or DESTRUCTION (rejects of a batch, with how and why). Proposed by the
--                                        first custodian; insert-only, audited on the lot.
--   recipe.controlled_custody_signature  FIRST (CONTROLLED_CUSTODY_RECORDED, the proposer) and SECOND
--                                        (CONTROLLED_CUSTODY_COUNTERSIGNED, another person: for a DESTRUCTION the
--                                        witness). States PROPOSED, AWAITING_COUNTERSIGN, CONFIRMED. One person never
--                                        fills both places (the command checks it; the kernel refuses it too: the second
--                                        meaning is a witness's, independent of the first and excluding the proposer).
--   recipe.controlled_custody_use        the consumption (or WMS move, site services 0970) a CONFIRMED DISPENSE (or
--                                        TRANSFER) record covered: once.
-- The dispensing guard (trigger zzc_controlled_dual_custody, after insert on site.lot_consumption): a consumption of a
-- material that the batch's product lists as controlled (plant.controlled_materials, 1031) needs a CONFIRMED DISPENSE
-- record of the same lot and batch, the exact quantity and unit, not used before, one of whose custodians is the
-- dispenser; it records the use. Any other consumption is refused (EBMR-CSM-020). An unflagged product is unaffected.
-- Commands: recipe.propose_controlled_custody(p) and recipe.sign_controlled_custody(custody, signature),
-- CONTROLLED.CUSTODY, never an administrator. Signed aggregate: controlled_custody <id>. Messages EBMR-CSM-010 to 029.

set local role ebmr_owner;

create table recipe.controlled_custody (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('DISPENSE', 'TRANSFER', 'RETURN', 'DESTRUCTION')),
  lot_id               uuid not null references site.material_lot (id),
  material_code        text not null,
  quantity             numeric not null check (quantity > 0),
  unit                 text not null,
  batch_id             uuid references recipe.batch_execution (id),
  from_location        text check (from_location ~ '^[!-~]{1,64}$'),
  to_location          text check (to_location ~ '^[!-~]{1,64}$'),
  note                 text check (note is null or (btrim(note) <> '' and length(note) <= 2000)),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  correlation_id       uuid not null,
  check ((kind = 'TRANSFER') = (batch_id is null)),
  check (kind <> 'TRANSFER' or (from_location is not null and to_location is not null and from_location <> to_location)),
  check (kind <> 'DESTRUCTION' or note is not null)
);
create index controlled_custody_lot on recipe.controlled_custody (lot_id, recorded_at);
create index controlled_custody_batch on recipe.controlled_custody (batch_id, material_code);

create table recipe.controlled_custody_signature (
  custody_id    uuid not null references recipe.controlled_custody (id),
  position      text not null check (position in ('FIRST', 'SECOND')),
  signature_id  uuid not null unique,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  primary key (custody_id, position)
);

create table recipe.controlled_custody_use (
  custody_id      uuid primary key references recipe.controlled_custody (id),
  consumption_id  uuid unique references site.lot_consumption (id),
  move_id         uuid unique references site.lot_location_move (id),
  recorded_at     timestamptz not null default clock_timestamp(),
  check ((consumption_id is null) <> (move_id is null))
);

do $$
declare
  t text;
begin
  foreach t in array array['controlled_custody', 'controlled_custody_signature', 'controlled_custody_use'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.controlled_custody', array['recorded_at']);
select platform.enforce_db_time('recipe.controlled_custody_signature', array['recorded_at']);
select platform.enforce_db_time('recipe.controlled_custody_use', array['recorded_at']);
select kernel.register_audited_table('recipe.controlled_custody', 'material_lot', 'lot_id', true);
select kernel.register_audited_table('recipe.controlled_custody_signature', 'controlled_custody', 'custody_id', true);
select kernel.register_audited_table('recipe.controlled_custody_use', 'controlled_custody', 'custody_id', true);
create trigger zz_immutable before update or delete on recipe.controlled_custody for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on recipe.controlled_custody_signature for each row execute function site.india_record_immutable();
create trigger zz_immutable before update or delete on recipe.controlled_custody_use for each row execute function site.india_record_immutable();

-- ---------------------------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------------------------

create function recipe.controlled_custody_state(p_custody uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case when not exists (select 1 from recipe.controlled_custody c where c.id = p_custody) then null
              when exists (select 1 from recipe.controlled_custody_signature s where s.custody_id = p_custody and s.position = 'SECOND') then 'CONFIRMED'
              when exists (select 1 from recipe.controlled_custody_signature s where s.custody_id = p_custody and s.position = 'FIRST') then 'AWAITING_COUNTERSIGN'
              else 'PROPOSED' end
$$;

-- The custodians of a record (FIRST, SECOND), NULL where not signed yet.
create function recipe.controlled_custodians(p_custody uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select array[(select s.person_id from recipe.controlled_custody_signature s where s.custody_id = p_custody and s.position = 'FIRST'),
               (select s.person_id from recipe.controlled_custody_signature s where s.custody_id = p_custody and s.position = 'SECOND')]
$$;

-- The controlled materials of a batch's product (recipe.batch_product, 0504): '{}' for an unflagged product.
create function recipe.batch_controlled_materials(p_batch uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select coalesce(plant.controlled_materials(recipe.batch_product(p_batch) ->> 'code'), '{}')
$$;

-- ---------------------------------------------------------------------------------------------
-- Signed content
-- ---------------------------------------------------------------------------------------------

-- The proposal only: it never changes, so both signatures stay VALID; the life cycle is in `state`.
create function recipe.controlled_custody_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  c recipe.controlled_custody;
  l site.material_lot;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from recipe.controlled_custody where id = p_id::uuid;
  if c.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into l from site.material_lot where id = c.lot_id;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('title', format('%s of %s %s of controlled lot %s', initcap(lower(c.kind)), c.quantity::text, c.unit, l.lot_code),
                                  'kind', c.kind, 'lot_id', l.id, 'lot_code', l.lot_code, 'material_code', c.material_code,
                                  'quantity', c.quantity::text, 'unit', c.unit, 'batch_id', c.batch_id,
                                  'batch_number', (select b.batch_number from recipe.batch_execution b where b.id = c.batch_id),
                                  'from_location', c.from_location, 'to_location', c.to_location, 'note', c.note,
                                  'proposed_by', c.proposed_by_person, 'proposed_at', site.utc_text(c.recorded_at),
                                  'status_note', 'Draft control IN-53: NDPS Act and Rules not verified'),
    'state', recipe.controlled_custody_state(c.id),
    'scope', jsonb_build_object('site', l.site_code),
    'entered_by', jsonb_build_array(c.proposed_by_person));
end
$$;

select esig.register_content_provider('controlled_custody', 'recipe.controlled_custody_content(text)',
  'One dual-custody act on a controlled API lot: dispensing, transfer, return or destruction, signed by two people (IN-53, draft)');

-- ---------------------------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------------------------

-- p: {kind, lotId, quantity (decimal text in the lot's unit), unit?, batchId?, fromLocation?, toLocation?, note?}.
create function recipe.propose_controlled_custody(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, plant, iam, pg_temp as $$
declare
  v_ctx     jsonb;
  l         site.material_lot;
  v_kind    text := p ->> 'kind';
  v_batch   uuid;
  v_status  text;
  v_qty     numeric;
  v_left    numeric;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  if p is null or coalesce(p ->> 'lotId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-010 a custody record names the lot of the controlled API (IN-53)';
  end if;
  select * into l from site.material_lot where id = (p ->> 'lotId')::uuid;
  if l.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-010 unknown lot %s', p ->> 'lotId');
  end if;
  v_ctx := iam.require_permission('CONTROLLED.CUSTODY', jsonb_build_object('site', l.site_code));
  if v_kind is null or v_kind not in ('DISPENSE', 'TRANSFER', 'RETURN', 'DESTRUCTION') then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-011 %s is no custody act (DISPENSE, TRANSFER, RETURN or DESTRUCTION)', coalesce(v_kind, 'NULL'));
  end if;
  if coalesce(p ->> 'quantity', '') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or (p ->> 'quantity')::numeric <= 0 or coalesce(p ->> 'unit', l.unit) <> l.unit then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-012 the quantity of a custody act is a positive decimal in the lot''s unit %s (IN-53)', l.unit);
  end if;
  v_qty := (p ->> 'quantity')::numeric;
  if v_kind = 'TRANSFER' then
    if p ? 'batchId' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-013 a transfer moves stock between two locations; it names no batch';
    end if;
    if coalesce(p ->> 'fromLocation', '') !~ '^[!-~]{1,64}$' or coalesce(p ->> 'toLocation', '') !~ '^[!-~]{1,64}$' or p ->> 'fromLocation' = p ->> 'toLocation' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-013 a transfer names the location it leaves and a different location it goes to';
    end if;
    if not plant.material_is_controlled(l.material_code) then
      raise exception using errcode = 'P0001', message = format('EBMR-CSM-014 %s is not a controlled material of any product in effect; no custody record is kept (IN-53)', l.material_code);
    end if;
    if v_qty > site.lot_quantity(l.id) then
      raise exception using errcode = 'P0001', message = format('EBMR-CSM-012 lot %s holds %s %s; more cannot be transferred', l.lot_code, site.lot_quantity(l.id), l.unit);
    end if;
  else
    if coalesce(p ->> 'batchId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from recipe.batch_execution b where b.id = (p ->> 'batchId')::uuid) then
      raise exception using errcode = 'P0001', message = format('EBMR-CSM-013 a %s names the batch it is for', lower(v_kind));
    end if;
    v_batch := (p ->> 'batchId')::uuid;
    if not (l.material_code = any (recipe.batch_controlled_materials(v_batch))) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-CSM-014 %s is not a controlled material of the product of this batch; no custody record is kept (IN-53)', l.material_code);
    end if;
    if v_kind = 'DISPENSE' then
      select s.status into v_status from recipe.execution_state s where s.batch_id = v_batch;
      if v_status is null or v_status not in ('ISSUED', 'IN_PROGRESS') then
        raise exception using errcode = 'P0001', message = format('EBMR-CSM-015 the batch is %s: a controlled API is dispensed only into a running batch', coalesce(v_status, 'not started'));
      end if;
      if v_qty > site.lot_quantity(l.id) then
        raise exception using errcode = 'P0001', message = format('EBMR-CSM-012 lot %s holds %s %s; more cannot be dispensed', l.lot_code, site.lot_quantity(l.id), l.unit);
      end if;
    else
      -- What is still in the batch's hands of this lot: dispensed, less what was returned or destroyed (confirmed or waiting).
      v_left := coalesce((select sum(x.quantity) from site.lot_consumption x where x.batch_id = v_batch and x.lot_id = l.id), 0)
              - coalesce((select sum(c.quantity) from recipe.controlled_custody c
                           where c.batch_id = v_batch and c.lot_id = l.id and c.kind in ('RETURN', 'DESTRUCTION')
                             and recipe.controlled_custody_state(c.id) <> 'PROPOSED'), 0);
      if v_qty > v_left then
        raise exception using errcode = 'P0001',
          message = format('EBMR-CSM-016 the batch holds %s %s of lot %s (dispensed less returned and destroyed); more cannot be %s (IN-53)',
                           v_left, l.unit, l.lot_code, case v_kind when 'RETURN' then 'returned' else 'destroyed' end);
      end if;
    end if;
    if p ? 'fromLocation' or p ? 'toLocation' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-013 only a transfer names locations';
    end if;
  end if;
  if (v_kind = 'DESTRUCTION' and coalesce(btrim(p ->> 'note'), '') = '') or (p ? 'note' and coalesce(btrim(p ->> 'note'), '') = '') then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-017 a destruction states how and why the rejects are destroyed; a note, when given, is not blank';
  end if;
  insert into recipe.controlled_custody (kind, lot_id, material_code, quantity, unit, batch_id, from_location, to_location, note,
                                         proposed_by_person, proposed_by_account, correlation_id)
  values (v_kind, l.id, l.material_code, v_qty, l.unit, v_batch, p ->> 'fromLocation', p ->> 'toLocation', nullif(btrim(coalesce(p ->> 'note', '')), ''),
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- The first custodian (the proposer) signs CONTROLLED_CUSTODY_RECORDED, then another person CONTROLLED_CUSTODY_COUNTERSIGNED.
create function recipe.sign_controlled_custody(p_custody uuid, p_signature uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, pg_temp as $$
declare
  v_ctx     jsonb;
  c         recipe.controlled_custody;
  v_state   text;
  v_meaning text;
  v_pos     text;
  v_first   uuid;
  v_prob    text;
begin
  perform iam.assert_not_administrator();
  select * into c from recipe.controlled_custody where id = p_custody;
  if c.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CSM-018 unknown custody record %s', coalesce(p_custody::text, 'NULL'));
  end if;
  v_ctx := iam.require_permission('CONTROLLED.CUSTODY', jsonb_build_object('site', (select l.site_code from site.material_lot l where l.id = c.lot_id)));
  perform pg_advisory_xact_lock(hashtext('recipe.controlled_custody'), hashtext(c.id::text));
  v_state := recipe.controlled_custody_state(c.id);
  if v_state = 'CONFIRMED' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-019 this custody record is signed by both custodians already';
  end if;
  if v_state = 'PROPOSED' then
    if c.proposed_by_person::text is distinct from v_ctx ->> 'person_id' then
      raise exception using errcode = 'P0001', message = 'EBMR-CSM-021 the first custodian is the person who proposed the custody record; the second signs after (IN-53)';
    end if;
    v_meaning := 'CONTROLLED_CUSTODY_RECORDED';
    v_pos := 'FIRST';
  else
    v_first := (recipe.controlled_custodians(c.id))[1];
    if v_first::text = v_ctx ->> 'person_id' or c.proposed_by_person::text = v_ctx ->> 'person_id' then
      raise exception using errcode = 'P0001',
        message = 'EBMR-CSM-022 dual custody: the second custodian (or the witness of a destruction) is another person than the first; one person never signs both places (IN-53, INV-03)';
    end if;
    v_meaning := 'CONTROLLED_CUSTODY_COUNTERSIGNED';
    v_pos := 'SECOND';
  end if;
  perform esig.assert_signature(p_signature, v_meaning, 'controlled_custody', c.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-023 ' || v_prob;
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-CSM-023 a custodian records the signature they gave themselves';
  end if;
  insert into recipe.controlled_custody_signature (custody_id, position, signature_id, person_id, account_id)
  values (c.id, v_pos, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
  if c.batch_id is not null then
    perform recipe.bump_epoch('BATCH', c.batch_id);
  end if;
  return recipe.controlled_custody_state(c.id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The dispensing guard
-- ---------------------------------------------------------------------------------------------

create function recipe.controlled_consumption_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_custody uuid;
begin
  if not (new.material_code = any (recipe.batch_controlled_materials(new.batch_id))) then
    return null;
  end if;
  select c.id into v_custody from recipe.controlled_custody c
   where c.kind = 'DISPENSE' and c.lot_id = new.lot_id and c.batch_id = new.batch_id and c.quantity = new.quantity and c.unit = new.unit
     and recipe.controlled_custody_state(c.id) = 'CONFIRMED'
     and new.consumed_by_person = any (recipe.controlled_custodians(c.id))
     and not exists (select 1 from recipe.controlled_custody_use u where u.custody_id = c.id)
   order by c.recorded_at, c.id limit 1
   for update;
  if v_custody is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CSM-020 %s %s of controlled API %s dispensed into batch %s with one person: a controlled API is dispensed only under dual custody, against a custody record of this lot, batch and exact quantity signed by two different people, one of them the dispenser (IN-53)',
                       new.quantity, new.unit, new.material_code, new.batch_number);
  end if;
  insert into recipe.controlled_custody_use (custody_id, consumption_id) values (v_custody, new.id);
  return null;
end
$$;
create trigger zzc_controlled_dual_custody after insert on site.lot_consumption for each row execute function recipe.controlled_consumption_guard();

-- The CONFIRMED TRANSFER record, not used before, that covers a WMS move of lot p_lot from p_from to p_to of exactly
-- p_quantity p_unit (site services 0970 records the use), or NULL.
create function recipe.controlled_transfer_for(p_lot uuid, p_from text, p_to text, p_quantity text, p_unit text) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select c.id from recipe.controlled_custody c
   where c.kind = 'TRANSFER' and c.lot_id = p_lot and c.from_location = p_from and c.to_location = p_to and c.unit = p_unit
     and p_quantity ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' and c.quantity = p_quantity::numeric
     and recipe.controlled_custody_state(c.id) = 'CONFIRMED'
     and not exists (select 1 from recipe.controlled_custody_use u where u.custody_id = c.id)
   order by c.recorded_at, c.id limit 1
$$;

revoke all on function recipe.controlled_custody_state(uuid), recipe.controlled_custodians(uuid), recipe.batch_controlled_materials(uuid),
  recipe.controlled_custody_content(text), recipe.propose_controlled_custody(jsonb), recipe.sign_controlled_custody(uuid, uuid),
  recipe.controlled_consumption_guard(), recipe.controlled_transfer_for(uuid, text, text, text, text) from public;
grant execute on function recipe.controlled_custody_state(uuid), recipe.controlled_custodians(uuid), recipe.batch_controlled_materials(uuid),
  recipe.propose_controlled_custody(jsonb), recipe.sign_controlled_custody(uuid, uuid) to ebmr_app;

reset role;
