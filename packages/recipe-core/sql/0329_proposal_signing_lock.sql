-- Recipe core, execution store (module C3): a proposed decision is serialised with every signing of its record, not only
-- with a signing on the server's path (Phase 2 exit review F37, the completeness critic's F37 defect "F37.R"; INV-09,
-- DI-37, PR-49, PR-45; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
-- Correction of 0309's header, stated here because applied migrations are never edited. 0309 serialised
-- recipe.propose_disposition and recipe.propose_hold_point_decision on the batch's row lock (FOR UPDATE on
-- recipe.batch_execution) and said that a proposal on a content version that already carries a signature of the
-- deciding meaning is refused "whatever the path". That holds only for a signature already committed, or made on the
-- server's path, which takes the batch's lock (recipe.lock_execution) before it signs. esig.sign takes only the record's
-- own signing lock (esig.aggregate_lock, a transaction advisory lock: kernel 0220, 0230), which the proposal functions
-- never took; the content providers lock nothing, no deferred re-hash runs when a signature is inserted, and a signature
-- may be committed without being applied (the 0297 same-transaction rule binds only applied signatures). So a writer
-- holding the application role could sign without the batch's lock and keep its transaction open while another QA
-- user's proposal committed on the same content version: the uncommitted signature was invisible to 0309's check, and
-- the committed signature then read CONTENT_MISMATCH, which only esig.verify_signatures reported.
--
-- Both functions now (CREATE OR REPLACE, the bodies of 0309 otherwise unchanged) take, right after the batch's row lock
-- and before reading anything, esig.aggregate_lock of their record ('batch_exception' or 'batch_step', <run>:<key>), the
-- lock every signing of that record holds from esig.sign to its commit, whatever the path:
--   * a proposal made while such a signing is open waits for it; its later statements (READ COMMITTED, one snapshot per
--     statement) then see the committed signature, and the proposal is refused (EBMR-EXE-084: already decided, or a
--     signature of the deciding meaning on that content version);
--   * a signing asked for while a proposal is open waits for the proposal's commit, then finds the content changed and
--     is refused (EBMR-ESIG-012), so it never covers content the record no longer has.
-- Lock order: the batch's lock, then the record's, as a signing on the server's path takes them, so the two never
-- deadlock. A writer that signs first and then takes the batch's lock in the same transaction (to record the act) takes
-- them in the other order; against a concurrent proposal PostgreSQL then detects the deadlock and aborts one of the two
-- transactions (SQLSTATE 40P01), and neither leaves a signature over content its record does not have (checked on
-- PostgreSQL 16: an advisory lock and a row lock taken in opposite orders by two transactions end in 40P01 for one).
--
-- Decision F37.1 in docs/decisions/phase-2-open-questions.md is corrected to match. CREATE OR REPLACE keeps the owner
-- (ebmr_owner), SECURITY DEFINER, the volatility, the search_path and the privileges (both executable by ebmr_app).
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-49, DI-37, INV-09: as 0309, also serialised with every signing of the exception (F37.R).
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

-- PR-45, DI-37, INV-09: as 0309, also serialised with every signing of the hold point (F37.R).
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

-- Privileges: CREATE OR REPLACE kept those of 0309 (both executable by ebmr_app). esig.aggregate_lock stays private to
-- the owner, which owns both functions.

reset role;
