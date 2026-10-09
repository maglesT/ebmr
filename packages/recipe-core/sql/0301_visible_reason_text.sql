-- Recipe core: a reason or a justification says something a person can read, and the life-cycle transitions that
-- need a reason record the person's own, both halves (DI-22, DI-24, PR-49, DI-37; review findings V1 and P29,
-- round-1 verification).
--
-- Three residuals of 0270 and 0290:
--   (a) recipe.reason_is_blank (0290) listed white space, controls and some invisible format characters, but not
--       all of them: a reason text of only U+FFF9 (an interlinear annotation mark), U+13430 (an Egyptian hieroglyph
--       format control) or U+070F passed, so an activation of a market authorisation and a RETIRE committed with a
--       reason nobody can read;
--   (b) of the recipe guards of the mbr_version machine only mbr_version.no_open_authorisation (APPROVED -RETIRE->)
--       checked the reason. APPROVED -WITHDRAW-> WITHDRAWN (guard mbr_version.never_authorised) and every RETURN to
--       DRAFT (guard mbr_version.draft_entry_recorded) passed with a reason code alone, through
--       platform.transition or recipe.return_to_draft, both open to the application role, and the engine then
--       wrote the text of the state row's audit entry itself ('WITHDRAW: APPROVED -> WITHDRAWN');
--   (c) the justification of an exception disposition was blank only when JavaScript's trim left nothing
--       (recipe.js_trim, 0270): a justification of only zero-width spaces, a word joiner or a soft hyphen was
--       proposed, signed and recorded.
--
-- From this migration on (with kernel 0960, which gives kernel.is_blank the whole class of characters that show
-- nothing on their own and makes the kernel guard platform.reason_given check both halves):
--   * recipe.reason_is_blank is kernel.is_blank: one test of a blank text for the audit trigger, the kernel's
--     reason guard and every recipe check, the same class as the execution engine's (guards.ts isBlankText);
--   * the guards mbr_version.never_authorised and mbr_version.draft_entry_recorded refuse the transition first
--     when the command's reason code or reason text is blank by that test, as mbr_version.no_open_authorisation
--     does since 0290. Each is registered again with a description that says so; codes, bindings and functions
--     are unchanged, and the machine's sealed hash covers guard codes only (kernel 0550), so the published
--     machine does not change. With the kernel guard, every RETURN, WITHDRAW and RETIRE of an MBR version now
--     records the person's own reason, and the engine never completes any half of it;
--   * recipe.propose_disposition and recipe.check_disposition_state refuse a justification that is blank by the
--     same test (EBMR-EXE-084 and EBMR-EXE-086 as before): the engine refuses it too (requireReason, engine
--     1.1.0), so the database and the engine agree. The justification is still stored trimmed as JavaScript trims
--     it (recipe.js_trim), as the engine stores it.
--
-- Apart from the blank test, each function is exactly as its last definition (0130, 0270, 0290): same checks,
-- order and messages. CREATE OR REPLACE keeps owner, privileges, SECURITY DEFINER (or not), volatility and
-- search_path: propose_disposition executable by ebmr_app; reason_is_blank, check_disposition_state and the guards
-- private to the owner. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- A blank reason half or justification: the kernel's test (kernel 0960).
create or replace function recipe.reason_is_blank(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select kernel.is_blank(p)
$$;

-- The return to DRAFT (all three RETURN transitions): the person's own reason, both halves, and the new draft
-- cycle recorded in this transaction by recipe.return_to_draft.
create or replace function recipe.guard_draft_entry_recorded(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language sql volatile set search_path = pg_catalog, recipe, pg_temp as $$
  select case when recipe.reason_is_blank(p_actor ->> 'reason_code') or recipe.reason_is_blank(p_actor ->> 'reason_text')
              then 'the return to DRAFT needs the reason of the person who returns the version: a reason code and a reason text, neither blank; '
                   'the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)'
              when not exists (select 1 from recipe.mbr_draft_entry d
                               where d.version_id = p_id and d.xact_id = txid_current() and d.from_state = p_transition ->> 'from')
              then 'a return to DRAFT goes through recipe.return_to_draft, which records the new draft cycle so every signature on the version is superseded (DI-37; INV-09)' end
$$;

-- The withdrawal of an APPROVED version (and of no other transition, 0140): the QA person's own reason, both
-- halves, and the version was never authorised for a market.
create or replace function recipe.guard_never_authorised(p_type text, p_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if recipe.reason_is_blank(p_actor ->> 'reason_code') or recipe.reason_is_blank(p_actor ->> 'reason_text') then
    return 'the withdrawal needs the reason of the QA person who withdraws the version: a reason code and a reason text, neither blank; '
           'the system writes no part of it (DI-22, DI-24; EBMR-AUDIT-002)';
  end if;
  if exists (select 1 from recipe.authorisation_cell c where c.version_id = p_id) then
    return 'the version has been authorised for a market: retire it instead of withdrawing it (ADR 0014; PR-05)';
  end if;
  return null;
end
$$;

select platform.register_guard('mbr_version.draft_entry_recorded', 'recipe.guard_draft_entry_recorded(text, uuid, jsonb, jsonb, jsonb)',
  'The command carries the reason of the person who returns the version, code and text (DI-22, DI-24), and the return to DRAFT recorded a new draft cycle in this transaction, superseding every signature (DI-37; INV-09)');
select platform.register_guard('mbr_version.never_authorised', 'recipe.guard_never_authorised(text, uuid, jsonb, jsonb, jsonb)',
  'The command carries the QA person''s own reason, code and text (DI-22, DI-24), and the version was never authorised for any market (ADR 0014)');

-- PR-49, DI-37: as 0270, with a justification that shows nothing refused (recipe.reason_is_blank).
create or replace function recipe.check_disposition_state(p_prior jsonb, p_state jsonb, p_cmd jsonb, p_person uuid, p_signatures uuid[]) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_ex text := coalesce(p_cmd ->> 'exception', 'null');
  x0   jsonb := p_prior -> 'exceptions' -> (p_cmd ->> 'exception');
  x    jsonb := p_state -> 'exceptions' -> (p_cmd ->> 'exception');
  d    jsonb := x -> 'disposition';
begin
  if jsonb_typeof(x0) is distinct from 'object' or x0 ->> 'status' is distinct from 'OPEN' then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is not open in the stored state, so it cannot be dispositioned (DI-26, PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if jsonb_typeof(p_cmd -> 'justification') is distinct from 'string' or recipe.reason_is_blank(p_cmd ->> 'justification') then
    raise exception using errcode = 'P0001',
      message = format('The disposition of exception %s has a blank justification; a disposition states why, in words (PR-49, DI-37). [EBMR-EXE-086]', v_ex);
  end if;
  if coalesce(p_cmd ->> 'outcome', '') not in ('NO_IMPACT', 'DEVIATION_RAISED') then
    raise exception using errcode = 'P0001',
      message = format('The disposition of exception %s is %s; it is NO_IMPACT or DEVIATION_RAISED (PR-49). [EBMR-EXE-086]', v_ex, coalesce(p_cmd ->> 'outcome', 'absent'));
  end if;
  if p_cmd ->> 'outcome' = 'NO_IMPACT' and (x0 -> 'deviationRequired') is distinct from 'false'::jsonb then
    raise exception using errcode = 'P0001',
      message = format('Exception %s needs a deviation; "no impact" is not a disposition it allows (PR-08, PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if p_cmd ->> 'outcome' = 'DEVIATION_RAISED' and jsonb_typeof(x0 -> 'deviation' -> 'ref') is distinct from 'string' then
    raise exception using errcode = 'P0001',
      message = format('Exception %s is dispositioned as a raised deviation, but no deviation is linked to it (PR-49). [EBMR-EXE-086]', v_ex);
  end if;
  if x ->> 'status' is distinct from 'DISPOSITIONED' or cardinality(p_signatures) is distinct from 1
     or d ->> 'outcome' is distinct from p_cmd ->> 'outcome' or d ->> 'justification' is distinct from recipe.js_trim(p_cmd ->> 'justification')
     or d ->> 'signature' is distinct from p_signatures[1]::text or d ->> 'by' is distinct from p_person::text then
    raise exception using errcode = 'P0001',
      message = format('The state records another disposition of exception %s than the signed one (PR-49, DI-37). [EBMR-EXE-086]', v_ex);
  end if;
end
$$;

-- Records the disposition a QA reviewer is about to sign: as 0270, with a justification that shows nothing refused
-- (recipe.reason_is_blank).
create or replace function recipe.propose_disposition(p_batch uuid, p_exception text, p_proposal jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Proposing an exception disposition');
  x       jsonb;
  v_agg   text := p_batch::text || ':' || p_exception;
  v_ver   integer;
begin
  perform recipe.require_command_permission('DISPOSITION_EXCEPTION', 'EXCEPTION_DISPOSITIONED');
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
  insert into recipe.execution_disposition_proposal (batch_id, exception_id, aggregate_id, content_version, proposal,
                                                     proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_exception, v_agg, v_ver, p_proposal, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('content_version', v_ver, 'proposal', p_proposal);
end
$$;

-- Privileges: CREATE OR REPLACE kept those of 0130, 0210, 0270 and 0290 (propose_disposition executable by ebmr_app;
-- reason_is_blank, check_disposition_state and the guards private to the owner).

reset role;
