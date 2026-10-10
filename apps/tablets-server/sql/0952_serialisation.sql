-- Tablets server, Phase 3 slice 4a (builder B; G-21, tablets spec K-21; outline L-53; default D-S4-1): the serial pools
-- the server requests from the site's L3 system per packaging order and market, the serial events it sends, the L3
-- report it fetches with its hash, how the G-21 entries stand on them, the release-gate check and the order-completion
-- guard (controls PR-42, IN-31; ADR 0012: the rules hold when the application's own database credentials are used
-- directly). Unit serials and aggregation stay in the L3 system: the record keeps the pool id, the counts, the
-- reconciliation and the hash-referenced report (L-53). Wire formats: integration-sdk serialisation/wire.ts.
--
--   tab.serial_pool         insert-only, audited: one pool the L3 system issued for a G-21 step of a packaging order and
--                           one serialised market (EU -> EU_FMD, US -> US_DSCSA; India's Schedule H2 is a batch-level
--                           code, never a pool), with the master's GTIN and the quantity asked and issued (the count of
--                           serials the L3 answered, never the serials) (STEP.EXECUTE)
--   tab.serial_event_upload insert-only: the counts per state of each batch of serial events the server sent (the L3
--                           system took it whole)
--   tab.serial_report       insert-only, audited: each report the server fetched: counts per state, unexplained and the
--                           report hash (the server checks the hash against the canonical report before recording)
--   tab.g21_job_pool        (replacing 0951's) the pool a print job of the step carries for its market
--   tab.serialisation_release_problem(batch): the release-gate check the Phase 4 gate calls: every serialised market of
--                           every G-21 step of the batch has its pool, the pool's latest report closes with zero
--                           unexplained and every serial in an end state, and the record's closed SERIAL_RECONCILIATION
--                           of that pool names that report's hash. Fails closed: NULL only when all hold.
--   trigger af_tab_g21_serial_entries on recipe.execution_command (before insert; accepted and refused rows alike): a
--                           SERIAL_POOL entry is exactly a pool recorded for this batch's step (id, market, GTIN,
--                           quantity); a SERIAL_RECONCILIATION entry exactly the latest report of that pool (EBMR-EXE-297)
--   trigger zs_tab_serial_completion on recipe.execution_state (after update): a batch whose MBR serialises reaches
--                           EXECUTION_COMPLETE only when tab.serialisation_release_problem is NULL: the packaging order
--                           does not complete without its serial reconciliation (PR-42) (EBMR-EXE-298).
--
-- Privileges: the application role SELECTs the tables and EXECUTEs the writers and the gate check.

set local role ebmr_owner;

-- The L3 market profile of batch market p_market (D-S4-1), or NULL when its packs carry no unit serials.
create function tab.l3_market(p_market text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_market when 'EU' then 'EU_FMD' when 'US' then 'US_DSCSA' end
$$;

create table tab.serial_pool (
  pool_id             text primary key check (pool_id ~ '^[!-~]{1,64}$'),
  batch_id            uuid not null references recipe.batch_execution (id),
  step_key            text not null,
  step                text not null,
  market              text not null,
  l3_market           text not null check (l3_market in ('EU_FMD', 'US_DSCSA')),
  gtin                text not null check (gtin ~ '^[0-9]{14}$'),
  quantity            numeric not null check (quantity > 0 and scale(quantity) = 0),
  issued_at_us        bigint not null check (issued_at_us >= 0),
  requested_by_person uuid not null,
  requested_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  correlation_id      uuid not null,
  unique (batch_id, step_key, market)
);
revoke all on tab.serial_pool from public;
create trigger aa_serial_pool_insert_only before update or delete on tab.serial_pool for each row execute function kernel.reject_mutation();
create trigger aa_serial_pool_no_truncate before truncate on tab.serial_pool for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.serial_pool', array['recorded_at']);
select kernel.register_audited_table('tab.serial_pool', 'batch', 'batch_id', true);

create table tab.serial_event_upload (
  id          uuid primary key default gen_random_uuid(),
  pool_id     text not null references tab.serial_pool (pool_id),
  counts      jsonb not null check (jsonb_typeof(counts) = 'object'),
  sent_by     uuid not null,
  sent_at     timestamptz not null default clock_timestamp()
);
revoke all on tab.serial_event_upload from public;
create trigger aa_serial_event_upload_insert_only before update or delete on tab.serial_event_upload for each row execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.serial_event_upload', array['sent_at']);
select kernel.register_audited_table('tab.serial_event_upload', 'serial_pool', 'pool_id', true);

create table tab.serial_report (
  id             uuid primary key default gen_random_uuid(),
  pool_id        text not null references tab.serial_pool (pool_id),
  counts         jsonb not null check (jsonb_typeof(counts) = 'object'),
  unexplained    numeric not null check (unexplained >= 0 and scale(unexplained) = 0),
  report_hash    text not null check (report_hash ~ '^[0-9a-f]{64}$'),
  fetched_by     uuid not null,
  fetched_at     timestamptz not null default clock_timestamp()
);
revoke all on tab.serial_report from public;
create trigger aa_serial_report_insert_only before update or delete on tab.serial_report for each row execute function kernel.reject_mutation();
create trigger aa_serial_report_no_truncate before truncate on tab.serial_report for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.serial_report', array['fetched_at']);
select kernel.register_audited_table('tab.serial_report', 'serial_pool', 'pool_id', true);

-- The latest report of pool p_pool, when no serial event was recorded after it (review 4a MEDIUM 3: an event after a
-- report makes it stale), else NULL.
create function tab.latest_serial_report(p_pool text) returns tab.serial_report
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select r from tab.serial_report r where r.pool_id = p_pool
     and not exists (select 1 from tab.serial_event_upload u where u.pool_id = p_pool and u.sent_at >= r.fetched_at)
   order by r.fetched_at desc, r.id desc limit 1
$$;

-- The step's G-21 configuration and the L3 profile of market p_market, refusing a market the step does not serialise.
create function tab.serialised_market(p_cfg jsonb, p_header jsonb, p_market text) returns text
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
begin
  if not coalesce((p_cfg -> 'serialisation' -> 'markets') ? p_market, false) or not coalesce((p_header -> 'marketSet') ? p_market, false) then
    raise exception using errcode = 'P0001', message = format('%s is not a serialised market of this step and batch (PR-42). [EBMR-EXE-297]', left(coalesce(p_market, 'NULL'), 16));
  end if;
  if tab.l3_market(p_market) is null then
    raise exception using errcode = 'P0001',
      message = format('%s packs carry no unit serials (a batch-level code), so no serial pool is requested for them (D-S4-1, PR-42). [EBMR-EXE-297]', p_market);
  end if;
  return tab.l3_market(p_market);
end
$$;

-- PR-42: the L3 pool request (integration-sdk PoolRequest) for G-21 step p_key of batch p_batch and market p_market:
-- the packaging order, the L3 profile and the master's GTIN come from the record, never from the caller.
create function tab.serial_pool_request(p_batch uuid, p_key text, p_market text, p_quantity text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_step jsonb;
  v_l3   text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_step := tab.g21_open_step(p_batch, p_key);
  v_l3 := tab.serialised_market(v_step -> 'cfg', v_step -> 'header', p_market);
  if coalesce(p_quantity, '') !~ '^[1-9][0-9]{0,5}$' or p_quantity::numeric > 100000 then
    raise exception using errcode = 'P0001', message = 'A pool is 1 to 100000 serials (PR-42). [EBMR-EXE-297]';
  end if;
  return jsonb_build_object('packagingOrder', (select b.batch_number from recipe.batch_execution b where b.id = p_batch), 'market', v_l3,
                            'gtin', v_step -> 'cfg' -> 'markets' -> p_market ->> 'gtin', 'quantity', p_quantity);
end
$$;

-- PR-42 (header): the pool p_answer ({poolId, issued, issuedAt}: the L3 answer with its serials counted by the server)
-- the L3 system issued for G-21 step p_key of batch p_batch and market p_market, for p_quantity serials.
create function tab.record_serial_pool(p_batch uuid, p_key text, p_market text, p_quantity text, p_answer jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_step  jsonb;
  v_cfg   jsonb;
  v_l3    text;
  v_gtin  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_step := tab.g21_open_step(p_batch, p_key);
  v_cfg := v_step -> 'cfg';
  v_l3 := tab.serialised_market(v_cfg, v_step -> 'header', p_market);
  v_gtin := v_cfg -> 'markets' -> p_market ->> 'gtin';
  if coalesce(p_quantity, '') !~ '^[1-9][0-9]{0,5}$' or p_quantity::numeric > 100000 then
    raise exception using errcode = 'P0001', message = 'A pool is 1 to 100000 serials (PR-42). [EBMR-EXE-297]';
  end if;
  if jsonb_typeof(p_answer) is distinct from 'object' or coalesce(p_answer ->> 'poolId', '') !~ '^[!-~]{1,64}$'
     or (p_answer ->> 'issued') is distinct from p_quantity or (p_answer ->> 'issuedAt') !~ '^(0|[1-9][0-9]{0,17})$' then
    raise exception using errcode = 'P0001', message = 'The L3 system''s answer is no pool of the quantity asked (PR-42, DI-31). [EBMR-EXE-297]';
  end if;
  if exists (select 1 from tab.serial_pool p where p.batch_id = p_batch and p.step_key = p_key and p.market = p_market) then
    raise exception using errcode = 'P0001', message = format('The step has its %s pool already (PR-42). [EBMR-EXE-297]', p_market);
  end if;
  insert into tab.serial_pool (pool_id, batch_id, step_key, step, market, l3_market, gtin, quantity, issued_at_us, requested_by_person, requested_by_account, correlation_id)
  values (p_answer ->> 'poolId', p_batch, p_key, v_step -> 'inst' ->> 'step', p_market, v_l3, v_gtin, p_quantity::numeric, (p_answer ->> 'issuedAt')::bigint,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('poolId', p_answer ->> 'poolId', 'market', p_market, 'l3Market', v_l3, 'gtin', v_gtin, 'quantity', p_quantity);
end
$$;

-- The pool a print job carries (replacing 0951's stand-in).
create or replace function tab.g21_job_pool(p_batch uuid, p_key text, p_market text) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select p.pool_id from tab.serial_pool p where p.batch_id = p_batch and p.step_key = p_key and p.market = p_market
$$;

-- The pool p_pool of a batch the actor may act on (STEP.EXECUTE at the batch's scope).
create function tab.acting_pool(p_pool text) returns tab.serial_pool
language plpgsql stable security definer set search_path = pg_catalog, tab, iam, plant, pg_temp as $$
declare
  p tab.serial_pool;
begin
  perform iam.assert_not_administrator();
  select * into p from tab.serial_pool where pool_id = p_pool;
  if p.pool_id is null then
    raise exception using errcode = 'P0001', message = format('%s is no serial pool of this site (PR-42). [EBMR-EXE-297]', left(coalesce(p_pool, 'NULL'), 64));
  end if;
  perform iam.require_permission('STEP.EXECUTE', plant.batch_scope(p.batch_id));
  return p;
end
$$;

-- The serial state changes the L3 contract allows, as 'FROM>TO' (NONE: issued, no state yet).
create function tab.serial_transitions() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['NONE>COMMISSIONED', 'NONE>UNUSED_RETURNED', 'NONE>DESTROYED', 'COMMISSIONED>DECOMMISSIONED', 'COMMISSIONED>DESTROYED',
               'COMMISSIONED>SAMPLE', 'DECOMMISSIONED>DESTROYED']
$$;

-- PR-42 (header; review 4a MEDIUM 3): the counts per state change ('FROM>TO') of a batch of serial events the server
-- sends the L3 system for pool p_pool; the states the pool's serials hold follow from them (tab.serial_states_of).
create function tab.record_serial_events(p_pool text, p_counts jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  p    tab.serial_pool := tab.acting_pool(p_pool);
  v_id uuid;
  v_st jsonb;
begin
  if jsonb_typeof(p_counts) is distinct from 'object' or p_counts = '{}'::jsonb
     or exists (select 1 from jsonb_each(p_counts) x where not (x.key = any (tab.serial_transitions()))
                                                         or jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ '^[1-9][0-9]{0,17}$') then
    raise exception using errcode = 'P0001', message = 'Serial events are counted per allowed state change (FROM>TO) as whole numbers (PR-42). [EBMR-EXE-297]';
  end if;
  perform 1 from tab.serial_pool where pool_id = p.pool_id for update;
  insert into tab.serial_event_upload (pool_id, counts, sent_by) values (p.pool_id, p_counts, (kernel.current_actor() ->> 'person_id')::uuid) returning id into v_id;
  v_st := tab.serial_states_of(p.pool_id);
  if exists (select 1 from jsonb_each_text(v_st) x where x.value::numeric < 0) then
    raise exception using errcode = 'P0001', message = format('The serial events of pool %s move more serials out of a state than are in it (PR-42). [EBMR-EXE-297]', p.pool_id);
  end if;
  return v_id;
end
$$;

-- The serials of pool p_pool per state as the server's recorded events leave them: {NONE, COMMISSIONED, ...} (text).
create function tab.serial_states_of(p_pool text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  with t as (
    select split_part(x.key, '>', 1) as f, split_part(x.key, '>', 2) as t, (x.value #>> '{}')::numeric as n
      from tab.serial_event_upload u, jsonb_each(u.counts) x where u.pool_id = p_pool)
  select jsonb_object_agg(s, ((case when s = 'NONE' then (select quantity from tab.serial_pool where pool_id = p_pool) else 0 end)
                              + coalesce((select sum(n) from t where t.t = s), 0) - coalesce((select sum(n) from t where t.f = s), 0))::text)
    from unnest(array['NONE', 'COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED']) s
$$;

-- PR-42 (header): the L3 report p_report (integration-sdk PoolReport; its hash checked by the server) of pool p_pool.
create function tab.record_serial_report(p_pool text, p_report jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  p    tab.serial_pool := tab.acting_pool(p_pool);
  v_c  jsonb := p_report -> 'counts';
  v_st jsonb;
begin
  perform 1 from tab.serial_pool where pool_id = p.pool_id for update;
  if jsonb_typeof(p_report) is distinct from 'object' or p_report ->> 'poolId' is distinct from p.pool_id or jsonb_typeof(v_c) is distinct from 'object'
     or (select count(*) from jsonb_each(v_c)) <> 6
     or exists (select 1 from unnest(array['issued', 'COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED']) k
                 where jsonb_typeof(v_c -> k) is distinct from 'string' or (v_c ->> k) !~ '^(0|[1-9][0-9]{0,17})$')
     or (p_report ->> 'unexplained') !~ '^(0|[1-9][0-9]{0,17})$' or coalesce(p_report ->> 'reportHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = format('The L3 report is no report of pool %s in the expected form (PR-42, DI-31). [EBMR-EXE-297]', p.pool_id);
  end if;
  if (v_c ->> 'issued')::numeric <> p.quantity then
    raise exception using errcode = 'P0001', message = format('The L3 report counts %s serials issued for pool %s, which the record holds as %s (PR-42). [EBMR-EXE-297]', v_c ->> 'issued', p.pool_id, p.quantity);
  end if;
  -- Review 4a MEDIUM 3: the report's counts are the states the server's own events leave, and its unexplained count is
  -- the serials those events left without a state.
  v_st := tab.serial_states_of(p.pool_id);
  if exists (select 1 from unnest(array['COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED']) k where (v_c ->> k)::numeric <> (v_st ->> k)::numeric)
     or (p_report ->> 'unexplained')::numeric <> (v_st ->> 'NONE')::numeric then
    raise exception using errcode = 'P0001',
      message = format('The L3 report of pool %s (%s, %s unexplained) is not what the server''s serial events leave (%s) (PR-42). [EBMR-EXE-297]', p.pool_id, v_c::text, p_report ->> 'unexplained', v_st::text);
  end if;
  insert into tab.serial_report (pool_id, counts, unexplained, report_hash, fetched_by)
  values (p.pool_id, v_c, (p_report ->> 'unexplained')::numeric, p_report ->> 'reportHash', (kernel.current_actor() ->> 'person_id')::uuid);
  return tab.serial_entry_of(p.pool_id);
end
$$;

-- The SERIAL_RECONCILIATION entry the latest report of pool p_pool gives (G-21's members), or NULL.
create function tab.serial_entry_of(p_pool text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select jsonb_build_object('kind', 'SERIAL_RECONCILIATION', 'poolId', r.pool_id, 'commissioned', r.counts -> 'COMMISSIONED', 'decommissioned', r.counts -> 'DECOMMISSIONED',
                            'destroyed', r.counts -> 'DESTROYED', 'samples', r.counts -> 'SAMPLE', 'unusedReturned', r.counts -> 'UNUSED_RETURNED',
                            'unexplained', r.unexplained::text, 'reportHash', r.report_hash)
    from tab.latest_serial_report(p_pool) r where r.id is not null
$$;

-- PR-42 (header): why batch p_batch may not be released for want of its serialisation; NULL when every serialised market
-- of its G-21 steps is reconciled. Fails closed.
create function tab.serialisation_release_problem(p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_state   jsonb;
  k         text;
  s         jsonb;
  m         text;
  p         tab.serial_pool;
  r         tab.serial_report;
begin
  if v_content is null then
    return format('batch %s is unknown', coalesce(p_batch::text, 'NULL'));
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_batch;
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x order by x.key loop
    continue when recipe.step_node(v_content, s ->> 'step') -> 'block' ->> 'type' is distinct from 'G-21';
    for m in select x from jsonb_array_elements_text(case when jsonb_typeof(recipe.g21_cfg(recipe.step_node(v_content, s ->> 'step')) -> 'serialisation' -> 'markets') = 'array'
                                                          then recipe.g21_cfg(recipe.step_node(v_content, s ->> 'step')) -> 'serialisation' -> 'markets' else '[]'::jsonb end) x
              where coalesce((v_state -> 'header' -> 'marketSet') ? x, false) and tab.l3_market(x) is not null loop
      select * into p from tab.serial_pool where batch_id = p_batch and step_key = k and market = m;
      if p.pool_id is null then
        return format('step %s has no serial pool for %s', k, m);
      end if;
      r := tab.latest_serial_report(p.pool_id);
      if r.id is null or r.unexplained <> 0
         or (select sum((r.counts ->> x)::numeric) from unnest(array['COMMISSIONED', 'DECOMMISSIONED', 'DESTROYED', 'SAMPLE', 'UNUSED_RETURNED']) x) <> p.quantity then
        return format('serial pool %s of step %s has no L3 report that closes with zero unexplained', p.pool_id, k);
      end if;
      if not exists (select 1 from jsonb_each(v_state -> 'entries') e
                      where e.value ->> 'stepKey' = k and e.value ->> 'kind' = 'SERIAL_RECONCILIATION' and e.value -> 'data' ->> 'poolId' = p.pool_id
                        and e.value -> 'data' ->> 'reportHash' = r.report_hash and (e.value -> 'data' -> 'closed') = 'true'::jsonb) then
        return format('the record of step %s holds no closed reconciliation of serial pool %s on report %s', k, p.pool_id, r.report_hash);
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- Entries (header).
create function tab.g21_serial_entry_problem(p_row recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry jsonb := p_row.command -> 'entry';
  p       tab.serial_pool;
  v_want  jsonb;
begin
  if v_entry ->> 'kind' not in ('SERIAL_POOL', 'SERIAL_RECONCILIATION') or tab.g21_command_node(p_row.batch_id, p_row.command) is null then
    return null;
  end if;
  select * into p from tab.serial_pool where pool_id = v_entry ->> 'poolId';
  if p.pool_id is null or p.batch_id <> p_row.batch_id or p.step <> (p_row.command ->> 'step') then
    return format('pool %s is no serial pool the L3 system issued for this step', left(coalesce(v_entry ->> 'poolId', '(none)'), 64));
  end if;
  v_want := case when v_entry ->> 'kind' = 'SERIAL_POOL'
                 then jsonb_build_object('kind', 'SERIAL_POOL', 'poolId', p.pool_id, 'market', p.market, 'gtin', p.gtin, 'quantity', p.quantity::text)
                 else tab.serial_entry_of(p.pool_id) end;
  if v_want is null or v_entry is distinct from v_want then
    return format('it states other facts than the L3 %s the record holds (%s)', case when v_entry ->> 'kind' = 'SERIAL_POOL' then 'pool' else 'report' end, coalesce(v_want::text, 'no report'));
  end if;
  return null;
end
$$;

create function tab.g21_serial_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.command_type is distinct from 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.g21_serial_entry_problem(new);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The %s entry of this RECORD_ENTRY row is refused: %s; pools and their reconciliation are the L3 system''s as the server recorded them (PR-42, L-53, DI-31). [EBMR-EXE-297]',
                       new.command -> 'entry' ->> 'kind', v_problem);
  end if;
  return new;
end
$$;

create trigger af_tab_g21_serial_entries before insert on recipe.execution_command for each row execute function tab.g21_serial_entry_check();

create function tab.serial_completion_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem text;
begin
  if new.state ->> 'status' is distinct from 'EXECUTION_COMPLETE' or old.state ->> 'status' = 'EXECUTION_COMPLETE' then
    return null;
  end if;
  v_problem := tab.serialisation_release_problem(new.batch_id);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The packaging order cannot complete: %s; its serial reconciliation closes with zero unexplained first (PR-42). [EBMR-EXE-298]', v_problem);
  end if;
  return null;
end
$$;

create trigger zs_tab_serial_completion after update on recipe.execution_state for each row execute function tab.serial_completion_check();

revoke all on function tab.l3_market(text), tab.serial_transitions(), tab.serial_states_of(text), tab.serial_pool_request(uuid, text, text, text), tab.latest_serial_report(text), tab.serialised_market(jsonb, jsonb, text), tab.record_serial_pool(uuid, text, text, text, jsonb),
  tab.acting_pool(text), tab.record_serial_events(text, jsonb), tab.record_serial_report(text, jsonb), tab.serial_entry_of(text), tab.serialisation_release_problem(uuid),
  tab.g21_serial_entry_problem(recipe.execution_command), tab.g21_serial_entry_check(), tab.serial_completion_check() from public;
grant execute on function tab.serial_pool_request(uuid, text, text, text), tab.record_serial_pool(uuid, text, text, text, jsonb), tab.record_serial_events(text, jsonb), tab.record_serial_report(text, jsonb),
  tab.serial_entry_of(text), tab.serial_states_of(text), tab.serialisation_release_problem(uuid) to ebmr_app;
grant select on tab.serial_pool, tab.serial_event_upload, tab.serial_report to ebmr_app;

reset role;
