-- Recipe core, execution store (module C3): a proposed decision is serialised with the signing of its batch, and never
-- lands on a content version a decision was already signed on (Phase 2 exit review F37; INV-09, DI-37, PR-49, PR-45;
-- ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- recipe.propose_disposition (0301) and recipe.propose_hold_point_decision (0295) record the decision a QA reviewer is
-- about to sign as the latest proposal of the record's current content version; the batch_exception and batch_step
-- content providers then add it to the signed content (proposedDisposition, proposedDecision). Neither function took a
-- lock that serialises it with a signing of the same batch: each read the status with a plain select, from a snapshot
-- taken before a concurrent signing committed, and inserted at the content version that signing had just signed (the
-- insert waited only on the foreign key). A second QA user's correctly attributed proposal, run through the store while
-- the first one's signing transaction was open, therefore changed the content a committed signature covers: the
-- signature read CONTENT_MISMATCH and the signed content named the other user's decision (the executed-attacks
-- reproducer). The server's own path was serialised only because it opens the run first.
--
-- Both functions now (CREATE OR REPLACE, the bodies of 0301 and 0295 otherwise unchanged):
--   1. take the batch's row lock (FOR UPDATE on recipe.batch_execution, the lock recipe.lock_execution takes and a
--      signing holds from its preparation to its commit) right after the permission check, before reading anything;
--      under READ COMMITTED each later statement then sees what a signing that held the lock committed, so a proposal
--      that waited behind a signed disposition finds the exception dispositioned, or the hold point decided, and is
--      refused (EBMR-EXE-084). Under REPEATABLE READ or SERIALIZABLE the lock itself fails with a serialisation error
--      when a signing committed a change of the batch meanwhile. The server's own path already holds this lock in the
--      same transaction, so taking it again costs nothing; no other lock is taken first, so this cannot deadlock with a
--      signing (which takes esig.aggregate_lock only after the batch's lock);
--   2. refuse a proposal on a content version that already carries a signature of the deciding meaning
--      (EXCEPTION_DISPOSITIONED; HOLD_POINT_RELEASED or HOLD_POINT_NOT_RELEASED), so what a signature covers never
--      changes, whatever the path (EBMR-EXE-084).
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the privileges
-- (both executable by ebmr_app: 0210, 0295). Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

-- PR-49, DI-37, INV-09: as 0301, serialised with the batch's signing (F37).
create or replace function recipe.propose_disposition(p_batch uuid, p_exception text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing an exception disposition');
  x       jsonb;
  v_agg   text := p_batch::text || ':' || p_exception;
  v_ver   integer;
begin
  perform recipe.require_command_permission('DISPOSITION_EXCEPTION', 'EXCEPTION_DISPOSITIONED');
  -- Serialised with a signing of the same batch (F37): the lock recipe.lock_execution takes, before anything is read;
  -- each statement below then reads what a signing that held it committed (READ COMMITTED takes a snapshot per statement).
  perform 1 from recipe.batch_execution where id = p_batch for update;
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

-- PR-45, DI-37, INV-09: as 0295, serialised with the batch's signing (F37).
create or replace function recipe.propose_hold_point_decision(p_batch uuid, p_step_key text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing a hold-point decision');
  x       jsonb;
  v_node  jsonb;
  v_agg   text := p_batch::text || ':' || coalesce(p_step_key, '');
  v_ver   integer;
begin
  if jsonb_typeof(p_proposal) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_proposal)) <> 2
     or jsonb_typeof(p_proposal -> 'disposition') is distinct from 'string' or coalesce(btrim(p_proposal ->> 'disposition'), '') = ''
     or not (p_proposal ? 'comment')
     or coalesce(jsonb_typeof(p_proposal -> 'comment'), 'null') not in ('string', 'null')
     or coalesce(length(p_proposal ->> 'comment'), 0) > 2000 then
    raise exception using errcode = 'P0001',
      message = 'A proposed hold-point decision is {disposition, comment}: a disposition the hold point offers and a comment of at most 2000 characters, or null (PR-45). [EBMR-EXE-084]';
  end if;
  perform recipe.require_command_permission('DISPOSITION_HOLD_POINT', recipe.hold_point_meaning(p_proposal ->> 'disposition'));
  -- Serialised with a signing of the same batch (F37): the lock recipe.lock_execution takes, before anything is read.
  perform 1 from recipe.batch_execution where id = p_batch for update;
  select s.state -> 'steps' -> p_step_key into x from recipe.execution_state s where s.batch_id = p_batch;
  if jsonb_typeof(x) is distinct from 'object' or x ->> 'kind' is distinct from 'HOLD' then
    raise exception using errcode = 'P0001', message = format('There is no hold point %s in this test batch (PR-45). [EBMR-EXE-084]', coalesce(p_step_key, 'null'));
  end if;
  if x ? 'disposition' or x ->> 'status' is distinct from 'ENABLED' then
    raise exception using errcode = 'P0001', message = format('Hold point %s is not waiting for a decision (PR-45). [EBMR-EXE-084]', p_step_key);
  end if;
  select recipe.step_node(pk.content, x ->> 'step') into v_node
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
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

-- Privileges: CREATE OR REPLACE kept those of 0210 and 0295 (both executable by ebmr_app).

reset role;
