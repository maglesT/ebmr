-- Tablets server, Phase 3 slice 3c (builder A): the tooling register of TB-09 (punch and die custody, inspection and
-- usage count; tablets spec B.2 TB-09) and the hold of a press's output that a failed tooling or detector check raises.
-- Controls: INV-24 (tooling part: compression only with inspected tooling within its stroke limit), IN-36 (b) (punches
-- and dies inspected before and after each use; a failed after-use check covers the tablets compressed since the last
-- intact check), PR-22, PR-23, PR-27 (tooling assigned to a product); ADR 0012: the rules hold when the application's
-- own database credentials are used directly.
--
--   tab.tooling_set         a punch and die set: code, the product it is assigned to (PR-27), type, shape, upper and lower
--                           embossing, score, tips, the number of upper and lower punches and dies, and its usage limit in
--                           press strokes (MASTERDATA.CHANGE); insert-only
--   tab.tooling_inspection  an inspection of a set BEFORE issue (PRE_USE) or after its return (POST_USE, naming the issue):
--                           the checklist (tips, edges, wear, embossing, corrosion, cleanliness), the result derived from it
--                           (PASS only when every item is in order), the disposition of a failed set (REPAIR, POLISH,
--                           RETIRE; a retired set is never issued again), person and database time (STEP.EXECUTE)
--   tab.tooling_issue       a set issued to a batch for a press (a PROCESS unit of plant.equipment), on its passing
--                           pre-use inspection, with the punches and dies issued (STEP.EXECUTE)
--   tab.tooling_return      its return: the punches and dies returned (a difference is recorded as a mismatch: fragment
--                           risk), the strokes of this use counted from the press's stroke.count readings (tablets 0820,
--                           through the process devices linked to the press: tablets 0871) or, only when the press sent
--                           none, keyed by hand and flagged MANUAL; the set's cumulative strokes and whether they passed its
--                           limit (STEP.EXECUTE)
--
-- A set is issued only when (tab.tooling_issue_problem; EBMR-TOOL-020): it is assigned to the batch's product; it is
-- not retired; no issue of it is open; its last use has its after-return inspection; its latest inspection is a passing
-- pre-use inspection recorded after its last return and used by no other issue; its cumulative strokes are below its
-- limit. While issued, tab.tooling_use_problem says why it may not compress now (retired, inspection, strokes at or past
-- the limit counting the strokes of the open use so far); TB-10's press set-up and close stand on it (tablets 0874).
-- A failed after-return inspection, and a return with punches or dies missing, hold every output container of the batch
-- and press opened since the issue (tab.hold_press_output: a FAIL in-process check of plant 0420, then the containers of
-- the window; QA releases them as any held container). Messages: EBMR-TOOL-0NN.
--
-- Every table is insert-only, audited, its times the database's; the application role reads them and writes only
-- through the SECURITY DEFINER functions, which refuse administrators and check their permission (pg_temp last, ADR
-- 0016). Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tables

create table tab.tooling_set (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  product_code    text not null references plant.product (code),
  tooling_type    text not null check (tooling_type in ('B', 'D', 'BB')),
  shape           text not null check (btrim(shape) <> ''),
  upper_embossing text not null check (btrim(upper_embossing) <> ''),
  lower_embossing text not null check (btrim(lower_embossing) <> ''),
  score           text not null check (btrim(score) <> ''),
  tips            integer not null check (tips between 1 and 64),
  upper_punches   integer not null check (upper_punches between 1 and 200),
  lower_punches   integer not null check (lower_punches between 1 and 200),
  dies            integer not null check (dies between 1 and 200),
  stroke_limit    bigint not null check (stroke_limit > 0),
  person_id       uuid not null,
  account_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp()
);

create table tab.tooling_issue (
  id                     uuid primary key default gen_random_uuid(),
  set_id                 uuid not null references tab.tooling_set (id),
  batch_id               uuid not null references recipe.batch_execution (id),
  press_equipment_id     uuid not null references plant.equipment (id),
  pre_use_inspection_id  uuid not null unique,
  upper_issued           integer not null check (upper_issued >= 1),
  lower_issued           integer not null check (lower_issued >= 1),
  dies_issued            integer not null check (dies_issued >= 1),
  baseline_reading_id    uuid references tab.process_reading (id),
  person_id              uuid not null,
  account_id             uuid not null,
  issued_at              timestamptz not null default clock_timestamp()
);
create index tooling_issue_by_set on tab.tooling_issue (set_id, issued_at);

create table tab.tooling_inspection (
  id            uuid primary key default gen_random_uuid(),
  set_id        uuid not null references tab.tooling_set (id),
  kind          text not null check (kind in ('PRE_USE', 'POST_USE')),
  issue_id      uuid references tab.tooling_issue (id),
  findings      jsonb not null check (jsonb_typeof(findings) = 'object'),
  result        text not null check (result in ('PASS', 'FAIL')),
  disposition   text check (disposition in ('REPAIR', 'POLISH', 'RETIRE')),
  hold          jsonb,
  person_id     uuid not null,
  account_id    uuid not null,
  inspected_at  timestamptz not null default clock_timestamp(),
  check ((kind = 'POST_USE') = (issue_id is not null)),
  check ((result = 'PASS') = (disposition is null))
);
create unique index tooling_inspection_post_use_once on tab.tooling_inspection (issue_id) where kind = 'POST_USE';
create index tooling_inspection_by_set on tab.tooling_inspection (set_id, inspected_at);
alter table tab.tooling_issue add constraint tooling_issue_pre_use_fk foreign key (pre_use_inspection_id) references tab.tooling_inspection (id);

create table tab.tooling_return (
  issue_id            uuid primary key references tab.tooling_issue (id),
  set_id              uuid not null references tab.tooling_set (id),
  upper_returned      integer not null check (upper_returned >= 0),
  lower_returned      integer not null check (lower_returned >= 0),
  dies_returned       integer not null check (dies_returned >= 0),
  count_mismatch      boolean not null,
  strokes             bigint not null check (strokes >= 0),
  stroke_source       text not null check (stroke_source in ('PRESS_COUNTER', 'MANUAL')),
  counter_readings    integer not null check (counter_readings >= 0),
  cumulative_strokes  bigint not null check (cumulative_strokes >= 0),
  limit_exceeded      boolean not null,
  hold                jsonb,
  person_id           uuid not null,
  account_id          uuid not null,
  returned_at         timestamptz not null default clock_timestamp(),
  check (stroke_source = 'MANUAL' or counter_readings > 0)
);

select platform.enforce_db_time('tab.tooling_set', array['recorded_at']);
select platform.enforce_db_time('tab.tooling_inspection', array['inspected_at']);
select platform.enforce_db_time('tab.tooling_issue', array['issued_at']);
select platform.enforce_db_time('tab.tooling_return', array['returned_at']);
select kernel.register_audited_table('tab.tooling_set', 'tooling_set', 'id', true);
select kernel.register_audited_table('tab.tooling_inspection', 'tooling_set', 'set_id', true);
select kernel.register_audited_table('tab.tooling_issue', 'tooling_set', 'set_id', true);
select kernel.register_audited_table('tab.tooling_return', 'tooling_set', 'set_id', true);
revoke all on tab.tooling_set, tab.tooling_inspection, tab.tooling_issue, tab.tooling_return from public;
grant select on tab.tooling_set, tab.tooling_inspection, tab.tooling_issue, tab.tooling_return to ebmr_app;

-- The checklist items of a tooling inspection (tablets spec TB-09: tip damage, chipping, wear, embossing legibility,
-- corrosion, cleanliness).
create function tab.tooling_checklist_items() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['TIPS', 'EDGES', 'WEAR', 'EMBOSSING', 'CORROSION', 'CLEANLINESS']
$$;

-- ---------------------------------------------------------------------------------------------
-- The hold of a press's output (tooling and detector failures)

-- Records a FAIL in-process check of press p_press for batch p_batch (plant.record_ipc_check: the containers since the
-- last passing check are held) and holds as well every container of the batch and press whose open interval reaches into
-- (p_since, the check], and every container it was merged into. Returns {ipcCheckId, held, pending}.
create function tab.hold_press_output(p_batch uuid, p_press text, p_since timestamptz, p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, platform, pg_temp as $$
declare
  v_actor  jsonb;
  v_check  jsonb;
  k        plant.ipc_check;
  r        record;
  v_held   jsonb := '[]'::jsonb;
  v_pend   jsonb := '[]'::jsonb;
  v_state  text;
begin
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_check := plant.record_ipc_check(p_batch, p_press, null, 'FAIL', p_reference);
  select * into k from plant.ipc_check where id = (v_check ->> 'ipc_check_id')::uuid;
  for r in
    with recursive direct as (
      select c.id from plant.output_container c left join plant.container_close x on x.container_id = c.id
       where c.batch_id = p_batch and c.press_code = p_press and c.opened_at <= k.recorded_at
         and coalesce(x.closed_at, 'infinity'::timestamptz) > coalesce(p_since, '-infinity'::timestamptz)),
    reach (id, via) as (
      select d.id, null::uuid from direct d
      union
      select m.target_id, coalesce(rr.via, rr.id) from plant.container_merge m join reach rr on m.source_id = rr.id
    )
    select distinct on (x.id) x.id, x.via, c.label_code from reach x join plant.output_container c on c.id = x.id order by x.id, x.via nulls first
  loop
    insert into plant.container_hold (container_id, ipc_check_id, via_container_id, person_id, account_id)
    values (r.id, k.id, r.via, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    on conflict (container_id, ipc_check_id) do nothing;
    v_state := plant.apply_hold(r.id);
    if v_state = 'OPEN' then
      v_pend := v_pend || to_jsonb(r.label_code);
    else
      v_held := v_held || to_jsonb(r.label_code);
    end if;
  end loop;
  return jsonb_build_object('ipcCheckId', k.id,
                            'held', (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_held || (v_check -> 'held')) x),
                            'pending', (select coalesce(jsonb_agg(distinct x order by x), '[]'::jsonb) from jsonb_array_elements_text(v_pend || (v_check -> 'pending')) x));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Strokes from the press counter

-- Review 3c finding 2: the counter reading a use starts from. At issue the press's latest GOOD stroke.count actual of a
-- process device linked to it, received within the last 60 s (G-06's default stale age), is the baseline of the use; a
-- press that sent none then has no baseline, and its use is counted only as a lower bound (tab.issue_strokes) that a
-- keyed count must cover at the return.
create function tab.press_counter_baseline(p_press uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select r.id from tab.process_reading r join tab.process_device_unit u on u.process_device_id = r.process_device_id
    join tab.process_device d on d.id = r.process_device_id
   where u.equipment_id = p_press and d.ended_at is null and r.tag = 'stroke.count' and r.kind = 'ACTUAL' and r.quality = 'GOOD'
     and r.received_at >= clock_timestamp() - interval '60 seconds'
   order by r.received_at desc, r.seq desc limit 1
$$;

-- The strokes of the use of issue p_issue up to p_to, from the press counter: with a baseline, the increments of the
-- baseline device's stroke.count readings from the baseline on; without one, the increments of the readings of the
-- press's devices received after the issue (the first one only a starting point: a lower bound). A counter that went
-- down restarted, so its new value is the increment. Returns {strokes, readings (received after the issue), baselined,
-- lastAt (the latest counter reading), crossedAt (the reception of the first reading at which the strokes of the use
-- passed p_remaining, when given)}.
create function tab.issue_strokes(p_issue uuid, p_to timestamptz, p_remaining bigint default null) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  with u as (select * from tab.tooling_issue where id = p_issue),
  b as (select r.* from tab.process_reading r join u on r.id = u.baseline_reading_id),
  chain as (
    select r.process_device_id as dev, r.seq, r.value::numeric as v, r.received_at, r.id = (select id from b) as base
      from tab.process_reading r, u
     where u.baseline_reading_id is not null and r.process_device_id = (select process_device_id from b) and r.seq >= (select seq from b)
       and r.tag = 'stroke.count' and r.kind = 'ACTUAL' and r.quality = 'GOOD' and r.received_at <= p_to
    union all
    select r.process_device_id, r.seq, r.value::numeric, r.received_at, false
      from tab.process_reading r join tab.process_device_unit d on d.process_device_id = r.process_device_id, u
     where u.baseline_reading_id is null and d.equipment_id = u.press_equipment_id and r.received_at > u.issued_at and r.received_at <= p_to
       and r.tag = 'stroke.count' and r.kind = 'ACTUAL' and r.quality = 'GOOD'
  ),
  steps as (
    select dev, seq, received_at, base,
           case when lag(v) over w is null then 0 when v >= lag(v) over w then v - lag(v) over w else v end as inc
      from chain window w as (partition by dev order by seq)
  ),
  running as (
    select received_at, base, inc, sum(inc) over (order by received_at, dev, seq) as total from steps
  )
  select jsonb_build_object('strokes', coalesce((select sum(inc) from running), 0)::bigint,
                            'readings', (select count(*) from running where not base),
                            'baselined', (select baseline_reading_id is not null from u),
                            'lastAt', (select max(received_at) from running),
                            'crossedAt', (select min(received_at) from running where p_remaining is not null and total > p_remaining))
$$;

-- ---------------------------------------------------------------------------------------------
-- Rules

-- The set's cumulative strokes over its returned uses.
create function tab.tooling_cumulative(p_set uuid) returns bigint
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(sum(strokes), 0)::bigint from tab.tooling_return where set_id = p_set
$$;

-- Why set p_set is not fit for use (retired, its latest inspection failed), or NULL.
create function tab.tooling_fit_problem(p_set uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  s tab.tooling_set;
  i tab.tooling_inspection;
begin
  select * into s from tab.tooling_set where id = p_set;
  if not found then
    return 'the tooling set does not exist';
  end if;
  if exists (select 1 from tab.tooling_inspection x where x.set_id = p_set and x.disposition = 'RETIRE') then
    return format('set %s is retired', s.code);
  end if;
  select * into i from tab.tooling_inspection x where x.set_id = p_set order by x.inspected_at desc, x.id desc limit 1;
  if i.id is not null and i.result = 'FAIL' then
    return format('the latest inspection of set %s failed (%s)', s.code, i.disposition);
  end if;
  return null;
end
$$;

-- EBMR-TOOL-020 (header): why set p_set cannot be issued to a batch of product p_product now, or NULL.
create function tab.tooling_issue_problem(p_set uuid, p_product text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  s        tab.tooling_set;
  v_last   tab.tooling_issue;
  v_ret    tab.tooling_return;
  i        tab.tooling_inspection;
  v_cum    bigint;
begin
  select * into s from tab.tooling_set where id = p_set;
  if not found then
    return 'the tooling set does not exist';
  end if;
  if s.product_code is distinct from p_product then
    return format('set %s is assigned to product %s, not to %s (PR-27)', s.code, s.product_code, coalesce(p_product, '(none)'));
  end if;
  if exists (select 1 from tab.tooling_inspection x where x.set_id = p_set and x.disposition = 'RETIRE') then
    return format('set %s is retired', s.code);
  end if;
  select * into v_last from tab.tooling_issue x where x.set_id = p_set order by x.issued_at desc, x.id desc limit 1;
  if v_last.id is not null then
    select * into v_ret from tab.tooling_return r where r.issue_id = v_last.id;
    if v_ret.issue_id is null then
      return format('set %s is issued to another use and not returned', s.code);
    end if;
    if not exists (select 1 from tab.tooling_inspection x where x.issue_id = v_last.id and x.kind = 'POST_USE') then
      return format('set %s has no inspection after its last return (IN-36 (b))', s.code);
    end if;
  end if;
  select * into i from tab.tooling_inspection x where x.set_id = p_set order by x.inspected_at desc, x.id desc limit 1;
  if i.id is null or i.kind <> 'PRE_USE' or (v_ret.issue_id is not null and i.inspected_at < v_ret.returned_at) then
    return format('set %s has no inspection before this use (IN-36 (b))', s.code);
  end if;
  if i.result <> 'PASS' then
    return format('the pre-use inspection of set %s failed', s.code);
  end if;
  if exists (select 1 from tab.tooling_issue x where x.pre_use_inspection_id = i.id) then
    return format('the pre-use inspection of set %s was used for an earlier issue', s.code);
  end if;
  v_cum := tab.tooling_cumulative(p_set);
  if v_cum >= s.stroke_limit then
    return format('set %s has %s strokes, at or past its limit of %s (INV-24)', s.code, v_cum, s.stroke_limit);
  end if;
  return null;
end
$$;

-- INV-24 (header): why the set of issue p_issue may not compress now (returned, retired, inspection failed, its strokes
-- with those of this open use so far at or past its limit), or NULL. {problem, strokes, cumulative}.
create function tab.tooling_use_problem(p_issue uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  u       tab.tooling_issue;
  s       tab.tooling_set;
  v_fit   text;
  v_live  bigint;
  v_cum   bigint;
begin
  select * into u from tab.tooling_issue where id = p_issue;
  if not found then
    return 'the tooling issue does not exist';
  end if;
  select * into s from tab.tooling_set where id = u.set_id;
  if exists (select 1 from tab.tooling_return r where r.issue_id = p_issue) then
    return format('set %s was returned', s.code);
  end if;
  v_fit := tab.tooling_fit_problem(u.set_id);
  if v_fit is not null then
    return v_fit;
  end if;
  if not exists (select 1 from tab.tooling_inspection i where i.id = u.pre_use_inspection_id and i.result = 'PASS') then
    return format('set %s has no passing inspection before this use', s.code);
  end if;
  v_live := (tab.issue_strokes(u.id, clock_timestamp()) ->> 'strokes')::bigint;
  v_cum := tab.tooling_cumulative(u.set_id) + v_live;
  if v_cum >= s.stroke_limit then
    return format('set %s has %s strokes with this use, at or past its limit of %s (INV-24)', s.code, v_cum, s.stroke_limit);
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Commands

-- MASTERDATA.CHANGE. p_def: {code, product, type, shape, upperEmbossing, lowerEmbossing, score, tips, upperPunches,
-- lowerPunches, dies, strokeLimit} (counts and the limit as whole-number text).
create function tab.define_tooling_set(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if jsonb_typeof(p_def) is distinct from 'object'
     or exists (select 1 from unnest(array['tips', 'upperPunches', 'lowerPunches', 'dies', 'strokeLimit']) k where coalesce(p_def ->> k, '') !~ '^[0-9]{1,18}$') then
    raise exception using errcode = 'P0001', message = 'A tooling set states its tips, punches, dies and stroke limit as whole numbers (EBMR-TOOL-001)';
  end if;
  perform plant.require_product(p_def ->> 'product');
  insert into tab.tooling_set (code, product_code, tooling_type, shape, upper_embossing, lower_embossing, score, tips, upper_punches, lower_punches, dies,
                               stroke_limit, person_id, account_id)
  values (p_def ->> 'code', p_def ->> 'product', p_def ->> 'type', p_def ->> 'shape', p_def ->> 'upperEmbossing', p_def ->> 'lowerEmbossing', p_def ->> 'score',
          (p_def ->> 'tips')::integer, (p_def ->> 'upperPunches')::integer, (p_def ->> 'lowerPunches')::integer, (p_def ->> 'dies')::integer,
          (p_def ->> 'strokeLimit')::bigint, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function tab.tooling_set_by_code(p_code text, p_lock boolean) returns tab.tooling_set
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  s tab.tooling_set;
begin
  if p_lock then
    select * into s from tab.tooling_set where code = p_code for update;
  else
    select * into s from tab.tooling_set where code = p_code;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = format('%s is no tooling set of the register (EBMR-TOOL-002)', coalesce(p_code, '(none)'));
  end if;
  return s;
end
$$;

-- STEP.EXECUTE (the set's product; for an after-return inspection the batch's). p_kind PRE_USE (p_issue NULL) or
-- POST_USE (p_issue: a returned issue of the set not yet inspected); p_findings {item: true|false} for every checklist
-- item; p_disposition when an item is not in order (REPAIR, POLISH, RETIRE). A failed POST_USE inspection holds the
-- press output of the batch since the issue (IN-36 (b)). Returns {inspectionId, result, hold}.
create function tab.inspect_tooling(p_set text, p_kind text, p_issue uuid, p_findings jsonb, p_disposition text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor  jsonb;
  s        tab.tooling_set;
  u        tab.tooling_issue;
  v_result text;
  v_hold   jsonb;
  v_id     uuid;
  v_items  text[] := tab.tooling_checklist_items();
begin
  perform iam.assert_not_administrator();
  s := tab.tooling_set_by_code(p_set, true);
  if p_kind = 'POST_USE' then
    select * into u from tab.tooling_issue where id = p_issue and set_id = s.id;
    if not found then
      raise exception using errcode = 'P0001', message = format('Issue %s is no issue of set %s (EBMR-TOOL-010)', coalesce(p_issue::text, '(none)'), s.code);
    end if;
    v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(u.batch_id));
    if not exists (select 1 from tab.tooling_return r where r.issue_id = u.id) then
      raise exception using errcode = 'P0001', message = format('Set %s is inspected after use once it is returned (IN-36 (b); EBMR-TOOL-011)', s.code);
    end if;
    if exists (select 1 from tab.tooling_inspection i where i.issue_id = u.id and i.kind = 'POST_USE') then
      raise exception using errcode = 'P0001', message = format('This use of set %s was inspected after return already (EBMR-TOOL-011)', s.code);
    end if;
  elsif p_kind = 'PRE_USE' then
    v_actor := iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', s.product_code));
    if p_issue is not null then
      raise exception using errcode = 'P0001', message = 'A pre-use inspection names no issue (EBMR-TOOL-010)';
    end if;
    if exists (select 1 from tab.tooling_issue x where x.set_id = s.id and not exists (select 1 from tab.tooling_return r where r.issue_id = x.id)) then
      raise exception using errcode = 'P0001', message = format('Set %s is issued; it is inspected after its return (IN-36 (b); EBMR-TOOL-011)', s.code);
    end if;
  else
    raise exception using errcode = 'P0001', message = 'An inspection is PRE_USE or POST_USE (EBMR-TOOL-010)';
  end if;
  if jsonb_typeof(p_findings) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_findings) k where k <> all (v_items))
     or exists (select 1 from unnest(v_items) k where jsonb_typeof(p_findings -> k) is distinct from 'boolean') then
    raise exception using errcode = 'P0001',
      message = format('An inspection records every checklist item (%s) as in order or not (IN-36 (b); EBMR-TOOL-012)', array_to_string(v_items, ', '));
  end if;
  v_result := case when exists (select 1 from unnest(v_items) k where (p_findings -> k) = 'false'::jsonb) then 'FAIL' else 'PASS' end;
  if (v_result = 'PASS') <> (p_disposition is null) then
    raise exception using errcode = 'P0001',
      message = format('A failed inspection states the disposition of the set (REPAIR, POLISH or RETIRE); a passing one none (result %s; EBMR-TOOL-013)', v_result);
  end if;
  if v_result = 'FAIL' and p_kind = 'POST_USE' then
    v_hold := tab.hold_press_output(u.batch_id, (select e.code from plant.equipment e where e.id = u.press_equipment_id), u.issued_at,
                                    format('TOOLING %s failed after use', s.code));
  end if;
  insert into tab.tooling_inspection (set_id, kind, issue_id, findings, result, disposition, hold, person_id, account_id)
  values (s.id, p_kind, p_issue, p_findings, v_result, p_disposition, v_hold, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('inspectionId', v_id, 'result', v_result, 'hold', v_hold);
end
$$;

-- STEP.EXECUTE (the batch's product). Issues set p_set to batch p_batch for press p_press (a PROCESS unit of the plant)
-- on its passing pre-use inspection; p_counts {upper, lower, dies} at most the set's (EBMR-TOOL-020, header).
create function tab.issue_tooling(p_set text, p_batch uuid, p_press text, p_counts jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, recipe, iam, pg_temp as $$
declare
  v_actor   jsonb;
  s         tab.tooling_set;
  e         plant.equipment;
  i         tab.tooling_inspection;
  v_problem text;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  s := tab.tooling_set_by_code(p_set, true);
  v_problem := plant.press_unit_problem(p_press);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Tooling is issued for a press of the plant: %s (PR-22; EBMR-TOOL-021)', v_problem);
  end if;
  select * into e from plant.equipment where code = p_press;
  v_problem := tab.tooling_issue_problem(s.id, recipe.batch_product(p_batch) ->> 'code');
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Set %s cannot be issued: %s (INV-24, IN-36 (b), PR-27; EBMR-TOOL-020)', s.code, v_problem);
  end if;
  if jsonb_typeof(p_counts) is distinct from 'object'
     or exists (select 1 from unnest(array['upper', 'lower', 'dies']) k where coalesce(p_counts ->> k, '') !~ '^[0-9]{1,4}$' or (p_counts ->> k)::integer < 1)
     or (p_counts ->> 'upper')::integer > s.upper_punches or (p_counts ->> 'lower')::integer > s.lower_punches or (p_counts ->> 'dies')::integer > s.dies then
    raise exception using errcode = 'P0001',
      message = format('The punches and dies issued are counted, at least one each and never more than set %s holds (%s, %s, %s) (EBMR-TOOL-022)', s.code, s.upper_punches,
                       s.lower_punches, s.dies);
  end if;
  select * into i from tab.tooling_inspection x where x.set_id = s.id order by x.inspected_at desc, x.id desc limit 1;
  insert into tab.tooling_issue (set_id, batch_id, press_equipment_id, pre_use_inspection_id, upper_issued, lower_issued, dies_issued, baseline_reading_id,
                                 person_id, account_id)
  values (s.id, p_batch, e.id, i.id, (p_counts ->> 'upper')::integer, (p_counts ->> 'lower')::integer, (p_counts ->> 'dies')::integer,
          tab.press_counter_baseline(e.id), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('issueId', v_id, 'set', s.code, 'press', e.code, 'preUseInspectionId', i.id);
end
$$;

-- STEP.EXECUTE (the batch's product). Returns the set of open issue p_issue: p_counts {upper, lower, dies}; the strokes
-- of the use from the press counter, or p_manual_strokes only when the press sent no counter reading in the use. A
-- difference from the counts issued is recorded and holds the press output since the issue (fragment risk). Returns
-- {issueId, strokes, strokeSource, cumulative, limitExceeded, countMismatch, hold}.
create function tab.return_tooling(p_issue uuid, p_counts jsonb, p_manual_strokes text default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor    jsonb;
  u          tab.tooling_issue;
  s          tab.tooling_set;
  v_count    jsonb;
  v_strokes  bigint;
  v_source   text;
  v_cum      bigint;
  v_mismatch boolean;
  v_hold     jsonb;
  v_prior    bigint;
begin
  perform iam.assert_not_administrator();
  select * into u from tab.tooling_issue where id = p_issue;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown tooling issue %s (EBMR-TOOL-030)', coalesce(p_issue::text, '(none)'));
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(u.batch_id));
  select * into s from tab.tooling_set where id = u.set_id for update;
  if exists (select 1 from tab.tooling_return r where r.issue_id = p_issue) then
    raise exception using errcode = 'P0001', message = format('Set %s was returned already (EBMR-TOOL-030)', s.code);
  end if;
  if jsonb_typeof(p_counts) is distinct from 'object'
     or exists (select 1 from unnest(array['upper', 'lower', 'dies']) k where coalesce(p_counts ->> k, '') !~ '^[0-9]{1,4}$') then
    raise exception using errcode = 'P0001', message = 'The punches and dies returned are counted as whole numbers (EBMR-TOOL-031)';
  end if;
  v_prior := tab.tooling_cumulative(s.id);
  v_count := tab.issue_strokes(p_issue, clock_timestamp(), s.stroke_limit - v_prior);
  -- Review 3c finding 2: the counter decides only from a baseline at issue to a reading at most 60 s old now; otherwise
  -- the strokes after its last reading (or before its first) are unseen, and the count is keyed, flagged MANUAL, never
  -- below what the counter saw.
  if (v_count -> 'baselined') = 'true'::jsonb and (v_count ->> 'lastAt')::timestamptz >= clock_timestamp() - interval '60 seconds' then
    if p_manual_strokes is not null then
      raise exception using errcode = 'P0001', message = format('The press counted the strokes of this use; a keyed count is refused (DI-31; EBMR-TOOL-032)');
    end if;
    v_strokes := (v_count ->> 'strokes')::bigint;
    v_source := 'PRESS_COUNTER';
  else
    if coalesce(p_manual_strokes, '') !~ '^[0-9]{1,18}$' then
      raise exception using errcode = 'P0001',
        message = 'The press counter did not see the whole use (no baseline at issue, or no reading in the last 60 s): key the count read from the press (flagged MANUAL) (DI-31; EBMR-TOOL-032)';
    end if;
    if p_manual_strokes::bigint < (v_count ->> 'strokes')::bigint then
      raise exception using errcode = 'P0001',
        message = format('The keyed count %s is below the %s strokes the press counter saw in this use (DI-31; EBMR-TOOL-033)', p_manual_strokes, v_count ->> 'strokes');
    end if;
    v_strokes := p_manual_strokes::bigint;
    v_source := 'MANUAL';
  end if;
  v_cum := v_prior + v_strokes;
  v_mismatch := (p_counts ->> 'upper')::integer <> u.upper_issued or (p_counts ->> 'lower')::integer <> u.lower_issued
                or (p_counts ->> 'dies')::integer <> u.dies_issued;
  -- Fragment risk: the output since the issue; review 3c finding 1: past the limit, the output since the counter crossed
  -- it (since the issue when the crossing is not known from the counter).
  if v_mismatch or v_cum > s.stroke_limit then
    v_hold := tab.hold_press_output(u.batch_id, (select e.code from plant.equipment e where e.id = u.press_equipment_id),
                                    case when not v_mismatch and v_source = 'PRESS_COUNTER' and v_count ->> 'crossedAt' is not null
                                         then (v_count ->> 'crossedAt')::timestamptz - interval '1 microsecond' else u.issued_at end,
                                    format('TOOLING %s %s', s.code, case when v_mismatch then 'returned incomplete' else 'past its stroke limit' end));
  end if;
  insert into tab.tooling_return (issue_id, set_id, upper_returned, lower_returned, dies_returned, count_mismatch, strokes, stroke_source, counter_readings,
                                  cumulative_strokes, limit_exceeded, hold, person_id, account_id)
  values (p_issue, s.id, (p_counts ->> 'upper')::integer, (p_counts ->> 'lower')::integer, (p_counts ->> 'dies')::integer, v_mismatch, v_strokes, v_source,
          (v_count ->> 'readings')::integer, v_cum, v_cum > s.stroke_limit, v_hold, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('issueId', p_issue, 'strokes', v_strokes::text, 'strokeSource', v_source, 'cumulative', v_cum::text,
                            'limitExceeded', v_cum > s.stroke_limit, 'countMismatch', v_mismatch, 'hold', v_hold);
end
$$;

revoke all on function tab.tooling_checklist_items(), tab.hold_press_output(uuid, text, timestamptz, text), tab.press_counter_baseline(uuid), tab.issue_strokes(uuid, timestamptz, bigint),
  tab.tooling_cumulative(uuid), tab.tooling_fit_problem(uuid), tab.tooling_issue_problem(uuid, text), tab.tooling_use_problem(uuid),
  tab.define_tooling_set(jsonb), tab.tooling_set_by_code(text, boolean), tab.inspect_tooling(text, text, uuid, jsonb, text),
  tab.issue_tooling(text, uuid, text, jsonb), tab.return_tooling(uuid, jsonb, text) from public;
grant execute on function tab.define_tooling_set(jsonb), tab.inspect_tooling(text, text, uuid, jsonb, text), tab.issue_tooling(text, uuid, text, jsonb),
  tab.return_tooling(uuid, jsonb, text), tab.tooling_issue_problem(uuid, text), tab.tooling_use_problem(uuid), tab.issue_strokes(uuid, timestamptz, bigint),
  tab.tooling_checklist_items() to ebmr_app;

reset role;
