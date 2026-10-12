-- Recipe core: after release: automatic suspension, re-confirmation, recall, rejection after release and disposal
-- (Phase 4 slice 5a; outline 5.2.6 "After release" and "Rejected lots"; controls L-19 (suspension and cascade), IN-29
-- (the AP's recall-assessment task), PR-46 and IN-05 (e) (disposal), INV-39, INV-05, INV-35; plan
-- docs/build-plan/phase-4/phase-4-plan.md slice 5, defaults D-5-1 to D-5-6 and D-5a-1 to D-5a-9).
--
-- Suspension (L-19; D-5-1, D-5-2, D-5-3). A cause is linked to a node of the PR-57 genealogy: a deviation-lite record
-- (any kind) linked to a lot, batch or container; a kernel incident or DI investigation linked to a batch or a material
-- lot; a revised LIMS result on a lot; an as-found calibration failure on equipment (the batches that used it since its
-- previous calibration). An AFTER INSERT trigger, in the linking transaction, finds every finished lot at or downstream of
-- the node (recipe.genealogy_downstream_lots: lot consumption, the bulk issue and packaging allocation, whole-batch
-- reprocessing parents, reprocessing and recovery additions, finished lots of a batch, returned goods) and suspends each
-- one that has a manufacturer release RELEASED (recipe.suspend_lot): every market of it decided RELEASED or CERTIFIED and
-- not yet recalled or rejected after release gets one insert-only row in recipe.release_suspension (idempotent by lot,
-- market and cause), and in the same transaction: the market events (recipe.cascade_market_dispositions), one ERP
-- stock-block message (site.request_erp_stock_block) and, when none is open, the AP's recall-assessment task (IN-29). A
-- lot not yet released only has the cause linked: the release gate blocks it already.
-- recipe.suspend_release(lot, cause) (owner only; slice 5b's amendment calls it) suspends the lot and everything
-- downstream of it.
--
-- States. recipe.after_release_state(lot, market): RECALLED or REJECTED_AFTER_RELEASE once the AP decided it for the
-- market (terminal); else RELEASE_SUSPENDED while a suspension row of the market is not covered by a re-confirmation;
-- else NULL. recipe.manufacturer_release_state reads it over a RELEASED decision (the decision stays as signed), and
-- recipe.disposition_state over a US RELEASED decision or an EU CERTIFIED outcome; a decided export market still reads
-- RELEASE_SUSPENDED while the manufacturer release is not RELEASED (INV-39). The shipping interlock (site services 0870)
-- reads these states, so a suspended, recalled or rejected lot never ships.
--
-- Acts (SECURITY DEFINER, never an administrator, the permission first, the signature the actor's own on the current
-- content; aggregate release_suspension <lot>/<market>/<act>/<n>, n the market's next decision number):
--   recipe.record_after_release_decision(lot, market, act, signature, expected epoch, text)   RELEASE.MANUFACTURER, signed
--       as AUTHORISED_PERSON, the signer outside the lot's involvement set (INV-35):
--     RECONFIRM (RELEASE_RECONFIRMED): the market RELEASE_SUSPENDED by causes of its own, every one resolved (a deviation
--       CLOSED or CANCELLED with no CONFIRMED impact for the market, D-2a-9; an incident or DI investigation no longer
--       blocking the node it was linked to; a revised result within its limits and not revised again; a calibration
--       failure by the impact assessment itself; any other kind fails closed), for US and EU the manufacturer release
--       RELEASED (INV-39), the person's impact assessment, G-REL for the market under the locks at the epoch the signer
--       evaluated (INV-05) with no RED item: the market returns to the state it had and the decision covers its causes.
--     RECALL (RECALLED) and REJECT_AFTER_RELEASE (REJECTED_AFTER_RELEASE): from RELEASE_SUSPENDED or a decided state
--       (RELEASED, CERTIFIED), with the person's reason; terminal. For IN the lot moves in the lot register in the same
--       transaction (material_lot v3: RELEASE_RECALL to RECALLED, the lot event RECALL of slice 2's register; RELEASE_REJECT
--       to REJECTED) and every export market's state is recorded (INV-39).
--     When no market of the lot is suspended any more the recall-assessment task closes, and when the manufacturer release
--       reads RELEASED again an UNBLOCK message goes to the ERP.
--   recipe.record_disposal(lot, route, quantity, return to, reference, reprocessing ref, text, signature)   RELEASE.DISPOSAL,
--       DISPOSAL_RECORDED on disposal <lot>/<sha256 of the details>: the lot REJECTED, REJECTED_AFTER_RELEASE or RECALLED for
--       IN (D-5a-4), once per lot; WITNESSED_DESTRUCTION waits for its witness; REPROCESSING names a signed reprocessing
--       authorisation or request of the same product (D-5-6); RETURN names SUPPLIER or CUSTOMER and a reference and moves
--       the lot to RETURNED; a lot whose records drew serial numbers opens a serial-decommissioning task (stub).
--   recipe.witness_disposal(disposal, signature)   STEP.WITNESS, DESTRUCTION_WITNESSED on the same record by a person other
--       than the performer (the kernel refuses it too: independent of DISPOSAL_RECORDED, performers excluded); the lot
--       moves to DESTROYED.
-- Messages: EBMR-ARL-001 to EBMR-ARL-049.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0840_after_release)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'after release: re-confirmation, recall, rejection after release and disposal (L-19, PR-46, IN-05 (e))'));

insert into iam.permission (code, domain, effect, description) values
  ('RELEASE.DISPOSAL', 'GMP', 'SIGN', 'Record the disposal of a rejected or recalled finished lot (witnessed destruction, reprocessing or return; PR-46)');
insert into iam.role_permission (role_code, permission_code) values
  ('AUTHORISED_PERSON', 'RELEASE.DISPOSAL'), ('QA_REVIEWER', 'RELEASE.DISPOSAL');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('RELEASE_RECONFIRMED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'RELEASE', 'Release re-confirmed after suspension',
   'As the authorised person, I re-confirm the release of this lot for this market: every cause of its suspension is resolved and my impact assessment is recorded.',
   array['RELEASE.MANUFACTURER'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.6 after release (L-19); INV-05; INV-35'),
  ('RECALLED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'RELEASE', 'Lot recalled for the market',
   'As the authorised person, I recall this lot from this market for the reason given.',
   array['RELEASE.MANUFACTURER'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.6 after release (L-19); IN-29'),
  ('REJECTED_AFTER_RELEASE', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'RELEASE', 'Lot rejected after release',
   'As the authorised person, I reject this released lot for this market for the reason given.',
   array['RELEASE.MANUFACTURER'], '{}', true, true, false, 'ALL_COMPONENTS', false, 'Outline 5.2.6 after release (L-19); L-20'),
  ('DISPOSAL_RECORDED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'PERFORMER', 'Disposal of a rejected lot recorded',
   'I record the disposal of this rejected lot as carried out, by the route and in the quantity stated.',
   array['RELEASE.DISPOSAL'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'PR-46; IN-05 (e); outline 5.2.6 rejected lots'),
  ('DESTRUCTION_WITNESSED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'WITNESS', 'Destruction of a rejected lot witnessed',
   'As an independent witness, I watched the destruction of this lot as recorded.',
   array['STEP.WITNESS', 'RELEASE.DISPOSAL'], array['DISPOSAL_RECORDED'], true, false, false, 'ALL_COMPONENTS', false, 'PR-46; IN-05 (e); outline 5.2.6 rejected lots');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables (insert-only, audited)
-- ---------------------------------------------------------------------------------------------

create table recipe.release_suspension (
  id             uuid primary key default gen_random_uuid(),
  lot_id         uuid not null,
  market         text not null check (market in ('IN', 'US', 'EU')),
  cause_kind     text not null check (cause_kind in ('DEVIATION', 'INCIDENT', 'DI_INVESTIGATION', 'LIMS_REVISION', 'CALIBRATION_FAILURE', 'RECORD_AMENDMENT')),
  cause_ref      text not null check (cause_ref ~ '^[!-~]{1,200}$'),
  via_kind       text not null check (via_kind in ('LOT', 'BATCH', 'EQUIPMENT')),
  via_id         uuid not null,
  label          text not null check (btrim(label) <> '' and length(label) <= 500),
  cause          jsonb not null check (jsonb_typeof(cause) = 'object'),
  prior_state    text not null check (prior_state in ('RELEASED', 'CERTIFIED')),
  xact_id        xid8 not null default pg_current_xact_id(),
  recorded_at    timestamptz not null default clock_timestamp(),
  unique (lot_id, market, cause_kind, cause_ref)
);
create index release_suspension_lot on recipe.release_suspension (lot_id, market, recorded_at);

create table recipe.after_release_decision (
  id              uuid primary key default gen_random_uuid(),
  lot_id          uuid not null,
  market          text not null check (market in ('IN', 'US', 'EU')),
  seq             integer not null check (seq >= 1),
  act             text not null check (act in ('RECONFIRM', 'RECALL', 'REJECT_AFTER_RELEASE')),
  to_state        text not null check (to_state in ('RELEASED', 'CERTIFIED', 'RECALLED', 'REJECTED_AFTER_RELEASE')),
  text            text not null check (btrim(text) <> '' and length(text) <= 4000),
  epoch           text check (epoch is null or epoch ~ '^[0-9a-f]{64}$'),
  checklist       jsonb,
  suspension_ids  uuid[] not null,
  signature_id    uuid not null unique,
  content_hash    text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  role_code       text not null,
  correlation_id  uuid not null,
  xact_id         xid8 not null default pg_current_xact_id(),
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (lot_id, market, seq),
  check ((act = 'RECONFIRM') = (epoch is not null and checklist is not null)),
  check ((act = 'RECONFIRM') = (to_state in ('RELEASED', 'CERTIFIED'))),
  check (act <> 'RECALL' or to_state = 'RECALLED'),
  check (act <> 'REJECT_AFTER_RELEASE' or to_state = 'REJECTED_AFTER_RELEASE')
);
-- RECALLED and REJECTED_AFTER_RELEASE are terminal: one per lot and market.
create unique index after_release_decision_terminal on recipe.after_release_decision (lot_id, market) where act <> 'RECONFIRM';

create table recipe.release_task (
  id          uuid primary key default gen_random_uuid(),
  lot_id      uuid not null,
  kind        text not null check (kind in ('RECALL_ASSESSMENT', 'SERIAL_DECOMMISSIONING')),
  owner_role  text not null references iam.role (code),
  cause       jsonb not null check (jsonb_typeof(cause) = 'object'),
  xact_id     xid8 not null default pg_current_xact_id(),
  opened_at   timestamptz not null default clock_timestamp()
);
create index release_task_lot on recipe.release_task (lot_id, opened_at);

create table recipe.release_task_closure (
  task_id      uuid primary key references recipe.release_task (id),
  decision_id  uuid references recipe.after_release_decision (id),
  closed_at    timestamptz not null default clock_timestamp()
);

create table recipe.lot_disposal (
  id                uuid primary key default gen_random_uuid(),
  lot_id            uuid not null unique,
  route             text not null check (route in ('WITNESSED_DESTRUCTION', 'REPROCESSING', 'RETURN')),
  quantity          numeric not null check (quantity > 0),
  unit              text not null,
  return_to         text check (return_to in ('SUPPLIER', 'CUSTOMER')),
  reference         text check (reference is null or (btrim(reference) <> '' and length(reference) <= 128)),
  reprocessing_ref  uuid,
  text              text check (text is null or (btrim(text) <> '' and length(text) <= 4000)),
  details_sha256    text not null check (details_sha256 ~ '^[0-9a-f]{64}$'),
  aggregate_id      text not null unique,
  from_state        text not null,
  signature_id      uuid not null unique,
  content_hash      text not null,
  person_id         uuid not null,
  account_id        uuid not null,
  role_code         text not null,
  xact_id           xid8 not null default pg_current_xact_id(),
  recorded_at       timestamptz not null default clock_timestamp(),
  check ((route = 'RETURN') = (return_to is not null)),
  check (route <> 'RETURN' or reference is not null),
  check ((route = 'REPROCESSING') = (reprocessing_ref is not null))
);

create table recipe.lot_disposal_witness (
  disposal_id   uuid primary key references recipe.lot_disposal (id),
  signature_id  uuid not null unique,
  person_id     uuid not null,
  account_id    uuid not null,
  xact_id       xid8 not null default pg_current_xact_id(),
  recorded_at   timestamptz not null default clock_timestamp()
);

do $$
declare
  t text;
begin
  foreach t in array array['release_suspension', 'after_release_decision', 'release_task', 'release_task_closure', 'lot_disposal', 'lot_disposal_witness'] loop
    execute format('revoke all on recipe.%I from public', t);
    execute format('grant select on recipe.%I to ebmr_app', t);
  end loop;
end
$$;
select platform.enforce_db_time('recipe.release_suspension', array['recorded_at']);
select platform.enforce_db_time('recipe.after_release_decision', array['recorded_at']);
select platform.enforce_db_time('recipe.release_task', array['opened_at']);
select platform.enforce_db_time('recipe.release_task_closure', array['closed_at']);
select platform.enforce_db_time('recipe.lot_disposal', array['recorded_at']);
select platform.enforce_db_time('recipe.lot_disposal_witness', array['recorded_at']);
select kernel.register_audited_table('recipe.release_suspension', 'release_suspension', 'lot_id', true);
select kernel.register_audited_table('recipe.after_release_decision', 'release_suspension', 'lot_id', true);
select kernel.register_audited_table('recipe.release_task', 'release_task', 'lot_id', true);
select kernel.register_audited_table('recipe.release_task_closure', 'release_task', 'task_id', true);
select kernel.register_audited_table('recipe.lot_disposal', 'disposal', 'lot_id', true);
select kernel.register_audited_table('recipe.lot_disposal_witness', 'disposal', 'disposal_id', true);

-- ---------------------------------------------------------------------------------------------
-- Genealogy (PR-57) and states
-- ---------------------------------------------------------------------------------------------

-- The finished lots downstream of a node (LOT or BATCH), the node itself excluded, at any depth.
create function recipe.genealogy_downstream_lots(p_kind text, p_id uuid) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  with recursive g(kind, id) as (
    select p_kind, p_id where p_kind in ('LOT', 'BATCH') and p_id is not null
    union
    select e.kind, e.id from g cross join lateral (
      -- a lot consumed by a batch; returned goods of a finished lot
      select 'BATCH'::text as kind, c.batch_id as id from site.lot_consumption c where g.kind = 'LOT' and c.lot_id = g.id
      union all
      select 'LOT', r.lot_id from site.returned_goods r where g.kind = 'LOT' and r.original_lot_id = g.id
      -- a batch's bulk issued to a packaging order, its packaging orders, its reprocessing children and additions, its lots
      union all
      select 'BATCH', i.order_batch_id from recipe.packaging_bulk_issue i where g.kind = 'BATCH' and i.parent_batch_id = g.id
      union all
      select 'BATCH', k from unnest(case when g.kind = 'BATCH' then recipe.packaging_children_of(g.id) else '{}'::uuid[] end) k
      union all
      select 'BATCH', p.child_batch_id from recipe.batch_parent_link p where g.kind = 'BATCH' and p.parent_batch_id = g.id
      union all
      select 'BATCH', a.batch_id from recipe.source_addition a where g.kind = 'BATCH' and a.source_batch_id = g.id
      union all
      select 'LOT', f.lot_id from site.finished_lot f where g.kind = 'BATCH' and f.batch_id = g.id) e
    where e.id is not null)
  select coalesce(array_agg(distinct g.id order by g.id), '{}') from g
   where g.kind = 'LOT' and not (g.kind = p_kind and g.id = p_id) and exists (select 1 from site.finished_lot f where f.lot_id = g.id)
$$;

-- The market was decided RELEASED (IN, US) or CERTIFIED (EU), whatever happened after.
create function recipe.market_decided_released(p_lot uuid, p_market text) returns boolean
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_market
           when 'IN' then coalesce((recipe.manufacturer_decision(p_lot)).decision = 'RELEASED', false)
           when 'US' then coalesce((recipe.us_decision(p_lot)).decision = 'RELEASED', false)
           when 'EU' then coalesce(recipe.eu_outcome(p_lot) = 'CERTIFIED', false)
           else false
         end
$$;

-- The suspension rows of the market no re-confirmation covers yet.
create function recipe.open_suspensions(p_lot uuid, p_market text) returns uuid[]
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(array_agg(s.id order by s.recorded_at, s.id), '{}') from recipe.release_suspension s
   where s.lot_id = p_lot and s.market = p_market
     and not exists (select 1 from recipe.after_release_decision d where d.lot_id = p_lot and d.market = p_market and s.id = any (d.suspension_ids))
$$;

-- L-19: the after-release state of a decided market, or NULL when nothing happened after its release.
create function recipe.after_release_state(p_lot uuid, p_market text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(
    (select d.to_state from recipe.after_release_decision d where d.lot_id = p_lot and d.market = p_market and d.act <> 'RECONFIRM'),
    case when cardinality(recipe.open_suspensions(p_lot, p_market)) > 0 then 'RELEASE_SUSPENDED' end)
$$;

-- As 0781, and over a RELEASED decision the after-release state (the decision stays as signed).
create or replace function recipe.manufacturer_release_state(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(case when (recipe.manufacturer_decision(p_lot)).decision = 'RELEASED' then recipe.after_release_state(p_lot, 'IN') end,
                  (recipe.manufacturer_decision(p_lot)).decision,
                  case when (recipe.grel_evaluate(p_lot, 'IN') ->> 'ready')::boolean then 'READY' else 'NOT_READY' end)
$$;

-- As 0822, and over a US RELEASED decision or an EU CERTIFIED outcome the after-release state.
create or replace function recipe.disposition_state(p_lot uuid, p_market text) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_mr  text;
  v_out text;
  d     recipe.us_disposition_decision;
begin
  if p_market = 'IN' then
    return recipe.manufacturer_release_state(p_lot);
  end if;
  if p_market is null or p_market not in ('US', 'EU') or recipe.market_base_set('LOT', p_lot) is null then
    return null;
  end if;
  if not (p_market = any (recipe.market_set('LOT', p_lot))) then
    return case when p_market = any (recipe.market_base_set('LOT', p_lot))
                  or exists (select 1 from recipe.market_change c where c.subject_kind = 'LOT' and c.subject_id = p_lot and c.market = p_market)
                then 'REMOVED' end;
  end if;
  if (recipe.market_ineligible_by(p_lot, p_market)).id is not null then
    return 'INELIGIBLE';
  end if;
  v_mr := recipe.manufacturer_release_state(p_lot);
  if p_market = 'US' then
    d := recipe.us_decision(p_lot);
    if d.lot_id is not null then
      if d.decision = 'RELEASED' then
        return coalesce(recipe.after_release_state(p_lot, 'US'), case when v_mr is distinct from 'RELEASED' then 'RELEASE_SUSPENDED' else 'RELEASED' end);
      end if;
      return d.decision;
    end if;
    return case when v_mr in ('READY', 'RELEASED') and (recipe.grel_evaluate(p_lot, 'US') ->> 'ready')::boolean then 'READY' else 'NOT_READY' end;
  end if;
  v_out := recipe.eu_outcome(p_lot);
  if v_out is not null then
    if v_out = 'CERTIFIED' then
      return coalesce(recipe.after_release_state(p_lot, 'EU'), case when v_mr is distinct from 'RELEASED' then 'RELEASE_SUSPENDED' else 'CERTIFIED' end);
    end if;
    return v_out;
  end if;
  return case when v_mr = 'RELEASED' and (recipe.grel_evaluate(p_lot, 'EU') ->> 'ready')::boolean then 'AWAITING_QP_CERTIFICATION' else 'NOT_READY' end;
end
$$;

-- D-5-4: why a cause of the suspension is not resolved for the market, or NULL.
create function recipe.suspension_cause_problem(p_suspension uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, records, plant, pg_temp as $$
declare
  s     recipe.release_suspension;
  v_st  text;
  v_ref text;
  r     site.lot_test_result;
begin
  select * into s from recipe.release_suspension where id = p_suspension;
  if not found then
    return 'no such suspension';
  end if;
  case s.cause_kind
    when 'DEVIATION' then
      v_st := site.deviation_state(s.cause_ref::uuid);
      select d.ref into v_ref from site.deviation d where d.id = s.cause_ref::uuid;
      if v_st is null or v_st not in ('CLOSED', 'CANCELLED') then
        return format('deviation %s is %s: a cause is resolved once its deviation is closed (D-5-4)', coalesce(v_ref, s.cause_ref), coalesce(v_st, 'unknown'));
      end if;
      if exists (select 1 from site.deviation_link k where k.deviation_id = s.cause_ref::uuid
                    and (site.deviation_latest_impact(k.id, s.market)).impact = 'CONFIRMED') then
        return format('deviation %s has a CONFIRMED impact for %s: the market is not re-confirmed on it (D-2a-9)', v_ref, s.market);
      end if;
      return null;
    when 'INCIDENT', 'DI_INVESTIGATION' then
      if exists (select 1 from records.open_blockers(case s.via_kind when 'LOT' then 'material_lot' else 'batch' end, s.via_id::text) o
                  where o.blocker_id = s.cause_ref::uuid and o.blocks_disposition) then
        return format('%s %s still blocks %s %s: it is closed or assessed for it first', lower(replace(s.cause_kind, '_', ' ')), s.cause_ref, lower(s.via_kind), s.via_id);
      end if;
      return null;
    when 'LIMS_REVISION' then
      select * into r from site.lot_test_result t where t.id = s.cause_ref::uuid;
      -- the latest revision of the result
      while r.id is not null and exists (select 1 from site.lot_test_result t where t.revises = r.id) loop
        select * into r from site.lot_test_result t where t.revises = r.id;
      end loop;
      if r.id is null or r.verdict <> 'PASS' then
        return format('the revised %s result is %s: a cause is resolved once the result is within its limits (D-5-4)', coalesce(r.test_code, 'test'), coalesce(r.verdict, 'missing'));
      end if;
      return null;
    when 'CALIBRATION_FAILURE' then
      -- D-5a-3: the AP's impact assessment of the as-found failure resolves it.
      return null;
    else
      return format('a %s cause is resolved by its own record (slice 5b); it is not resolved yet', s.cause_kind);
  end case;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Suspension (L-19, IN-29)
-- ---------------------------------------------------------------------------------------------

-- Suspends one finished lot for a cause (owner only): every market decided RELEASED or CERTIFIED and not terminal.
create function recipe.suspend_lot(p_lot uuid, p_cause jsonb) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m       text;
  v_n     integer := 0;
  v_one   integer;
  v_key   text := (p_cause ->> 'kind') || '/' || (p_cause ->> 'ref');
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return 0;
  end if;
  -- D-5-2: a lot never released only has the cause linked (its release gate blocks it already).
  if not recipe.market_decided_released(p_lot, 'IN') then
    return 0;
  end if;
  perform site.lock_lot(p_lot);
  foreach m in array array['IN', 'US', 'EU'] loop
    continue when m <> 'IN' and not (m = any (coalesce(recipe.market_set('LOT', p_lot), '{}')));
    continue when not recipe.market_decided_released(p_lot, m);
    continue when exists (select 1 from recipe.after_release_decision d where d.lot_id = p_lot and d.market = m and d.act <> 'RECONFIRM');
    insert into recipe.release_suspension (lot_id, market, cause_kind, cause_ref, via_kind, via_id, label, cause, prior_state)
    values (p_lot, m, p_cause ->> 'kind', p_cause ->> 'ref', p_cause ->> 'via_kind', (p_cause ->> 'via_id')::uuid, p_cause ->> 'label', p_cause,
            case m when 'EU' then 'CERTIFIED' else 'RELEASED' end)
    on conflict (lot_id, market, cause_kind, cause_ref) do nothing;
    get diagnostics v_one = row_count;
    v_n := v_n + v_one;
  end loop;
  if v_n > 0 then
    -- In the same transaction (D-5-3): the export markets' states, the ERP stock block, the AP's recall-assessment task.
    perform recipe.cascade_market_dispositions(p_lot, jsonb_build_object('cause', 'RELEASE_SUSPENDED', 'suspension', p_cause));
    perform site.request_erp_stock_block(p_lot, 'BLOCK', v_key, p_cause);
    if not exists (select 1 from recipe.release_task t where t.lot_id = p_lot and t.kind = 'RECALL_ASSESSMENT'
                    and not exists (select 1 from recipe.release_task_closure c where c.task_id = t.id)) then
      insert into recipe.release_task (lot_id, kind, owner_role, cause) values (p_lot, 'RECALL_ASSESSMENT', 'AUTHORISED_PERSON', p_cause);
    end if;
    perform recipe.bump_epoch('LOT', p_lot);
  end if;
  return v_n;
end
$$;

-- The cause as stored: kind, ref, via node and label checked.
create function recipe.suspension_cause(p_cause jsonb, p_lot uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c jsonb := coalesce(p_cause, '{}'::jsonb);
begin
  if jsonb_typeof(c) <> 'object' or coalesce(c ->> 'kind', '') not in ('DEVIATION', 'INCIDENT', 'DI_INVESTIGATION', 'LIMS_REVISION', 'CALIBRATION_FAILURE', 'RECORD_AMENDMENT')
     or coalesce(c ->> 'ref', '') !~ '^[!-~]{1,200}$' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ARL-001 a suspension names its cause: kind (DEVIATION, INCIDENT, DI_INVESTIGATION, LIMS_REVISION, CALIBRATION_FAILURE or RECORD_AMENDMENT) and ref, not %s', c);
  end if;
  return c || jsonb_build_object('via_kind', coalesce(c ->> 'via_kind', 'LOT'), 'via_id', coalesce(c ->> 'via_id', p_lot::text),
                                 'label', coalesce(nullif(btrim(c ->> 'label'), ''), format('%s %s', lower(replace(c ->> 'kind', '_', ' ')), c ->> 'ref')));
end
$$;

-- Owner only (0820's interface; slice 5b's amendment calls it): the lot and every finished lot downstream of it.
create or replace function recipe.suspend_release(p_lot uuid, p_cause jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  c jsonb;
  x uuid;
begin
  if p_lot is null or not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-002 %s is no finished lot', coalesce(p_lot::text, 'NULL'));
  end if;
  c := recipe.suspension_cause(p_cause, p_lot);
  foreach x in array array[p_lot] || recipe.genealogy_downstream_lots('LOT', p_lot) loop
    perform recipe.suspend_lot(x, c);
  end loop;
end
$$;

-- The triggers' entry (owner only): every finished lot at or downstream of the node.
create function recipe.suspend_affected(p_kind text, p_id uuid, p_cause jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  c jsonb := p_cause || jsonb_build_object('via_kind', p_kind, 'via_id', p_id);
  x uuid;
begin
  if p_id is null then
    return;
  end if;
  c := recipe.suspension_cause(c, p_id);
  foreach x in array case when p_kind = 'LOT' then array[p_id] else '{}'::uuid[] end || recipe.genealogy_downstream_lots(p_kind, p_id) loop
    perform recipe.suspend_lot(x, c);
  end loop;
end
$$;

create function recipe.suspend_on_deviation_link() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_ref text := (select d.ref from site.deviation d where d.id = new.deviation_id);
begin
  perform recipe.suspend_affected(case new.subject_kind when 'LOT' then 'LOT' else 'BATCH' end,
                                  case new.subject_kind when 'LOT' then new.subject_id else new.batch_id end,
                                  jsonb_build_object('kind', 'DEVIATION', 'ref', new.deviation_id::text,
                                                     'label', format('deviation %s linked to %s %s', v_ref, lower(new.subject_kind), new.subject_ref)));
  return null;
end
$$;
create trigger zzzs_suspend_after_release after insert on site.deviation_link for each row execute function recipe.suspend_on_deviation_link();

create function recipe.suspend_on_kernel_link() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, records, pg_temp as $$
declare
  v_kind text := case tg_table_name when 'incident_link' then 'INCIDENT' else 'DI_INVESTIGATION' end;
  v_ref  uuid := case tg_table_name when 'incident_link' then (to_jsonb(new) ->> 'incident_id')::uuid else (to_jsonb(new) ->> 'investigation_id')::uuid end;
  v_id   uuid;
begin
  if new.aggregate_type not in ('batch', 'material_lot') or new.aggregate_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  v_id := new.aggregate_id::uuid;
  perform recipe.suspend_affected(case new.aggregate_type when 'material_lot' then 'LOT' else 'BATCH' end, v_id,
                                  jsonb_build_object('kind', v_kind, 'ref', v_ref::text,
                                                     'label', format('%s linked to %s %s', lower(replace(v_kind, '_', ' ')), replace(new.aggregate_type, '_', ' '), new.aggregate_id)));
  return null;
end
$$;
create trigger zzzs_suspend_after_release after insert on records.incident_link for each row execute function recipe.suspend_on_kernel_link();
create trigger zzzs_suspend_after_release after insert on records.di_investigation_link for each row execute function recipe.suspend_on_kernel_link();

create function recipe.suspend_on_revised_result() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
begin
  perform recipe.suspend_affected('LOT', new.lot_id,
                                  jsonb_build_object('kind', 'LIMS_REVISION', 'ref', new.id::text,
                                                     'label', format('%s result revised (%s)', new.test_code, new.verdict)));
  return null;
end
$$;
create trigger zzzs_suspend_after_release after insert on site.lot_test_result for each row when (new.revises is not null)
  execute function recipe.suspend_on_revised_result();

-- D-5-1: an as-found calibration failure suspends what the batches made with the equipment since its previous calibration.
create function recipe.suspend_on_calibration_failure() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_since timestamptz;
  v_code  text := (select e.code from plant.equipment e where e.id = new.equipment_id);
  b       uuid;
begin
  select max(c.recorded_at) into v_since from plant.calibration c where c.equipment_id = new.equipment_id and c.id <> new.id and c.recorded_at <= new.recorded_at;
  for b in select distinct u.batch_id from (
             select x.batch_id, x.started_at as at from plant.equipment_use x where x.equipment_id = new.equipment_id
             union all
             select y.batch_id, y.recorded_at from plant.instrument_use y where y.equipment_id = new.equipment_id) u
           where v_since is null or u.at >= v_since order by 1 loop
    perform recipe.suspend_affected('BATCH', b,
                                    jsonb_build_object('kind', 'CALIBRATION_FAILURE', 'ref', new.id::text,
                                                       'label', format('as-found calibration failure of %s (%s)', v_code, new.reference)));
  end loop;
  return null;
end
$$;
create trigger zzzs_suspend_after_release after insert on plant.calibration for each row when (new.as_found = 'FAIL')
  execute function recipe.suspend_on_calibration_failure();

-- ---------------------------------------------------------------------------------------------
-- The AP's after-release decisions (RECONFIRM, RECALL, REJECT_AFTER_RELEASE)
-- ---------------------------------------------------------------------------------------------

create function recipe.release_suspension_next_id(p_lot uuid, p_market text, p_act text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select format('%s/%s/%s/%s', p_lot, p_market, p_act, (select count(*) + 1 from recipe.after_release_decision d where d.lot_id = p_lot and d.market = p_market))
$$;

-- The market's state now: IN the manufacturer release, US and EU their disposition.
create function recipe.market_state_now(p_lot uuid, p_market text) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case p_market when 'IN' then recipe.manufacturer_release_state(p_lot) else recipe.disposition_state(p_lot, p_market) end
$$;

-- Why the act cannot be given now (the database's reasons; the acts check them again under the locks), empty when it can.
-- The G-REL items are checked by the act at the signed epoch, not here.
create function recipe.after_release_problems(p_lot uuid, p_market text, p_act text) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  v_state text;
  v_out   text[] := '{}';
  s       uuid;
  v_prob  text;
begin
  if not exists (select 1 from site.finished_lot f where f.lot_id = p_lot) then
    return array[format('%s is no finished lot', coalesce(p_lot::text, 'NULL'))];
  end if;
  if p_market is null or p_market not in ('IN', 'US', 'EU') or (p_market <> 'IN' and not (p_market = any (coalesce(recipe.market_set('LOT', p_lot), '{}')))) then
    return array[format('%s is not a market of the lot', coalesce(p_market, 'NULL'))];
  end if;
  v_state := recipe.market_state_now(p_lot, p_market);
  if p_act = 'RECONFIRM' then
    if v_state is distinct from 'RELEASE_SUSPENDED' then
      return array[format('the market is %s: only a suspended market is re-confirmed', coalesce(v_state, 'not decided'))];
    end if;
    if cardinality(recipe.open_suspensions(p_lot, p_market)) = 0 then
      v_out := v_out || 'the market is suspended because the manufacturer release is not RELEASED: re-confirm IN first (INV-39)'::text;
    elsif p_market <> 'IN' and recipe.manufacturer_release_state(p_lot) is distinct from 'RELEASED' then
      v_out := v_out || format('the manufacturer release is %s: IN is re-confirmed before %s (INV-39)', recipe.manufacturer_release_state(p_lot), p_market);
    end if;
    foreach s in array recipe.open_suspensions(p_lot, p_market) loop
      v_prob := recipe.suspension_cause_problem(s);
      if v_prob is not null then
        v_out := v_out || v_prob;
      end if;
    end loop;
  elsif p_act in ('RECALL', 'REJECT_AFTER_RELEASE') then
    if v_state is null or v_state not in ('RELEASE_SUSPENDED', 'RELEASED', 'CERTIFIED') or not recipe.market_decided_released(p_lot, p_market) then
      v_out := v_out || format('the market is %s: a lot is recalled or rejected after release from RELEASE_SUSPENDED or a decided release (D-5-5)', coalesce(v_state, 'not decided'));
    end if;
  else
    v_out := v_out || format('%s is no after-release act (RECONFIRM, RECALL or REJECT_AFTER_RELEASE)', coalesce(p_act, 'NULL'));
  end if;
  return v_out;
end
$$;

create function recipe.release_suspension_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(IN|US|EU)/(RECONFIRM|RECALL|REJECT_AFTER_RELEASE)/([1-9][0-9]{0,5})$');
  f  site.finished_lot;
  d  recipe.after_release_decision;
  v_lot uuid;
  v_n   integer;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  v_lot := m[1]::uuid;
  select * into f from site.finished_lot where lot_id = v_lot;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from recipe.after_release_decision x where x.lot_id = v_lot and x.market = m[2] and x.seq = m[4]::integer;
  if d.id is not null then
    if d.act <> m[3] then
      return '{"exists": false}'::jsonb;
    end if;
    return jsonb_build_object('exists', true, 'content_version', 1, 'state', 'RECORDED', 'market', m[2],
      'content', jsonb_build_object('lot_id', v_lot, 'lot_code', (select l.lot_code from site.material_lot l where l.id = v_lot), 'market', m[2], 'act', m[3],
                                    'sequence', d.seq, 'to_state', d.to_state, 'suspensions', to_jsonb(d.suspension_ids), 'checklist', d.checklist),
      'scope', recipe.release_scope(v_lot), 'involved', to_jsonb(recipe.release_involvement(v_lot)));
  end if;
  select count(*) + 1 into v_n from recipe.after_release_decision x where x.lot_id = v_lot and x.market = m[2];
  if v_n <> m[4]::integer then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1,
    'content', jsonb_build_object(
      'lot_id', v_lot, 'lot_code', (select l.lot_code from site.material_lot l where l.id = v_lot), 'product_code', f.product_code, 'strength', f.strength,
      'batch_number', f.batch_number, 'market', m[2], 'act', m[3], 'sequence', v_n,
      'suspensions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.cause_kind, 'ref', s.cause_ref, 'label', s.label, 'prior_state', s.prior_state)
                                                order by s.recorded_at, s.id)
                                 from recipe.release_suspension s where s.id = any (recipe.open_suspensions(v_lot, m[2]))), '[]'::jsonb),
      -- RECONFIRM signs the G-REL evaluation of the market (INV-05); the act compares it under the locks.
      'checklist', case when m[3] = 'RECONFIRM' then recipe.grel_evaluate(v_lot, m[2]) end),
    'market', m[2],
    'state', recipe.market_state_now(v_lot, m[2]),
    'scope', recipe.release_scope(v_lot),
    'involved', to_jsonb(recipe.release_involvement(v_lot)));
end
$$;

select esig.register_content_provider('release_suspension', 'recipe.release_suspension_content(text)',
  'An after-release decision of the AP for one market of a finished lot: re-confirmation, recall or rejection after release (L-19)');

-- After a decision: the task closes when no market is suspended by a cause of its own; the ERP unblocks when IN is RELEASED.
create function recipe.after_release_settle(p_lot uuid, p_decision uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  t uuid;
begin
  if exists (select 1 from unnest(array['IN', 'US', 'EU']) m where cardinality(recipe.open_suspensions(p_lot, m)) > 0
               and recipe.after_release_state(p_lot, m) = 'RELEASE_SUSPENDED') then
    return;
  end if;
  for t in select x.id from recipe.release_task x where x.lot_id = p_lot and x.kind = 'RECALL_ASSESSMENT'
              and not exists (select 1 from recipe.release_task_closure c where c.task_id = x.id) loop
    insert into recipe.release_task_closure (task_id, decision_id) values (t, p_decision);
  end loop;
  if recipe.manufacturer_release_state(p_lot) = 'RELEASED'
     and exists (select 1 from site.erp_stock_block_request r where r.lot_id = p_lot and r.kind = 'BLOCK') then
    perform site.request_erp_stock_block(p_lot, 'UNBLOCK', 'RECONFIRM/' || p_decision::text, jsonb_build_object('decision_id', p_decision));
  end if;
end
$$;

create function recipe.record_after_release_decision(p_lot uuid, p_market text, p_act text, p_signature uuid, p_expected_epoch text, p_text text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, platform, pg_temp as $$
declare
  v_actor   jsonb;
  v_scope   jsonb;
  l         site.material_lot;
  v_aid     text;
  v_meaning text;
  v_prob    text[];
  v_sig     jsonb;
  v_role    text;
  v_content text;
  g         jsonb := null;
  i         jsonb;
  v_red     text[] := '{}';
  v_open    uuid[];
  v_to      text;
  v_id      uuid;
  v_from    platform.aggregate_state;
begin
  perform iam.assert_not_administrator();
  if p_act is null or p_act not in ('RECONFIRM', 'RECALL', 'REJECT_AFTER_RELEASE') then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-010 %s is no after-release act (RECONFIRM, RECALL or REJECT_AFTER_RELEASE)', coalesce(p_act, 'NULL'));
  end if;
  if p_market is null or p_market not in ('IN', 'US', 'EU') then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-011 %s is not a market (IN, US or EU)', coalesce(p_market, 'NULL'));
  end if;
  v_scope := recipe.release_scope(p_lot);
  v_actor := iam.require_permission('RELEASE.MANUFACTURER', v_scope);
  l := recipe.lock_release_evidence(p_lot);

  v_prob := recipe.after_release_problems(p_lot, p_market, p_act);
  if cardinality(v_prob) > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ARL-012 lot %s, %s: %s (L-19, D-5-4, D-5-5)', l.lot_code, p_market, array_to_string(v_prob, '; '));
  end if;
  if p_text is null or recipe.reason_is_blank(p_text) then
    raise exception using errcode = 'P0001',
      message = case p_act when 'RECONFIRM' then 'EBMR-ARL-013 a re-confirmation records the person''s impact assessment (D-5-4)'
                           else 'EBMR-ARL-013 a recall or a rejection after release states the person''s own reason (DI-22, D-5-5)' end;
  end if;
  if p_act = 'RECONFIRM' then
    -- INV-05: G-REL of the market again, under the locks, at the epoch the signer evaluated.
    g := recipe.grel_evaluate(p_lot, p_market);
    if p_expected_epoch is null or p_expected_epoch is distinct from g ->> 'epoch' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ARL-014 the evidence of lot %s changed after it was evaluated (epoch %s, now %s); evaluate G-REL again (INV-05, DI-37)',
                         l.lot_code, coalesce(left(p_expected_epoch, 12), 'none given'), left(g ->> 'epoch', 12));
    end if;
  elsif p_expected_epoch is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-014 only a re-confirmation is made at an evaluated epoch';
  end if;

  -- The signature: this record, this meaning, valid, the actor's own, as the AP, on the content as it stands now.
  v_aid := recipe.release_suspension_next_id(p_lot, p_market, p_act);
  v_meaning := case p_act when 'RECONFIRM' then 'RELEASE_RECONFIRMED' when 'RECALL' then 'RECALLED' else 'REJECTED_AFTER_RELEASE' end;
  v_sig := recipe.assert_release_signature(p_signature, v_meaning, 'release_suspension', v_aid, (v_actor ->> 'person_id')::uuid);
  select s.signer_role_code into v_role from esig.signature s where s.id = p_signature;
  if v_role is distinct from 'AUTHORISED_PERSON' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ARL-015 an after-release decision is signed by the authorised person, not as %s (D-5-4, D-5-5)', coalesce(v_role, 'no role'));
  end if;
  if (v_actor ->> 'person_id')::uuid = any (recipe.release_involvement(p_lot)) then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-016 a person involved in the lot''s records never decides its release after release (INV-35)';
  end if;
  v_content := esig.content_hash_of('release_suspension', v_aid, esig.provide('release_suspension', v_aid));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-017 the signed decision is not the current one (its causes or evaluation moved); sign it again (INV-05, DI-37)';
  end if;
  if p_act = 'RECONFIRM' then
    for i in select value from jsonb_array_elements(g -> 'items') loop
      if i ->> 'status' = 'RED' then
        v_red := v_red || format('%s: %s', i ->> 'id', i ->> 'problem');
      end if;
    end loop;
    if cardinality(v_red) > 0 then
      raise exception using errcode = 'P0001', message = format('EBMR-ARL-018 lot %s is not ready for %s: %s (INV-05, D-5-4)', l.lot_code, p_market, array_to_string(v_red, '; '));
    end if;
  end if;

  v_open := recipe.open_suspensions(p_lot, p_market);
  v_to := case p_act when 'RECONFIRM' then case p_market when 'EU' then 'CERTIFIED' else 'RELEASED' end
                     when 'RECALL' then 'RECALLED' else 'REJECTED_AFTER_RELEASE' end;
  insert into recipe.after_release_decision (lot_id, market, seq, act, to_state, text, epoch, checklist, suspension_ids, signature_id, content_hash,
                                             person_id, account_id, role_code, correlation_id)
  values (p_lot, p_market, split_part(v_aid, '/', 4)::integer, p_act, v_to, btrim(p_text), g ->> 'epoch', g, v_open, p_signature, v_content,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_role, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;

  if p_market = 'IN' then
    if p_act <> 'RECONFIRM' then
      -- The lot register in the same transaction (material_lot v3; the lot event RECALL of slice 2's register).
      select * into v_from from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot;
      perform site.lot_transition(l, case p_act when 'RECALL' then 'RELEASE_RECALL' else 'RELEASE_REJECT' end, v_from.version, p_signature, null);
    end if;
    -- INV-39: every export market's state after the manufacturer side changed.
    perform recipe.cascade_market_dispositions(p_lot, jsonb_build_object('cause', 'AFTER_RELEASE_' || p_act, 'decision_id', v_id, 'signature_id', p_signature));
  end if;
  perform recipe.after_release_settle(p_lot, v_id);
  perform recipe.bump_epoch('LOT', p_lot);
  return v_id;
end
$$;

-- material_lot v3's guard (site services 0880): the IN decision recorded in this transaction, as the lot event it fires.
create function recipe.after_release_lot_event_in_xact(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case d.act when 'RECALL' then 'RELEASE_RECALL' when 'REJECT_AFTER_RELEASE' then 'RELEASE_REJECT' end
    from recipe.after_release_decision d where d.lot_id = p_lot and d.market = 'IN' and d.act <> 'RECONFIRM' and d.xact_id = pg_current_xact_id()
$$;

-- ---------------------------------------------------------------------------------------------
-- Disposal (PR-46, IN-05 (e))
-- ---------------------------------------------------------------------------------------------

-- As the server computes it: the details as entered, trimmed, one per line.
create function recipe.disposal_details_sha256(p_route text, p_quantity text, p_return_to text, p_reference text, p_reprocessing uuid, p_text text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(concat_ws(E'\n', btrim(coalesce(p_route, '')), btrim(coalesce(p_quantity, '')), btrim(coalesce(p_return_to, '')),
                                            btrim(coalesce(p_reference, '')), coalesce(p_reprocessing::text, ''), btrim(coalesce(p_text, ''))), 'UTF8')), 'hex')
$$;

-- Why the lot cannot be disposed of now, or NULL.
create function recipe.disposal_problem(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
  select case
    when f.lot_id is null then format('%s is no finished lot', coalesce(p_lot::text, 'NULL'))
    when exists (select 1 from recipe.lot_disposal x where x.lot_id = p_lot) then format('lot %s has its disposal already (once per lot, D-5-6)', l.lot_code)
    when recipe.manufacturer_release_state(p_lot) not in ('REJECTED', 'REJECTED_AFTER_RELEASE', 'RECALLED')
      then format('lot %s is %s for IN: a disposal follows a rejection (REJECTED or REJECTED_AFTER_RELEASE) or a recall (PR-46)', l.lot_code, recipe.manufacturer_release_state(p_lot))
  end
  from (select 1) d left join site.finished_lot f on f.lot_id = p_lot left join site.material_lot l on l.id = p_lot
$$;

create function recipe.disposal_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, site, pg_temp as $$
declare
  m  text[] := regexp_match(coalesce(p_id, ''), '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9a-f]{64})$');
  f  site.finished_lot;
  l  site.material_lot;
  x  recipe.lot_disposal;
begin
  if m is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into f from site.finished_lot where lot_id = m[1]::uuid;
  select * into l from site.material_lot where id = m[1]::uuid;
  if f.lot_id is null then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from recipe.lot_disposal d where d.lot_id = f.lot_id;
  if x.id is not null then
    if x.aggregate_id <> p_id then
      return '{"exists": false}'::jsonb;
    end if;
    return jsonb_build_object('exists', true, 'content_version', 1,
      'content', jsonb_build_object('lot_id', l.id, 'lot_code', l.lot_code, 'from_state', x.from_state, 'route', x.route, 'quantity', x.quantity::text, 'unit', x.unit,
                                    'return_to', x.return_to, 'reference', x.reference, 'reprocessing_ref', x.reprocessing_ref, 'text', x.text,
                                    'details_sha256', x.details_sha256),
      'state', case when x.route = 'WITNESSED_DESTRUCTION' and not exists (select 1 from recipe.lot_disposal_witness w where w.disposal_id = x.id)
                    then 'AWAITING_WITNESS' else 'RECORDED' end,
      'scope', recipe.release_scope(l.id), 'involved', '[]'::jsonb);
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('lot_id', l.id, 'lot_code', l.lot_code, 'product_code', f.product_code, 'batch_number', f.batch_number,
                                  'from_state', recipe.manufacturer_release_state(l.id), 'received_quantity', l.received_quantity::text, 'unit', l.unit,
                                  'details_sha256', m[2]),
    'state', case when recipe.disposal_problem(l.id) is null then 'DISPOSABLE' else recipe.manufacturer_release_state(l.id) end,
    'scope', recipe.release_scope(l.id), 'involved', '[]'::jsonb);
end
$$;

select esig.register_content_provider('disposal', 'recipe.disposal_content(text)',
  'The disposal of a rejected or recalled finished lot: witnessed destruction, reprocessing or return (PR-46, IN-05 (e))');

create function recipe.record_disposal(p_lot uuid, p_route text, p_quantity text, p_return_to text, p_reference text, p_reprocessing uuid, p_text text,
                                       p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, platform, pg_temp as $$
declare
  v_actor   jsonb;
  l         site.material_lot;
  f         site.finished_lot;
  v_qty     numeric;
  v_prob    text;
  v_sha     text;
  v_aid     text;
  v_sig     jsonb;
  v_content text;
  v_product text;
  v_from    platform.aggregate_state;
  v_serials boolean := false;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('RELEASE.DISPOSAL', recipe.release_scope(p_lot));
  l := site.lock_lot(p_lot);
  select * into f from site.finished_lot where lot_id = p_lot;
  v_prob := recipe.disposal_problem(p_lot);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-030 %s', v_prob);
  end if;
  if p_route is null or p_route not in ('WITNESSED_DESTRUCTION', 'REPROCESSING', 'RETURN') then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-031 %s is no disposal route (WITNESSED_DESTRUCTION, REPROCESSING or RETURN; D-5-6)', coalesce(p_route, 'NULL'));
  end if;
  if coalesce(p_quantity, '') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$' or p_quantity::numeric <= 0 or p_quantity::numeric > l.received_quantity then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ARL-032 the quantity disposed of is a positive decimal in %s, at most the lot''s %s (PR-46)', l.unit, l.received_quantity);
  end if;
  v_qty := p_quantity::numeric;
  if (p_route = 'RETURN') <> (p_return_to is not null) or (p_return_to is not null and p_return_to not in ('SUPPLIER', 'CUSTOMER'))
     or (p_route = 'RETURN' and (p_reference is null or btrim(p_reference) = '')) then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-033 a return names SUPPLIER or CUSTOMER and its reference; only a return does (D-5-6)';
  end if;
  if (p_route = 'REPROCESSING') <> (p_reprocessing is not null) then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-034 a disposal by reprocessing names its reprocessing authorisation or request; only it does (D-5-6)';
  end if;
  if p_route = 'REPROCESSING' then
    select coalesce(
             (select v.product_code from recipe.reprocessing_authorisation a join recipe.reprocessing_authorisation_signature s on s.authorisation_id = a.id
                join recipe.mbr_family v on v.id = (recipe.batch_master_version(a.batch_id)).family_id where a.id = p_reprocessing),
             (select v.product_code from recipe.reprocessing_request q join recipe.reprocessing_request_signature s on s.request_id = q.id
                join recipe.mbr_family v on v.id = q.family_id where q.id = p_reprocessing))
      into v_product;
    if v_product is null then
      raise exception using errcode = 'P0001', message = 'EBMR-ARL-035 the reprocessing named is no signed reprocessing authorisation or request (D-5-6)';
    end if;
    if upper(v_product) <> upper(f.product_code) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-ARL-035 the reprocessing named is for product %s, not the lot''s %s (D-5-6)', v_product, f.product_code);
    end if;
  end if;
  if p_text is not null and btrim(p_text) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-036 a note, when given, is not blank';
  end if;

  v_sha := recipe.disposal_details_sha256(p_route, p_quantity, p_return_to, p_reference, p_reprocessing, p_text);
  v_aid := p_lot::text || '/' || v_sha;
  v_sig := recipe.assert_release_signature(p_signature, 'DISPOSAL_RECORDED', 'disposal', v_aid, (v_actor ->> 'person_id')::uuid);
  v_content := esig.content_hash_of('disposal', v_aid, esig.provide('disposal', v_aid));
  if v_content is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-037 the signed disposal is not the current one; sign it again (DI-37)';
  end if;
  insert into recipe.lot_disposal (lot_id, route, quantity, unit, return_to, reference, reprocessing_ref, text, details_sha256, aggregate_id, from_state,
                                   signature_id, content_hash, person_id, account_id, role_code)
  values (p_lot, p_route, v_qty, l.unit, p_return_to, nullif(btrim(coalesce(p_reference, '')), ''), p_reprocessing, nullif(btrim(coalesce(p_text, '')), ''),
          v_sha, v_aid, recipe.manufacturer_release_state(p_lot), p_signature, v_content,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code')
  returning id into v_id;
  if p_route = 'RETURN' then
    select * into v_from from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = p_lot;
    perform site.lot_transition(l, 'DISPOSAL_RETURN', v_from.version, p_signature, null);
  end if;
  -- PR-46: a lot whose records drew serial numbers opens a serial-decommissioning task (stub; the edition's serial pools).
  if to_regclass('tab.serial_pool') is not null then
    execute 'select exists (select 1 from tab.serial_pool p where p.batch_id = any ($1))' into v_serials using recipe.release_batches(p_lot);
  end if;
  if v_serials then
    insert into recipe.release_task (lot_id, kind, owner_role, cause)
    values (p_lot, 'SERIAL_DECOMMISSIONING', 'QA_REVIEWER', jsonb_build_object('disposal_id', v_id, 'route', p_route));
  end if;
  perform recipe.bump_epoch('LOT', p_lot);
  return v_id;
end
$$;

create function recipe.witness_disposal(p_disposal uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, esig, iam, platform, pg_temp as $$
declare
  v_actor   jsonb;
  x         recipe.lot_disposal;
  l         site.material_lot;
  v_sig     jsonb;
  v_from    platform.aggregate_state;
begin
  perform iam.assert_not_administrator();
  select * into x from recipe.lot_disposal where id = p_disposal;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-040 there is no disposal %s', coalesce(p_disposal::text, 'NULL'));
  end if;
  v_actor := iam.require_permission('STEP.WITNESS', recipe.release_scope(x.lot_id));
  l := site.lock_lot(x.lot_id);
  if x.route <> 'WITNESSED_DESTRUCTION' then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-041 the disposal of lot %s is a %s: only a destruction is witnessed', l.lot_code, x.route);
  end if;
  if exists (select 1 from recipe.lot_disposal_witness w where w.disposal_id = x.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ARL-042 the destruction of lot %s is witnessed already', l.lot_code);
  end if;
  if (v_actor ->> 'person_id')::uuid = x.person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-043 the witness of a destruction is a person other than the one who recorded it (PR-46, INV-03)';
  end if;
  v_sig := recipe.assert_release_signature(p_signature, 'DESTRUCTION_WITNESSED', 'disposal', x.aggregate_id, (v_actor ->> 'person_id')::uuid);
  if esig.content_hash_of('disposal', x.aggregate_id, esig.provide('disposal', x.aggregate_id)) is distinct from v_sig ->> 'content_hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-ARL-044 the signed destruction is not the recorded one; sign it again (DI-37)';
  end if;
  insert into recipe.lot_disposal_witness (disposal_id, signature_id, person_id, account_id)
  values (x.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  select * into v_from from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = x.lot_id;
  perform site.lot_transition(l, 'DISPOSAL_DESTROY', v_from.version, p_signature, null);
  perform recipe.bump_epoch('LOT', x.lot_id);
end
$$;

-- material_lot v3's guard (site services 0880): the disposal completed in this transaction, as the lot event it fires.
create function recipe.disposal_lot_event_in_xact(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(
    (select 'DISPOSAL_DESTROY' from recipe.lot_disposal x join recipe.lot_disposal_witness w on w.disposal_id = x.id
      where x.lot_id = p_lot and w.xact_id = pg_current_xact_id()),
    (select 'DISPOSAL_RETURN' from recipe.lot_disposal x where x.lot_id = p_lot and x.route = 'RETURN' and x.xact_id = pg_current_xact_id()))
$$;

revoke all on function recipe.genealogy_downstream_lots(text, uuid), recipe.market_decided_released(uuid, text), recipe.open_suspensions(uuid, text),
  recipe.after_release_state(uuid, text), recipe.suspension_cause_problem(uuid), recipe.suspend_lot(uuid, jsonb), recipe.suspension_cause(jsonb, uuid),
  recipe.suspend_affected(text, uuid, jsonb), recipe.suspend_on_deviation_link(), recipe.suspend_on_kernel_link(), recipe.suspend_on_revised_result(),
  recipe.suspend_on_calibration_failure(), recipe.release_suspension_next_id(uuid, text, text), recipe.market_state_now(uuid, text),
  recipe.after_release_problems(uuid, text, text), recipe.release_suspension_content(text),
  recipe.after_release_settle(uuid, uuid), recipe.record_after_release_decision(uuid, text, text, uuid, text, text), recipe.after_release_lot_event_in_xact(uuid),
  recipe.disposal_details_sha256(text, text, text, text, uuid, text), recipe.disposal_problem(uuid), recipe.disposal_content(text),
  recipe.record_disposal(uuid, text, text, text, text, uuid, text, uuid), recipe.witness_disposal(uuid, uuid), recipe.disposal_lot_event_in_xact(uuid) from public;
grant execute on function recipe.genealogy_downstream_lots(text, uuid), recipe.after_release_state(uuid, text), recipe.open_suspensions(uuid, text),
  recipe.suspension_cause_problem(uuid), recipe.release_suspension_next_id(uuid, text, text), recipe.after_release_problems(uuid, text, text),
  recipe.record_after_release_decision(uuid, text, text, uuid, text, text), recipe.disposal_details_sha256(text, text, text, text, uuid, text),
  recipe.disposal_problem(uuid), recipe.record_disposal(uuid, text, text, text, text, uuid, text, uuid), recipe.witness_disposal(uuid, uuid) to ebmr_app;

reset role;
