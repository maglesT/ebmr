-- Tablets server, Phase 3 slice 4a (builder B; G-21, tablets spec K-20; outline 5.2.8 L-29): line printers and
-- inspection devices behind the site gateway, the packaging order's batch data, the print jobs the server releases with
-- the record's variable data, the gateway's echo and events, and how the G-21 entries stand on them (controls PR-35,
-- PR-36, PR-37, IN-16, IN-22, IN-31, DI-20, DI-31; ADR 0012: the rules hold when the application's own database
-- credentials are used directly). Wire formats: integration-sdk printer/wire.ts (the 4a interface).
--
--   tab.print_device          a printer, coder, code reader, vision system, checkweigher or missing-leaflet detector (an
--                             INSTRUMENT of the device registry) a gateway enrolment serves, by serial and kind
--                             (IAM.DEVICE_MANAGE; ended with a reason, never changed), as tab.process_device (0820)
--   tab.packaging_batch_data  insert-only, audited: the variable data of a G-21 step of a packaging order, versioned:
--                             the batch number, the manufacturing date (the issue date, in the site's zone, of the
--                             processing batch the order packs: the parent of a PACKAGING number, else the batch itself)
--                             and the expiry month (manufacturing month plus the step's shelf life, less one), all taken
--                             from the record; the MRP of an India-domestic pack the only value a person gives. Dates are
--                             plain record dates (YYYY-MM-DD, YYYY-MM), never coded (IN-31). A later version is a change
--                             with the person's own reason (STEP.EXECUTE).
--   tab.print_job             a job released for one printer of a G-21 step (STEP.EXECUTE): its fields are the current
--                             batch data with the master's GTIN or NDC for the batch's market and the step's serial pool
--                             (0952), never a caller's value (PR-36: no keying at the device); its artwork set and
--                             packaging order are those of the line's active occupancy by this batch (the slice 1
--                             PACKAGING_ORDER clearance and start: one active order per line, L-29, PR-35), so the job is
--                             bound to the packaging order
--   tab.print_job_ack         the gateway's acknowledgement, once (a repeated identical one is taken again): LOADED only
--                             when the printer's echo equals the job exactly, else the load is refused (REFUSED; IN-31,
--                             PR-42: what is encoded is the record's); MISMATCH and FAILED as the gateway reports them
--   tab.print_job_void        a job voided because the batch data changed after it was released: a job the printer had
--                             loaded (set up) holds the output on the step's line unit since its last passing check
--                             (plant hold window, L-29); the gateway is no longer offered a voided job
--   tab.print_event           insert-only, audited: printed counts, reader, vision and challenge results and faults as the
--                             gateway sent them, taken whole or refused whole (one INTEGRATION command, INTERFACE.WRITE):
--                             a device of the gateway's enrolment by serial, a job of that device (null only for a fault),
--                             the next sequence of the device (the same again with the same content a duplicate)
--   tab.print_event_use       a challenge result is used by one entry at most
-- Entries (trigger ae_tab_g21_print_entries on recipe.execution_command, before insert; accepted and refused rows alike):
--   FIRST_PRINT names a job of this batch's step for the step's printer, loaded by the printer with the record's data and
--   not voided, approved by a person other than the one who released it; CHALLENGE of a gateway device names a challenge
--   result of that device's serial on a job of this batch's step, with the entry's result, not used before (EBMR-EXE-296).
--
-- Privileges: the application role SELECTs the tables and EXECUTEs the writers; it never writes a row directly.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Devices

create table tab.print_device (
  id                    uuid primary key default gen_random_uuid(),
  gateway_key_id        uuid not null references tab.gateway_key (id),
  instrument_device_id  uuid not null references iam.device (id),
  device_code           text not null,
  serial                text not null check (serial ~ '^[!#-~]{1,32}$'),
  kind                  text not null check (kind in ('PRINTER', 'READER', 'VISION', 'CHECKWEIGHER', 'LEAFLET_DETECTOR')),
  bound_by_person       uuid not null,
  bound_at              timestamptz not null default clock_timestamp(),
  ended_at              timestamptz,
  ended_reason          text
);
create unique index print_device_one_active on tab.print_device (instrument_device_id) where ended_at is null;
create unique index print_device_serial_active on tab.print_device (gateway_key_id, serial) where ended_at is null;

create function tab.print_device_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.ended_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-DEV-140 a print device binding starts active';
    end if;
    return new;
  end if;
  if (new.id, new.gateway_key_id, new.instrument_device_id, new.device_code, new.serial, new.kind, new.bound_by_person, new.bound_at)
       is distinct from (old.id, old.gateway_key_id, old.instrument_device_id, old.device_code, old.serial, old.kind, old.bound_by_person, old.bound_at)
     or old.ended_at is not null or new.ended_at is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-140 a print device binding never changes; end it and bind again';
  end if;
  return new;
end
$$;
create trigger aa_print_device_guard before insert or update on tab.print_device for each row execute function tab.print_device_guard();
create trigger aa_print_device_no_delete before delete or truncate on tab.print_device for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.print_device', 'gateway_key', 'gateway_key_id', false);

-- IAM.DEVICE_MANAGE: binds a printer or inspection device (an active INSTRUMENT) to a gateway enrolment with its serial.
create function tab.bind_print_device(p_gateway_key uuid, p_device_code text, p_serial text, p_kind text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_dev   iam.device%rowtype;
  v_id    uuid;
begin
  -- Device configuration is the system administrator's (as tab.bind_process_device, 0820); no GMP record is written.
  v_actor := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  if not exists (select 1 from tab.gateway_key where id = p_gateway_key and status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-013 no active gateway key with this id';
  end if;
  select * into v_dev from iam.device where code = p_device_code;
  if not found or v_dev.device_class <> 'INSTRUMENT' or v_dev.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-014 %s is not an active INSTRUMENT in the registry', p_device_code);
  end if;
  insert into tab.print_device (gateway_key_id, instrument_device_id, device_code, serial, kind, bound_by_person)
  values (p_gateway_key, v_dev.id, v_dev.code, p_serial, p_kind, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function tab.end_print_device(p_binding uuid, p_reason_code text, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_saved jsonb;
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
  update tab.print_device set ended_at = clock_timestamp(), ended_reason = p_reason_text where id = p_binding and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-140 no active print device binding with this id';
  end if;
  perform kernel.set_actor_context(v_saved);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The step and its batch data

-- The G-21 step instance p_key of batch p_batch, IN_PROGRESS, with its node: {inst, node, cfg, content, state}; refuses
-- anything else.
create function tab.g21_open_step(p_batch uuid, p_key text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_state   jsonb;
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_inst    jsonb;
  v_node    jsonb;
begin
  select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
  v_inst := v_state -> 'steps' -> p_key;
  v_node := recipe.step_node(v_content, v_inst ->> 'step');
  if v_node is null or v_node -> 'block' ->> 'type' is distinct from 'G-21' or v_inst ->> 'status' is distinct from 'IN_PROGRESS' then
    raise exception using errcode = 'P0001',
      message = format('%s is not a printed-materials step (G-21) of this batch in progress (PR-36). [EBMR-EXE-296]', left(coalesce(p_key, 'NULL'), 120));
  end if;
  return jsonb_build_object('inst', v_inst, 'node', v_node, 'cfg', recipe.g21_cfg(v_node), 'header', v_state -> 'header');
end
$$;

-- The one market of batch header p_header with variable data in step configuration p_cfg, or NULL when none or several.
create function tab.g21_job_market(p_cfg jsonb, p_header jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when count(*) = 1 then min(m) end
    from jsonb_array_elements_text(case when jsonb_typeof(p_header -> 'marketSet') = 'array' then p_header -> 'marketSet' else '[]'::jsonb end) m
   where jsonb_typeof(p_cfg -> 'markets' -> m) = 'object'
$$;

create table tab.packaging_batch_data (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references recipe.batch_execution (id),
  step_key            text not null check (btrim(step_key) <> ''),
  version             integer not null check (version >= 1),
  fields              jsonb not null check (jsonb_typeof(fields) = 'object'),
  reason              text check (reason is null or btrim(reason) <> ''),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (batch_id, step_key, version),
  check ((version = 1) = (reason is null))
);
revoke all on tab.packaging_batch_data from public;
create trigger aa_packaging_batch_data_insert_only before update or delete on tab.packaging_batch_data for each row execute function kernel.reject_mutation();
create trigger aa_packaging_batch_data_no_truncate before truncate on tab.packaging_batch_data for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.packaging_batch_data', array['recorded_at']);
select kernel.register_audited_table('tab.packaging_batch_data', 'batch', 'batch_id', true);

-- Review 4a MEDIUM 6: the second person's check of a batch-data version that carries an MRP a person gave (IN-31).
create table tab.packaging_batch_data_check (
  data_id            uuid primary key references tab.packaging_batch_data (id),
  checked_by_person  uuid not null,
  checked_by_account uuid not null,
  checked_at         timestamptz not null default clock_timestamp()
);
revoke all on tab.packaging_batch_data_check from public;
create trigger aa_packaging_batch_data_check_insert_only before update or delete on tab.packaging_batch_data_check for each row execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.packaging_batch_data_check', 'batch', 'data_id', true);

-- The current batch data of step p_key of batch p_batch, or NULL.
create function tab.current_batch_data(p_batch uuid, p_key text) returns tab.packaging_batch_data
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select d from tab.packaging_batch_data d where d.batch_id = p_batch and d.step_key = p_key order by d.version desc limit 1
$$;

create table tab.print_job (
  id                 text primary key check (id ~ '^[!-~]{1,64}$'),
  batch_id           uuid not null references recipe.batch_execution (id),
  step_key           text not null,
  step               text not null,
  config_device      text not null,
  print_device_id    uuid not null references tab.print_device (id),
  device_serial      text not null,
  gateway_key_id     uuid not null references tab.gateway_key (id),
  packaging_order    text not null,
  artwork_set        text not null,
  occupancy_id       uuid not null references plant.area_occupancy (id),
  fields             jsonb not null,
  layout_ref         text not null check (layout_ref ~ '^[ -~]{1,64}$'),
  data_version       integer not null,
  released_by_person uuid not null,
  released_by_account uuid not null,
  released_at        timestamptz not null default clock_timestamp(),
  correlation_id     uuid not null
);
revoke all on tab.print_job from public;
create trigger aa_print_job_insert_only before update or delete on tab.print_job for each row execute function kernel.reject_mutation();
create trigger aa_print_job_no_truncate before truncate on tab.print_job for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.print_job', array['released_at']);
select kernel.register_audited_table('tab.print_job', 'batch', 'batch_id', true);

create table tab.print_job_ack (
  job_id          text primary key references tab.print_job (id),
  outcome         text not null check (outcome in ('LOADED', 'MISMATCH', 'FAILED')),
  echoed_fields   jsonb,
  source_time_us  bigint not null check (source_time_us >= 0),
  message         text,
  result          text not null check (result in ('LOADED', 'REFUSED', 'MISMATCH', 'FAILED')),
  session_id      uuid not null,
  received_at     timestamptz not null default clock_timestamp()
);
revoke all on tab.print_job_ack from public;
create trigger aa_print_job_ack_insert_only before update or delete on tab.print_job_ack for each row execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.print_job_ack', 'print_job', 'job_id', true);

create table tab.print_job_void (
  job_id          text primary key references tab.print_job (id),
  data_version    integer not null,
  held            boolean not null,
  voided_by       uuid not null,
  voided_at       timestamptz not null default clock_timestamp()
);
revoke all on tab.print_job_void from public;
create trigger aa_print_job_void_insert_only before update or delete on tab.print_job_void for each row execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.print_job_void', 'print_job', 'job_id', true);

-- The serial pool a job of step p_key of batch p_batch for market p_market carries (0952 replaces it), or NULL.
create function tab.g21_job_pool(p_batch uuid, p_key text, p_market text) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select null::text
$$;

-- IN-31, PR-36 (header): the batch data of step p_key of batch p_batch from the record, with the MRP p_mrp a person gives
-- for an India-domestic pack; a later version with the person's own reason p_reason voids the jobs released on an earlier
-- one and, for a job the printer had loaded, holds the output on the step's line unit since its last passing check (L-29).
create function tab.record_packaging_batch_data(p_batch uuid, p_key text, p_mrp text, p_reason text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, plant, site, pg_temp as $$
declare
  v_actor  jsonb;
  v_step   jsonb;
  v_cfg    jsonb;
  v_market text;
  v_codes  jsonb;
  b        recipe.batch_execution;
  v_proc   recipe.batch_execution;
  v_mfg    date;
  v_exp    date;
  v_fields jsonb;
  v_cur    tab.packaging_batch_data;
  v_ver    integer;
  j        tab.print_job;
  v_held   boolean;
  v_voided jsonb := '[]'::jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  perform pg_advisory_xact_lock(hashtext('tab.packaging_batch_data:' || p_batch::text || ':' || coalesce(p_key, '')));
  v_step := tab.g21_open_step(p_batch, p_key);
  v_cfg := v_step -> 'cfg';
  v_market := tab.g21_job_market(v_cfg, v_step -> 'header');
  if v_market is null then
    raise exception using errcode = 'P0001',
      message = 'The step names variable data for none or several of the batch''s markets: a packaging order prints for one market (PR-36). [EBMR-EXE-296]';
  end if;
  v_codes := v_cfg -> 'markets' -> v_market;
  if jsonb_typeof(v_cfg -> 'shelfLifeMonths') is distinct from 'number' then
    raise exception using errcode = 'P0001', message = 'The step names no shelf life, so the record gives no expiry date (PR-36, IN-31). [EBMR-EXE-296]';
  end if;
  if coalesce((v_codes -> 'mrp') = 'true'::jsonb, false) <> (p_mrp is not null) then
    raise exception using errcode = 'P0001',
      message = format('An MRP is given exactly for a pack that shows it (%s: %s) (IN-31). [EBMR-EXE-296]', v_market, case when (v_codes -> 'mrp') = 'true'::jsonb then 'it does' else 'it does not' end);
  end if;
  if p_mrp is not null and (p_mrp !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$' or p_mrp::numeric <= 0) then
    raise exception using errcode = 'P0001', message = 'An MRP is a positive amount in rupees with at most 2 decimals (IN-31). [EBMR-EXE-296]';
  end if;
  select * into b from recipe.batch_execution where id = p_batch;
  -- The processing batch the order packs: the parent of a PACKAGING number, else the batch itself.
  select x.* into v_proc from site.batch_number_allocation a
    join recipe.batch_allocation_link l on l.allocation_id = a.parent_allocation_id
    join recipe.batch_execution x on x.id = l.batch_id
   where a.id = (select k.allocation_id from recipe.batch_allocation_link k where k.batch_id = p_batch);
  if v_proc.id is null then
    v_proc := b;
  end if;
  v_mfg := (v_proc.issued_at at time zone kernel.site_zone())::date;
  v_exp := (date_trunc('month', v_mfg) + make_interval(months => (v_cfg ->> 'shelfLifeMonths')::integer - 1))::date;
  v_fields := jsonb_strip_nulls(jsonb_build_object('batch', b.batch_number, 'mfgDate', to_char(v_mfg, 'YYYY-MM-DD'), 'expiryDate', to_char(v_exp, 'YYYY-MM'), 'mrp', p_mrp));
  v_cur := tab.current_batch_data(p_batch, p_key);
  if (v_cur.id is null) <> (p_reason is null) or (p_reason is not null and btrim(p_reason) = '') then
    raise exception using errcode = 'P0001', message = case when v_cur.id is null
      then 'The step has no batch data yet: the first version is recorded without a reason (DI-22). [EBMR-EXE-296]'
      else 'A change of the batch data after set-up is recorded with your own reason; the jobs released on the earlier data are voided (L-29, DI-22). [EBMR-EXE-296]' end;
  end if;
  v_ver := coalesce(v_cur.version, 0) + 1;
  insert into tab.packaging_batch_data (batch_id, step_key, version, fields, reason, recorded_by_person, recorded_by_account, correlation_id)
  values (p_batch, p_key, v_ver, v_fields, p_reason, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  -- L-29: the jobs released on earlier data are void; what a loaded (set-up) job printed since the last good check is held.
  for j in select x.* from tab.print_job x where x.batch_id = p_batch and x.step_key = p_key and x.data_version < v_ver
              and tab.print_job_state(x.id) in ('RELEASED', 'LOADED') order by x.released_at, x.id loop
    v_held := exists (select 1 from tab.print_job_ack a where a.job_id = j.id and a.result = 'LOADED') and jsonb_typeof(v_cfg -> 'unit') = 'string';
    insert into tab.print_job_void (job_id, data_version, held, voided_by) values (j.id, v_ver, v_held, (v_actor ->> 'person_id')::uuid);
    if v_held then
      perform plant.ipc_check_record(p_batch, v_cfg ->> 'unit', null, 'FAIL', format('L-29: batch data changed after set-up of print job %s', j.id), v_actor, false);
    end if;
    v_voided := v_voided || jsonb_build_object('jobId', j.id, 'held', v_held);
  end loop;
  return jsonb_build_object('version', v_ver, 'fields', v_fields, 'voided', v_voided);
end
$$;

-- IN-31 (review 4a MEDIUM 6): STEP.VERIFY: a second person checks the MRP of the current batch data version p_version of
-- step p_key of batch p_batch, never the person who gave it.
create function tab.check_packaging_batch_data(p_batch uuid, p_key text, p_version integer) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_data  tab.packaging_batch_data;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.VERIFY', plant.batch_scope(p_batch));
  v_data := tab.current_batch_data(p_batch, p_key);
  if v_data.id is null or v_data.version is distinct from p_version or not (v_data.fields ? 'mrp') then
    raise exception using errcode = 'P0001', message = 'Only the current batch data version with an MRP is checked (IN-31). [EBMR-EXE-296]';
  end if;
  if v_data.recorded_by_person = (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'The MRP is checked by a second person, not the one who gave it (IN-31). [EBMR-EXE-296]';
  end if;
  insert into tab.packaging_batch_data_check (data_id, checked_by_person, checked_by_account) values (v_data.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

-- PR-36, PR-35, L-29 (header): releases a print job for printer p_device (the step configuration's id) of G-21 step
-- p_key of batch p_batch, with layout p_layout; its fields are the record's. Returns the job.
create function tab.release_print_job(p_batch uuid, p_key text, p_device text, p_layout text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, kernel, plant, pg_temp as $$
declare
  v_actor  jsonb;
  v_step   jsonb;
  v_cfg    jsonb;
  v_dev    jsonb;
  v_pd     tab.print_device;
  v_data   tab.packaging_batch_data;
  v_market text;
  v_codes  jsonb;
  v_pool   text;
  v_occ    plant.area_occupancy;
  v_fields jsonb;
  v_id     text := gen_random_uuid()::text;
  b        recipe.batch_execution;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_step := tab.g21_open_step(p_batch, p_key);
  v_cfg := v_step -> 'cfg';
  v_dev := recipe.g21_cfg_member(v_cfg, 'devices', to_jsonb(p_device));
  if v_dev is null or v_dev ->> 'kind' is distinct from 'PRINTER' or jsonb_typeof(v_dev -> 'serial') is distinct from 'string' then
    raise exception using errcode = 'P0001', message = format('%s is no printer of the step with a gateway serial (PR-36). [EBMR-EXE-296]', left(coalesce(p_device, 'NULL'), 64));
  end if;
  select * into v_pd from tab.print_device d where d.serial = v_dev ->> 'serial' and d.kind = 'PRINTER' and d.ended_at is null;
  if v_pd.id is null then
    raise exception using errcode = 'P0001', message = format('Printer %s has no active gateway binding (DI-20). [EBMR-EXE-296]', v_dev ->> 'serial');
  end if;
  if coalesce(p_layout, '') !~ '^[ -~]{1,64}$' then
    raise exception using errcode = 'P0001', message = 'A print job names its layout (PR-36). [EBMR-EXE-296]';
  end if;
  if jsonb_typeof(v_cfg -> 'unit') is distinct from 'string' then
    raise exception using errcode = 'P0001', message = 'The step names no plant unit of the line, so a batch-data change could hold nothing (L-29). [EBMR-EXE-296]';
  end if;
  v_data := tab.current_batch_data(p_batch, p_key);
  if v_data.id is null then
    raise exception using errcode = 'P0001', message = 'The step has no batch data: a print job carries only the record''s data (PR-36). [EBMR-EXE-296]';
  end if;
  -- Review 4a MEDIUM 6: an MRP a person gave is checked by a second person before any job carries it, and the person who
  -- gave it does not release the job.
  if v_data.fields ? 'mrp' then
    if not exists (select 1 from tab.packaging_batch_data_check c where c.data_id = v_data.id) then
      raise exception using errcode = 'P0001', message = format('The MRP of batch data version %s is not checked by a second person yet (IN-31). [EBMR-EXE-296]', v_data.version);
    end if;
    if v_data.recorded_by_person = (v_actor ->> 'person_id')::uuid then
      raise exception using errcode = 'P0001', message = 'The person who gave the MRP does not release the print job that carries it (IN-31). [EBMR-EXE-296]';
    end if;
  end if;
  select * into b from recipe.batch_execution where id = p_batch;
  -- L-29, PR-35: the line runs this packaging order now, cleared for it and its artwork set.
  select o.* into v_occ from plant.area_occupancy_status o join plant.area a on a.id = o.area_id
   where o.batch_id = p_batch and a.kind = 'LINE' and o.ended_at is null and o.packaging_order = b.batch_number
   order by o.started_at desc limit 1;
  if v_occ.id is null then
    raise exception using errcode = 'P0001',
      message = format('No line runs packaging order %s now: a print job is bound to the order and artwork set the line was cleared and started for (L-29, PR-35). [EBMR-EXE-296]', b.batch_number);
  end if;
  v_market := tab.g21_job_market(v_cfg, v_step -> 'header');
  v_codes := v_cfg -> 'markets' -> v_market;
  if (v_cfg -> 'serialisation' -> 'markets') ? v_market then
    v_pool := tab.g21_job_pool(p_batch, p_key, v_market);
    if v_pool is null then
      raise exception using errcode = 'P0001', message = format('%s is serialised and the step has no serial pool for it yet (PR-42). [EBMR-EXE-296]', v_market);
    end if;
  end if;
  v_fields := v_data.fields || jsonb_strip_nulls(jsonb_build_object('gtin', v_codes -> 'gtin', 'ndc', v_codes -> 'ndc', 'serialPoolId', v_pool));
  insert into tab.print_job (id, batch_id, step_key, step, config_device, print_device_id, device_serial, gateway_key_id, packaging_order, artwork_set, occupancy_id,
                             fields, layout_ref, data_version, released_by_person, released_by_account, correlation_id)
  values (v_id, p_batch, p_key, v_step -> 'inst' ->> 'step', p_device, v_pd.id, v_pd.serial, v_pd.gateway_key_id, b.batch_number, v_occ.artwork_set, v_occ.id,
          v_fields, p_layout, v_data.version, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('id', v_id, 'deviceSerial', v_pd.serial, 'packagingOrder', b.batch_number, 'artworkSet', v_occ.artwork_set, 'fields', v_fields, 'layoutRef', p_layout);
end
$$;

-- The state of job p_id: VOIDED, LOADED, REFUSED, MISMATCH, FAILED or RELEASED.
create function tab.print_job_state(p_id text) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select case when exists (select 1 from tab.print_job_void v where v.job_id = p_id) then 'VOIDED'
              else coalesce((select a.result from tab.print_job_ack a where a.job_id = p_id), 'RELEASED') end
$$;

-- ---------------------------------------------------------------------------------------------
-- The gateway's side (INTEGRATION commands, SITE_GATEWAY, INTERFACE.WRITE)

-- The jobs released for this gateway's printers, not yet acknowledged nor voided (integration-sdk PrintJobsResponse).
create function tab.pending_print_jobs() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_key tab.gateway_key%rowtype;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  return jsonb_build_object('jobs', (
    select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'deviceSerial', j.device_serial, 'packagingOrder', j.packaging_order, 'artworkSet', j.artwork_set,
                                                 'fields', j.fields, 'layoutRef', j.layout_ref) order by j.released_at, j.id), '[]'::jsonb)
      from tab.print_job j join tab.print_device d on d.id = j.print_device_id
     where j.gateway_key_id = v_key.id and d.ended_at is null and tab.print_job_state(j.id) = 'RELEASED'));
end
$$;

-- IN-31, PR-36, PR-42 (header): the gateway's acknowledgement p_ack (integration-sdk PrintJobAckRequest) of job p_id.
create function tab.ack_print_job(p_id text, p_ack jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, recipe, plant, pg_temp as $$
declare
  v_actor  jsonb;
  v_key    tab.gateway_key%rowtype;
  j        tab.print_job;
  v_old    tab.print_job_ack;
  v_out    text := p_ack ->> 'outcome';
  v_echo   jsonb := case when jsonb_typeof(p_ack -> 'echoedFields') = 'object' then p_ack -> 'echoedFields' end;
  v_msg    text := case when jsonb_typeof(p_ack -> 'message') = 'string' then p_ack ->> 'message' end;
  v_result text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  select * into j from tab.print_job where id = p_id and gateway_key_id = v_key.id;
  if j.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-141 DI-31: %s is no print job of gateway %s', left(coalesce(p_id, 'NULL'), 64), v_key.gateway_code);
  end if;
  if jsonb_typeof(p_ack) is distinct from 'object' or v_out is null or v_out not in ('LOADED', 'MISMATCH', 'FAILED')
     or (p_ack ->> 'sourceTime') !~ '^(0|[1-9][0-9]{0,17})$' or (p_ack ->> 'sessionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (v_out <> 'FAILED' and v_echo is null) or ((v_out = 'LOADED') <> (v_msg is null))
     or exists (select 1 from jsonb_object_keys(p_ack) k where k not in ('sessionId', 'outcome', 'echoedFields', 'sourceTime', 'message')) then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-142 DI-31: the print job acknowledgement is not in the expected form';
  end if;
  perform 1 from tab.print_job where id = j.id for update;
  select * into v_old from tab.print_job_ack where job_id = j.id;
  if v_old.job_id is not null then
    if (v_old.outcome, v_old.echoed_fields, v_old.source_time_us, v_old.message) is distinct from (v_out, v_echo, (p_ack ->> 'sourceTime')::bigint, v_msg) then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-143 DI-31: print job %s was acknowledged already, otherwise', j.id);
    end if;
    return jsonb_build_object('jobId', j.id, 'state', tab.print_job_state(j.id), 'duplicate', true);
  end if;
  v_result := case when v_out = 'LOADED' and v_echo = j.fields then 'LOADED' when v_out = 'LOADED' then 'REFUSED' else v_out end;
  insert into tab.print_job_ack (job_id, outcome, echoed_fields, source_time_us, message, result, session_id)
  values (j.id, v_out, v_echo, (p_ack ->> 'sourceTime')::bigint, v_msg, v_result, (v_actor ->> 'session_id')::uuid);
  -- Review 4a MEDIUM 4 (L-29): a job voided before the printer loaded it holds the output on the line all the same; the
  -- answer's state VOIDED tells the gateway to clear the printer.
  if v_out = 'LOADED' and exists (select 1 from tab.print_job_void v where v.job_id = j.id) then
    perform plant.ipc_check_record(j.batch_id, recipe.g21_cfg(recipe.step_node(recipe.batch_mbr_content(j.batch_id), j.step)) ->> 'unit', null, 'FAIL',
                                   format('L-29: voided print job %s loaded by the printer', j.id), v_actor, false);
  end if;
  perform kernel.audit_business_event('batch:' || j.batch_id,
    format('Print job %s on %s: %s%s', j.id, j.device_serial, v_result,
           case when v_result = 'REFUSED' then ' (the printer''s echo differs from the record''s data: the load is refused)' else '' end),
    jsonb_build_object('job_id', j.id, 'outcome', v_out, 'result', v_result));
  return jsonb_build_object('jobId', j.id, 'state', tab.print_job_state(j.id), 'duplicate', false);
end
$$;

create table tab.print_event (
  id                uuid primary key default gen_random_uuid(),
  print_device_id   uuid not null references tab.print_device (id),
  gateway_key_id    uuid not null references tab.gateway_key (id),
  serial            text not null,
  job_id            text references tab.print_job (id),
  kind              text not null check (kind in ('PRINTED_COUNT', 'READER_RESULT', 'VISION_RESULT', 'CHALLENGE_RESULT', 'FAULT')),
  value             text not null,
  source_time_us    bigint not null check (source_time_us >= 0),
  seq               bigint not null check (seq >= 1),
  gateway_run_id    uuid not null,
  received_at       timestamptz not null default clock_timestamp(),
  ingest_session_id uuid not null,
  correlation_id    uuid not null,
  unique (gateway_key_id, serial, seq),
  check ((job_id is null) = false or kind = 'FAULT'),
  check (case kind when 'PRINTED_COUNT' then value ~ '^(0|[1-9][0-9]{0,17})$' when 'FAULT' then value ~ '^[A-Z][A-Z0-9_]{1,47}$' else value in ('PASS', 'FAIL') end)
);
revoke all on tab.print_event from public;
create trigger aa_print_event_insert_only before update or delete on tab.print_event for each row execute function kernel.reject_mutation();
create trigger aa_print_event_no_truncate before truncate on tab.print_event for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.print_event', 'print_event', 'id', true);

create table tab.print_event_use (
  event_id    uuid primary key references tab.print_event (id),
  batch_id    uuid not null,
  command_id  text not null,
  used_at     timestamptz not null default clock_timestamp()
);
revoke all on tab.print_event_use from public;
create trigger aa_print_event_use_insert_only before update or delete on tab.print_event_use for each row execute function kernel.reject_mutation();

-- DI-31 (header): a print-events request (integration-sdk PrintEventsRequest), taken whole or refused whole.
create function tab.ingest_print_events(p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  v_key   tab.gateway_key%rowtype;
  v_dev   tab.print_device%rowtype;
  v_old   tab.print_event%rowtype;
  v_run   uuid;
  r       jsonb;
  n       bigint;
  v_seq   bigint;
  v_head  bigint;
  v_id    uuid;
  v_job   text;
  v_out   jsonb := '[]'::jsonb;
  v_where text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  if jsonb_typeof(p_body) is distinct from 'object' or (p_body ->> 'sessionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(p_body -> 'events') is distinct from 'array' or jsonb_array_length(p_body -> 'events') not between 1 and 200
     or exists (select 1 from jsonb_object_keys(p_body) k where k not in ('sessionId', 'events')) then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-144 DI-31: the print events are not in the expected form (sessionId and 1 to 200 events)';
  end if;
  v_run := (p_body ->> 'sessionId')::uuid;
  perform 1 from tab.gateway_key where id = v_key.id for update;
  for r, n in select x.v, x.i from jsonb_array_elements(p_body -> 'events') with ordinality x (v, i) order by x.i loop
    v_where := format('event %s', n - 1);
    if jsonb_typeof(r) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(r) k where k not in ('deviceSerial', 'jobId', 'kind', 'value', 'sourceTime', 'sequence'))
       or jsonb_typeof(r -> 'deviceSerial') is distinct from 'string' or jsonb_typeof(r -> 'value') is distinct from 'string'
       or (r ->> 'kind') is null or (r ->> 'kind') not in ('PRINTED_COUNT', 'READER_RESULT', 'VISION_RESULT', 'CHALLENGE_RESULT', 'FAULT')
       or (jsonb_typeof(r -> 'jobId') is distinct from 'string' and (r -> 'jobId') is distinct from 'null'::jsonb)
       or ((r -> 'jobId') = 'null'::jsonb and r ->> 'kind' <> 'FAULT')
       or (r ->> 'kind' = 'PRINTED_COUNT' and (r ->> 'value') !~ '^(0|[1-9][0-9]{0,17})$')
       or (r ->> 'kind' = 'FAULT' and (r ->> 'value') !~ '^[A-Z][A-Z0-9_]{1,47}$')
       or (r ->> 'kind' in ('READER_RESULT', 'VISION_RESULT', 'CHALLENGE_RESULT') and (r ->> 'value') not in ('PASS', 'FAIL'))
       or (r ->> 'sourceTime') !~ '^(0|[1-9][0-9]{0,17})$' or (r ->> 'sequence') !~ '^[1-9][0-9]{0,17}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-144 DI-31: %s is not a print event in the expected form', v_where);
    end if;
    v_seq := (r ->> 'sequence')::bigint;
    v_job := case when jsonb_typeof(r -> 'jobId') = 'string' then r ->> 'jobId' end;
    select * into v_dev from tab.print_device where gateway_key_id = v_key.id and serial = r ->> 'deviceSerial' and ended_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-145 DI-20: %s names serial %s, which is no print device of gateway %s', v_where, left(r ->> 'deviceSerial', 32), v_key.gateway_code);
    end if;
    -- Review 4a LOW 7: the job is the named device's (a printer's reader and vision results come under its serial).
    if v_job is not null and not exists (select 1 from tab.print_job j where j.id = v_job and j.gateway_key_id = v_key.id and j.print_device_id = v_dev.id) then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-146 DI-31: %s names job %s, which is no print job of device %s', v_where, left(v_job, 64), v_dev.serial);
    end if;
    select * into v_old from tab.print_event where gateway_key_id = v_key.id and serial = v_dev.serial and seq = v_seq;
    if found then
      if (v_old.job_id, v_old.kind, v_old.value, v_old.source_time_us, v_old.gateway_run_id) is distinct from (v_job, r ->> 'kind', r ->> 'value', (r ->> 'sourceTime')::bigint, v_run) then
        raise exception using errcode = 'P0001', message = format('EBMR-DEV-147 DI-31: sequence %s of %s was already received with other content', v_seq, v_dev.serial);
      end if;
      v_out := v_out || jsonb_build_object('deviceSerial', v_dev.serial, 'sequence', v_seq::text, 'outcome', 'DUPLICATE', 'eventId', v_old.id);
      continue;
    end if;
    select coalesce(max(seq), 0) into v_head from tab.print_event where gateway_key_id = v_key.id and serial = v_dev.serial;
    if v_seq <> v_head + 1 then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-148 DI-31: sequence break for %s: the server holds up to %s, the event is %s', v_dev.serial, v_head, v_seq);
    end if;
    insert into tab.print_event (print_device_id, gateway_key_id, serial, job_id, kind, value, source_time_us, seq, gateway_run_id, ingest_session_id, correlation_id)
    values (v_dev.id, v_key.id, v_dev.serial, v_job, r ->> 'kind', r ->> 'value', (r ->> 'sourceTime')::bigint, v_seq, v_run,
            (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
    v_out := v_out || jsonb_build_object('deviceSerial', v_dev.serial, 'sequence', v_seq::text, 'outcome', 'INGESTED', 'eventId', v_id);
  end loop;
  perform kernel.audit_business_event('gateway_key:' || v_key.id, format('Print events from gateway %s: %s received', v_key.gateway_code, jsonb_array_length(v_out)),
                                      jsonb_build_object('gateway_run_id', v_run, 'events', v_out));
  return jsonb_build_object('events', v_out);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Entries (header)

-- The units the printers of G-21 step p_step of batch p_batch printed: for each of the step's jobs its last cumulative
-- PRINTED_COUNT, summed.
create function tab.g21_printed(p_batch uuid, p_step text) returns numeric
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(sum(c), 0) from (
    select (select e.value::numeric from tab.print_event e where e.job_id = j.id and e.kind = 'PRINTED_COUNT' order by e.seq desc limit 1) c
      from tab.print_job j where j.batch_id = p_batch and j.step = p_step) x
$$;

-- Review 4a MEDIUM 5: a reconciliation of a coded item at a step whose printer reports through the gateway counts, as used,
-- set-up waste and coded destroyed, exactly what the printers printed (PR-39, IN-17).
create function tab.g21_printed_count_problem(p_row recipe.execution_command, p_node jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry  jsonb := p_row.command -> 'entry';
  v_cfg    jsonb := recipe.g21_cfg(p_node);
  v_item   jsonb := recipe.g21_cfg_member(v_cfg, 'items', v_entry -> 'item');
  v_coded  numeric;
  v_print  numeric;
begin
  if v_item is null or (v_item -> 'coded') is distinct from 'true'::jsonb
     or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_cfg -> 'devices') = 'array' then v_cfg -> 'devices' else '[]'::jsonb end) d
                     where d ->> 'kind' = 'PRINTER' and jsonb_typeof(d -> 'serial') = 'string') then
    return null;
  end if;
  v_coded := coalesce(recipe.g21_dec(v_entry -> 'used'), 0) + coalesce(recipe.g21_dec(v_entry -> 'setupWaste'), 0) + coalesce(recipe.g21_dec(v_entry -> 'codedDestroyed'), 0);
  v_print := tab.g21_printed(p_row.batch_id, p_row.command ->> 'step');
  if v_coded <> v_print then
    return format('it counts %s coded units of %s (used, set-up waste, coded destroyed), where the step''s printers printed %s', v_coded, v_item ->> 'id', v_print);
  end if;
  return null;
end
$$;

create function tab.g21_print_entry_problem(p_row recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry jsonb := p_row.command -> 'entry';
  v_node  jsonb := tab.g21_command_node(p_row.batch_id, p_row.command);
  v_dev   jsonb;
  j       tab.print_job;
  ev      tab.print_event;
begin
  if v_node is not null and v_entry ->> 'kind' = 'RECONCILIATION' then
    return tab.g21_printed_count_problem(p_row, v_node);
  end if;
  if v_node is null or v_entry ->> 'kind' not in ('FIRST_PRINT', 'CHALLENGE') then
    return null;
  end if;
  v_dev := recipe.g21_cfg_member(recipe.g21_cfg(v_node), 'devices', v_entry -> 'device');
  if v_entry ->> 'kind' = 'FIRST_PRINT' then
    select * into j from tab.print_job where id = v_entry ->> 'job';
    if j.id is null or j.batch_id <> p_row.batch_id or j.step <> (p_row.command ->> 'step') or j.config_device is distinct from (v_entry ->> 'device') then
      return format('job %s is no print job of this step''s printer %s', left(coalesce(v_entry ->> 'job', '(none)'), 64), coalesce(v_entry ->> 'device', '(none)'));
    end if;
    if tab.print_job_state(j.id) <> 'LOADED' then
      return format('job %s is %s: a first print is approved only on a job the printer loaded with the record''s data', j.id, tab.print_job_state(j.id));
    end if;
    if j.released_by_person = p_row.actor_person then
      return format('job %s was released by the person who approves its first print', j.id);
    end if;
    return null;
  end if;
  if jsonb_typeof(v_dev -> 'serial') is distinct from 'string' then
    return null;
  end if;
  select * into ev from tab.print_event where id::text = v_entry ->> 'event';
  if ev.id is null or ev.kind <> 'CHALLENGE_RESULT' or ev.serial <> (v_dev ->> 'serial') then
    return format('event %s is no challenge result of device %s', left(coalesce(v_entry ->> 'event', '(none)'), 64), v_dev ->> 'serial');
  end if;
  if not exists (select 1 from tab.print_job x where x.id = ev.job_id and x.batch_id = p_row.batch_id and x.step = (p_row.command ->> 'step')) then
    return format('challenge result %s belongs to no print job of this step', ev.id);
  end if;
  if ev.value is distinct from (v_entry ->> 'result') then
    return format('challenge result %s is %s, not %s', ev.id, ev.value, coalesce(v_entry ->> 'result', '(none)'));
  end if;
  if exists (select 1 from tab.print_event_use u where u.event_id = ev.id) then
    return format('challenge result %s is recorded already', ev.id);
  end if;
  -- Review 4a HIGH 1: the challenge is timed by the device's result, and the device's results are recorded in their order:
  -- none is skipped (a FAIL dropped, a stale PASS reused).
  if (v_entry ->> 'at') is distinct from ev.source_time_us::text then
    return format('the challenge states the time %s, where result %s was taken at %s', coalesce(v_entry ->> 'at', '(none)'), ev.id, ev.source_time_us);
  end if;
  if exists (select 1 from tab.print_event o join tab.print_job x on x.id = o.job_id
              where o.gateway_key_id = ev.gateway_key_id and o.serial = ev.serial and o.kind = 'CHALLENGE_RESULT' and o.seq < ev.seq
                and x.batch_id = p_row.batch_id and x.step = (p_row.command ->> 'step')
                and not exists (select 1 from tab.print_event_use u where u.event_id = o.id)) then
    return format('an earlier challenge result of %s on this step is not recorded yet: results are recorded in the device''s order', ev.serial);
  end if;
  return null;
end
$$;

create function tab.g21_print_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.g21_print_entry_problem(new);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s entry of this RECORD_ENTRY row is refused: %s; a first print, a gateway device''s challenge and a printed item''s count stand on the server''s jobs and the gateway''s results (PR-36, PR-39, IN-22, DI-31). [EBMR-EXE-296]',
                       new.command -> 'entry' ->> 'kind', v_problem);
  end if;
  if new.accepted and new.command -> 'entry' ->> 'kind' = 'CHALLENGE' and jsonb_typeof(new.command -> 'entry' -> 'event') = 'string' and tab.g21_command_node(new.batch_id, new.command) is not null then
    insert into tab.print_event_use (event_id, batch_id, command_id) values ((new.command -> 'entry' ->> 'event')::uuid, new.batch_id, new.command_id);
  end if;
  return new;
end
$$;

create trigger ae_tab_g21_print_entries before insert on recipe.execution_command for each row execute function tab.g21_print_entry_check();

-- Review 4a HIGH 1: a G-21 step that row p_new closes has no failed challenge result of its devices on its jobs left
-- unrecorded (a FAIL becomes an entry, with its exception and its hold).
create function tab.g21_unrecorded_fail_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k text;
  s jsonb;
  v_content jsonb;
  ev tab.print_event;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(new.state -> 'steps') = 'object' then new.state -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and old.state -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_content := coalesce(v_content, recipe.batch_mbr_content(new.batch_id));
    continue when recipe.step_node(v_content, s ->> 'step') -> 'block' ->> 'type' is distinct from 'G-21';
    select e.* into ev from tab.print_event e join tab.print_job j on j.id = e.job_id
     where j.batch_id = new.batch_id and j.step = s ->> 'step' and e.kind = 'CHALLENGE_RESULT' and e.value = 'FAIL'
       and not exists (select 1 from tab.print_event_use u where u.event_id = e.id)
     order by e.seq limit 1;
    if ev.id is not null then
      raise exception using errcode = 'P0001',
        message = format('This row closes step %s, but the failed challenge result %s of %s is not recorded: a failed challenge stops the step and holds the output (IN-22, PR-37). [EBMR-EXE-296]', k, ev.id, ev.serial);
    end if;
  end loop;
  return null;
end
$$;

create trigger zu_tab_g21_unrecorded_fail after update on recipe.execution_state for each row execute function tab.g21_unrecorded_fail_check();

revoke all on function tab.print_device_guard(), tab.bind_print_device(uuid, text, text, text), tab.end_print_device(uuid, text, text), tab.g21_open_step(uuid, text),
  tab.g21_job_market(jsonb, jsonb), tab.current_batch_data(uuid, text), tab.g21_job_pool(uuid, text, text), tab.record_packaging_batch_data(uuid, text, text, text),
  tab.release_print_job(uuid, text, text, text), tab.print_job_state(text), tab.pending_print_jobs(), tab.ack_print_job(text, jsonb), tab.ingest_print_events(jsonb),
  tab.g21_print_entry_problem(recipe.execution_command), tab.g21_print_entry_check(), tab.check_packaging_batch_data(uuid, text, integer), tab.g21_printed(uuid, text),
  tab.g21_printed_count_problem(recipe.execution_command, jsonb), tab.g21_unrecorded_fail_check() from public;
grant execute on function tab.bind_print_device(uuid, text, text, text), tab.end_print_device(uuid, text, text), tab.record_packaging_batch_data(uuid, text, text, text),
  tab.check_packaging_batch_data(uuid, text, integer),
  tab.release_print_job(uuid, text, text, text), tab.print_job_state(text), tab.pending_print_jobs(), tab.ack_print_job(text, jsonb), tab.ingest_print_events(jsonb) to ebmr_app;
grant select on tab.print_device, tab.packaging_batch_data, tab.packaging_batch_data_check, tab.print_job, tab.print_job_ack, tab.print_job_void, tab.print_event, tab.print_event_use to ebmr_app;

reset role;
