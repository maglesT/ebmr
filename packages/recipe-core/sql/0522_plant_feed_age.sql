-- Recipe core, Phase 3 slice 3a: an item of the Phase 3 review backlog (docs/build-plan/phase-3/review-backlog.md).
--
-- #5 (product-scoped plant transitions) is recipe-core 0523, through the kernel's SCOPE hook (kernel 1150, ADR-0018).
--
-- #9 (slice 1 quick review; IN-25 (b)): a utility's latest feed status counted as OK however old it was. From here on
-- a status older than the utility class's configured feed age (plant.utility_feed_age, set with MASTERDATA.CHANGE,
-- latest row wins; default 15 minutes when none is set, the stricter default) does not count: plant.utility_problem,
-- replaced from its only definition (0403), reports it stale. The age runs from the earlier of the feed's observation
-- time and the database's receipt time, against the database clock.
--
-- New tables are insert-only and audited; new functions are owned by ebmr_owner, with pg_temp last in their search_path;
-- the writer refuses administrators and checks MASTERDATA.CHANGE. CREATE OR REPLACE keeps each replaced function's owner,
-- privileges, SECURITY DEFINER and search_path. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- #9: the feed age of a utility class (header).
create table plant.utility_feed_age (
  id           uuid primary key default gen_random_uuid(),
  class_code   text not null references plant.equipment_class (code),
  max_age      interval not null check (max_age > interval '0' and max_age <= interval '1 day'),
  recorded_by  uuid not null,
  recorded_at  timestamptz not null default clock_timestamp()
);
create index utility_feed_age_by_class on plant.utility_feed_age (class_code, recorded_at);
select kernel.register_audited_table('plant.utility_feed_age', 'plant_equipment_class', 'class_code', true);
grant select on plant.utility_feed_age to ebmr_app;

-- MASTERDATA.CHANGE: the feed age of utility class p_class (a new row; the latest counts).
create function plant.set_utility_feed_age(p_class text, p_max_age interval) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if not exists (select 1 from plant.equipment_class where code = p_class and kind = 'UTILITY') then
    perform plant.fail(format('%s is not a utility class (EBMR-PLANT-140)', coalesce(p_class, 'NULL')));
  end if;
  insert into plant.utility_feed_age (class_code, max_age, recorded_by) values (p_class, p_max_age, plant.actor_person())
  returning id into v_id;
  return v_id;
end
$$;

-- #9: the feed age that counts for a utility of class p_class now (default 15 minutes).
create function plant.utility_feed_max_age(p_class text) returns interval
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce((select a.max_age from plant.utility_feed_age a where a.class_code = p_class order by a.recorded_at desc, a.id desc limit 1),
                  interval '15 minutes')
$$;

-- As 0403_plant_equipment_commands.sql; a status older than the class's feed age does not count (#9, header).
create or replace function plant.utility_problem(p_equipment_code text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  e        plant.equipment;
  v_status text;
  v_at     timestamptz;
  v_age    interval;
  v_fit    text;
begin
  select * into e from plant.equipment where code = p_equipment_code;
  if e.id is null or e.kind <> 'UTILITY' then
    return format('%s is not a utility', coalesce(p_equipment_code, 'NULL'));
  end if;
  v_fit := plant.equipment_fitness(e.id);
  if v_fit <> 'QUALIFIED' then
    return format('%s is %s', e.code, v_fit);
  end if;
  select status, least(observed_at, recorded_at) into v_status, v_at from plant.utility_reading where equipment_id = e.id order by recorded_at desc, id desc limit 1;
  if v_status is distinct from 'OK' then
    return format('the latest feed status of %s is %s', e.code, coalesce(v_status, 'missing'));
  end if;
  v_age := plant.utility_feed_max_age(e.class_code);
  if clock_timestamp() - v_at > v_age then
    return format('the latest feed status of %s (OK at %s) is older than its feed age of %s, so it does not count', e.code, v_at, v_age);
  end if;
  return null;
end
$$;

revoke all on function plant.set_utility_feed_age(text, interval), plant.utility_feed_max_age(text) from public;
grant execute on function plant.set_utility_feed_age(text, interval), plant.utility_feed_max_age(text) to ebmr_app;

reset role;
