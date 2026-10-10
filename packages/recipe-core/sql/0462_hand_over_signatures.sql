-- Recipe core, execution store (module C3): the hand-over of a step in progress, part 2: its e-signatures (Phase 3 slice
-- 2, plan item 3; outline 5.2.3, L-07; DI-35, DI-17, PR-14; INV-10; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- recipe.check_signatures (last replaced by 0451) refused every signed command type it had no case for (EBMR-EXE-050).
-- It now checks HAND_OVER_STEP (0461) with every guard of 0451 kept for each signature (meaning allowed for the command
-- type and part, signer, never used before, valid, bound to the record in its present state; for the signer's own
-- signature, made in this command and in this very transaction):
--   HAND_OVER_STEP  the recording supervisor's own signature (HANDOVER_APPROVED) and QA's approval (HANDOVER_APPROVED)
--                   of another person (recipe.approval_refs), both on the batch record at the state version the row acts
--                   on (0450's `<batch>:record@<version>`).
-- recipe.check_approver_roles (0451) gains, for HAND_OVER_STEP, from the authority the kernel evaluated when each person
-- signed (never from the roles the command names): the approval is QA's (the quality unit: QA, QA_REVIEWER), and the
-- command's own signature is a production supervisor's (PRODUCTION_SUPERVISOR or HEAD_OF_PRODUCTION; engine
-- DEFAULT_POLICY supervisorRoles). That neither of them is the outgoing or the incoming performer or involved in the
-- step is 0463's.
--
-- Messages: EBMR-EXE-050/051/052 (as in 0451), EBMR-EXE-171 (a signer without the role). CREATE OR REPLACE keeps the
-- owner, privileges (none for PUBLIC), SECURITY DEFINER and search_path of both functions. Applied as a new migration
-- because applied migrations are never edited.

set local role ebmr_owner;

create or replace function recipe.check_approver_roles(p_type text, p_refs jsonb) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  supervisor_or_qa constant text[] := array['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION', 'QA'];
  quality_unit     constant text[] := array['QA', 'QA_REVIEWER'];
  v_need  text[];
  v_held  text[];
  v_heads integer := 0;
  v_qas   integer := 0;
  r       jsonb;
begin
  -- L-07 (0462): the signer of a hand-over is a production supervisor (the engine's policy supervisorRoles).
  if p_type = 'HAND_OVER_STEP' then
    for r in select x from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) x where x ->> 'part' = 'signature' loop
      v_held := recipe.signer_engine_roles((r -> 'ref' ->> 'id')::uuid);
      if not (v_held && array['PRODUCTION_SUPERVISOR', 'HEAD_OF_PRODUCTION']) then
        raise exception using errcode = 'P0001',
          message = format('The hand-over is signed by %s, who held %s when signing; a hand-over is signed by a production supervisor and approved by QA (PR-14, DI-17, DI-35). [EBMR-EXE-171]',
                           r ->> 'signer', coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'));
      end if;
    end loop;
  end if;
  for r in select x from jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) x where x ->> 'part' = 'approval' loop
    v_held := recipe.signer_engine_roles((r -> 'ref' ->> 'id')::uuid);
    if p_type = 'ABORT_BATCH' then
      if 'HEAD_OF_PRODUCTION' = any (v_held) and v_heads = 0 then
        v_heads := 1;
        continue;
      elsif v_held && quality_unit and v_qas = 0 then
        v_qas := 1;
        continue;
      end if;
      raise exception using errcode = 'P0001',
        message = format('The abort approval signed by %s is neither the head of production''s nor QA''s (the signer held %s): an abort is approved by the head of production and by QA, two different persons (PR-13, DI-35). [EBMR-EXE-171]',
                         r ->> 'signer', coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'));
    end if;
    v_need := case p_type
                when 'CORRECT_ENTRY' then supervisor_or_qa
                when 'REQUEST_SKIP' then supervisor_or_qa
                when 'VOID_ATTEMPT' then array['QA']
                when 'INVALIDATE_RESULT' then quality_unit
                when 'HAND_OVER_STEP' then quality_unit
              end;
    if v_need is null then
      raise exception using errcode = 'P0001', message = format('%s carries an approval this release does not check (DI-17, DI-35). [EBMR-EXE-171]', coalesce(p_type, 'This command'));
    end if;
    if not (v_held && v_need) then
      raise exception using errcode = 'P0001',
        message = format('The approval of this %s is signed by %s, who held %s when signing; it is approved only by %s, as S25 and S28 ask (DI-17, DI-24, DI-29). [EBMR-EXE-171]',
                         p_type, r ->> 'signer', coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'), array_to_string(v_need, ' or '));
    end if;
  end loop;
  if p_type = 'ABORT_BATCH' and (v_heads <> 1 or v_qas <> 1) then
    raise exception using errcode = 'P0001',
      message = 'An abort is approved by the head of production and by QA, two different persons (PR-13, DI-35). [EBMR-EXE-171]';
  end if;
end
$$;

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
    when 'REQUEST_SKIP' then
      -- The approval of a skip is about the batch record (0450): a phase about to be skipped has no stored content
      -- (its first version is stored when a person first works on it).
      v_atype := 'batch_record';
      v_agg := p_batch::text || ':record@' || coalesce(v_prior ->> 'version', '?');
      v_refs := recipe.approval_refs(p_cmd, p_person, 'A skip');
    when 'VOID_ATTEMPT' then
      -- S28: every void is approved, whatever the pinned policy says (the application chose that policy; the
      -- stricter rule). The approval is about the batch record (0450): the void changes the step's content.
      v_atype := 'batch_record';
      v_agg := p_batch::text || ':record@' || coalesce(v_prior ->> 'version', '?');
      if not (p_cmd ? 'approval') then
        raise exception using errcode = 'P0001',
          message = 'A void of an attempt needs the signed approval of QA (S28, DI-29). [EBMR-EXE-051]';
      end if;
      v_refs := recipe.approval_refs(p_cmd, p_person, 'A void');
    when 'INVALIDATE_RESULT' then
      v_atype := 'batch_point';
      v_agg := p_batch::text || ':' || (p_cmd ->> 'point');
      v_refs := recipe.approval_refs(p_cmd, p_person, 'An invalidation');
    when 'ABORT_BATCH' then
      v_atype := 'batch_record';
      v_agg := p_batch::text || ':record@' || coalesce(v_prior ->> 'version', '?');
      if jsonb_typeof(p_cmd -> 'approvals') is distinct from 'array' or jsonb_array_length(p_cmd -> 'approvals') <> 2
         or exists (select 1 from jsonb_array_elements(p_cmd -> 'approvals') a
                     where jsonb_typeof(a) is distinct from 'object' or a -> 'approver' ->> 'kind' is distinct from 'PERSON'
                        or jsonb_typeof(a -> 'approver' -> 'id') is distinct from 'string')
         or (p_cmd -> 'approvals' -> 0 -> 'approver' ->> 'id') = (p_cmd -> 'approvals' -> 1 -> 'approver' ->> 'id') then
        raise exception using errcode = 'P0001',
          message = 'An abort carries exactly two approvals, each signed by its approver, two different persons: the head of production and QA (PR-13, DI-35). [EBMR-EXE-052]';
      end if;
      select jsonb_agg(jsonb_build_object('part', 'approval', 'ref', a -> 'signature', 'signer', a -> 'approver' ->> 'id') order by i)
        into v_refs from jsonb_array_elements(p_cmd -> 'approvals') with ordinality x (a, i);
    when 'CANCEL_BATCH' then
      v_atype := 'batch_record';
      v_agg := p_batch::text || ':record@' || coalesce(v_prior ->> 'version', '?');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person));
    when 'HAND_OVER_STEP' then
      -- L-07 (0462): the supervisor's own signature, made in this command, and QA's approval, another person's; both on
      -- the batch record at the state version the row acts on (0461).
      v_atype := 'batch_record';
      v_agg := p_batch::text || ':record@' || coalesce(v_prior ->> 'version', '?');
      v_refs := jsonb_build_array(jsonb_build_object('part', 'signature', 'ref', p_cmd -> 'signature', 'signer', p_person))
                || recipe.approval_refs(p_cmd, p_person, 'A hand-over');
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

  perform recipe.check_approver_roles(v_type, v_refs);
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
