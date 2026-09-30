-- Recipe core, execution store (module C3): the signer's own e-signature is made in the transaction that records
-- the signed act (review finding P24, follow-up; INV-10, DI-35; Part 11 signature/record linking; EU GMP Annex 11
-- section 14). ADR 0012: the rule holds when the application's own database credentials are used directly.
--
-- recipe.check_signatures (0270, 0295) tied the signer's own signature to the command recording the act only
-- through the correlation id: esig.signature.correlation_id had to equal the actor's correlation id. Correlation ids
-- are chosen by the application and nothing makes them unique (neither kernel.validate_actor_context nor
-- iam.command_log refuses a correlation id seen before). So a valid signature made and committed in an earlier
-- transaction, and never applied, was accepted by a later command that reused that transaction's correlation id,
-- although the 0270 header and the store's README promise a signature made in this very command (the ceremony
-- signs and applies atomically).
--
-- Now the signer's own signature (part 'signature') must also have been made in the current transaction: the
-- SIGNATURE use of its authentication event (iam.auth_event_use, written by iam.consume_auth_event inside esig.sign
-- and never written again for that event) carries this transaction's id (pg_current_xact_id(), the top-level
-- transaction's id also inside a savepoint). A transaction id is assigned by the server, never by the caller, and a
-- signature row is written once, by esig.sign, so a signature made elsewhere cannot meet it. The check on the
-- correlation id stays, with its message, and runs first. An approval of a correction (part 'approval') is still
-- signed by its approver in a command of their own, as before.
--
-- The replacement carries forward every guard of 0295 unchanged: the meaning allowed for the command type and on
-- the step, the hold-point decision class and binding (recipe.check_hold_point_decision), the check a verifier signs
-- (P37, recipe.step_check_meanings), the reuse, validity, state and signer checks, and the exception-disposition
-- proposal (recipe.check_disposition_proposal).
--
-- Message: EBMR-EXE-051 (a signature made in another transaction). CREATE OR REPLACE keeps the owner (ebmr_owner),
-- the privileges (none for PUBLIC; executed only by recipe.append_execution, which runs as the owner), SECURITY
-- DEFINER and the search_path of 0210/0270/0295. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- INV-10, DI-35, DI-37: every e-signature an accepted command of a signed type needs is there, has a meaning the
-- command type allows and the engine allows on that step (recipe.step_signature_meanings), was made by the person
-- who uses it, was never used before, is valid (content unchanged, sealed, not superseded), belongs to the
-- aggregate the command acts on, was applied in the record's present state, and, for the signer's own signature,
-- was made in this command: under its correlation id and in this very transaction (the SIGNATURE use of its
-- authentication event carries this transaction's id, P24). A VERIFY is signed with the check the step requires
-- (recipe.step_check_meanings, P37).
-- A correction of a value not declared NON_CRITICAL carries an approval by another person (S25). An accepted
-- DISPOSITION_EXCEPTION carries the proposal its signature covers, an accepted DISPOSITION_HOLD_POINT the decision
-- its signature covers (P26, P38). Returns the signature ids.
create or replace function recipe.check_signatures(p_batch uuid, p_cmd jsonb, p_person uuid) returns uuid[]
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_type    text := p_cmd ->> 'type';
  v_signed  boolean;
  v_prior   jsonb;
  v_step    text[];
  v_check   text[];
  v_refs    jsonb := '[]'::jsonb;
  v_agg     text;
  v_atype   text;
  r         jsonb;
  v_ref     jsonb;
  v_id      uuid;
  v_mean    text;
  v_used    bigint;
  s         esig.signature;
  v_problem text;
  v_out     uuid[] := '{}';
begin
  select c.signed into v_signed from recipe.execution_command_permission c where c.command_type = v_type;
  select st.state into v_prior from recipe.execution_state st where st.batch_id = p_batch;
  case v_type
    when 'SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT' then
      v_atype := 'batch_step';
      v_agg := recipe.instance_aggregate(p_batch, p_cmd ->> 'step', p_cmd -> 'context');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person));
    when 'SIGN_OFF_STAGE' then
      v_atype := 'batch_stage';
      v_agg := recipe.instance_aggregate(p_batch, p_cmd ->> 'stage', p_cmd -> 'context');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person));
    when 'DISPOSITION_EXCEPTION' then
      v_atype := 'batch_exception';
      v_agg := p_batch::text || ':' || (p_cmd ->> 'exception');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person));
    when 'CORRECT_ENTRY' then
      v_atype := 'batch_point';
      v_agg := p_batch::text || ':' || (p_cmd ->> 'point');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person));
      if p_cmd ? 'approval' then
        if jsonb_typeof(p_cmd -> 'approval') is distinct from 'object' or p_cmd -> 'approval' -> 'approver' ->> 'kind' is distinct from 'PERSON'
           or coalesce(p_cmd -> 'approval' -> 'approver' ->> 'id', p_person::text) = p_person::text then
          raise exception using errcode = 'P0001',
            message = 'A correction is approved by another person than the corrector, who signs the approval themselves (DI-24, DI-35). [EBMR-EXE-052]';
        end if;
        v_refs := v_refs || jsonb_build_array(jsonb_build_object('part', 'approval', 'ref', p_cmd -> 'approval' -> 'signature',
                                                                  'signer', p_cmd -> 'approval' -> 'approver' ->> 'id'));
      elsif recipe.correction_needs_approval(p_batch, v_prior, p_cmd ->> 'point') then
        raise exception using errcode = 'P0001',
          message = format('The correction of %s needs the signed approval of a supervisor or QA: the value is not declared non-critical (S25, DI-24). [EBMR-EXE-051]',
                           coalesce(p_cmd ->> 'point', 'the data point'));
      end if;
    else
      if v_signed is distinct from false then
        raise exception using errcode = 'P0001',
          message = format('%s is a signed act whose signature test runs cannot check in this release (DI-35). [EBMR-EXE-050]', coalesce(v_type, 'This command'));
      end if;
      if p_cmd ? 'signature' or p_cmd ? 'approval' or p_cmd ? 'approvals' then
        raise exception using errcode = 'P0001',
          message = format('%s carries e-signatures, which test runs do not accept in this release (DI-35). [EBMR-EXE-050]', v_type);
      end if;
      return v_out;
  end case;
  if v_signed is not true then
    raise exception using errcode = 'P0001', message = format('%s is not listed as a signed command type (DI-35). [EBMR-EXE-050]', v_type);
  end if;
  v_step := recipe.step_signature_meanings(p_batch, v_prior, p_cmd);
  if v_type = 'VERIFY' then
    v_check := recipe.step_check_meanings(p_batch, v_prior, p_cmd);
  end if;

  for r in select * from jsonb_array_elements(v_refs) loop
    v_ref := r -> 'ref';
    if jsonb_typeof(v_ref) is distinct from 'object' or jsonb_typeof(v_ref -> 'id') is distinct from 'string' then
      raise exception using errcode = 'P0001', message = format('%s needs an e-signature (DI-35, INV-10). [EBMR-EXE-051]', v_type);
    end if;
    begin
      v_id := (v_ref ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = 'P0001',
        message = format('%s names signature %s, which is not an e-signature of this system (DI-35, INV-10). [EBMR-EXE-051]', v_type, v_ref ->> 'id');
    end;
    if (v_ref ->> 'signer') is distinct from (r ->> 'signer') then
      raise exception using errcode = 'P0001',
        message = format('Signature %s is used by %s but names %s as its signer: nobody signs for someone else (DI-35, INV-10). [EBMR-EXE-052]',
                         v_id, coalesce(r ->> 'signer', 'nobody'), coalesce(v_ref ->> 'signer', 'nobody'));
    end if;
    v_mean := v_ref ->> 'meaning';
    if not exists (select 1 from recipe.execution_signature_meaning m where m.command_type = v_type and m.part = r ->> 'part' and m.meaning_code = v_mean) then
      raise exception using errcode = 'P0001',
        message = format('%s cannot be signed with meaning %s (DI-35, INV-10). [EBMR-EXE-051]', v_type, coalesce(v_mean, 'none'));
    end if;
    if v_type = 'DISPOSITION_HOLD_POINT' and (jsonb_typeof(p_cmd -> 'disposition') is distinct from 'string'
                                               or v_mean is distinct from recipe.hold_point_meaning(p_cmd ->> 'disposition')) then
      raise exception using errcode = 'P0001',
        message = format('The hold-point decision %s is signed %s; a decision is signed with the meaning of its own class (PR-45, DI-35). [EBMR-EXE-051]',
                         coalesce(p_cmd ->> 'disposition', 'none'), v_mean);
    end if;
    if v_step is not null and not (v_mean = any (v_step)) then
      raise exception using errcode = 'P0001',
        message = format('On step %s the engine accepts %s signed %s, not %s: the meanings come from the step''s block, its check meaning in the MBR, its hold-point decisions and whether it awaits re-verification (DI-35, INV-10). [EBMR-EXE-051]',
                         coalesce(p_cmd ->> 'step', 'null'), v_type,
                         case when cardinality(v_step) = 0 then 'with no meaning' else array_to_string(v_step, ' or ') end, v_mean);
    end if;
    select c.seq into v_used from recipe.execution_command c where c.signature_ids @> array[v_id] limit 1;
    if v_used is not null or v_id = any (v_out) then
      raise exception using errcode = 'P0001',
        message = format('Signature %s was already used%s; an e-signature authorises one act only (INV-10, DI-35). [EBMR-EXE-051]',
                         v_id, case when v_used is null then ' in this command' else ' by row ' || v_used end);
    end if;
    perform esig.assert_signature(v_id, v_mean, v_atype, v_agg);
    select * into s from esig.signature g where g.id = v_id;
    if s.signer_person::text is distinct from r ->> 'signer' then
      raise exception using errcode = 'P0001', message = format('Signature %s was not made by %s (DI-35, INV-10). [EBMR-EXE-052]', v_id, r ->> 'signer');
    end if;
    v_problem := esig.signature_state_problem(v_id);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Signature %s is not bound to the record as it is now: %s (DI-37, INV-10). [EBMR-EXE-051]', v_id, v_problem);
    end if;
    if r ->> 'part' = 'signature' and s.correlation_id is distinct from (v_actor ->> 'correlation_id')::uuid then
      raise exception using errcode = 'P0001',
        message = format('Signature %s was made in another command; a signed act is recorded by the command that signed it (INV-10, DI-35). [EBMR-EXE-051]', v_id);
    end if;
    -- P24: the correlation id is the application's choice and may repeat; the transaction id is the server's. The
    -- signer's own signature was made in this very transaction: esig.sign consumed its authentication event here.
    if r ->> 'part' = 'signature'
       and not exists (select 1 from iam.auth_event_use u
                        where u.auth_event_id = s.auth_event_id and u.use_kind = 'SIGNATURE' and u.xact_id = pg_current_xact_id()) then
      raise exception using errcode = 'P0001',
        message = format('Signature %s was made in another transaction; a signed act is recorded in the transaction that signed it, whatever correlation id the command gives (INV-10, DI-35). [EBMR-EXE-051]', v_id);
    end if;
    -- P37: a verifier signs the check the step requires, never a witness or another block's check in its place.
    if v_type = 'VERIFY' and not (v_mean = any (coalesce(v_check, '{}'))) then
      raise exception using errcode = 'P0001',
        message = format('Step %s requires the check %s, not %s: a verifier signs the check the step requires (its re-verification, the MBR''s witness, or its block''s own check), never another in its place (DI-35, PR-14, PR-20). [EBMR-EXE-051]',
                         coalesce(p_cmd ->> 'step', 'null'), case when cardinality(v_check) = 0 then '(none: not a step of this MBR)' else array_to_string(v_check, ' or ') end, v_mean);
    end if;
    v_out := v_out || v_id;
  end loop;

  if v_type = 'DISPOSITION_EXCEPTION' then
    perform recipe.check_disposition_proposal(p_batch, v_prior, p_cmd, p_person, v_out[1]);
  end if;
  if v_type = 'DISPOSITION_HOLD_POINT' then
    perform recipe.check_hold_point_decision(v_agg, p_cmd, p_person, v_out[1]);
  end if;
  return v_out;
end
$$;

reset role;
