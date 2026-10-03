-- Recipe core, execution store (module C3): a decision is proposed only in a READ COMMITTED transaction, where the locks
-- of 0309 and 0329 serialise it with every signing of its record (Phase 2 exit review F37, the round-4 verification of
-- the completeness critic's F37 defect "F37.R"; INV-09, DI-37, PR-49, PR-45; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- Corrections of earlier headers, stated here because applied migrations are never edited:
--   * 0309 said that under REPEATABLE READ or SERIALIZABLE the batch's row lock "fails with a serialization error when a
--     signing committed a change of the batch meanwhile". That holds only for a signing that changed the batch's row (one
--     on the server's path). A signer outside that path changes no batch row, so the proposal took the lock without an
--     error, and every later statement still read the snapshot of the transaction's first statement, taken before the
--     wait: the round-4 verification ran the steward's proposal in REPEATABLE READ (and SERIALIZABLE) while QA1's
--     signature, made through esig.sign without the batch's lock, was open; the proposal waited for 0329's signing lock,
--     then found no signature and the exception open in its snapshot and committed on the signed content version, and
--     the signature read CONTENT_MISMATCH, seen only by esig.verify_signatures.
--   * 0329 said a proposal made while a signing is open "waits for it; its later statements (READ COMMITTED, one snapshot
--     per statement) then see the committed signature", and that a signing asked for while a proposal is open is refused
--     because the record changed (EBMR-ESIG-012). Both hold only in READ COMMITTED: a proposal in a snapshot isolation
--     level saw nothing committed after its first statement (above), and a signing in REPEATABLE READ waited for the
--     proposal's commit and then re-hashed the record as its own snapshot showed it, signed, and read CONTENT_MISMATCH
--     (the verification's case B). Decision F37.1 said the same and is corrected by F37.2.
--
-- Both proposal functions (CREATE OR REPLACE; the bodies of 0329 otherwise unchanged) now refuse, before they take any
-- lock or read anything, a transaction whose isolation level is not READ COMMITTED (EBMR-EXE-084, with the reason). The
-- signing side is closed in the kernel: esig.aggregate_lock, which esig.sign and every change of signed content take,
-- refuses any other isolation level (kernel 1020, EBMR-ESIG-015). The server's commands run in READ COMMITTED (decision
-- X20), so nothing it does changes. CREATE OR REPLACE keeps the owner (ebmr_owner), SECURITY DEFINER, the volatility,
-- the search_path and the privileges (both executable by ebmr_app). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

-- PR-49, DI-37, INV-09: as 0329, and only in READ COMMITTED (F37.R, round 2).
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

-- PR-45, DI-37, INV-09: as 0329, and only in READ COMMITTED (F37.R, round 2).
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

-- Privileges: CREATE OR REPLACE kept those of 0329 (both executable by ebmr_app).

reset role;
