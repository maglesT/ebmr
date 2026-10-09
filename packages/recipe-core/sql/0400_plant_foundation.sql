-- Plant master data and plant records, part 1: the plant schema, its tables and the guards of the plant machines
-- (Phase 3 slice 1, plan item 2; build outline 5.2.8; decision D-S1-3: plant data lives in recipe-core because both
-- editions need it).
--
-- Controls: INV-12 (PROCESS occupancy never overlaps: a chain of uses per unit and an exclusion constraint on the
-- closed intervals), IN-25 (b)(c)(d), PR-23 (use guard, sql/0403), INV-15, IN-21, PR-26, PR-34, PR-35 (clearances before
-- a start, sql/0404), IN-26 (a)(b)(c), PR-25, PR-27 (campaign limits, room eligibility), IN-25 (a), PR-24 (logbook view,
-- sql/0405).
--
--   product            products as the plant sees them (highly potent flag, IN-26 (c))
--   equipment_class    PROCESS / INSTRUMENT / UTILITY (L-27), clean-hold and dirty-hold durations, calibration and
--                      check regime
--   area               rooms and lines; segregated (with a recorded risk justification), negative pressure cascade
--   equipment          code (unique; containers of sql/0420 refer to it by code), class, kind, room
--   equipment_event    qualification, maintenance, out of service, failure signalled, repaired, retired
--   calibration        calibration records (due instant, as-found and as-left results)
--   instrument_check   per-use and daily checks of instruments
--   instrument_use     uses of instruments (no occupancy: one instrument serves two presses)
--   utility_reading    status rows of the external feed of a utility
--   campaign (+ _closure)              same-product campaigns on PROCESS equipment or rooms (max batches, max days,
--                                      validation reference)
--   cleaning (+ _completion, _verification, _abandonment)
--                                      cleanings of equipment and areas (level MINOR / MAJOR; MANUAL: performer and a
--                                      different verifier; validated CIP: one verifier)
--   equipment_use (+ _end)             PROCESS equipment occupancy by a batch
--   clearance (+ _verification)        clearances of rooms and lines (type, previous product / batch / order, performer,
--                                      verifier)
--   area_occupancy (+ _end)            a batch stage in a room, a packaging order on a line
--   *_status views                     each record with its later acts, as the commands and screens read it
--
-- Every table is insert-only: a later act (completion, verification, end) is a row of its own, so no recorded value
-- is ever changed and no update needs a reason (outline 5.4). Privileges: ebmr_app reads; every write is a SECURITY
-- DEFINER function of sql/0403-0404 that refuses administrators and checks a permission. The tables are audited;
-- event times come from the database clock.
--
-- Messages: plain language, then the control and EBMR-PLANT-NNN:
--   001-019 master data   020-039 equipment fitness and events   040-059 cleaning   060-079 equipment use
--   080-099 campaigns     100-119 clearances                     120-139 area occupancy

create schema if not exists plant authorization ebmr_owner;
revoke all on schema plant from public;
grant usage on schema plant to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function plant.actor_person() returns uuid
language sql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select (recipe.require_actor() ->> 'person_id')::uuid
$$;

create function plant.actor_account() returns uuid
language sql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select (recipe.require_actor() ->> 'account_id')::uuid
$$;

create function plant.is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(btrim(p), '') = ''
$$;

-- ---------------------------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------------------------

create table plant.product (
  code           text primary key check (code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  name           text not null check (btrim(name) <> ''),
  highly_potent  boolean not null,
  recorded_by    uuid not null,
  recorded_at    timestamptz not null default clock_timestamp()
);

create table plant.equipment_class (
  code                  text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  kind                  text not null check (kind in ('PROCESS', 'INSTRUMENT', 'UTILITY')),
  description           text not null check (btrim(description) <> ''),
  clean_hold            interval,
  dirty_hold            interval,
  calibration_required  boolean not null,
  check_regime          text check (check_regime in ('PER_USE', 'DAILY')),
  recorded_by           uuid not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  unique (code, kind),
  -- PROCESS: both hold clocks; INSTRUMENT: calibration and a check regime, no cleanliness; UTILITY: neither.
  check (case kind
           when 'PROCESS' then clean_hold > interval '0' and dirty_hold > interval '0' and check_regime is null
           when 'INSTRUMENT' then clean_hold is null and dirty_hold is null and calibration_required and check_regime is not null
           else clean_hold is null and dirty_hold is null and check_regime is null and not calibration_required
         end)
);

create table plant.area (
  id                          uuid primary key default gen_random_uuid(),
  code                        text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  kind                        text not null check (kind in ('ROOM', 'LINE')),
  name                        text not null check (btrim(name) <> ''),
  segregated                  boolean not null,
  segregation_justification   text,
  negative_pressure           boolean not null,
  recorded_by                 uuid not null,
  recorded_at                 timestamptz not null default clock_timestamp(),
  -- IN-26 (b): a room that may hold two products at once states its risk justification. A line runs one packaging
  -- order at a time (PR-35), so a line is never segregated for that purpose.
  check (not segregated or (kind = 'ROOM' and btrim(coalesce(segregation_justification, '')) <> '')),
  check (segregated or segregation_justification is null)
);

create table plant.equipment (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  name         text not null check (btrim(name) <> ''),
  class_code   text not null,
  kind         text not null,
  area_id      uuid references plant.area (id),
  recorded_by  uuid not null,
  recorded_at  timestamptz not null default clock_timestamp(),
  foreign key (class_code, kind) references plant.equipment_class (code, kind)
);

-- ---------------------------------------------------------------------------------------------
-- Fitness records
-- ---------------------------------------------------------------------------------------------

create table plant.equipment_event (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references plant.equipment (id),
  kind          text not null check (kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN', 'MAINTENANCE_STARTED', 'MAINTENANCE_ENDED',
                                              'TAKEN_OUT_OF_SERVICE', 'RETURNED_TO_SERVICE', 'FAILURE_SIGNALLED', 'REPAIRED', 'RETIRED')),
  reference     text,
  batch_ref     text,
  detail        text not null check (btrim(detail) <> ''),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  check (kind not in ('QUALIFIED', 'REPAIRED') or btrim(coalesce(reference, '')) <> '')
);
create index equipment_event_by_equipment on plant.equipment_event (equipment_id, kind, recorded_at);

create table plant.calibration (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references plant.equipment (id),
  due_at        timestamptz not null,
  as_found      text not null check (as_found in ('PASS', 'FAIL')),
  as_left       text not null check (as_left in ('PASS', 'FAIL')),
  reference     text not null check (btrim(reference) <> ''),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  check (due_at > recorded_at)
);
create index calibration_by_equipment on plant.calibration (equipment_id, recorded_at);

create table plant.instrument_check (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references plant.equipment (id),
  regime        text not null check (regime in ('PER_USE', 'DAILY')),
  result        text not null check (result in ('PASS', 'FAIL')),
  batch_ref     text,
  reference     text not null check (btrim(reference) <> ''),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  check (regime = 'DAILY' or btrim(coalesce(batch_ref, '')) <> '')
);
create index instrument_check_by_equipment on plant.instrument_check (equipment_id, recorded_at);

create table plant.instrument_use (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references plant.equipment (id),
  batch_ref     text not null check (btrim(batch_ref) <> ''),
  product_code  text not null references plant.product (code),
  regime        text not null check (regime in ('PER_USE', 'DAILY')),
  check_id      uuid not null references plant.instrument_check (id),
  planned_end   timestamptz not null,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);
-- A per-use check serves one use; a daily check serves every use of its site day (sql/0403).
create unique index instrument_use_per_use_check_once on plant.instrument_use (check_id) where regime = 'PER_USE';
create index instrument_use_by_equipment on plant.instrument_use (equipment_id, recorded_at);

create table plant.utility_reading (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references plant.equipment (id),
  status        text not null check (status in ('OK', 'ALARM', 'FAULT', 'OFFLINE')),
  source        text not null check (btrim(source) <> ''),
  observed_at   timestamptz not null,
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp()
);
create index utility_reading_by_equipment on plant.utility_reading (equipment_id, recorded_at);

-- ---------------------------------------------------------------------------------------------
-- Campaigns, cleanings, uses, clearances, occupancies
-- ---------------------------------------------------------------------------------------------

create table plant.campaign (
  id              uuid primary key default gen_random_uuid(),
  equipment_id    uuid references plant.equipment (id),
  area_id         uuid references plant.area (id),
  product_code    text not null references plant.product (code),
  max_batches     integer not null check (max_batches between 1 and 1000),
  max_days        integer not null check (max_days between 1 and 366),
  validation_ref  text not null check (btrim(validation_ref) <> ''),
  opened_by       uuid not null,
  opened_at       timestamptz not null default clock_timestamp(),
  check ((equipment_id is null) <> (area_id is null))
);

create table plant.campaign_closure (
  campaign_id  uuid primary key references plant.campaign (id),
  reason       text not null check (btrim(reason) <> ''),
  closed_by    uuid not null,
  closed_at    timestamptz not null default clock_timestamp()
);

-- Cleanings are recorded as insert-only acts (start, completion, verification, abandonment): every row is a first
-- entry, so no recorded value is ever changed (outline 5.4) and no reason has to be invented for an update.
create table plant.cleaning (
  id                   uuid primary key default gen_random_uuid(),
  equipment_id         uuid references plant.equipment (id),
  area_id              uuid references plant.area (id),
  level                text not null check (level in ('MINOR', 'MAJOR')),
  method               text not null check (method in ('MANUAL', 'CIP')),
  dirty_hold_exceeded  boolean not null,
  started_by           uuid not null,
  started_at           timestamptz not null default clock_timestamp(),
  check ((equipment_id is null) <> (area_id is null)),
  check (method = 'MANUAL' or equipment_id is not null)
);
create index cleaning_by_equipment on plant.cleaning (equipment_id, started_at) where equipment_id is not null;
create index cleaning_by_area on plant.cleaning (area_id, started_at) where area_id is not null;

create table plant.cleaning_completion (
  cleaning_id      uuid primary key references plant.cleaning (id),
  completed_by     uuid not null,
  cycle_reference  text,
  completed_at     timestamptz not null default clock_timestamp()
);

create table plant.cleaning_verification (
  cleaning_id   uuid primary key references plant.cleaning_completion (cleaning_id),
  verified_by   uuid not null,
  signature_id  uuid not null unique,
  verified_at   timestamptz not null default clock_timestamp()
);

create table plant.cleaning_abandonment (
  cleaning_id   uuid primary key references plant.cleaning (id),
  reason        text not null check (btrim(reason) <> ''),
  abandoned_by  uuid not null,
  abandoned_at  timestamptz not null default clock_timestamp()
);

-- PROCESS equipment occupancy (INV-12). The uses of a unit form one chain: each use names the use before it (NULL for
-- the first), no two uses name the same predecessor (unique, NULLs not distinct), and the trigger below admits a use
-- only when its predecessor is the unit's latest use and has ended no later than the new start. Ended uses carry their
-- closed interval in equipment_use_end, where an exclusion constraint refuses any overlap.
create table plant.equipment_use (
  id                uuid primary key default gen_random_uuid(),
  equipment_id      uuid not null references plant.equipment (id),
  previous_use_id   uuid references plant.equipment_use (id),
  batch_ref         text not null check (btrim(batch_ref) <> ''),
  product_code      text not null references plant.product (code),
  planned_end       timestamptz not null,
  cleaning_id       uuid not null references plant.cleaning_verification (cleaning_id),
  campaign_id       uuid references plant.campaign (id),
  started_by        uuid not null,
  started_at        timestamptz not null default clock_timestamp(),
  check (planned_end > started_at),
  unique nulls not distinct (equipment_id, previous_use_id)
);

create table plant.equipment_use_end (
  use_id               uuid primary key references plant.equipment_use (id),
  equipment_id         uuid not null,
  started_at           timestamptz not null,
  ended_by             uuid not null,
  ended_at             timestamptz not null default clock_timestamp(),
  clean_hold_crossed   boolean not null,
  calibration_crossed  boolean not null,
  period               tstzrange generated always as (tstzrange(started_at, ended_at, '[)')) stored,
  check (ended_at >= started_at),
  -- INV-12: closed occupancies of one PROCESS unit never overlap (instrument uses are a separate table).
  constraint equipment_use_no_overlap exclude using gist (equipment_id with =, period with &&)
);

create table plant.clearance (
  id                      uuid primary key default gen_random_uuid(),
  area_id                 uuid not null references plant.area (id),
  clearance_type          text not null check (clearance_type in ('PRODUCT_CHANGE', 'CAMPAIGN', 'PACKAGING_ORDER')),
  previous_occupancy_id   uuid,
  previous_product        text,
  previous_batch          text,
  previous_order          text,
  previous_artwork_set    text,
  next_product            text not null references plant.product (code),
  next_batch              text not null check (btrim(next_batch) <> ''),
  next_order              text,
  next_artwork_set        text,
  performed_by            uuid not null,
  performed_account       uuid not null,
  performed_at            timestamptz not null default clock_timestamp(),
  -- L-29: a packaging-order clearance is keyed on the order and the artwork set.
  check ((clearance_type = 'PACKAGING_ORDER') = (next_order is not null)
         and (next_order is null or (btrim(next_order) <> '' and btrim(coalesce(next_artwork_set, '')) <> ''))
         and (next_order is not null or next_artwork_set is null))
);
create index clearance_by_area on plant.clearance (area_id, performed_at);

create table plant.clearance_verification (
  clearance_id  uuid primary key references plant.clearance (id),
  result        text not null check (result in ('PASSED', 'FAILED')),
  verified_by   uuid not null,
  signature_id  uuid not null unique,
  verified_at   timestamptz not null default clock_timestamp()
);

-- A batch stage in a room or a packaging order on a line. In an area that is not segregated the occupancies form one
-- chain like the equipment uses (exclusive = true): one open at a time, so one active packaging order per line
-- (PR-35). A segregated room may hold concurrent batches (exclusive = false, IN-26 (b)).
create table plant.area_occupancy (
  id                     uuid primary key default gen_random_uuid(),
  area_id                uuid not null references plant.area (id),
  exclusive              boolean not null,
  previous_occupancy_id  uuid references plant.area_occupancy (id),
  batch_ref              text not null check (btrim(batch_ref) <> ''),
  product_code           text not null references plant.product (code),
  stage                  text not null check (btrim(stage) <> ''),
  packaging_order        text,
  artwork_set            text,
  clearance_id           uuid not null unique references plant.clearance_verification (clearance_id),
  started_by             uuid not null,
  started_at             timestamptz not null default clock_timestamp(),
  check ((packaging_order is null) = (artwork_set is null))
);
create index area_occupancy_by_area on plant.area_occupancy (area_id, started_at);
create unique index area_occupancy_chain on plant.area_occupancy (area_id, previous_occupancy_id) nulls not distinct where exclusive;

create table plant.area_occupancy_end (
  occupancy_id  uuid primary key references plant.area_occupancy (id),
  ended_by      uuid not null,
  ended_at      timestamptz not null default clock_timestamp()
);

-- Current views of the acts above (what the commands, guards and screens read).
create view plant.cleaning_status as
  select c.*, k.completed_by, k.cycle_reference, k.completed_at, v.verified_by, v.signature_id, v.verified_at,
         x.abandoned_by, x.reason as abandon_reason, x.abandoned_at
  from plant.cleaning c
  left join plant.cleaning_completion k on k.cleaning_id = c.id
  left join plant.cleaning_verification v on v.cleaning_id = c.id
  left join plant.cleaning_abandonment x on x.cleaning_id = c.id;

create view plant.equipment_use_status as
  select u.*, e.ended_by, e.ended_at, e.clean_hold_crossed, e.calibration_crossed
  from plant.equipment_use u left join plant.equipment_use_end e on e.use_id = u.id;

create view plant.clearance_status as
  select c.*, v.result, v.verified_by, v.signature_id, v.verified_at
  from plant.clearance c left join plant.clearance_verification v on v.clearance_id = c.id;

create view plant.area_occupancy_status as
  select o.*, e.ended_by, e.ended_at
  from plant.area_occupancy o left join plant.area_occupancy_end e on e.occupancy_id = o.id;

create view plant.campaign_status as
  select c.*, x.closed_by, x.closed_at, x.reason as close_reason
  from plant.campaign c left join plant.campaign_closure x on x.campaign_id = c.id;

-- ---------------------------------------------------------------------------------------------
-- Row guards: the rules that hold whoever writes (owner-level code included)
-- ---------------------------------------------------------------------------------------------

-- S22: a manual cleaning is verified by someone who neither started nor performed it; an abandoned cleaning is never
-- verified and a verified one is never abandoned.
create function plant.cleaning_verification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.cleaning_status;
begin
  select * into c from plant.cleaning_status where id = new.cleaning_id;
  if c.abandoned_at is not null then
    raise exception using errcode = 'P0001', message = 'An abandoned cleaning is never verified (EBMR-PLANT-046)';
  end if;
  if c.method = 'MANUAL' and new.verified_by in (c.started_by, c.completed_by) then
    raise exception using errcode = 'P0001', message = 'A manual cleaning is verified by a person other than the one who performed it (S22; EBMR-PLANT-047)';
  end if;
  return new;
end
$$;
create trigger a1_guard before insert on plant.cleaning_verification for each row execute function plant.cleaning_verification_guard();

create function plant.cleaning_abandonment_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
begin
  if exists (select 1 from plant.cleaning_verification where cleaning_id = new.cleaning_id) then
    raise exception using errcode = 'P0001', message = 'A verified cleaning is never abandoned (EBMR-PLANT-049)';
  end if;
  return new;
end
$$;
create trigger a1_guard before insert on plant.cleaning_abandonment for each row execute function plant.cleaning_abandonment_guard();

-- S23, S24: a clearance is verified by a person other than its performer.
create function plant.clearance_verification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
begin
  if exists (select 1 from plant.clearance where id = new.clearance_id and performed_by = new.verified_by) then
    raise exception using errcode = 'P0001', message = 'A clearance is verified by a person other than the one who performed it (S23, S24; EBMR-PLANT-104)';
  end if;
  return new;
end
$$;
create trigger a1_guard before insert on plant.clearance_verification for each row execute function plant.clearance_verification_guard();

-- INV-12: a use of a unit follows its latest use, which has ended no later than the new start (runs after a0_db_time
-- has set started_at). The unit's row is locked so two starts serialise.
create function plant.equipment_use_chain_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_latest uuid;
  v_ended  timestamptz;
begin
  perform 1 from plant.equipment where id = new.equipment_id and kind = 'PROCESS' for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Only PROCESS equipment is occupied by a batch (L-27; EBMR-PLANT-062)';
  end if;
  select id into v_latest from plant.equipment_use where equipment_id = new.equipment_id order by started_at desc, id desc limit 1;
  if new.previous_use_id is distinct from v_latest then
    raise exception using errcode = 'P0001', message = 'A use follows the latest use of the unit (INV-12; EBMR-PLANT-064)';
  end if;
  if v_latest is not null then
    select ended_at into v_ended from plant.equipment_use_end where use_id = v_latest;
    if v_ended is null or v_ended > new.started_at then
      raise exception using errcode = 'P0001', message = 'The unit is occupied by an open use: PROCESS occupancy never overlaps (INV-12; EBMR-PLANT-064)';
    end if;
  end if;
  return new;
end
$$;
create trigger a1_chain before insert on plant.equipment_use for each row execute function plant.equipment_use_chain_guard();

create function plant.equipment_use_end_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  u plant.equipment_use;
begin
  select * into u from plant.equipment_use where id = new.use_id;
  new.equipment_id := u.equipment_id;
  new.started_at := u.started_at;
  return new;
end
$$;
create trigger a1_copy before insert on plant.equipment_use_end for each row execute function plant.equipment_use_end_guard();

create function plant.area_occupancy_chain_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_latest uuid;
  v_ended  timestamptz;
begin
  perform 1 from plant.area where id = new.area_id for update;
  if not new.exclusive and not (select segregated from plant.area where id = new.area_id) then
    raise exception using errcode = 'P0001', message = 'Only a segregated room holds concurrent batches (IN-26 (b); EBMR-PLANT-124)';
  end if;
  if new.exclusive then
    select id into v_latest from plant.area_occupancy where area_id = new.area_id order by started_at desc, id desc limit 1;
    if new.previous_occupancy_id is distinct from v_latest then
      raise exception using errcode = 'P0001', message = 'An occupancy follows the latest occupancy of the area (INV-15; EBMR-PLANT-130)';
    end if;
    if v_latest is not null then
      select ended_at into v_ended from plant.area_occupancy_end where occupancy_id = v_latest;
      if v_ended is null or v_ended > new.started_at then
        raise exception using errcode = 'P0001', message = 'The area is occupied by an open batch or order (PR-35, INV-15; EBMR-PLANT-130)';
      end if;
    end if;
  end if;
  return new;
end
$$;
create trigger a1_chain before insert on plant.area_occupancy for each row execute function plant.area_occupancy_chain_guard();

-- Database time for every event column.
select platform.enforce_db_time('plant.product', array['recorded_at']);
select platform.enforce_db_time('plant.equipment_class', array['recorded_at']);
select platform.enforce_db_time('plant.area', array['recorded_at']);
select platform.enforce_db_time('plant.equipment', array['recorded_at']);
select platform.enforce_db_time('plant.equipment_event', array['recorded_at']);
select platform.enforce_db_time('plant.calibration', array['recorded_at']);
select platform.enforce_db_time('plant.instrument_check', array['recorded_at']);
select platform.enforce_db_time('plant.instrument_use', array['recorded_at']);
select platform.enforce_db_time('plant.utility_reading', array['recorded_at']);
select platform.enforce_db_time('plant.campaign', array['opened_at']);
select platform.enforce_db_time('plant.campaign_closure', array['closed_at']);
select platform.enforce_db_time('plant.cleaning', array['started_at']);
select platform.enforce_db_time('plant.cleaning_completion', array['completed_at']);
select platform.enforce_db_time('plant.cleaning_verification', array['verified_at']);
select platform.enforce_db_time('plant.cleaning_abandonment', array['abandoned_at']);
select platform.enforce_db_time('plant.equipment_use', array['started_at']);
select platform.enforce_db_time('plant.equipment_use_end', array['ended_at']);
select platform.enforce_db_time('plant.clearance', array['performed_at']);
select platform.enforce_db_time('plant.clearance_verification', array['verified_at']);
select platform.enforce_db_time('plant.area_occupancy', array['started_at']);
select platform.enforce_db_time('plant.area_occupancy_end', array['ended_at']);

-- Audit (hash-chained, kernel 0010). Every plant table is insert-only.
select kernel.register_audited_table('plant.product', 'plant_product', 'code', true);
select kernel.register_audited_table('plant.equipment_class', 'plant_equipment_class', 'code', true);
select kernel.register_audited_table('plant.area', 'plant_area', 'id', true);
select kernel.register_audited_table('plant.equipment', 'plant_equipment', 'id', true);
select kernel.register_audited_table('plant.equipment_event', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.calibration', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.instrument_check', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.instrument_use', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.utility_reading', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.campaign', 'plant_campaign', 'id', true);
select kernel.register_audited_table('plant.campaign_closure', 'plant_campaign', 'campaign_id', true);
select kernel.register_audited_table('plant.cleaning', 'plant_cleaning', 'id', true);
select kernel.register_audited_table('plant.cleaning_completion', 'plant_cleaning', 'cleaning_id', true);
select kernel.register_audited_table('plant.cleaning_verification', 'plant_cleaning', 'cleaning_id', true);
select kernel.register_audited_table('plant.cleaning_abandonment', 'plant_cleaning', 'cleaning_id', true);
select kernel.register_audited_table('plant.equipment_use', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.equipment_use_end', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.clearance', 'plant_clearance', 'id', true);
select kernel.register_audited_table('plant.clearance_verification', 'plant_clearance', 'clearance_id', true);
select kernel.register_audited_table('plant.area_occupancy', 'plant_area', 'area_id', true);
select kernel.register_audited_table('plant.area_occupancy_end', 'plant_area', 'occupancy_id', true);

grant select on all tables in schema plant to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Guards of the plant machines (sql/0401, 0402). Each checks that the plant rows agree with the transition; the rows
-- are written only by the plant commands, which transition in the same transaction.
-- ---------------------------------------------------------------------------------------------

create function plant.latest_cleaning(p_aggregate_type text, p_id uuid) returns plant.cleaning_status
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select c.* from plant.cleaning_status c
  where (p_aggregate_type = 'plant_equipment' and c.equipment_id = p_id) or (p_aggregate_type = 'plant_area' and c.area_id = p_id)
  order by c.started_at desc, c.id desc limit 1
$$;

create function plant.guard_cleaning_open(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.cleaning_status := plant.latest_cleaning(p_aggregate_type, p_aggregate_id);
begin
  if c.id is null or c.verified_at is not null or c.abandoned_at is not null then
    return 'no cleaning was started (start it with plant.start_cleaning)';
  end if;
  return null;
end
$$;

create function plant.guard_cleaning_verified(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.cleaning_status := plant.latest_cleaning(p_aggregate_type, p_aggregate_id);
begin
  if c.id is null or c.verified_at is null then
    return 'the cleaning has not been verified (verify it with plant.verify_cleaning)';
  end if;
  return null;
end
$$;

create function plant.guard_cleaning_abandoned(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.cleaning_status := plant.latest_cleaning(p_aggregate_type, p_aggregate_id);
begin
  if c.id is null or c.abandoned_at is null then
    return 'the cleaning has not been abandoned (use plant.abandon_cleaning)';
  end if;
  return null;
end
$$;

create function plant.guard_equipment_use_open(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when not exists (select 1 from plant.equipment_use_status u where u.equipment_id = p_aggregate_id and u.ended_at is null)
              then 'no use was started (start it with plant.start_equipment_use, which runs the use guard)' end
$$;

create function plant.guard_equipment_no_use_open(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.equipment_use_status u where u.equipment_id = p_aggregate_id and u.ended_at is null)
              then 'the use is still open (end it with plant.end_equipment_use)' end
$$;

-- The instant after which a clearance of the area must be recorded (INV-15): the latest start or end of an occupancy
-- of the area, or the latest verified cleaning of it, whichever is later (a clearance follows the cleaning it checks).
create function plant.area_last_occupancy_event(p_area uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select greatest((select max(greatest(o.started_at, coalesce(o.ended_at, o.started_at))) from plant.area_occupancy_status o where o.area_id = p_area),
                  (select max(c.verified_at) from plant.cleaning_status c where c.area_id = p_area))
$$;

create function plant.guard_clearance_passed(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when not exists (
    select 1 from plant.clearance_status c
    where c.area_id = p_aggregate_id and c.result = 'PASSED'
      and not exists (select 1 from plant.area_occupancy o where o.clearance_id = c.id)
      and c.performed_at > coalesce(plant.area_last_occupancy_event(p_aggregate_id), '-infinity'::timestamptz))
    then 'no passed clearance has been verified since the last occupancy or cleaning (INV-15)' end
$$;

create function plant.guard_area_occupancy_open(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when not exists (select 1 from plant.area_occupancy_status o where o.area_id = p_aggregate_id and o.ended_at is null)
              then 'no batch was started in the area (start it with plant.start_area_occupancy, which checks the clearance)' end
$$;

create function plant.guard_area_no_occupancy_open(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when exists (select 1 from plant.area_occupancy_status o where o.area_id = p_aggregate_id and o.ended_at is null)
              then 'a batch is still open in the area' end
$$;

select platform.register_guard('plant.cleaning_open', 'plant.guard_cleaning_open(text, uuid, jsonb, jsonb, jsonb)',
                               'A cleaning of the equipment or area was started and is neither verified nor abandoned');
select platform.register_guard('plant.cleaning_verified', 'plant.guard_cleaning_verified(text, uuid, jsonb, jsonb, jsonb)',
                               'The latest cleaning of the equipment or area is verified');
select platform.register_guard('plant.cleaning_abandoned', 'plant.guard_cleaning_abandoned(text, uuid, jsonb, jsonb, jsonb)',
                               'The latest cleaning of the equipment or area was abandoned with a reason');
select platform.register_guard('plant.equipment_use_open', 'plant.guard_equipment_use_open(text, uuid, jsonb, jsonb, jsonb)',
                               'A use of the PROCESS equipment was started through the use guard and is open');
select platform.register_guard('plant.equipment_no_use_open', 'plant.guard_equipment_no_use_open(text, uuid, jsonb, jsonb, jsonb)',
                               'No use of the PROCESS equipment is open');
select platform.register_guard('plant.clearance_passed', 'plant.guard_clearance_passed(text, uuid, jsonb, jsonb, jsonb)',
                               'An unused, passed and verified clearance of the area was recorded after its last occupancy (INV-15)');
select platform.register_guard('plant.area_occupancy_open', 'plant.guard_area_occupancy_open(text, uuid, jsonb, jsonb, jsonb)',
                               'A batch occupancy of the area was started through the clearance check and is open');
select platform.register_guard('plant.area_no_occupancy_open', 'plant.guard_area_no_occupancy_open(text, uuid, jsonb, jsonb, jsonb)',
                               'No batch occupancy of the area is open');

reset role;
