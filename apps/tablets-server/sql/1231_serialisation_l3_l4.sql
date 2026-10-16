-- Tablets, Phase 6 slice 6c: serialisation L3/L4 through the adapter framework, the serial query and the L3 freshness at
-- release (PR-42; outline 4.6; defaults D-P6c-1, D-P6c-12 to D-P6c-15; ADR 0012: the rules hold when the application's
-- own database credentials are used directly). The device-side pool contract stays tablets 0952's.
--
-- Handbook: modules/tablets-server.md
--
--   platform.inbound_schema       l3.aggregation and l3.decommission_task, version 1 (integration-sdk adapter/systems/l3.ts).
--   platform.mirror_data_class    L3_SERIAL_STATUS (blocking), with its mode (STAND_IN by default, D-P6c-12) and its bound
--                                 (3600 s) settings: the L3 adapter's heartbeat keeps it fresh in MIRROR mode.
--   tab.l3_aggregation            insert-only, audited: an EPCIS-style aggregation the L3 adapter received (D-P6c-15).
--   tab.l3_decommission_task      insert-only, audited: each received state of a decommissioning task (OPEN, DONE), from
--                                 the adapter's feed or from the L3's own answer to a rejection (D-P6c-14).
--   tab.receive_l3_message(envelope)   the L3 adapter's receiving command (INTERFACE.WRITE): platform.accept_inbound_detail
--                                 (kernel 1180), then the payload in the same transaction. Refusals:
--                                   EBMR-L3-101 MALFORMED       the payload's shape
--                                   EBMR-L3-103 WRONG_IDENTITY  L3_SERIAL_STATUS is STAND_IN; an unknown pool; a parent that
--                                                               is no shipper SSCC of the pool's packaging order; a task for
--                                                               another packaging order than the pool's
--                                   EBMR-L3-104 STALE           older than a state of the same aggregation parent or task
--                                                               already applied
--                                   EBMR-L3-105 OUT_OF_RANGE    an aggregation whose count is not the shipper's packs (the
--                                                               aggregation mismatch); a task with more serials than the pool
--   tab.record_pool_rejection(pool, reason, task)   QA.FLOOR_APPROVE: the OPEN task the L3 answered to QA's rejection
--                                 (EBMR-L3-106 to -108).
--   tab.serial_lookup(answer)     RECORD.READ: the L3's answer to a serial query, answered with the record's lot (the
--                                 packaging order's batch number) and expiry (recipe.batch_expiry); any L3 lot, expiry,
--                                 GTIN or packaging order that differs is listed in problems (D-P6c-13) (EBMR-L3-109,
--                                 -110).
--   tab.l3_release_problem(batch) PR-42: an OPEN decommissioning task of a pool of the order; in MIRROR mode, a stale L3
--                                 mirror (fails closed, outline 4.6); NULL when nothing blocks.
--   tab.grel_recon_serial(order)  re-created from tablets 1162 (same signature): adds the L3 problems to
--                                 E.RECONCILIATION_SERIAL.
--   tab.batch_pools_view(batch)   the serialisation.batchPools view (contract ns/serialisation.ts).
-- Messages EBMR-L3-101 to EBMR-L3-110.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1231_serialisation_l3_l4)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'L3 message schemas and the L3 serial-status mirror (PR-42; Phase 6 slice 6c)'));

insert into platform.inbound_schema (source_system, message_type, schema_version, description) values
  ('L3', 'l3.aggregation', 1, 'An EPCIS-style aggregation of serialised packs into a shipper (SSCC)'),
  ('L3', 'l3.decommission_task', 1, 'A decommissioning task opened on a rejection, or closed');

insert into platform.mirror_data_class (code, source_system, blocking, description) values
  ('L3_SERIAL_STATUS', 'L3', true, 'Serial status, aggregations and decommissioning tasks of the L3 system read at release (PR-42)');

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis) values
  ('integration.mode.l3_serial_status', 'TEXT', 'STAND_IN', null, null, array['STAND_IN', 'MIRROR'], null, null,
   'Whether L3_SERIAL_STATUS is read by the server''s direct L3 calls (STAND_IN) or mirrored from the L3 by its adapter (MIRROR)',
   'D-P6a-5, D-P6c-12: one mode per data class and site; switching is a configuration change'),
  ('integration.mirror_max_age_s.l3_serial_status', 'INTEGER', '3600', 60, 604800, null, null, 's',
   'Age of the last successful L3 synchronisation of L3_SERIAL_STATUS above which the mirror is stale (fails closed)',
   'D-P6c-12: as the other blocking mirrors, 60 min');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables

create table tab.l3_aggregation (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid not null unique references platform.inbound_message (id),
  event_id         text not null check (event_id ~ '^[\x21-\x7E]{1,64}$'),
  pool_id          text not null references tab.serial_pool (pool_id),
  batch_id         uuid not null references recipe.batch_execution (id),
  action           text not null check (action in ('ADD', 'DELETE')),
  parent_sscc      text not null check (parent_sscc ~ '^[0-9]{18}$'),
  child_count      numeric not null check (child_count >= 0 and scale(child_count) = 0),
  event_time       timestamptz not null,
  received_at      timestamptz not null default clock_timestamp()
);
create index l3_aggregation_by_parent on tab.l3_aggregation (pool_id, parent_sscc, event_time);
revoke all on tab.l3_aggregation from public;
create trigger aa_l3_aggregation_insert_only before update or delete on tab.l3_aggregation for each row execute function kernel.reject_mutation();
create trigger aa_l3_aggregation_no_truncate before truncate on tab.l3_aggregation for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.l3_aggregation', array['received_at']);
select kernel.register_audited_table('tab.l3_aggregation', 'serial_pool', 'pool_id', true);

create table tab.l3_decommission_task (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid unique references platform.inbound_message (id),
  task_id          text not null check (task_id ~ '^[\x21-\x7E]{1,64}$'),
  pool_id          text not null references tab.serial_pool (pool_id),
  batch_id         uuid not null references recipe.batch_execution (id),
  serial_count     numeric not null check (serial_count >= 0 and scale(serial_count) = 0),
  reason           text not null,
  state            text not null check (state in ('OPEN', 'DONE')),
  changed_at       timestamptz not null,
  source           text not null check (source in ('FEED', 'REJECTION')),
  recorded_by      uuid not null,
  received_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid not null,
  check ((source = 'FEED') = (message_id is not null))
);
create index l3_decommission_task_by_pool on tab.l3_decommission_task (pool_id, task_id, changed_at);
revoke all on tab.l3_decommission_task from public;
create trigger aa_l3_decommission_task_insert_only before update or delete on tab.l3_decommission_task for each row execute function kernel.reject_mutation();
create trigger aa_l3_decommission_task_no_truncate before truncate on tab.l3_decommission_task for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.l3_decommission_task', array['received_at']);
select kernel.register_audited_table('tab.l3_decommission_task', 'serial_pool', 'pool_id', true);

-- The latest state of each decommissioning task of pool p_pool (by the L3's change time, then arrival).
create function tab.l3_tasks_of(p_pool text) returns setof tab.l3_decommission_task
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select distinct on (t.task_id) t.* from tab.l3_decommission_task t where t.pool_id = p_pool
   order by t.task_id, t.changed_at desc, t.received_at desc, t.id desc
$$;

-- The packs of the shipper with SSCC p_sscc of a TB-24 step of batch p_batch (the record's SHIPPER entries), or NULL.
create function tab.l3_shipper_packs(p_batch uuid, p_sscc text) returns numeric
language sql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select (e.value -> 'data' ->> 'packs')::numeric
    from recipe.execution_state st, jsonb_each(case when jsonb_typeof(st.state -> 'entries') = 'object' then st.state -> 'entries' else '{}'::jsonb end) e
   where st.batch_id = p_batch and e.value ->> 'kind' = 'SHIPPER' and e.value -> 'data' ->> 'sscc' = p_sscc
     and (e.value -> 'data' ->> 'packs') ~ '^(0|[1-9][0-9]{0,17})$'
   limit 1
$$;

-- ---------------------------------------------------------------------------------------------
-- The adapter's receiving command (header)

create function tab.receive_l3_message(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, platform, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_type  text := p_envelope ->> 'messageType';
  v_out   jsonb;
  m       platform.inbound_message;
  p       jsonb;
  sp      tab.serial_pool;
  v_num   text;
  v_packs numeric;
  v_at    timestamptz;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if v_type is null or v_type not in ('l3.aggregation', 'l3.decommission_task') then
    raise exception using errcode = 'P0001', message = format('EBMR-L3-101 this command receives l3.aggregation and l3.decommission_task messages, not %s', left(coalesce(v_type, 'none'), 64));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId');
  end if;
  if platform.setting_text('integration.mode.l3_serial_status') <> 'MIRROR' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-L3-103 this site reads L3_SERIAL_STATUS through the server''s direct L3 calls (STAND_IN); an L3 message is not applied (D-P6c-12)';
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  if v_type = 'l3.aggregation' then
    if jsonb_typeof(p) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p) k where k not in ('eventId', 'action', 'poolId', 'parentId', 'childCount', 'eventTime'))
       or coalesce(p ->> 'eventId', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'action', '') not in ('ADD', 'DELETE')
       or coalesce(p ->> 'poolId', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'parentId', '') !~ '^[0-9]{18}$'
       or coalesce(p ->> 'childCount', '') !~ '^(0|[1-9][0-9]{0,17})$' or coalesce(p ->> 'eventTime', '') !~ '^(0|[1-9][0-9]{0,15})$' then
      raise exception using errcode = 'P0001', message = 'EBMR-L3-101 malformed l3.aggregation payload: eventId, action ADD|DELETE, poolId, parentId (an SSCC), childCount and eventTime (epoch microseconds)';
    end if;
    select * into sp from tab.serial_pool where pool_id = p ->> 'poolId';
    if sp.pool_id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-103 pool %s is no serial pool of this site', p ->> 'poolId');
    end if;
    v_packs := tab.l3_shipper_packs(sp.batch_id, p ->> 'parentId');
    if v_packs is null then
      select batch_number into v_num from recipe.batch_execution where id = sp.batch_id;
      raise exception using errcode = 'P0001', message = format('EBMR-L3-103 parent %s is no shipper of packaging order %s (the record''s SSCCs)', p ->> 'parentId', v_num);
    end if;
    v_at := platform.epoch_us_to_timestamptz(p ->> 'eventTime');
    if exists (select 1 from tab.l3_aggregation a where a.pool_id = sp.pool_id and a.parent_sscc = p ->> 'parentId' and a.event_time > v_at) then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-104 a newer aggregation of shipper %s is applied already', p ->> 'parentId');
    end if;
    if p ->> 'action' = 'ADD' and (p ->> 'childCount')::numeric <> v_packs then
      raise exception using errcode = 'P0001',
        message = format('EBMR-L3-105 the L3 aggregates %s packs into shipper %s, the record %s: the aggregation does not match (D-P6c-15)', p ->> 'childCount', p ->> 'parentId', v_packs);
    end if;
    insert into tab.l3_aggregation (message_id, event_id, pool_id, batch_id, action, parent_sscc, child_count, event_time)
    values (m.id, p ->> 'eventId', sp.pool_id, sp.batch_id, p ->> 'action', p ->> 'parentId', (p ->> 'childCount')::numeric, v_at)
    returning id into v_id;
  else
    if jsonb_typeof(p) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p) k where k not in ('taskId', 'poolId', 'packagingOrder', 'serialCount', 'reason', 'state', 'changedAt'))
       or coalesce(p ->> 'taskId', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'poolId', '') !~ '^[\x21-\x7E]{1,64}$'
       or coalesce(p ->> 'packagingOrder', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'serialCount', '') !~ '^(0|[1-9][0-9]{0,17})$'
       or coalesce(p ->> 'reason', '') !~ '^[\x20-\x7E]{1,500}$' or coalesce(p ->> 'state', '') not in ('OPEN', 'DONE')
       or coalesce(p ->> 'changedAt', '') !~ '^(0|[1-9][0-9]{0,15})$' then
      raise exception using errcode = 'P0001', message = 'EBMR-L3-101 malformed l3.decommission_task payload: taskId, poolId, packagingOrder, serialCount, reason, state OPEN|DONE and changedAt';
    end if;
    select * into sp from tab.serial_pool where pool_id = p ->> 'poolId';
    if sp.pool_id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-103 pool %s is no serial pool of this site', p ->> 'poolId');
    end if;
    select batch_number into v_num from recipe.batch_execution where id = sp.batch_id;
    if v_num is distinct from p ->> 'packagingOrder' then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-103 pool %s belongs to packaging order %s, not %s', sp.pool_id, v_num, p ->> 'packagingOrder');
    end if;
    if (p ->> 'serialCount')::numeric > sp.quantity then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-105 the task names %s serials; pool %s has %s', p ->> 'serialCount', sp.pool_id, sp.quantity);
    end if;
    v_at := platform.epoch_us_to_timestamptz(p ->> 'changedAt');
    if exists (select 1 from tab.l3_decommission_task t where t.task_id = p ->> 'taskId' and t.pool_id = sp.pool_id and t.changed_at > v_at) then
      raise exception using errcode = 'P0001', message = format('EBMR-L3-104 a newer state of decommissioning task %s is applied already', p ->> 'taskId');
    end if;
    insert into tab.l3_decommission_task (message_id, task_id, pool_id, batch_id, serial_count, reason, state, changed_at, source, recorded_by, correlation_id)
    values (m.id, p ->> 'taskId', sp.pool_id, sp.batch_id, (p ->> 'serialCount')::numeric, p ->> 'reason', p ->> 'state', v_at, 'FEED',
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  end if;
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', v_type, 'rowId', v_id);
end
$$;

-- D-P6c-14 (header). p_task: the L3's DecommissionTask answer (integration-sdk serialisation wire).
create function tab.record_pool_rejection(p_pool text, p_reason text, p_task jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, platform, pg_temp as $$
declare
  v_actor jsonb;
  sp      tab.serial_pool;
  v_num   text;
begin
  perform iam.assert_not_administrator();
  select * into sp from tab.serial_pool where pool_id = p_pool;
  if sp.pool_id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-L3-106 %s is no serial pool of this site', left(coalesce(p_pool, 'NULL'), 64));
  end if;
  v_actor := iam.require_permission('QA.FLOOR_APPROVE', plant.batch_scope(sp.batch_id));
  if p_reason is null or p_reason !~ '^[\x20-\x7E]{1,500}$' or btrim(p_reason) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-L3-107 QA rejects a pool with its reason (1 to 500 printable characters)';
  end if;
  select batch_number into v_num from recipe.batch_execution where id = sp.batch_id;
  if jsonb_typeof(p_task) is distinct from 'object' or coalesce(p_task ->> 'taskId', '') !~ '^[\x21-\x7E]{1,64}$' or p_task ->> 'poolId' is distinct from sp.pool_id
     or p_task ->> 'packagingOrder' is distinct from v_num or p_task ->> 'state' is distinct from 'OPEN'
     or coalesce(p_task ->> 'createdAt', '') !~ '^(0|[1-9][0-9]{0,15})$' or jsonb_typeof(p_task -> 'serials') is distinct from 'array'
     or jsonb_array_length(p_task -> 'serials') > sp.quantity then
    raise exception using errcode = 'P0001', message = format('EBMR-L3-108 the L3 answered no OPEN decommissioning task of pool %s for packaging order %s', sp.pool_id, v_num);
  end if;
  if not exists (select 1 from tab.l3_decommission_task t where t.task_id = p_task ->> 'taskId' and t.pool_id = sp.pool_id) then
    insert into tab.l3_decommission_task (task_id, pool_id, batch_id, serial_count, reason, state, changed_at, source, recorded_by, correlation_id)
    values (p_task ->> 'taskId', sp.pool_id, sp.batch_id, jsonb_array_length(p_task -> 'serials'), btrim(p_reason), 'OPEN',
            platform.epoch_us_to_timestamptz(p_task ->> 'createdAt'), 'REJECTION', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  end if;
  return tab.batch_pools_view(sp.batch_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The serial query (PR-42, D-P6c-13; header)

create function tab.serial_lookup(p_answer jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, iam, pg_temp as $$
declare
  sp      tab.serial_pool;
  b       recipe.batch_execution;
  v_exp   jsonb;
  v_probs text[] := '{}';
  v_state text;
begin
  perform iam.require_permission('RECORD.READ', '{}'::jsonb);
  if jsonb_typeof(p_answer) is distinct from 'object' or coalesce(p_answer ->> 'serial', '') !~ '^[A-Za-z0-9/.-]{1,20}$'
     or coalesce(p_answer ->> 'poolId', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p_answer ->> 'gtin', '') !~ '^[0-9]{14}$'
     or coalesce(p_answer ->> 'packagingOrder', '') !~ '^[\x20-\x7E]{1,64}$'
     or (p_answer -> 'state' <> 'null'::jsonb and coalesce(p_answer ->> 'state', '') not in ('COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED')) then
    raise exception using errcode = 'P0001', message = 'EBMR-L3-109 the L3 answer to the serial query is not a SerialQueryAnswer';
  end if;
  select * into sp from tab.serial_pool where pool_id = p_answer ->> 'poolId';
  if sp.pool_id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-L3-110 the L3 names pool %s for serial %s, which is no serial pool of this site''s records', p_answer ->> 'poolId', p_answer ->> 'serial');
  end if;
  select * into b from recipe.batch_execution where id = sp.batch_id;
  v_exp := recipe.batch_expiry(sp.batch_id);
  if p_answer ->> 'gtin' <> sp.gtin then
    v_probs := v_probs || format('the L3 holds GTIN %s, the record %s', p_answer ->> 'gtin', sp.gtin);
  end if;
  if p_answer ->> 'packagingOrder' <> b.batch_number then
    v_probs := v_probs || format('the L3 holds packaging order %s, the record %s', p_answer ->> 'packagingOrder', b.batch_number);
  end if;
  if p_answer ? 'lot' and p_answer ->> 'lot' is distinct from b.batch_number then
    v_probs := v_probs || format('the L3 holds lot %s, the record %s', p_answer ->> 'lot', b.batch_number);
  end if;
  if p_answer ? 'expiry' and p_answer ->> 'expiry' is distinct from v_exp ->> 'expiryMonth' then
    v_probs := v_probs || format('the L3 holds expiry %s, the record %s', p_answer ->> 'expiry', coalesce(v_exp ->> 'expiryMonth', 'none'));
  end if;
  v_state := coalesce(p_answer ->> 'state', 'ISSUED');
  return jsonb_build_object(
    'serial', p_answer ->> 'serial', 'poolId', sp.pool_id, 'gtin', sp.gtin, 'market', sp.market, 'batchId', sp.batch_id,
    'lot', b.batch_number, 'expiry', v_exp ->> 'expiryMonth', 'status', v_state,
    'l3', jsonb_build_object('lot', p_answer ->> 'lot', 'expiry', p_answer ->> 'expiry', 'packagingOrder', p_answer ->> 'packagingOrder'),
    'problems', to_jsonb(v_probs));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Release (PR-42, outline 4.6; header)

create function tab.l3_release_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, platform, pg_temp as $$
declare
  sp tab.serial_pool;
  t  tab.l3_decommission_task;
  f  jsonb;
begin
  if not exists (select 1 from tab.serial_pool where batch_id = p_batch) then
    return null;
  end if;
  for sp in select * from tab.serial_pool where batch_id = p_batch order by pool_id loop
    select * into t from tab.l3_tasks_of(sp.pool_id) x where x.state = 'OPEN' order by x.task_id limit 1;
    if t.id is not null then
      return format('serial pool %s has the open decommissioning task %s (%s serials): the L3 has not reported it done (PR-42)', sp.pool_id, t.task_id, t.serial_count);
    end if;
  end loop;
  f := platform.mirror_freshness('L3_SERIAL_STATUS');
  if f ->> 'mode' = 'MIRROR' and (f ->> 'stale')::boolean then
    return format('the L3 mirror L3_SERIAL_STATUS is stale (%s, bound %s s): the serial status cannot be relied on until the L3 adapter synchronises again (PR-42)',
                  case when f ->> 'asOfUs' is null then 'never synchronised' else format('last synchronised %s s ago', f ->> 'ageSeconds') end, f ->> 'boundSeconds');
  end if;
  return null;
end
$$;

-- E.RECONCILIATION_SERIAL (tablets 1162), with the L3 problems.
create or replace function tab.grel_recon_serial(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_probs jsonb := '[]'::jsonb;
  v_prob  text := tab.serialisation_release_problem(p_order);
  v_l3    text := tab.l3_release_problem(p_order);
begin
  if v_prob is not null then
    v_probs := jsonb_build_array(tab.grel_problem(v_prob, tab.grel_batch_ev(p_order)));
  end if;
  if v_l3 is not null then
    v_probs := v_probs || jsonb_build_array(tab.grel_problem(v_l3, tab.grel_batch_ev(p_order)));
  end if;
  v_probs := v_probs || coalesce((select jsonb_agg(tab.grel_problem('a serial pool reconciled open: ' || (u ->> 'problem'), u -> 'evidence'))
                                    from jsonb_array_elements(tab.grel_unresolved(array[p_order], array['SERIAL_RECONCILIATION_OPEN'])) u), '[]'::jsonb);
  return tab.grel_item_of('E.RECONCILIATION_SERIAL', '4', 'Serial pools reconciled (PR-42)', v_probs, tab.grel_batch_ev(p_order));
end
$$;

-- The serialisation.batchPools view (contract ns/serialisation.ts BatchPoolsView).
create function tab.batch_pools_view(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, recipe, platform, pg_temp as $$
  select jsonb_build_object(
    'batchId', b.id,
    'batchNumber', b.batch_number,
    'mirror', (select jsonb_build_object('mode', f ->> 'mode', 'stale', (f ->> 'stale')::boolean, 'ageSeconds', (f ->> 'ageSeconds')::bigint,
                                         'boundSeconds', coalesce((f ->> 'boundSeconds')::bigint, platform.setting_numeric('integration.mirror_max_age_s.l3_serial_status')::bigint))
                 from (select platform.mirror_freshness('L3_SERIAL_STATUS') as f) x),
    'pools', coalesce((select jsonb_agg(jsonb_build_object(
        'poolId', sp.pool_id, 'stepKey', sp.step_key, 'market', sp.market, 'gtin', sp.gtin, 'quantity', sp.quantity::text,
        'latestReport', (select jsonb_build_object('unexplained', r.unexplained::text, 'reportHash', r.report_hash, 'fetchedAt', r.fetched_at)
                           from tab.serial_report r where r.pool_id = sp.pool_id order by r.fetched_at desc, r.id desc limit 1),
        'aggregations', coalesce((select jsonb_agg(jsonb_build_object('parentId', a.parent_sscc, 'action', a.action, 'childCount', a.child_count::text) order by a.event_time, a.received_at)
                                    from tab.l3_aggregation a where a.pool_id = sp.pool_id), '[]'::jsonb),
        'decommissionTasks', coalesce((select jsonb_agg(jsonb_build_object('taskId', t.task_id, 'state', t.state, 'serialCount', t.serial_count::text, 'reason', t.reason) order by t.task_id)
                                         from tab.l3_tasks_of(sp.pool_id) t), '[]'::jsonb)) order by sp.pool_id)
                       from tab.serial_pool sp where sp.batch_id = b.id), '[]'::jsonb),
    'releaseProblem', coalesce(tab.serialisation_release_problem(b.id), tab.l3_release_problem(b.id)))
  from recipe.batch_execution b where b.id = p_batch
$$;

revoke all on function tab.l3_tasks_of(text), tab.l3_shipper_packs(uuid, text), tab.receive_l3_message(jsonb), tab.record_pool_rejection(text, text, jsonb), tab.serial_lookup(jsonb),
  tab.l3_release_problem(uuid), tab.batch_pools_view(uuid) from public;
grant execute on function tab.receive_l3_message(jsonb), tab.record_pool_rejection(text, text, jsonb), tab.serial_lookup(jsonb), tab.l3_release_problem(uuid),
  tab.batch_pools_view(uuid) to ebmr_app;
grant select on tab.l3_aggregation, tab.l3_decommission_task to ebmr_app;

reset role;
