-- Recipe core: the remaining batch acts are authorised in the batch's {site, product} scope, as recipe-core 1100 did for
-- step work and step signatures (Phase 6 exit review 6jc-R16, the rest; IN-04, DI-21, DI-17; open question O-T1-1).
--
-- Handbook: modules/recipe-core.md
--
-- What was wrong. These acts checked their permission at the actor's location only ({site, area}), or unscoped. A
-- request that names no product is matched by every product-limited qualification requirement (iam.requirement_applies,
-- kernel 0100, fails closed: the request may be work on that product), and no product-limited grant covers it
-- (iam.scope_covers). So a requirement limited to product A refused these acts on every batch of the site, and a person
-- whose grant is limited to product A could not act on A's batches at all.
--
-- What changed (each function replaced from its latest definition; one line each, every other guard kept as it was):
--   * plant.acknowledge_alarm (0976): ALARM.ACKNOWLEDGE in the scope of each bound batch (plant.batch_scope, {site,
--     product}) only; the unscoped check before them is made only for an occurrence bound to no batch. This settles
--     O-T1-1: a person scoped to one product acknowledges an alarm bound only to batches of that product; one bound also
--     to another product's batch still needs the right there (Q-6b-1, 0976).
--   * recipe.propose_disposition (0331), recipe.propose_hold_point_decision (0502), recipe.propose_act (0470): the
--     command's permission through recipe.require_command_permission(type, meaning, batch) of 1100, the actor's location
--     with the batch's product (recipe.batch_scope_members).
--   * recipe.review_exception (0721, after 0601's deviation references and 0713's review freeze): the review act's
--     permission at the actor's location with the batch's product.
--   * recipe.consume_lot (0700): DISPENSE.EXECUTE at the actor's location with the batch's product; the site side
--     (site.consume_reservation, site services 1103) checks it again in the lot's site with the batch's product.
-- A batch without a product keeps the location-only scope (recipe.batch_scope_members gives {}), so a product-limited
-- requirement still applies to it. A requirement limited to this batch's product, or to none, applies as before, and its
-- qualification must still come from a fresh source (STALE_QUALIFICATION_SOURCE, kernel 0130 and 1181). Signatures,
-- messages and error codes are unchanged.
--
-- CREATE OR REPLACE keeps the owners, privileges, SECURITY DEFINER and search_path of the replaced functions. Applied as
-- a new migration because applied migrations are never edited.

set local role ebmr_owner;

-- As 0976; the bound batches' scopes only (header).
create or replace function plant.acknowledge_alarm(p_alarm uuid, p_action_taken text, p_comment text, p_deviation_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, site, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.alarm;
  v_batch uuid;
  b       record;
  v_why   text;
  v_bound boolean := false;
begin
  perform iam.assert_not_administrator();
  select * into a from plant.alarm where id = p_alarm for update;
  if a.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-011 there is no plant alarm %s', coalesce(p_alarm::text, 'NULL'));
  end if;
  -- ALARM.ACKNOWLEDGE in the scope of every batch the occurrence is bound to (a room alarm may bind batches of several
  -- products): the disposition stands in each batch's record, so the person must hold the right in each. Only there
  -- (6jc-R16): each batch's {site, product}, so a requirement limited to another product does not apply and a grant
  -- limited to the batch's product covers it (O-T1-1). An occurrence bound to no batch: unscoped, as before.
  for v_batch in select ab.batch_id from plant.alarm_batch ab where ab.alarm_id = a.id order by ab.batch_id loop
    v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', plant.batch_scope(v_batch));
    v_bound := true;
  end loop;
  if not v_bound then
    v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', '{}'::jsonb);
  end if;
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-010 DI-49: an alarm is acknowledged by a person';
  end if;
  if exists (select 1 from plant.alarm_ack where alarm_id = a.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-016 DI-49: alarm %s is already acknowledged', a.id);
  end if;
  if coalesce(btrim(p_action_taken), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-012 DI-49: an alarm is acknowledged with the action taken';
  end if;
  if a.gmp_critical and coalesce(btrim(p_comment), '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-013 DI-49: alarm %s is GMP-critical; it is acknowledged only with a comment', a.alarm_code);
  end if;
  if a.deviation_required then
    if coalesce(btrim(p_deviation_ref), '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-014 DI-49: alarm %s needs a deviation; cite its reference', a.alarm_code);
    end if;
    for b in select ab.batch_id from plant.alarm_batch ab where ab.alarm_id = a.id loop
      v_why := site.deviation_ref_problem(p_deviation_ref, 'LINK', b.batch_id);
      if v_why is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: the deviation %s', v_why);
      end if;
    end loop;
    if not exists (select 1 from plant.alarm_batch where alarm_id = a.id) and not exists (select 1 from site.deviation where ref = btrim(p_deviation_ref)) then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: %s is not a deviation record of this installation', btrim(p_deviation_ref));
    end if;
  end if;
  insert into plant.alarm_ack (alarm_id, action_taken, comment, deviation_ref, person_id, account_id, session_id, role_code, correlation_id)
  values (a.id, btrim(p_action_taken), nullif(btrim(coalesce(p_comment, '')), ''), nullif(btrim(coalesce(p_deviation_ref, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid, v_actor ->> 'role_code',
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- As 0331; the command's permission in the batch's scope (header).
create or replace function recipe.propose_disposition(p_batch uuid, p_exception text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing an exception disposition');
  x       jsonb;
  v_agg   text := p_batch::text || ':' || p_exception;
  v_ver   integer;
begin
  -- F37.R round 2 (0331): only in READ COMMITTED, where the statements after the locks read what committed before them.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001',
      message = format('A disposition of exception %s is proposed only in a READ COMMITTED transaction: under %s the proposal would read the exception, and the signatures on it, as its snapshot saw them before it waited for a signing of the exception, and could change the content a signature committed meanwhile covers (INV-09, DI-37). [EBMR-EXE-084]',
                       coalesce(p_exception, 'null'), current_setting('transaction_isolation'));
  end if;
  perform recipe.require_command_permission('DISPOSITION_EXCEPTION', 'EXCEPTION_DISPOSITIONED', p_batch);
  -- Serialised with a signing of the same batch (F37): the lock recipe.lock_execution takes, before anything is read;
  -- each statement below then reads what a signing that held it committed (READ COMMITTED takes a snapshot per statement).
  perform 1 from recipe.batch_execution where id = p_batch for update;
  -- F37.R (0329): and the record's own signing lock, which esig.sign takes whatever the path, after the batch's (the
  -- order of a signing on the server's path), so a signer that never took the batch's lock serialises with this too.
  perform esig.aggregate_lock('batch_exception', v_agg);
  select s.state -> 'exceptions' -> p_exception into x from recipe.execution_state s where s.batch_id = p_batch;
  if jsonb_typeof(x) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = format('There is no exception %s in this test batch (DI-26). [EBMR-EXE-084]', coalesce(p_exception, 'null'));
  end if;
  if x ->> 'status' is distinct from 'OPEN' then
    raise exception using errcode = 'P0001', message = format('Exception %s is already dispositioned (DI-26). [EBMR-EXE-084]', p_exception);
  end if;
  if jsonb_typeof(p_proposal) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_proposal)) <> 3
     or jsonb_typeof(p_proposal -> 'outcome') is distinct from 'string' or coalesce(p_proposal ->> 'outcome', '') not in ('NO_IMPACT', 'DEVIATION_RAISED')
     or jsonb_typeof(p_proposal -> 'justification') is distinct from 'string'
     or recipe.reason_is_blank(p_proposal ->> 'justification') or length(p_proposal ->> 'justification') > 4000
     or not (p_proposal ? 'deviationRef')
     or (p_proposal -> 'deviationRef') is distinct from coalesce(x -> 'deviation' -> 'ref', 'null'::jsonb) then
    raise exception using errcode = 'P0001',
      message = 'A proposed disposition is {outcome, justification, deviationRef}: NO_IMPACT or DEVIATION_RAISED, a justification that is not blank, and the deviation linked to the exception (PR-49). [EBMR-EXE-084]';
  end if;
  if p_proposal ->> 'outcome' = 'NO_IMPACT' and (x -> 'deviationRequired') is distinct from 'false'::jsonb then
    raise exception using errcode = 'P0001',
      message = format('Exception %s needs a deviation; "no impact" is not a disposition it allows (PR-08, PR-49). [EBMR-EXE-084]', p_exception);
  end if;
  if p_proposal ->> 'outcome' = 'DEVIATION_RAISED' and jsonb_typeof(x -> 'deviation' -> 'ref') is distinct from 'string' then
    raise exception using errcode = 'P0001',
      message = format('Link the deviation to exception %s before proposing to disposition it as raised (PR-49). [EBMR-EXE-084]', p_exception);
  end if;
  select max(content_version) into v_ver from recipe.execution_exception_content where aggregate_id = v_agg;
  if v_ver is null then
    raise exception using errcode = 'P0001', message = format('Exception %s has no signable content (DI-37). [EBMR-EXE-084]', p_exception);
  end if;
  -- A decision is never proposed on a content version that a decision was already signed on (F37; INV-09).
  if exists (select 1 from esig.signature g
              where g.aggregate_type = 'batch_exception' and g.aggregate_id = v_agg and g.content_version = v_ver
                and g.meaning_code = 'EXCEPTION_DISPOSITIONED') then
    raise exception using errcode = 'P0001',
      message = format('A disposition of exception %s is already signed on content version %s; no other is proposed on it (INV-09, DI-37). [EBMR-EXE-084]', p_exception, v_ver);
  end if;
  insert into recipe.execution_disposition_proposal (batch_id, exception_id, aggregate_id, content_version, proposal,
                                                     proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_exception, v_agg, v_ver, p_proposal, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('content_version', v_ver, 'proposal', p_proposal);
end
$$;

-- As 0502; the command's permission in the batch's scope (header).
create or replace function recipe.propose_hold_point_decision(p_batch uuid, p_step_key text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing a hold-point decision');
  x       jsonb;
  v_node  jsonb;
  v_agg   text := p_batch::text || ':' || coalesce(p_step_key, '');
  v_ver   integer;
begin
  -- F37.R round 2 (0331): only in READ COMMITTED, as recipe.propose_disposition.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001',
      message = format('A decision on hold point %s is proposed only in a READ COMMITTED transaction: under %s the proposal would read the hold point, and the signatures on it, as its snapshot saw them before it waited for a signing of the hold point, and could change the content a signature committed meanwhile covers (INV-09, DI-37, PR-45). [EBMR-EXE-084]',
                       coalesce(p_step_key, 'null'), current_setting('transaction_isolation'));
  end if;
  if jsonb_typeof(p_proposal) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_proposal)) <> 2
     or jsonb_typeof(p_proposal -> 'disposition') is distinct from 'string' or coalesce(btrim(p_proposal ->> 'disposition'), '') = ''
     or not (p_proposal ? 'comment')
     or coalesce(jsonb_typeof(p_proposal -> 'comment'), 'null') not in ('string', 'null')
     or coalesce(length(p_proposal ->> 'comment'), 0) > 2000 then
    raise exception using errcode = 'P0001',
      message = 'A proposed hold-point decision is {disposition, comment}: a disposition the hold point offers and a comment of at most 2000 characters, or null (PR-45). [EBMR-EXE-084]';
  end if;
  perform recipe.require_command_permission('DISPOSITION_HOLD_POINT', recipe.hold_point_meaning(p_proposal ->> 'disposition'), p_batch);
  -- Serialised with a signing of the same batch (F37): the lock recipe.lock_execution takes, before anything is read.
  perform 1 from recipe.batch_execution where id = p_batch for update;
  -- F37.R (0329): and the record's own signing lock, as in recipe.propose_disposition.
  perform esig.aggregate_lock('batch_step', v_agg);
  select s.state -> 'steps' -> p_step_key into x from recipe.execution_state s where s.batch_id = p_batch;
  if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' then
    raise exception using errcode = 'P0001', message = format('There is no hold point %s in this test batch (PR-45). [EBMR-EXE-084]', coalesce(p_step_key, 'null'));
  end if;
  if x ? 'disposition' or x ->> 'status' is distinct from 'ENABLED' then
    raise exception using errcode = 'P0001', message = format('Hold point %s is not waiting for a decision (PR-45). [EBMR-EXE-084]', p_step_key);
  end if;
  select recipe.step_node(pk.content, x ->> 'step') into v_node
    from recipe.batch_execution b cross join lateral (select recipe.execution_mbr_content(b.package_hash, b.control_recipe_id) as content) pk where b.id = p_batch;
  if v_node ->> 'kind' is distinct from 'holdPoint'
     or not coalesce(case when jsonb_typeof(v_node -> 'dispositions') = 'array' then (v_node -> 'dispositions') ? (p_proposal ->> 'disposition') end, false) then
    raise exception using errcode = 'P0001',
      message = format('%s is not a decision hold point %s offers (PR-45). [EBMR-EXE-084]', p_proposal ->> 'disposition', p_step_key);
  end if;
  select max(content_version) into v_ver from recipe.execution_step_content where aggregate_id = v_agg;
  if v_ver is null then
    raise exception using errcode = 'P0001', message = format('Hold point %s has no signable content (DI-37). [EBMR-EXE-084]', p_step_key);
  end if;
  -- A decision is never proposed on a content version that a decision was already signed on (F37; INV-09).
  if exists (select 1 from esig.signature g
              where g.aggregate_type = 'batch_step' and g.aggregate_id = v_agg and g.content_version = v_ver
                and g.meaning_code in ('HOLD_POINT_RELEASED', 'HOLD_POINT_NOT_RELEASED')) then
    raise exception using errcode = 'P0001',
      message = format('A decision on hold point %s is already signed on content version %s; no other is proposed on it (INV-09, DI-37, PR-45). [EBMR-EXE-084]', p_step_key, v_ver);
  end if;
  insert into recipe.execution_decision_proposal (batch_id, step_key, aggregate_id, content_version, proposal,
                                                  proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_step_key, v_agg, v_ver, jsonb_build_object('disposition', p_proposal -> 'disposition', 'comment', p_proposal -> 'comment'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('content_version', v_ver, 'proposal', recipe.current_decision(v_agg, v_ver));
end
$$;

-- As 0470; the act's command permission in the batch's scope (header).
create or replace function recipe.propose_act(p_batch uuid, p_act jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := recipe.execution_actor('Asking for the approval of an act');
  v_version integer;
  v_hash    text;
  v_agg     text;
begin
  if jsonb_typeof(p_act) is distinct from 'object' or p_act ->> 'type' is null
     or p_act ->> 'type' not in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'INVALIDATE_RESULT', 'ABORT_BATCH', 'HAND_OVER_STEP')
     or p_act ?| array['commandId', 'actor', 'approval', 'approvals', 'signature', 'expectedVersion']
     or p_act ->> 'requestedBy' is distinct from v_actor ->> 'person_id' or jsonb_typeof(p_act -> 'requestedBy') is distinct from 'string'
     or length(p_act::text) > 16384 then
    raise exception using errcode = 'P0001',
      message = 'An act asked for approval is a skip, a void, an invalidation, an abort or a hand-over, as its command will record it without id, actor or signatures, requested by the person who asks (DI-24, DI-35). [EBMR-EXE-179]';
  end if;
  perform recipe.require_command_permission(p_act ->> 'type', null, p_batch);
  select s.state_version into v_version from recipe.execution_state s where s.batch_id = p_batch;
  if v_version is null then
    raise exception using errcode = 'P0001', message = 'There is no test batch with this id (DI-34). [EBMR-EXE-010]';
  end if;
  v_hash := recipe.canonical_hash(p_act);
  v_agg := p_batch::text || ':act@' || v_version::text || ':' || v_hash;
  insert into recipe.execution_act_proposal (aggregate_id, batch_id, state_version, act, act_hash, proposed_by_person, proposed_by_account, correlation_id)
  values (v_agg, p_batch, v_version, p_act, v_hash, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  on conflict (aggregate_id) do nothing;
  return jsonb_build_object('aggregate_id', v_agg, 'state_version', v_version);
end
$$;

-- As 0721; the review act's permission in the batch's scope (header).
create or replace function recipe.review_exception(p_batch uuid, p_exception text, p_act text, p_note text, p_deviation_ref text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Reviewing an exception of a test run');
  v_perms  text[];
  v_held   text[];
  v_perm   text;
  v_person uuid := (v_actor ->> 'person_id')::uuid;
  reg      recipe.exception_register;
  v_disp   recipe.exception_register_act;
  v_last   recipe.exception_register_act;
  v_query  recipe.exception_register_act;
  v_state  jsonb;
  v_id     bigint;
  v_prob   text;
begin
  select permissions into v_perms from recipe.exception_review_permission where act = p_act;
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = format('%s is not a review act; an exception is QUERIED, RESPONDED, ACCEPTED_BY_QA or ESCALATED in review (DI-26). [EBMR-EXE-164]', coalesce(p_act, 'null'));
  end if;
  v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
  select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
  perform iam.require_permission(coalesce(v_perm, v_perms[1]), iam.actor_location_scope() || recipe.batch_scope_members(p_batch));

  select * into reg from recipe.exception_register r where r.batch_id = p_batch and r.exception_id = p_exception for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('Test batch %s has no registered exception %s (DI-26). [EBMR-EXE-164]', p_batch, coalesce(p_exception, 'null'));
  end if;
  select * into v_disp from recipe.exception_register_act a where a.batch_id = p_batch and a.exception_id = p_exception and a.act = 'DISPOSITIONED';
  select * into v_last from recipe.exception_register_act a
   where a.batch_id = p_batch and a.exception_id = p_exception and a.act in ('QUERIED', 'RESPONDED', 'ACCEPTED_BY_QA', 'ESCALATED') order by a.id desc limit 1;
  if v_last.act in ('ACCEPTED_BY_QA', 'ESCALATED') then
    raise exception using errcode = 'P0001',
      message = format('Exception %s was already %s in review; its review is concluded (DI-26). [EBMR-EXE-164]', p_exception, lower(replace(v_last.act, '_', ' ')));
  end if;
  -- Phase 4 slice 1a (PR-52, INV-30, DI-34): on a GMP batch QA accepts an item only in the QA review of the record,
  -- signed (recipe.dispose_review_items); the unsigned act stays for test runs. Queries, answers and escalations stay.
  if p_act in ('ACCEPTED_BY_QA', 'ESCALATED') and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-059 on a GMP batch QA %s exception %s only in the QA review of the record, with its signed disposition (PR-52, INV-30, DI-34)',
                       case p_act when 'ESCALATED' then 'escalates' else 'accepts' end, p_exception);
  end if;
  if p_act in ('QUERIED', 'RESPONDED') and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.purpose = 'GMP_BATCH')
     and recipe.batch_review_state(p_batch) is distinct from 'PRODUCTION_APPROVED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-REV-065 the record is %s; on a GMP batch a query and its answer belong to the QA review, after the production approval (INV-30, DI-26)',
                       coalesce(recipe.batch_review_state(p_batch), 'unknown'));
  end if;
  if p_act <> 'ACCEPTED_BY_QA' and (p_note is null or recipe.reason_is_blank(p_note)) then
    raise exception using errcode = 'P0001',
      message = format('A %s review act on exception %s states its text in words (DI-26, PR-49). [EBMR-EXE-164]', p_act, p_exception);
  end if;

  case p_act
    when 'QUERIED' then
      if v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before another is asked (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
    when 'RESPONDED' then
      if v_last.act is distinct from 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has no open query to respond to (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if v_last.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s asked the query on exception %s and cannot answer it too (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
    when 'ACCEPTED_BY_QA', 'ESCALATED' then
      if p_act = 'ACCEPTED_BY_QA' and v_disp.id is null then
        raise exception using errcode = 'P0001',
          message = format('Exception %s is still open; QA accepts an exception in review only after its disposition, and a review never closes it (DI-26, INV-41). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ACCEPTED_BY_QA' and v_last.act = 'QUERIED' then
        raise exception using errcode = 'P0001',
          message = format('Exception %s has an open query; it is answered before QA accepts the exception (DI-26). [EBMR-EXE-164]', p_exception);
      end if;
      if p_act = 'ESCALATED' and (p_deviation_ref is null or recipe.reason_is_blank(p_deviation_ref)) then
        raise exception using errcode = 'P0001',
          message = format('An escalation of exception %s names the deviation it is escalated to (DI-26, PR-49). [EBMR-EXE-164]', p_exception);
      end if;
      -- On a GMP batch the escalation names a deviation-lite record linked to it (slice 5a, D-S5-2).
      if p_act = 'ESCALATED' and exists (select 1 from recipe.batch_execution b where b.id = p_batch and b.installation = 'GMP') then
        v_prob := site.deviation_ref_problem(btrim(p_deviation_ref), 'LINK', p_batch);
        if v_prob is not null then
          raise exception using errcode = 'P0001',
            message = format('Exception %s cannot be escalated to %s: %s (PR-49, PR-13). [EBMR-EXE-604]', p_exception, btrim(p_deviation_ref), v_prob);
        end if;
      end if;
      select s.state into v_state from recipe.execution_state s where s.batch_id = p_batch;
      if recipe.exception_step_involvement(p_batch, v_state, p_exception, null) ? v_person::text or reg.raised_by = v_person::text
         or v_disp.by_person = v_person then
        raise exception using errcode = 'P0001',
          message = format('%s raised, worked in the step of, or dispositioned exception %s, so they cannot conclude its review (INV-03, DI-26). [EBMR-EXE-165]', v_person, p_exception);
      end if;
  end case;

  insert into recipe.exception_register_act (batch_id, exception_id, act, by_person, by_account, role_code, deviation_ref, note, correlation_id)
  values (p_batch, p_exception, p_act, v_person, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          case when p_act = 'ESCALATED' then btrim(p_deviation_ref) end, case when p_note is null or recipe.reason_is_blank(p_note) then null else p_note end,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- As 0700; DISPENSE.EXECUTE in the batch's scope (header).
create or replace function recipe.consume_lot(p_batch uuid, p_reservation uuid, p_material_code text, p_quantity numeric, p_unit text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, site, iam, pg_temp as $$
declare
  b        recipe.batch_execution;
  v_status text;
begin
  if kernel.current_actor() is null then
    raise exception using errcode = 'P0001',
      message = 'No validated command: material is consumed inside a command started with kernel.begin_command (INV-07; EBMR-RCP-430)';
  end if;
  perform iam.assert_not_administrator();
  -- Dispensing against a batch (DI-17), at the actor's location with the batch's product like the execution writers
  -- (6jc-R16); the site checks it again in the lot's site with the batch's product (site services 1103).
  perform iam.require_permission('DISPENSE.EXECUTE', iam.actor_location_scope() || recipe.batch_scope_members(p_batch));
  select * into b from recipe.batch_execution where id = p_batch for share;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s: material is consumed only into an issued batch (INV-14; EBMR-RCP-431)', p_batch);
  end if;
  select s.status into v_status from recipe.execution_state s where s.batch_id = b.id for share;
  if v_status is null or v_status not in ('ISSUED', 'IN_PROGRESS') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-RCP-432 batch %s is %s: material is consumed only into a running batch (ISSUED or IN_PROGRESS), never into one completed, on hold, aborted or cancelled (INV-13, INV-14)',
                       b.batch_number, coalesce(v_status, 'without a stored state'));
  end if;
  return site.consume_reservation(p_reservation, b.id, b.batch_number, b.market_set, p_material_code, p_quantity, p_unit)
         || jsonb_build_object('batch_id', b.id, 'batch_number', b.batch_number, 'market_set', to_jsonb(b.market_set));
end
$$;

reset role;
