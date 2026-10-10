-- Recipe core, Phase 3 slice 3a: two items of the Phase 3 review backlog (docs/build-plan/phase-3/review-backlog.md).
--
-- #5 (slice 2b quick review; DI-17, IN-21): an operator whose STEP.EXECUTE grant is limited to a product could not
-- start a press, end its use or open, close, hold or charge a container: plant.start_equipment_use and the container
-- commands check STEP.EXECUTE with the batch's product scope, but the state transitions they then make
-- (equipment_cleanliness START_USE and END_USE, the output_container events and its creation; machine permission
-- step.execute) were checked by the platform's authority adapter (iam.platform_authority, kernel 0710) with the
-- session's location scope only, so a product-limited grant never matched and the command failed closed. Default taken
-- (the backlog's): those transitions also evaluate the batch's product. plant.transition_scope gives, for the
-- permission step.execute on an aggregate of type plant_equipment (the product of the unit's latest use: the use a
-- START_USE starts is inserted before the move, the one an END_USE ends is still the latest) or output_container (the
-- container's product), {"product": <code>}, and nothing for any other permission or aggregate.
-- iam.platform_authority is replaced from its only definition (kernel 0710) with that one change: the scope it
-- evaluates is the session's location scope with the product added. The AUTHORITY hook still names
-- iam.platform_authority. Nothing else is relaxed: a grant limited to another product is refused as before, and a grant
-- without a product limit matches as before.
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

-- #5: the product a plant transition's permission is evaluated for (header).
create function plant.transition_scope(p_permission text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_product text;
begin
  if lower(coalesce(p_permission, '')) <> 'step.execute' or p_aggregate_id is null
     or p_aggregate_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{}'::jsonb;
  end if;
  if p_aggregate_type = 'plant_equipment' then
    select u.product_code into v_product from plant.equipment_use u
     where u.equipment_id = p_aggregate_id::uuid order by u.started_at desc, u.id desc limit 1;
  elsif p_aggregate_type = 'output_container' then
    select c.product_code into v_product from plant.output_container c where c.id = p_aggregate_id::uuid;
  end if;
  return case when v_product is null then '{}'::jsonb else jsonb_build_object('product', v_product) end;
end
$$;
revoke all on function plant.transition_scope(text, text, text) from public;

-- As kernel 0710_authorization_scope_and_platform.sql; the scope also carries the plant product (#5, header).
create or replace function iam.platform_authority(p_permission text, p_actor jsonb, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_code  text := iam.platform_permission_code(p_permission);
  v_scope jsonb;
  v_eval  jsonb;
begin
  if not iam.actor_is_validated() then
    return 'EBMR-IAM-002 no validated actor: the command was not started with kernel.begin_command';
  end if;
  v_actor := kernel.current_actor();
  if p_actor is null
     or p_actor ->> 'person_id' is distinct from v_actor ->> 'person_id'
     or p_actor ->> 'account_id' is distinct from v_actor ->> 'account_id'
     or p_actor ->> 'role_code' is distinct from v_actor ->> 'role_code'
     or p_actor ->> 'session_id' is distinct from v_actor ->> 'session_id' then
    return 'EBMR-IAM-043 the actor given to the authority check is not the validated actor of this command';
  end if;
  if v_code is null then
    return format('EBMR-IAM-043 %L is not a permission name the catalogue can map', p_permission);
  end if;
  v_scope := iam.actor_location_scope() || plant.transition_scope(p_permission, p_aggregate_type, p_aggregate_id);
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_code, v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if (v_eval ->> 'allowed')::boolean then
    return null;
  end if;
  raise exception using errcode = 'P0001',
    message = format('EBMR-PLAT-006 permission %s denied: %s acting as %s lacks %s in scope %s for %s:%s: %s (evaluation %s)', p_permission,
                     v_actor ->> 'account_id', v_actor ->> 'role_code', v_code, v_scope, coalesce(p_aggregate_type, '?'),
                     coalesce(p_aggregate_id, '?'), v_eval -> 'reasons', v_eval ->> 'evaluation_id'),
    detail = jsonb_build_object('person_id', v_actor ->> 'person_id', 'account_id', v_actor ->> 'account_id',
                                'role_code', v_actor ->> 'role_code', 'permission', v_code, 'scope', v_scope,
                                'reasons', v_eval -> 'reasons', 'platform_permission', p_permission)::text;
end
$$;

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
