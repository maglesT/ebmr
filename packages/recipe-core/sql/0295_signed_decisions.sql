-- Recipe core, execution store (module C3): what a QA reviewer and a verifier sign is what the database records
-- (review findings P26, P38, P37; PR-45, PR-14, PR-20, DI-35, DI-37; Part 11 signature/record linking; EU GMP
-- Annex 11 section 14). ADR 0012: the rules hold when the application's own database credentials are used directly.
--
-- Hold-point decisions (P26, P38). A hold point offers dispositions of two classes only as far as the signature
-- meaning goes (HOLD_POINT_RELEASED for APPROVED, APPROVED_WITH_CONDITIONS and the other releasing dispositions;
-- HOLD_POINT_NOT_RELEASED for the rest), and the step's content held neither the disposition nor the reviewer's
-- comment. recipe.check_signatures (0270) compared only the class, so a signature requested for a conditional
-- release could record an unconditional one, and the reason QA gave for a rejection was never under a signature.
-- Now, as for an exception disposition (0200, 0270):
--   * recipe.propose_hold_point_decision records the decision a reviewer is about to sign, {disposition, comment},
--     on the hold point's current content version, when the signing challenge is prepared (the permission of
--     DISPOSITION_HOLD_POINT with the meaning of the decision's class; an undecided hold point; a disposition the
--     hold point offers in the batch's own MBR content; a comment that is a text of at most 2000 characters, or
--     none). Insert-only and audited, apart from the signed content table on purpose: proposing is not a change of
--     the step's data, so it never makes the reviewer an "enterer" of the record they sign (esig content_change,
--     INV-03);
--   * the batch_step content provider adds the latest proposal made on the current content version of a hold point
--     as `proposedDecision` (JSON null when none), so the challenge, the signature and every later check of it bind
--     the disposition and the comment; a second proposal changes the content, so a signature requested for another
--     decision can no longer be applied (the kernel's content check);
--   * an accepted DISPOSITION_HOLD_POINT carries exactly the disposition and comment its signature covers: the
--     proposal on the signed content version, made by the signer in the command that requested this very signature
--     (the challenge's correlation id), recipe.check_hold_point_decision;
--   * on every row a hold point's decision in the engine state changes only through the accepted
--     DISPOSITION_HOLD_POINT of that hold point, which records the signed disposition and comment, by the signer,
--     with the one signature the row uses (recipe.check_hold_point_changes); a decision is never removed.
--
-- The check a verifier signs (P37). The engine asks a verifier for one meaning: RE_VERIFIED_AFTER_CORRECTION while
-- the step awaits re-verification, WITNESSED where the MBR asks for a witness, else the step block's own check
-- meaning (CONTAINER_CHECKED on a dispensing step, LINE_CLEARANCE_VERIFIED on a clearance) or VERIFIED. 0270 also
-- accepted WITNESSED on every other step, which drops the check the step requires (and needs STEP.WITNESS
-- instead of STEP.VERIFY), and any verification meaning of another block. Now an accepted VERIFY is signed with the
-- meaning the step requires (recipe.step_check_meanings: the block's own check meanings when it has any), checked
-- after the signature's own checks, so the reasons 0270 gives stay as they were.
--
-- Messages: EBMR-EXE-086 (a decision other than the signed one, as for an exception disposition), EBMR-EXE-051 (a
-- meaning the step does not require), EBMR-EXE-084 (a proposal that cannot be recorded), EBMR-EXE-044 (a state that
-- changes a hold-point decision no row may change). CREATE OR REPLACE keeps the owner, the privileges, SECURITY
-- DEFINER and the search_path of 0210/0270; the new helpers are private to the owner. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Proposed hold-point decisions
-- ---------------------------------------------------------------------------------------------

create table recipe.execution_decision_proposal (
  id                   bigint generated always as identity primary key,
  batch_id             uuid not null references recipe.batch_execution (id),
  step_key             text not null check (btrim(step_key) <> ''),
  aggregate_id         text not null,
  content_version      integer not null check (content_version >= 1),
  proposal             jsonb not null check (jsonb_typeof(proposal) = 'object'),
  proposed_by_person   uuid not null,
  proposed_by_account  uuid not null,
  correlation_id       uuid not null,
  proposed_at          timestamptz not null default clock_timestamp(),
  check (aggregate_id = batch_id::text || ':' || step_key)
);
revoke all on recipe.execution_decision_proposal from public;
create index execution_decision_proposal_aggregate on recipe.execution_decision_proposal (aggregate_id, content_version, id);

select kernel.register_audited_table('recipe.execution_decision_proposal', 'batch', 'batch_id', true);

-- INV-27: the latest proposal of a content version is the one with the highest id, so an id reused after a restore
-- could change which decision a reviewer signs (as for recipe.execution_disposition_proposal, 0220).
select continuity.register_protected_sequence('recipe.execution_decision_proposal.id',
  pg_get_serial_sequence('recipe.execution_decision_proposal', 'id')::regclass,
  'OTHER', 'recipe-core', 'Ids of recipe.execution_decision_proposal (record ids in the audit trail of a test batch)', 100000);

-- The latest proposed decision made on a content version of a hold point's step aggregate (JSON null when none).
create function recipe.current_decision(p_aggregate text, p_version integer) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select p.proposal from recipe.execution_decision_proposal p
                    where p.aggregate_id = p_aggregate and p.content_version = p_version order by p.id desc limit 1), 'null'::jsonb)
$$;

-- Records the decision a QA reviewer is about to sign on hold point p_step_key: {disposition, comment}, on the
-- step's current content version (sandbox only; the permission of DISPOSITION_HOLD_POINT for the meaning of the
-- decision's class). The hold point is undecided in the stored state, the disposition one it offers in the batch's
-- MBR content, the comment a text of at most 2000 characters or null. An absent or extra member is refused.
create function recipe.propose_hold_point_decision(p_batch uuid, p_step_key text, p_proposal jsonb) returns jsonb
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
  insert into recipe.execution_decision_proposal (batch_id, step_key, aggregate_id, content_version, proposal,
                                                  proposed_by_person, proposed_by_account, correlation_id)
  values (p_batch, p_step_key, v_agg, v_ver, jsonb_build_object('disposition', p_proposal -> 'disposition', 'comment', p_proposal -> 'comment'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('content_version', v_ver, 'proposal', recipe.current_decision(v_agg, v_ver));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The batch_step content provider: a hold point's content carries the decision being signed
-- ---------------------------------------------------------------------------------------------

create or replace function recipe.execution_content_of(p_type text, p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_table regclass := recipe.content_table(p_type);
  v_row   record;
  v_batch uuid;
  v_key   text;
  b       recipe.batch_execution;
  st      jsonb;
  x       jsonb;
  v_state text;
  v_by    uuid[] := '{}';
  v_act   jsonb;
  v_ended bigint;
  v_dev   uuid;
begin
  if v_table is null or p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:.+$' then
    return jsonb_build_object('exists', false);
  end if;
  v_batch := split_part(p_id, ':', 1)::uuid;
  v_key := substr(p_id, 38);
  execute format('select content_version, content from %s where aggregate_id = $1 order by content_version desc limit 1', v_table) into v_row using p_id;
  if v_row.content_version is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = v_batch;
  select state into st from recipe.execution_state where batch_id = v_batch;
  case p_type
    when 'batch_step' then
      x := st -> 'steps' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(coalesce(x -> 'performers', '[]') || coalesce(x -> 'dataEnterers', '[]') || coalesce(x -> 'correctors', '[]')
                                || coalesce(x -> 'performedSigners', '[]'));
      v_ended := recipe.micros_of(x -> 'endedAt');
      if v_ended is not null then
        select c.device_id into v_dev from recipe.execution_command c
         where c.batch_id = v_batch and c.accepted and c.command_type = 'SIGN_PERFORMED'
           and recipe.instance_aggregate(v_batch, c.command ->> 'step', c.command -> 'context') = p_id
         order by c.seq desc limit 1;
        if v_dev is not null then
          v_act := jsonb_build_object('device_id', v_dev, 'at', timestamptz 'epoch' + make_interval(secs => 0) + (v_ended::text || ' microseconds')::interval,
                                      'next_step_started', recipe.next_step_started(st, v_key, v_ended));
        end if;
      end if;
      -- The hold-point decision being signed is part of the signed content (recipe.propose_hold_point_decision; P26, P38).
      if v_row.content -> 'step' ->> 'kind' = 'HOLD' then
        v_row.content := v_row.content || jsonb_build_object('proposedDecision', recipe.current_decision(p_id, v_row.content_version));
      end if;
    when 'batch_stage' then
      x := st -> 'stages' -> v_key;
      v_state := case when (x -> 'signOff' ->> 'valid')::boolean is true then 'SIGNED_OFF'
                      when (x ->> 'awaitingSignOff')::boolean is true or x ? 'endedAt' then 'AWAITING_SIGN_OFF'
                      else 'IN_PROGRESS' end;
    when 'batch_exception' then
      x := st -> 'exceptions' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'raisedBy', x -> 'deviation' ->> 'linkedBy'));
      -- The disposition being signed is part of the signed content (recipe.propose_disposition).
      v_row.content := v_row.content || jsonb_build_object('proposedDisposition', recipe.current_proposal(p_id, v_row.content_version));
    when 'batch_point' then
      x := st -> 'points' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'enteredBy'));
  end case;
  -- The content is returned exactly as stored (its null members are part of the signed text); only an
  -- absent act is left out.
  return jsonb_build_object(
    'exists', true, 'content_version', v_row.content_version, 'content', v_row.content, 'state', v_state,
    'entered_by', to_jsonb(v_by), 'scope', jsonb_build_object('site', b.site_code))
    || case when v_act is null then '{}'::jsonb else jsonb_build_object('act', v_act) end;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards (owner only)
-- ---------------------------------------------------------------------------------------------

-- PR-45, DI-37: an accepted DISPOSITION_HOLD_POINT on aggregate p_agg carries exactly the decision its signature
-- p_signature covers: the latest proposal on the signed content version (part of the signed content), made by the
-- signer p_person in the command that requested this signature (the challenge's correlation id).
create function recipe.check_hold_point_decision(p_agg text, p_cmd jsonb, p_person uuid, p_signature uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_step text := coalesce(p_cmd ->> 'step', 'null');
  v_ver  bigint;
  v_corr uuid;
  pr     recipe.execution_decision_proposal;
begin
  select g.content_version, c.correlation_id into v_ver, v_corr
    from esig.signature g join esig.challenge c on c.id = g.challenge_id where g.id = p_signature;
  select * into pr from recipe.execution_decision_proposal p
   where p.aggregate_id = p_agg and p.content_version = v_ver order by p.id desc limit 1;
  if pr.id is null then
    raise exception using errcode = 'P0001',
      message = format('The signature on hold point %s covers no proposed decision, so nothing was signed to decide it (PR-45, DI-37). [EBMR-EXE-086]', v_step);
  end if;
  if pr.proposed_by_person is distinct from p_person or pr.correlation_id is distinct from v_corr then
    raise exception using errcode = 'P0001',
      message = format('The decision the signature on hold point %s covers was not prepared by the signer when this signature was requested (PR-45, DI-37). [EBMR-EXE-086]', v_step);
  end if;
  if jsonb_typeof(p_cmd -> 'disposition') is distinct from 'string' or coalesce(jsonb_typeof(p_cmd -> 'comment'), 'string') is distinct from 'string'
     or p_cmd ->> 'disposition' is distinct from pr.proposal ->> 'disposition'
     or coalesce(p_cmd -> 'comment', 'null'::jsonb) is distinct from coalesce(pr.proposal -> 'comment', 'null'::jsonb) then
    raise exception using errcode = 'P0001',
      message = format('The disposition or comment of the decision on hold point %s is not the decision its signature covers; a decision is recorded exactly as signed (PR-45, DI-37). [EBMR-EXE-086]', v_step);
  end if;
end
$$;

-- PR-45, DI-37: what a row may do to the hold-point decisions of the stored state p_prior. A decision stays in the
-- state as recorded (never removed or changed); a step gets one only through an accepted DISPOSITION_HOLD_POINT of
-- that step instance, which records the command's disposition and comment, by person p_person, with the one
-- signature the row uses (p_sigs); and that command does record it.
create function recipe.check_hold_point_changes(p_prior jsonb, p_state jsonb, p_kind text, p_cmd jsonb, p_accepted boolean, p_person uuid, p_sigs uuid[]) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  s0     jsonb := coalesce(p_prior -> 'steps', '{}'::jsonb);
  s1     jsonb := p_state -> 'steps';
  v_act  boolean := coalesce(p_kind = 'COMMAND' and p_accepted is true and p_cmd ->> 'type' = 'DISPOSITION_HOLD_POINT', false);
  v_done boolean := false;
  k      text;
  x0     jsonb;
  x1     jsonb;
  d0     jsonb;
  d1     jsonb;
begin
  if jsonb_typeof(s0) is distinct from 'object' or jsonb_typeof(s1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The steps of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  for k, x0 in select key, value from jsonb_each(s0) where jsonb_typeof(value) = 'object' and value ? 'disposition' loop
    if (s1 -> k -> 'disposition') is distinct from (x0 -> 'disposition') then
      raise exception using errcode = 'P0001',
        message = format('The state changes or removes the decision recorded on hold point %s; a signed decision is kept as recorded (PR-45, DI-37). [EBMR-EXE-044]', k);
    end if;
  end loop;
  for k, x1 in select key, value from jsonb_each(s1) loop
    d1 := case when jsonb_typeof(x1) = 'object' then x1 -> 'disposition' end;
    d0 := s0 -> k -> 'disposition';
    if d1 is null or d0 is not null then
      continue;
    end if;
    if not v_act or x1 ->> 'step' is distinct from p_cmd ->> 'step' or coalesce(x1 -> 'frames', '[]'::jsonb) is distinct from coalesce(p_cmd -> 'context', '[]'::jsonb) then
      raise exception using errcode = 'P0001',
        message = format('The state records a decision on hold point %s without its own signed decision (PR-45, DI-37). [EBMR-EXE-044]', k);
    end if;
    if jsonb_typeof(d1) is distinct from 'object' or cardinality(p_sigs) is distinct from 1
       or d1 ->> 'value' is distinct from p_cmd ->> 'disposition'
       or coalesce(d1 -> 'comment', 'null'::jsonb) is distinct from coalesce(p_cmd -> 'comment', 'null'::jsonb)
       or d1 ->> 'by' is distinct from p_person::text or d1 ->> 'signature' is distinct from p_sigs[1]::text then
      raise exception using errcode = 'P0001',
        message = format('The state records another decision on hold point %s than the signed one (PR-45, DI-37). [EBMR-EXE-086]', k);
    end if;
    v_done := true;
  end loop;
  if v_act and not v_done then
    raise exception using errcode = 'P0001',
      message = format('The accepted decision on hold point %s is not recorded in the state (PR-45, DI-37). [EBMR-EXE-086]', coalesce(p_cmd ->> 'step', 'null'));
  end if;
end
$$;

-- DI-35, PR-14, PR-20 (P37): the meaning a VERIFY must be signed with on the step it names, as the engine asks for
-- it (actions.ts checkMeaning): RE_VERIFIED_AFTER_CORRECTION while the stored step instance awaits re-verification,
-- WITNESSED where the MBR asks for a witness, else the step block's own check meanings (recipe.block_signature_meaning)
-- or VERIFIED. Empty when the step is not a phase of the batch's MBR content (fail closed).
create function recipe.step_check_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_node jsonb;
  v_own  text[];
begin
  select recipe.step_node(pk.content, p_cmd ->> 'step') into v_node
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  if (recipe.step_instance_of(p_prior, p_cmd) -> 'reverification') = 'true'::jsonb then
    return array['RE_VERIFIED_AFTER_CORRECTION'];
  end if;
  if v_node -> 'signatures' -> 'check' ->> 'meaning' = 'WITNESSED' then
    return array['WITNESSED'];
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version' and m.part = 'check'
                  order by 1);
  return case when cardinality(v_own) > 0 then v_own else array['VERIFIED'] end;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- recipe.check_signatures (0270) with the decision and check-meaning guards
-- ---------------------------------------------------------------------------------------------

-- INV-10, DI-35, DI-37: every e-signature an accepted command of a signed type needs is there, has a meaning the
-- command type allows and the engine allows on that step (recipe.step_signature_meanings), was made by the person
-- who uses it, was never used before, is valid (content unchanged, sealed, not superseded), belongs to the
-- aggregate the command acts on, was applied in the record's present state, and, for the signer's own signature,
-- was made in this command. A VERIFY is signed with the check the step requires (recipe.step_check_meanings, P37).
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

-- ---------------------------------------------------------------------------------------------
-- recipe.append_execution (0270) with the hold-point decision check on every row
-- ---------------------------------------------------------------------------------------------

-- Appends one engine call (COMMAND, PREPARE or SWEEP) to a locked batch. Checks: the validated actor, not
-- an administrator, sandbox only (Phase 2), the mapped permission, the transaction's clock marker
-- (INV-16), the sequence and the hash chain, the state and events hashes recomputed here, a unique command
-- id, the engine actor is the command's person (or, for SWEEP, a system service account), engine roles
-- from stored evaluations in the declared role at the actor's location through the role map (INV-26, D4),
-- INV-03 for verifications against the stored state, every e-signature an accepted command of a signed type
-- needs with the meaning its step allows and, for a VERIFY, requires (INV-10, P37), an accepted exception
-- disposition as signed (PR-49), the exceptions of the stored state changed only by the row that may change them
-- (DI-26, INV-41), and a hold-point decision recorded only by its own accepted command, as signed (PR-45; P26,
-- P38). Absent values are refused, never passed (every guard is NULL-safe). The INV-40 trigger checks the badge tap.
create or replace function recipe.append_execution(p_batch uuid, p_expected_seq bigint, p_kind text, p_command jsonb, p_command_id text, p_now_us bigint,
                                                   p_accepted boolean, p_refusal jsonb, p_state jsonb, p_state_hash text, p_events jsonb, p_events_hash text,
                                                   p_roles jsonb, p_contents jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Recording a test-run command');
  b        recipe.batch_execution;
  p        recipe.execution_state;
  v_type   text;
  v_eng    jsonb;
  v_roles  jsonb := '[]'::jsonb;
  v_sigs   uuid[] := '{}';
  v_mean   text;
  r        recipe.execution_command;
  v_n      integer;
begin
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = 'There is no test batch with this id (DI-34). [EBMR-EXE-010]';
  end if;
  perform recipe.assert_marker(p_batch, p_now_us);
  if coalesce(p_kind, '') not in ('COMMAND', 'PREPARE', 'SWEEP') then
    raise exception using errcode = 'P0001', message = format('A %s row cannot be appended; a batch is issued once (DI-34). [EBMR-EXE-022]', coalesce(p_kind, 'null'));
  end if;
  select * into p from recipe.execution_state where batch_id = p_batch for update;
  if p.last_seq is distinct from p_expected_seq then
    raise exception using errcode = 'P0001',
      message = format('The batch moved on (row %s) since the command read it (row %s); reload and try again (DI-34). [EBMR-EXE-023]', p.last_seq, p_expected_seq);
  end if;
  perform recipe.check_state(b, p_state, p_state_hash, p_events, p_events_hash);
  if coalesce(btrim(p_command_id), '') = '' then
    raise exception using errcode = 'P0001', message = 'Every engine call needs a command id (outline 5.7). [EBMR-EXE-024]';
  end if;
  if exists (select 1 from recipe.execution_command where command_id = p_command_id) then
    raise exception using errcode = 'P0001', message = format('Command %s was already recorded; a command is applied once (outline 5.7). [EBMR-EXE-024]', p_command_id);
  end if;
  if p_accepted is null or jsonb_typeof(p_command) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'An engine call is recorded with its command and as accepted or refused (DI-34). [EBMR-EXE-030]';
  end if;
  if not p_accepted and (jsonb_typeof(p_refusal) is distinct from 'object' or coalesce(p_refusal ->> 'code', '') = '') then
    raise exception using errcode = 'P0001', message = 'A refused engine call is recorded with its refusal (DI-34). [EBMR-EXE-030]';
  end if;

  if p_kind = 'SWEEP' then
    -- A time sweep is a system act: a SYSTEM-source service account, never a person (INV-20).
    if v_actor ->> 'source' is distinct from 'SYSTEM' or p_command ->> 'type' is distinct from 'SWEEP' or p_accepted is not true then
      raise exception using errcode = 'P0001', message = 'Only the system sweeper records a time sweep (INV-20). [EBMR-EXE-038]';
    end if;
    perform recipe.require_command_permission('SWEEP', null);
  else
    if coalesce(v_actor ->> 'source', '') not in ('UI', 'API') then
      raise exception using errcode = 'P0001', message = 'Only a person executes and signs steps (DI-14). [EBMR-EXE-038]';
    end if;
    v_eng := p_command -> 'actor';
    if jsonb_typeof(v_eng) is distinct from 'object' or v_eng ->> 'id' is distinct from v_actor ->> 'person_id' or v_eng ->> 'kind' is distinct from 'PERSON' then
      raise exception using errcode = 'P0001',
        message = 'The engine command names another person than the one signed in: a command is attributed to the person who gives it (DI-14, INV-26). [EBMR-EXE-039]';
    end if;
    if p_kind = 'COMMAND' and p_command ->> 'commandId' is distinct from p_command_id then
      raise exception using errcode = 'P0001', message = 'The command id of the row and of the engine command differ (outline 5.7). [EBMR-EXE-024]';
    end if;
    v_type := case when p_kind = 'PREPARE' then p_command -> 'target' ->> 'type' else p_command ->> 'type' end;
    v_mean := case when p_kind = 'PREPARE' then p_command ->> 'meaning' else p_command -> 'signature' ->> 'meaning' end;
    perform recipe.require_command_permission(v_type, v_mean);
    v_roles := recipe.check_engine_roles(v_eng, p_roles);
    if p_kind = 'COMMAND' and p_accepted then
      perform recipe.check_verifier(p.state, p_command);
      v_sigs := recipe.check_signatures(p_batch, p_command, (v_actor ->> 'person_id')::uuid);
      if v_type = 'DISPOSITION_EXCEPTION' then
        perform recipe.check_disposition_state(p.state, p_state, p_command, (v_actor ->> 'person_id')::uuid, v_sigs);
      end if;
    end if;
  end if;
  perform recipe.check_exception_changes(p.state, p_state, p_kind, p_command, p_accepted);
  perform recipe.check_hold_point_changes(p.state, p_state, p_kind, p_command, p_accepted, (v_actor ->> 'person_id')::uuid, v_sigs);

  r := recipe.write_row(p_batch, p.last_seq + 1, p_kind, p_command_id, p_command, v_actor, p_now_us, p_accepted, p_refusal, p_state, p_events,
                        v_roles, v_sigs, p_evidence, p.last_row_hash);
  v_n := recipe.insert_contents(p_batch, r.seq, p_contents);
  return jsonb_build_object('seq', r.seq::text, 'row_hash', r.row_hash, 'state_hash', r.state_hash, 'contents', v_n, 'signature_ids', to_jsonb(v_sigs));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the application role records a proposal and reads the current one (as for exception dispositions,
-- 0210) and reads the table like the other execution tables of 0200; the guards are private to the owner.
-- CREATE OR REPLACE kept the privileges of the replaced functions.
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.current_decision(text, integer), recipe.propose_hold_point_decision(uuid, text, jsonb),
                       recipe.check_hold_point_decision(text, jsonb, uuid, uuid),
                       recipe.check_hold_point_changes(jsonb, jsonb, text, jsonb, boolean, uuid, uuid[]),
                       recipe.step_check_meanings(uuid, jsonb, jsonb) from public;
grant execute on function recipe.propose_hold_point_decision(uuid, text, jsonb), recipe.current_decision(text, integer) to ebmr_app;
grant select on recipe.execution_decision_proposal to ebmr_app;

reset role;
