-- Phase 6 slice 6b (builder B): the plant rules behind the clauses Phase 4 deferred to Phase 6 (decision 0011):
-- rooms get a clean-hold time and a cleaning state (PR-25), a spill sets a room to cleaning required (PR-27), a
-- site-level penicillin rule keeps beta-lactam materials and products out of a non-penicillin facility (PR-27), line
-- adjacency and segregation (PR-35), and the controlled areas whose work needs an area authorisation (PR-15, kernel
-- 1190). Every rule is master data under MASTERDATA.CHANGE, versioned and insert-only (the latest version counts);
-- the guards read them on every writer (ADR 0012).
--
-- Handbook: modules/recipe-core.md
--
--   plant.area_rule               per room or line, versioned: whether work in it needs an area authorisation
--                                 (a controlled area, PR-15) and its clean-hold time (PR-25: the longest a verified
--                                 cleaning stands before a batch starts in the room); plant.set_area_rule
--   plant.area_spill              insert-only, audited: a spill in a room or line (what, by whom, the batch if any);
--                                 plant.record_spill (LOGBOOK.ENTRY). The room is CLEANING_REQUIRED until a cleaning
--                                 of it is verified after the spill (D-P6b-B-3)
--   plant.room_cleaning_state     (view) per room or line: CLEANING_REQUIRED, OVERDUE, CLEAN or NOT_CLEANED, with the
--                                 last verified cleaning, the clean-hold time and the open spills
--   plant.area_adjacency          versioned per pair of rooms or lines: adjacent, segregated or not (segregation states
--                                 its justification); plant.define_area_adjacency
--   plant.facility_rule           per site, versioned: whether the site is a penicillin facility (an unconfigured site
--                                 is not, fail safe); plant.set_facility_rule
--   plant.beta_lactam_class       versioned per material or product code: beta-lactam or not; plant.classify_beta_lactam
--   plant.room_start_problem(area, batch, at)        PR-25, PR-27: null, or why work of the batch may not start in the
--                                 room now: an open spill (EBMR-PLANT-151) or a clean hold run out before the batch's
--                                 occupancy started, or now when the batch does not occupy the room (EBMR-PLANT-150)
--   plant.adjacency_problem(area, batch)             PR-35: null, or the adjacent unsegregated room or line where
--                                 another product runs now (EBMR-PLANT-161)
--   plant.batch_beta_lactam(batch), plant.penicillin_problem(site, kind, code, beta_lactam)   PR-27 (EBMR-PLANT-170)
--   Triggers: ab_plant_room_rules on plant.area_occupancy (before insert: room start, adjacency and penicillin rules
--   for every occupancy, whoever writes it) and ab_plant_penicillin_lot on site.material_lot (before insert: a lot of
--   a beta-lactam material is not received at a non-penicillin site).
--
-- Messages: EBMR-PLANT-150 to 153, 160 to 161, 170 to 172.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Area rules: controlled area (PR-15) and clean-hold time (PR-25)
-- ---------------------------------------------------------------------------------------------

create table plant.area_rule (
  area_id                 uuid not null references plant.area (id),
  version                 integer not null check (version >= 1),
  authorisation_required  boolean not null,
  clean_hold              interval check (clean_hold is null or clean_hold > interval '0'),
  reason                  text not null check (btrim(reason) <> '' and length(reason) <= 500),
  recorded_by_person      uuid not null,
  recorded_by_account     uuid not null,
  correlation_id          uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (area_id, version)
);
revoke all on plant.area_rule from public;
select platform.enforce_db_time('plant.area_rule', array['recorded_at']);
select kernel.register_audited_table('plant.area_rule', 'plant_area', 'area_id', true);

create view plant.area_rule_current as
  select distinct on (r.area_id) r.* from plant.area_rule r order by r.area_id, r.version desc;

-- MASTERDATA.CHANGE: a new version of the rules of room or line p_area (seconds of clean hold, or null for none).
create function plant.set_area_rule(p_area text, p_authorisation_required boolean, p_clean_hold_seconds bigint, p_reason text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.area;
  v_ver   integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  a := plant.area_by_code(p_area, true);
  if p_authorisation_required is null or (p_clean_hold_seconds is not null and p_clean_hold_seconds <= 0) or coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-PLANT-153 the rules of a room or line state whether its work needs an area authorisation, its clean-hold time in seconds (or none) and the reason (PR-15, PR-25)';
  end if;
  select coalesce(max(version), 0) + 1 into v_ver from plant.area_rule where area_id = a.id;
  insert into plant.area_rule (area_id, version, authorisation_required, clean_hold, reason, recorded_by_person, recorded_by_account, correlation_id)
  values (a.id, v_ver, p_authorisation_required, case when p_clean_hold_seconds is not null then make_interval(secs => p_clean_hold_seconds) end,
          btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_ver;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Spills (PR-27) and the cleaning state of a room
-- ---------------------------------------------------------------------------------------------

create table plant.area_spill (
  id                   uuid primary key default gen_random_uuid(),
  area_id              uuid not null references plant.area (id),
  description          text not null check (btrim(description) <> '' and length(description) <= 1000),
  material             text check (material is null or (btrim(material) <> '' and length(material) <= 200)),
  batch_id             uuid references recipe.batch_execution (id),
  person_id            uuid not null,
  account_id           uuid not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp()
);
create index area_spill_by_area on plant.area_spill (area_id, recorded_at);
revoke all on plant.area_spill from public;
select platform.enforce_db_time('plant.area_spill', array['recorded_at']);
select kernel.register_audited_table('plant.area_spill', 'plant_area', 'area_id', true);

-- The last verified cleaning of a room or line (null when it was never cleaned).
create function plant.area_last_cleaned(p_area uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select max(v.verified_at) from plant.cleaning c join plant.cleaning_verification v on v.cleaning_id = c.id where c.area_id = p_area
$$;

create view plant.room_cleaning_state as
  select a.id as area_id, a.code, a.kind, r.clean_hold, r.authorisation_required, plant.area_last_cleaned(a.id) as last_cleaned_at,
         (select count(*) from plant.area_spill s where s.area_id = a.id and s.recorded_at > coalesce(plant.area_last_cleaned(a.id), '-infinity'::timestamptz))::integer as open_spills,
         case
           when exists (select 1 from plant.area_spill s where s.area_id = a.id and s.recorded_at > coalesce(plant.area_last_cleaned(a.id), '-infinity'::timestamptz))
             then 'CLEANING_REQUIRED'
           when plant.area_last_cleaned(a.id) is null then 'NOT_CLEANED'
           when r.clean_hold is not null and clock_timestamp() > plant.area_last_cleaned(a.id) + r.clean_hold
                and not exists (select 1 from plant.area_occupancy_status o where o.area_id = a.id and o.ended_at is null
                                   and o.started_at > plant.area_last_cleaned(a.id)) then 'OVERDUE'
           else 'CLEAN'
         end as cleaning_state
  from plant.area a left join plant.area_rule_current r on r.area_id = a.id;

-- LOGBOOK.ENTRY, a person: a spill in room or line p_area (the batch working there, if any). Returns the spill's id.
create function plant.record_spill(p_area text, p_description text, p_material text, p_batch uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.area;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-152 a spill is recorded by a person (PR-27)';
  end if;
  a := plant.area_by_code(p_area, true);
  if coalesce(btrim(p_description), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-152 a spill states what was spilt and where (PR-27)';
  end if;
  if p_batch is not null and not exists (select 1 from recipe.batch_execution where id = p_batch) then
    perform plant.fail(format('Unknown batch %s (EBMR-PLANT-014)', p_batch));
  end if;
  insert into plant.area_spill (area_id, description, material, batch_id, person_id, account_id, correlation_id)
  values (a.id, btrim(p_description), nullif(btrim(coalesce(p_material, '')), ''), p_batch,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- PR-25, PR-27: null when work of batch p_batch may start in room or line p_area at p_at; else why not.
create function plant.room_start_problem(p_area uuid, p_batch uuid, p_at timestamptz) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  a       plant.area;
  r       plant.area_rule_current;
  v_clean timestamptz := plant.area_last_cleaned(p_area);
  v_spill plant.area_spill;
  v_from  timestamptz;
begin
  select * into a from plant.area where id = p_area;
  if a.id is null then
    return null;
  end if;
  select * into v_spill from plant.area_spill s where s.area_id = p_area and s.recorded_at > coalesce(v_clean, '-infinity'::timestamptz)
   order by s.recorded_at limit 1;
  if v_spill.id is not null then
    return format('EBMR-PLANT-151 %s is CLEANING_REQUIRED: a spill was recorded at %s (%s); work starts there again after a verified cleaning (PR-27)',
                  a.code, recipe.utc_text(v_spill.recorded_at), v_spill.description);
  end if;
  select * into r from plant.area_rule_current where area_id = p_area;
  if r.clean_hold is null then
    return null;
  end if;
  -- The clean hold runs from the last verified cleaning to the start of the batch's open occupancy of the room (the
  -- work in an occupied room stands on the cleaning that preceded it), or to now when the batch does not occupy it.
  select o.started_at into v_from from plant.area_occupancy_status o
   where o.area_id = p_area and o.batch_id = p_batch and o.ended_at is null and o.started_at <= p_at order by o.started_at desc limit 1;
  v_from := coalesce(v_from, p_at);
  if v_clean is null or v_clean > v_from or v_from > v_clean + r.clean_hold then
    return format('EBMR-PLANT-150 %s is overdue for cleaning: %s, clean-hold time %s (PR-25)', a.code,
                  case when v_clean is null then 'it has no verified cleaning' else 'last cleaning verified at ' || recipe.utc_text(v_clean) end, r.clean_hold);
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Line adjacency and segregation (PR-35)
-- ---------------------------------------------------------------------------------------------

create table plant.area_adjacency (
  area_a                  uuid not null references plant.area (id),
  area_b                  uuid not null references plant.area (id),
  version                 integer not null check (version >= 1),
  adjacent                boolean not null,
  segregated              boolean not null,
  segregation_justification text check (segregation_justification is null or btrim(segregation_justification) <> ''),
  recorded_by_person      uuid not null,
  recorded_by_account     uuid not null,
  correlation_id          uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (area_a, area_b, version),
  check (area_a < area_b),
  check (not segregated or segregation_justification is not null)
);
revoke all on plant.area_adjacency from public;
select platform.enforce_db_time('plant.area_adjacency', array['recorded_at']);
select kernel.register_audited_table('plant.area_adjacency', 'plant_area', 'area_a', true);

create view plant.area_adjacency_current as
  select distinct on (j.area_a, j.area_b) j.* from plant.area_adjacency j order by j.area_a, j.area_b, j.version desc;

-- MASTERDATA.CHANGE: rooms or lines p_one and p_two are adjacent (or no longer), segregated (with the justification)
-- or not. Returns the version.
create function plant.define_area_adjacency(p_one text, p_two text, p_adjacent boolean, p_segregated boolean, p_justification text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  x       plant.area;
  y       plant.area;
  v_a     uuid;
  v_b     uuid;
  v_ver   integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  x := plant.area_by_code(p_one, false);
  y := plant.area_by_code(p_two, false);
  if x.id = y.id or p_adjacent is null or p_segregated is null or (p_segregated and coalesce(btrim(p_justification), '') = '') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-PLANT-160 an adjacency names two different rooms or lines, whether they are adjacent, and whether they are segregated (a segregation states its justification) (PR-35)';
  end if;
  v_a := least(x.id, y.id);
  v_b := greatest(x.id, y.id);
  perform pg_advisory_xact_lock(hashtextextended('plant.area_adjacency:' || v_a || ':' || v_b, 0));
  select coalesce(max(version), 0) + 1 into v_ver from plant.area_adjacency where area_a = v_a and area_b = v_b;
  insert into plant.area_adjacency (area_a, area_b, version, adjacent, segregated, segregation_justification, recorded_by_person, recorded_by_account, correlation_id)
  values (v_a, v_b, v_ver, p_adjacent, p_segregated, case when p_segregated then btrim(p_justification) end,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_ver;
end
$$;

-- PR-35: null when batch p_batch may start in room or line p_area beside what runs now; else the adjacent,
-- unsegregated room or line where another product runs.
create function plant.adjacency_problem(p_area uuid, p_batch uuid) returns text
language sql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
  select format('EBMR-PLANT-161 product %s cannot start on %s: the adjacent %s %s runs product %s (batch %s) and the two are not segregated (PR-35)',
                recipe.batch_product(p_batch) ->> 'code', (select code from plant.area where id = p_area), lower(n.kind), n.code, o.product_code, o.batch_ref)
  from plant.area_adjacency_current j
  join plant.area n on n.id = case when j.area_a = p_area then j.area_b else j.area_a end
  join plant.area_occupancy_status o on o.area_id = n.id and o.ended_at is null
  where (j.area_a = p_area or j.area_b = p_area) and j.adjacent and not j.segregated
    and o.product_code is distinct from recipe.batch_product(p_batch) ->> 'code' and o.batch_id <> p_batch
  order by n.code, o.started_at
  limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Penicillin facility (PR-27)
-- ---------------------------------------------------------------------------------------------

create table plant.facility_rule (
  site_code            text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  version              integer not null check (version >= 1),
  penicillin_facility  boolean not null,
  justification        text not null check (btrim(justification) <> '' and length(justification) <= 500),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  primary key (site_code, version)
);
revoke all on plant.facility_rule from public;
select platform.enforce_db_time('plant.facility_rule', array['recorded_at']);
select kernel.register_audited_table('plant.facility_rule', 'plant_facility', 'site_code', true);

create table plant.beta_lactam_class (
  subject_kind         text not null check (subject_kind in ('MATERIAL', 'PRODUCT')),
  code                 text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$'),
  version              integer not null check (version >= 1),
  beta_lactam          boolean not null,
  reason               text not null check (btrim(reason) <> '' and length(reason) <= 500),
  recorded_by_person   uuid not null,
  recorded_by_account  uuid not null,
  correlation_id       uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  primary key (subject_kind, code, version)
);
revoke all on plant.beta_lactam_class from public;
select platform.enforce_db_time('plant.beta_lactam_class', array['recorded_at']);
select kernel.register_audited_table('plant.beta_lactam_class', 'plant_facility', 'code', true);

create function plant.set_facility_rule(p_site text, p_penicillin_facility boolean, p_justification text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_ver   integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if coalesce(p_site, '') !~ '^[A-Z0-9][A-Z0-9-]{0,15}$' or p_penicillin_facility is null or coalesce(btrim(p_justification), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-171 a facility rule names the site, whether it is a penicillin facility, and the justification (PR-27)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plant.facility_rule:' || p_site, 0));
  select coalesce(max(version), 0) + 1 into v_ver from plant.facility_rule where site_code = p_site;
  insert into plant.facility_rule (site_code, version, penicillin_facility, justification, recorded_by_person, recorded_by_account, correlation_id)
  values (p_site, v_ver, p_penicillin_facility, btrim(p_justification), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_ver;
end
$$;

create function plant.classify_beta_lactam(p_kind text, p_code text, p_beta_lactam boolean, p_reason text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_ver   integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if coalesce(p_kind, '') not in ('MATERIAL', 'PRODUCT') or coalesce(p_code, '') !~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,63}$' or p_beta_lactam is null
     or coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLANT-172 a beta-lactam classification names MATERIAL or PRODUCT, the code, whether it is beta-lactam, and the reason (PR-27)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plant.beta_lactam_class:' || p_kind || ':' || p_code, 0));
  select coalesce(max(version), 0) + 1 into v_ver from plant.beta_lactam_class where subject_kind = p_kind and code = p_code;
  insert into plant.beta_lactam_class (subject_kind, code, version, beta_lactam, reason, recorded_by_person, recorded_by_account, correlation_id)
  values (p_kind, p_code, v_ver, p_beta_lactam, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return v_ver;
end
$$;

-- Whether the latest classification of (kind, code) says beta-lactam (false when never classified).
create function plant.classified_beta_lactam(p_kind text, p_code text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce((select c.beta_lactam from plant.beta_lactam_class c where c.subject_kind = p_kind and c.code = p_code order by c.version desc limit 1), false)
$$;

-- Whether batch p_batch's product is beta-lactam: classified so, flagged by the ERP product master, or by the MBR's
-- betaLactam predicate (any of them; a flag only ever adds).
create function plant.batch_beta_lactam(p_batch uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, recipe, site, pg_temp as $$
  select plant.classified_beta_lactam('PRODUCT', recipe.batch_product(p_batch) ->> 'code')
      or coalesce((site.product_master_of(recipe.batch_product(p_batch) ->> 'code', recipe.batch_product(p_batch) ->> 'strength') ->> 'betaLactam')::boolean, false)
      or coalesce((recipe.batch_mbr_content(p_batch) -> 'header' -> 'predicates' -> 'betaLactam') = 'true'::jsonb, false)
$$;

-- PR-27: null unless a beta-lactam subject would enter site p_site, which is not a penicillin facility (an
-- unconfigured site is not one).
create function plant.penicillin_problem(p_site text, p_kind text, p_code text, p_beta_lactam boolean) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when p_beta_lactam and not coalesce((select f.penicillin_facility from plant.facility_rule f where f.site_code = p_site order by f.version desc limit 1), false)
         then format('EBMR-PLANT-170 %s %s is beta-lactam (penicillin) and site %s is not a penicillin facility: it is not received or processed there (PR-27)',
                     lower(p_kind), p_code, coalesce(p_site, 'NULL'))
         end
$$;

-- ---------------------------------------------------------------------------------------------
-- The guards on every writer
-- ---------------------------------------------------------------------------------------------

create function plant.area_occupancy_rules_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_problem text;
begin
  v_problem := coalesce(plant.room_start_problem(new.area_id, new.batch_id, clock_timestamp()),
                        plant.adjacency_problem(new.area_id, new.batch_id),
                        plant.penicillin_problem((select b.site_code from recipe.batch_execution b where b.id = new.batch_id), 'PRODUCT', new.product_code,
                                                 plant.batch_beta_lactam(new.batch_id)));
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
create trigger ab_plant_room_rules before insert on plant.area_occupancy for each row execute function plant.area_occupancy_rules_check();

create function plant.material_lot_penicillin_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_problem text := plant.penicillin_problem(new.site_code, 'MATERIAL', new.material_code, plant.classified_beta_lactam('MATERIAL', new.material_code));
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
create trigger ab_plant_penicillin_lot before insert on site.material_lot for each row execute function plant.material_lot_penicillin_check();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function plant.set_area_rule(text, boolean, bigint, text), plant.area_last_cleaned(uuid), plant.record_spill(text, text, text, uuid),
  plant.room_start_problem(uuid, uuid, timestamptz), plant.define_area_adjacency(text, text, boolean, boolean, text), plant.adjacency_problem(uuid, uuid),
  plant.set_facility_rule(text, boolean, text), plant.classify_beta_lactam(text, text, boolean, text), plant.classified_beta_lactam(text, text),
  plant.batch_beta_lactam(uuid), plant.penicillin_problem(text, text, text, boolean), plant.area_occupancy_rules_check(),
  plant.material_lot_penicillin_check() from public;
grant select on plant.area_rule, plant.area_rule_current, plant.area_spill, plant.room_cleaning_state, plant.area_adjacency, plant.area_adjacency_current,
  plant.facility_rule, plant.beta_lactam_class to ebmr_app;
grant execute on function plant.set_area_rule(text, boolean, bigint, text), plant.area_last_cleaned(uuid), plant.record_spill(text, text, text, uuid),
  plant.room_start_problem(uuid, uuid, timestamptz), plant.define_area_adjacency(text, text, boolean, boolean, text), plant.adjacency_problem(uuid, uuid),
  plant.set_facility_rule(text, boolean, text), plant.classify_beta_lactam(text, text, boolean, text), plant.classified_beta_lactam(text, text),
  plant.batch_beta_lactam(uuid), plant.penicillin_problem(text, text, text, boolean) to ebmr_app;

reset role;
