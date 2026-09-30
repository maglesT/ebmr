-- Recipe core, execution store (module C3): the database guards of a test-run row fail closed (review findings
-- P22, P24, P25, P29). ADR 0012: the rules hold even when the application's own database credentials are used
-- directly, so the checks below never rely on the server having sent the right values.
--
-- Engine roles (P22; INV-26, DI-17, decision D4). recipe.check_engine_roles (0210) accepted an engine role when
-- (role, permission) was a row of recipe.engine_role_permission and SOME allowed evaluation of the permission
-- existed for the person in this command. RECORD.PRODUCTION_APPROVE backs both STAGE_RESPONSIBLE and
-- HEAD_OF_PRODUCTION, and the application role may call iam.evaluate_authority itself (any role filter, any scope,
-- any instant), so a command could carry an engine role its declared kernel role never maps to, or one evaluated
-- at another site. Now every piece of role evidence must be:
--   * an allowed evaluation of the named permission, for this person and account, made in this command (as before);
--   * evaluated at this command's time (at or after the start of its transaction, never for an earlier instant);
--   * evaluated in the DECLARED kernel role (role filter and granting role both equal to it);
--   * evaluated at the actor's location (iam.actor_location_scope(), the session's site and room);
--   * the mapped role of the declared kernel role through that permission in recipe.engine_role_map, the map of
--     decision D4 held where the recipe schema can read it (the edition's own copy, tab.engine_role_map, is
--     private to the edition and applied after recipe-core);
--   * named once (one evaluation never backs two roles).
-- The issue of a test batch applies the same rule to the engine roles its request names for the issuer: they
-- are derived here from the evaluations stored in the issuing command, and the ISSUE row stores them.
--
-- E-signatures (P24; INV-10, DI-35, DI-37, Part 11 signature manifestation and record linking). check_signatures
-- (0210) added the signature of SIGN_PERFORMED, VERIFY and DISPOSITION_HOLD_POINT only when the command had one,
-- took the meaning from the command's own reference and never refused a signature used before. Now, for every
-- accepted command of a signed type (recipe.execution_command_permission.signed):
--   * the signature is required; a CORRECT_ENTRY also needs the approval of another person when the corrected
--     value is not declared NON_CRITICAL in the MBR (S25). The pinned policy's switch that would waive it is a
--     value the application chose (issue_execution checks only its hash), so the database never lets it waive
--     the approval;
--   * its meaning is one recipe.execution_signature_meaning allows for the command type, and the one the engine
--     allows on that very step: PERFORMED or the step block's own perform meaning (recipe.block_signature_meaning)
--     for SIGN_PERFORMED; for VERIFY, WITNESSED alone where the MBR asks for a witness, the verification meanings
--     with RE_VERIFIED_AFTER_CORRECTION (and without WITNESSED) while the step awaits re-verification, else the
--     verification meanings and WITNESSED; for a hold point the meaning of the decision's class, for a
--     disposition the hold point offers. The step is read from the batch's own MBR content (recipe.step_node);
--     a step the database cannot find accepts no meaning;
--   * it was never used by another row, nor twice in this one;
--   * it is valid (esig.assert_signature: the record's content still hashes to the signed content, sealed, not
--     superseded) and the record is still in the state the signature was applied in (esig.signature_state_problem);
--   * the signer's own signature was made in this very command (the ceremony signs and applies atomically).
--
-- Exceptions and their dispositions (P25; PR-49, DI-26, DI-37, INV-41, Annex 11 signature binding). The
-- signature on an exception covers the proposed disposition (recipe.current_proposal, part of the signed
-- content). Now:
--   * propose_disposition records only a disposition the engine would accept: an outcome of the two, a
--     justification that is not blank (white space as JavaScript trims it, recipe.js_trim, so a tab or an
--     ideographic space is blank too), the linked deviation, DEVIATION_RAISED only with a linked deviation and
--     never NO_IMPACT on an exception that needs a deviation;
--   * an accepted DISPOSITION_EXCEPTION carries exactly the outcome and justification of the proposal its
--     signature covers, prepared by the signer, with the deviation linked in the stored state; the exception
--     was open, the same outcome rules hold against the stored exception, the justification is not blank, and
--     the resulting state records that disposition (outcome, trimmed justification, signature and person);
--   * on every row (recipe.check_exception_changes) an exception of the stored state stays in the state as it
--     was raised: its status and disposition change only through an accepted DISPOSITION_EXCEPTION of that
--     exception, its deviation link only through an accepted ATTACH_DEVIATION of that exception, and an
--     exception the row raises is open, without disposition or link. The rest of the engine state is checked
--     by replay (recipe-core verify), not here.
--
-- Three-valued logic (P29; PR-49, DI-14, DI-34). Guards written as `x <> v` or `x not in (...)` let SQL NULL
-- (an absent member) through, because IF treats NULL as false. The guards of append_execution, check_state,
-- propose_disposition and issue_execution now compare with IS DISTINCT FROM or on coalesced values: an absent
-- outcome, justification, actor kind, schema, state version, kind or accepted flag is refused.
--
-- Messages keep the codes of 0210 (EBMR-EXE-035/036/037 roles, 051/052 signatures, 030/039 malformed rows, 084
-- proposals) and use EBMR-EXE-086 (the server's own "disposition is not the one reviewed") for a disposition
-- that is not the signed one, and EBMR-EXE-044 for a state that changes an exception no row may change.
-- CREATE OR REPLACE keeps the owner and the privileges of 0210; the new helpers and tables are private to the
-- owner, the tables readable by the application role like the other configuration tables of 0200. Applied as
-- a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Configuration: the engine-role map of decision D4 and the signature meanings of each signed command type
-- ---------------------------------------------------------------------------------------------

-- The declared kernel role -> the engine role it carries, through one permission (decision D4). An edition that
-- maps its kernel roles otherwise adds rows in a release of its own; nothing is ever changed or removed.
create table recipe.engine_role_map (
  kernel_role     text not null references iam.role (code),
  engine_role     text not null,
  via_permission  text not null,
  primary key (kernel_role, engine_role, via_permission),
  foreign key (engine_role, via_permission) references recipe.engine_role_permission (engine_role, permission)
);
revoke all on recipe.engine_role_map from public;

insert into recipe.engine_role_map (kernel_role, engine_role, via_permission) values
  ('OPERATOR', 'PRODUCTION_OPERATOR', 'STEP.EXECUTE'),
  ('DISPENSER', 'DISPENSER', 'DISPENSE.EXECUTE'),
  ('VERIFIER', 'PRODUCTION_VERIFIER', 'STEP.VERIFY'),
  ('SHIFT_SUPERVISOR', 'PRODUCTION_SUPERVISOR', 'STEP.SUPERVISE'),
  ('STAGE_RESPONSIBLE', 'STAGE_RESPONSIBLE', 'RECORD.PRODUCTION_APPROVE'),
  ('HEAD_OF_PRODUCTION', 'HEAD_OF_PRODUCTION', 'RECORD.PRODUCTION_APPROVE'),
  ('QA_SHOP_FLOOR', 'QA', 'QA.FLOOR_APPROVE'),
  ('QA_REVIEWER', 'QA_REVIEWER', 'RECORD.QA_REVIEW');

create trigger aa_insert_only before update or delete on recipe.engine_role_map for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.engine_role_map for each statement execute function kernel.reject_mutation();

-- The meanings an accepted command of a signed type may carry: its own signature ('signature') and, for a
-- correction, the approval ('approval'). The engine asks for the same meanings (PERFORMED and the blocks'
-- perform meanings; the verification meanings, WITNESSED and re-verification; the hold-point, stage and
-- exception meanings; CORRECTED and CORRECTION_APPROVED). A release that adds a block meaning adds its row.
create table recipe.execution_signature_meaning (
  command_type  text not null references recipe.execution_command_permission (command_type),
  part          text not null check (part in ('signature', 'approval')),
  meaning_code  text not null check (meaning_code ~ '^[A-Z][A-Z_]{1,63}$'),
  primary key (command_type, part, meaning_code)
);
revoke all on recipe.execution_signature_meaning from public;

insert into recipe.execution_signature_meaning (command_type, part, meaning_code) values
  ('SIGN_PERFORMED', 'signature', 'PERFORMED'),
  ('SIGN_PERFORMED', 'signature', 'IPC_PERFORMED'),
  ('SIGN_PERFORMED', 'signature', 'SAMPLE_TAKEN'),
  ('SIGN_PERFORMED', 'signature', 'LINE_CLEARANCE_PERFORMED'),
  ('VERIFY', 'signature', 'VERIFIED'),
  ('VERIFY', 'signature', 'CONTAINER_CHECKED'),
  ('VERIFY', 'signature', 'CHARGE_IN_VERIFIED'),
  ('VERIFY', 'signature', 'YIELD_VERIFIED'),
  ('VERIFY', 'signature', 'IPC_VERIFIED'),
  ('VERIFY', 'signature', 'LINE_CLEARANCE_VERIFIED'),
  ('VERIFY', 'signature', 'WITNESSED'),
  ('VERIFY', 'signature', 'RE_VERIFIED_AFTER_CORRECTION'),
  ('DISPOSITION_HOLD_POINT', 'signature', 'HOLD_POINT_RELEASED'),
  ('DISPOSITION_HOLD_POINT', 'signature', 'HOLD_POINT_NOT_RELEASED'),
  ('SIGN_OFF_STAGE', 'signature', 'STAGE_SIGNED_OFF'),
  ('DISPOSITION_EXCEPTION', 'signature', 'EXCEPTION_DISPOSITIONED'),
  ('CORRECT_ENTRY', 'signature', 'CORRECTED'),
  ('CORRECT_ENTRY', 'approval', 'CORRECTION_APPROVED');

create trigger aa_insert_only before update or delete on recipe.execution_signature_meaning for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.execution_signature_meaning for each statement execute function kernel.reject_mutation();

-- The block versions' own signature meanings (the registry's handler meanings): the meaning a performer of a
-- step of that block may sign with besides PERFORMED ('perform'), and the one a checker may sign with besides the
-- verification meanings ('check'). A release that adds a block version with meanings adds its rows.
create table recipe.block_signature_meaning (
  block_type     text not null check (block_type ~ '^[A-Z]+-[0-9]{2,3}$'),
  block_version  text not null check (block_version ~ '^[0-9]+$'),
  part           text not null check (part in ('perform', 'check')),
  meaning_code   text not null check (meaning_code ~ '^[A-Z][A-Z_]{1,63}$'),
  primary key (block_type, block_version, part, meaning_code)
);
revoke all on recipe.block_signature_meaning from public;

insert into recipe.block_signature_meaning (block_type, block_version, part, meaning_code) values
  ('G-07', '1', 'check', 'CONTAINER_CHECKED'),
  ('G-08', '1', 'check', 'CHARGE_IN_VERIFIED'),
  ('G-10', '1', 'perform', 'LINE_CLEARANCE_PERFORMED'),
  ('G-10', '1', 'check', 'LINE_CLEARANCE_VERIFIED'),
  ('G-12', '1', 'perform', 'SAMPLE_TAKEN'),
  ('G-13', '1', 'perform', 'IPC_PERFORMED'),
  ('G-13', '1', 'check', 'IPC_VERIFIED'),
  ('G-20', '1', 'check', 'YIELD_VERIFIED');

create trigger aa_insert_only before update or delete on recipe.block_signature_meaning for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on recipe.block_signature_meaning for each statement execute function kernel.reject_mutation();

do $$
begin
  -- Every meaning is an active type of the e-signature catalogue, and every signed command type has its meanings.
  if exists (select 1 from recipe.execution_signature_meaning m
             where not exists (select 1 from esig.meaning_type t where t.code = m.meaning_code and t.status = 'ACTIVE'))
     or exists (select 1 from recipe.block_signature_meaning m
                where not exists (select 1 from esig.meaning_type t where t.code = m.meaning_code and t.status = 'ACTIVE')) then
    raise exception using errcode = 'P0001', message = 'a signature meaning of recipe-core 0270 is not in the e-signature catalogue (DI-35)';
  end if;
  if exists (select 1 from recipe.execution_command_permission c
             where c.signed and not exists (select 1 from recipe.execution_signature_meaning m where m.command_type = c.command_type and m.part = 'signature')) then
    raise exception using errcode = 'P0001', message = 'a signed command type has no signature meaning in recipe.execution_signature_meaning (DI-35)';
  end if;
  -- A block's own meaning is one its command type accepts (perform: SIGN_PERFORMED; check: VERIFY).
  if exists (select 1 from recipe.block_signature_meaning b
             where not exists (select 1 from recipe.execution_signature_meaning m
                               where m.command_type = case b.part when 'perform' then 'SIGN_PERFORMED' else 'VERIFY' end
                                 and m.part = 'signature' and m.meaning_code = b.meaning_code)) then
    raise exception using errcode = 'P0001', message = 'a block meaning is not a meaning of its command type in recipe.execution_signature_meaning (DI-35)';
  end if;
  -- Every engine role of recipe.engine_role_permission is reachable from a kernel role (D4).
  if exists (select 1 from recipe.engine_role_permission p
             where not exists (select 1 from recipe.engine_role_map m where m.engine_role = p.engine_role and m.via_permission = p.permission)) then
    raise exception using errcode = 'P0001', message = 'an engine role has no row in recipe.engine_role_map (D4, INV-26)';
  end if;
end
$$;

select kernel.register_audited_table('recipe.engine_role_map', 'engine_role_map', 'kernel_role', true);
select kernel.register_audited_table('recipe.execution_signature_meaning', 'execution_signature_meaning', 'command_type', true);
select kernel.register_audited_table('recipe.block_signature_meaning', 'block_signature_meaning', 'block_type', true);

-- A signature id is used by one row only: the lookup of the ids already used.
create index execution_command_signature_ids on recipe.execution_command using gin (signature_ids);

-- ---------------------------------------------------------------------------------------------
-- Helpers (owner only)
-- ---------------------------------------------------------------------------------------------

-- NULL when the stored authority evaluation p_evaluation backs permission p_permission for the validated actor
-- p_actor: allowed, for its person and account, made in this command at this command's time, in the declared
-- kernel role and at the actor's location; else the reason (INV-26, DI-17, D4).
create function recipe.role_evaluation_problem(p_actor jsonb, p_permission text, p_evaluation uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  ev      iam.authority_evaluation;
  v_role  text := p_actor ->> 'role_code';
  v_scope jsonb;
begin
  if p_evaluation is null then
    return 'no stored evaluation is named';
  end if;
  select * into ev from iam.authority_evaluation where id = p_evaluation;
  if not found then
    return format('evaluation %s does not exist', p_evaluation);
  end if;
  if ev.allowed is not true then
    return format('evaluation %s did not allow it', ev.id);
  end if;
  if ev.person_id is distinct from (p_actor ->> 'person_id')::uuid or ev.account_id is distinct from (p_actor ->> 'account_id')::uuid then
    return format('evaluation %s was made for another person or account', ev.id);
  end if;
  if ev.permission_code is distinct from p_permission then
    return format('evaluation %s evaluated %s', ev.id, ev.permission_code);
  end if;
  if ev.correlation_id is distinct from (p_actor ->> 'correlation_id')::uuid then
    return format('evaluation %s was made in another command', ev.id);
  end if;
  if ev.at_instant is null or ev.at_instant < now() or ev.at_instant > clock_timestamp() then
    return format('evaluation %s was made for %s, not for the time of this command', ev.id, coalesce(ev.at_instant::text, 'no instant'));
  end if;
  if coalesce(v_role, '') = '' or ev.role_filter is distinct from v_role or ev.role_code is distinct from v_role then
    return format('evaluation %s was made in role %s, not in the declared role %s', ev.id, coalesce(ev.role_filter, 'any role'), coalesce(v_role, 'none'));
  end if;
  v_scope := iam.actor_location_scope();
  if ev.scope is distinct from v_scope then
    return format('evaluation %s was made for scope %s, not at the actor''s location %s', ev.id, ev.scope, v_scope);
  end if;
  return null;
end
$$;

-- The meaning of a hold-point decision's signature: HOLD_POINT_RELEASED for a releasing disposition, else
-- HOLD_POINT_NOT_RELEASED (the engine's RELEASING_DISPOSITIONS; PR-45).
create function recipe.hold_point_meaning(p_disposition text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_disposition in ('APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED')
              then 'HOLD_POINT_RELEASED' else 'HOLD_POINT_NOT_RELEASED' end
$$;

-- The verification meanings a checker may sign any step with (the engine's VERIFICATION_MEANINGS).
create function recipe.verification_meanings() returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['VERIFIED', 'CONTAINER_CHECKED', 'CHARGE_IN_VERIFIED', 'YIELD_VERIFIED', 'IPC_VERIFIED', 'LINE_CLEARANCE_VERIFIED']
$$;

-- A text without the leading and trailing white space JavaScript's String.prototype.trim removes (the engine keeps
-- a justification trimmed that way, and a text it trims to nothing is blank).
create function recipe.js_trim(p text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select regexp_replace(p, E'^[\\t\\n\\v\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\\t\\n\\v\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')
$$;

-- The stored step instance a command names (step and context), from a state; NULL when there is none.
create function recipe.step_instance_of(p_state jsonb, p_cmd jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select i.value from jsonb_each(case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' else '{}'::jsonb end) i
   where i.value ->> 'step' = p_cmd ->> 'step' and coalesce(i.value -> 'frames', '[]'::jsonb) = coalesce(p_cmd -> 'context', '[]'::jsonb)
   limit 1
$$;

-- The node of step p_step (a phase or a hold point) in MBR content p_content, as the engine expands it: a step
-- inlined from a library element has the id <call>/<inner id> (one call level per segment), found through the
-- call's pinned element snapshot (content.library). NULL when no node, or more than one, answers (fail closed).
create function recipe.step_node(p_content jsonb, p_step text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_parts text[] := string_to_array(p_step, '/');
  v_scope jsonb := p_content -> 'procedure';
  v_node  jsonb;
  v_n     bigint;
  v_els   jsonb := case when jsonb_typeof(p_content -> 'library') = 'array' then p_content -> 'library' else '[]'::jsonb end;
begin
  if coalesce(array_length(v_parts, 1), 0) = 0 or jsonb_typeof(v_scope) is distinct from 'object' then
    return null;
  end if;
  for i in 1 .. array_length(v_parts, 1) loop
    select count(*), (array_agg(n))[1] into v_n, v_node
      from jsonb_path_query(v_scope, 'strict $.** ? (@.id == $id && (@.kind == "phase" || @.kind == "holdPoint" || @.kind == "libraryCall"))',
                            jsonb_build_object('id', v_parts[i])) n;
    if v_n is distinct from 1 then
      return null;
    end if;
    if i < array_length(v_parts, 1) then
      if v_node ->> 'kind' is distinct from 'libraryCall' then
        return null;
      end if;
      select count(*), (array_agg(e -> 'body'))[1] into v_n, v_scope from jsonb_array_elements(v_els) e where e ->> 'ref' = v_node ->> 'element';
      if v_n is distinct from 1 or jsonb_typeof(v_scope) is distinct from 'object' then
        return null;
      end if;
    end if;
  end loop;
  if v_node ->> 'kind' not in ('phase', 'holdPoint') then
    return null;
  end if;
  return v_node;
end
$$;

-- The meanings the engine accepts for the signature of command p_cmd on the step it names, from the batch's MBR
-- content (the step's block and check meaning; a hold point's dispositions) and the stored step instance
-- (re-verification); NULL for a command type without a step signature. An empty array when the step is not a
-- step of that kind in the content, or the decision is not one the hold point offers.
create function recipe.step_signature_meanings(p_batch uuid, p_prior jsonb, p_cmd jsonb) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type text := p_cmd ->> 'type';
  v_node jsonb;
  v_own  text[];
begin
  if v_type is null or v_type not in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT') then
    return null;
  end if;
  select recipe.step_node(pk.content, p_cmd ->> 'step') into v_node
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
  if v_type = 'DISPOSITION_HOLD_POINT' then
    if v_node ->> 'kind' is distinct from 'holdPoint' or jsonb_typeof(p_cmd -> 'disposition') is distinct from 'string'
       or not coalesce(case when jsonb_typeof(v_node -> 'dispositions') = 'array' then (v_node -> 'dispositions') ? (p_cmd ->> 'disposition') end, false) then
      return '{}';
    end if;
    return array[recipe.hold_point_meaning(p_cmd ->> 'disposition')];
  end if;
  if v_node ->> 'kind' is distinct from 'phase' then
    return '{}';
  end if;
  v_own := array(select m.meaning_code from recipe.block_signature_meaning m
                  where m.block_type = v_node -> 'block' ->> 'type' and m.block_version = v_node -> 'block' ->> 'version'
                    and m.part = case v_type when 'SIGN_PERFORMED' then 'perform' else 'check' end
                  order by 1);
  if v_type = 'SIGN_PERFORMED' then
    return array['PERFORMED'] || v_own;
  end if;
  if (recipe.step_instance_of(p_prior, p_cmd) -> 'reverification') = 'true'::jsonb then
    v_own := recipe.verification_meanings() || v_own || array['RE_VERIFIED_AFTER_CORRECTION'];
  elsif v_node -> 'signatures' -> 'check' ->> 'meaning' = 'WITNESSED' then
    return array['WITNESSED'];
  else
    v_own := recipe.verification_meanings() || v_own || array['WITNESSED'];
  end if;
  -- Each meaning once, in the engine's order.
  return array(select u.m from unnest(v_own) with ordinality u (m, i) group by u.m order by min(u.i));
end
$$;

-- Whether a correction of data point p_point of batch p_batch needs an approval (S25): a value of a parameter
-- that the MBR does not declare NON_CRITICAL does (CRITICAL until classified, DI-07; an unknown item fails
-- closed). The pinned policy's criticalCorrectionNeedsApproval is not read: the application chooses the pinned
-- policy (issue_execution checks only its hash), so it never waives the approval here (the stricter rule; the
-- server pins the engine's default, which requires it).
create function recipe.correction_needs_approval(p_batch uuid, p_prior jsonb, p_point text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b      recipe.batch_execution;
  v_item text := p_prior -> 'points' -> p_point ->> 'item';
begin
  select * into b from recipe.batch_execution where id = p_batch;
  return not exists (
    select 1 from recipe.test_package pk
    cross join lateral jsonb_array_elements(case when jsonb_typeof(pk.content -> 'parameters') = 'array' then pk.content -> 'parameters' else '[]'::jsonb end) p
    where pk.package_hash = b.package_hash and v_item is not null and p ->> 'id' = v_item and p ->> 'criticality' = 'NON_CRITICAL');
end
$$;

-- PR-49, DI-37: an accepted DISPOSITION_EXCEPTION carries exactly the proposal its signature p_signature covers
-- (the latest proposal on the signed content version, which is part of the signed content), prepared by the
-- signer, with the deviation linked in the stored state before the command.
create function recipe.check_disposition_proposal(p_batch uuid, p_prior jsonb, p_cmd jsonb, p_person uuid, p_signature uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_agg text := p_batch::text || ':' || (p_cmd ->> 'exception');
  v_ver bigint;
  pr    recipe.execution_disposition_proposal;
begin
  select g.content_version into v_ver from esig.signature g where g.id = p_signature;
  select * into pr from recipe.execution_disposition_proposal p
   where p.aggregate_id = v_agg and p.content_version = v_ver order by p.id desc limit 1;
  if pr.id is null then
    raise exception using errcode = 'P0001',
      message = format('The signature on exception %s covers no proposed disposition, so nothing was signed to disposition it (PR-49, DI-37). [EBMR-EXE-086]', coalesce(p_cmd ->> 'exception', 'null'));
  end if;
  if pr.proposed_by_person is distinct from p_person then
    raise exception using errcode = 'P0001',
      message = format('The disposition signed on exception %s was prepared by another person than the signer (PR-49, DI-37). [EBMR-EXE-086]', p_cmd ->> 'exception');
  end if;
  if jsonb_typeof(p_cmd -> 'outcome') is distinct from 'string' or jsonb_typeof(p_cmd -> 'justification') is distinct from 'string'
     or p_cmd ->> 'outcome' is distinct from pr.proposal ->> 'outcome' or p_cmd ->> 'justification' is distinct from pr.proposal ->> 'justification'
     or coalesce(pr.proposal -> 'deviationRef', 'null'::jsonb)
        is distinct from coalesce(p_prior -> 'exceptions' -> (p_cmd ->> 'exception') -> 'deviation' -> 'ref', 'null'::jsonb) then
    raise exception using errcode = 'P0001',
      message = format('The outcome, justification or linked deviation of the disposition of exception %s is not the disposition its signature covers; a disposition is recorded exactly as signed (PR-49, DI-37). [EBMR-EXE-086]', p_cmd ->> 'exception');
  end if;
end
$$;

-- PR-49, DI-37: an accepted DISPOSITION_EXCEPTION dispositions an exception that was open in the stored state
-- p_prior, with an outcome the engine allows there (DEVIATION_RAISED only with a linked deviation; never
-- NO_IMPACT on an exception that needs a deviation) and a justification that is not blank; the state p_state it
-- leaves records that disposition as signed: the exception dispositioned by the person, with the command's
-- outcome, its justification (trimmed as the engine trims it) and the one signature the row uses.
create function recipe.check_disposition_state(p_prior jsonb, p_state jsonb, p_cmd jsonb, p_person uuid, p_signatures uuid[]) returns void
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
  if jsonb_typeof(p_cmd -> 'justification') is distinct from 'string' or coalesce(recipe.js_trim(p_cmd ->> 'justification'), '') = '' then
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

-- DI-26, INV-41, PR-49: what a row may do to the exceptions of the stored state p_prior. An exception stays in
-- the state (never removed) and as it was raised: its status and disposition change only through an accepted
-- DISPOSITION_EXCEPTION of that exception (checked in full by check_disposition_state), its deviation link only
-- through an accepted ATTACH_DEVIATION of that exception that links the command's reference (trimmed) by the
-- command's person to an open exception without one. An exception the row raises is open, without disposition or
-- link.
create function recipe.check_exception_changes(p_prior jsonb, p_state jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0    jsonb := coalesce(p_prior -> 'exceptions', '{}'::jsonb);
  e1    jsonb := p_state -> 'exceptions';
  v_act text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_ex  text := p_cmd ->> 'exception';
  v_ref text := recipe.js_trim(p_cmd ->> 'deviationRef');
  k     text;
  x0    jsonb;
  x1    jsonb;
begin
  if jsonb_typeof(e0) is distinct from 'object' or jsonb_typeof(e1) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'The exceptions of the engine state are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  for k, x0 in select key, value from jsonb_each(e0) loop
    x1 := e1 -> k;
    if jsonb_typeof(x1) is distinct from 'object' then
      raise exception using errcode = 'P0001',
        message = format('The state no longer holds exception %s; an exception is never removed (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if (x1 - 'status' - 'disposition' - 'deviation') is distinct from (x0 - 'status' - 'disposition' - 'deviation') then
      raise exception using errcode = 'P0001',
        message = format('The state changes exception %s as it was raised; an exception is kept as raised (DI-26, INV-41). [EBMR-EXE-044]', k);
    end if;
    if coalesce(x1 -> 'deviation', 'null'::jsonb) is distinct from coalesce(x0 -> 'deviation', 'null'::jsonb)
       and not coalesce(v_act = 'ATTACH_DEVIATION' and v_ex = k and coalesce(x0 -> 'deviation', 'null'::jsonb) = 'null'::jsonb
                         and x0 ->> 'status' = 'OPEN' and coalesce(v_ref, '') <> ''
                         and x1 -> 'deviation' ->> 'ref' = v_ref and x1 -> 'deviation' ->> 'linkedBy' = p_cmd -> 'actor' ->> 'id', false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the deviation link of exception %s, which this row does not link (PR-49, DI-26). [EBMR-EXE-044]', k);
    end if;
    if ((x1 -> 'status') is distinct from (x0 -> 'status') or (x1 -> 'disposition') is distinct from (x0 -> 'disposition'))
       and not coalesce(v_act = 'DISPOSITION_EXCEPTION' and v_ex = k, false) then
      raise exception using errcode = 'P0001',
        message = format('The state changes the status or disposition of exception %s without its own signed disposition (PR-49, DI-37, INV-41). [EBMR-EXE-044]', k);
    end if;
  end loop;
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) loop
    if jsonb_typeof(x1) is distinct from 'object' or x1 ->> 'status' is distinct from 'OPEN' or x1 ? 'disposition' or x1 ? 'deviation' then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is raised by this row already dispositioned or linked; a new exception is open (DI-26, PR-49). [EBMR-EXE-044]', k);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Engine roles (P22)
-- ---------------------------------------------------------------------------------------------

-- INV-26, D4: every engine role the command's actor carries is backed by a stored authority evaluation of the
-- role's permission that allowed it for this person and account, made in this very command at its time, in the
-- DECLARED kernel role and at the actor's location, and the role is the one the declared kernel role maps to
-- through that permission (recipe.engine_role_map). Returns the normalised evidence ([{role, permission,
-- evaluationId}]).
create or replace function recipe.check_engine_roles(p_engine_actor jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_role    text;
  e         jsonb;
  v_eval    uuid;
  v_problem text;
  v_out     jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) is distinct from 'array'
     or jsonb_typeof(coalesce(p_engine_actor -> 'roles', '[]'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e -> 'role') is distinct from 'string'
       or jsonb_typeof(e -> 'permission') is distinct from 'string' or jsonb_typeof(e -> 'evaluationId') is distinct from 'string' then
      raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
    end if;
    if not exists (select 1 from recipe.engine_role_permission rp where rp.engine_role = e ->> 'role' and rp.permission = e ->> 'permission') then
      raise exception using errcode = 'P0001',
        message = format('Engine role %s cannot be held through permission %s (INV-26). [EBMR-EXE-035]', e ->> 'role', e ->> 'permission');
    end if;
    begin
      v_eval := (e ->> 'evaluationId')::uuid;
    exception when invalid_text_representation then
      v_eval := null;
    end;
    v_problem := recipe.role_evaluation_problem(v_actor, e ->> 'permission', v_eval);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('Engine role %s is not backed by an allowed authority evaluation of %s made for this person in this command, in the declared role at the actor''s location: %s (INV-26, D4). [EBMR-EXE-036]',
                         e ->> 'role', e ->> 'permission', v_problem);
    end if;
    if not exists (select 1 from recipe.engine_role_map m
                   where m.kernel_role = v_actor ->> 'role_code' and m.engine_role = e ->> 'role' and m.via_permission = e ->> 'permission') then
      raise exception using errcode = 'P0001',
        message = format('The declared role %s does not carry engine role %s through permission %s; an engine role comes only from the declared kernel role through the role map (D4, INV-26). [EBMR-EXE-035]',
                         coalesce(v_actor ->> 'role_code', 'none'), e ->> 'role', e ->> 'permission');
    end if;
    if exists (select 1 from jsonb_array_elements(v_out) x where x ->> 'role' = e ->> 'role' or x ->> 'evaluationId' = v_eval::text) then
      raise exception using errcode = 'P0001',
        message = format('The role evidence names engine role %s or evaluation %s twice; one evaluation backs one role (INV-26). [EBMR-EXE-035]', e ->> 'role', v_eval);
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('role', e ->> 'role', 'permission', e ->> 'permission', 'evaluationId', v_eval));
  end loop;
  for v_role in select jsonb_array_elements_text(coalesce(p_engine_actor -> 'roles', '[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(v_out) x where x ->> 'role' = v_role) then
      raise exception using errcode = 'P0001',
        message = format('The command claims engine role %s without a stored authority evaluation behind it; roles come from the stored evaluations, never from the client (INV-26). [EBMR-EXE-037]', v_role);
    end if;
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- E-signatures and dispositions (P24, P25)
-- ---------------------------------------------------------------------------------------------

-- INV-10, DI-35, DI-37: every e-signature an accepted command of a signed type needs is there, has a meaning the
-- command type allows and the engine allows on that step (recipe.step_signature_meanings), was made by the person
-- who uses it, was never used before, is valid (content unchanged, sealed, not superseded), belongs to the
-- aggregate the command acts on, was applied in the record's present state, and, for the signer's own signature,
-- was made in this command. A correction of a value not declared NON_CRITICAL carries an approval by another
-- person (S25). An accepted DISPOSITION_EXCEPTION carries the proposal its signature covers. Returns the
-- signature ids.
create or replace function recipe.check_signatures(p_batch uuid, p_cmd jsonb, p_person uuid) returns uuid[]
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_type    text := p_cmd ->> 'type';
  v_signed  boolean;
  v_prior   jsonb;
  v_step    text[];
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
    v_out := v_out || v_id;
  end loop;

  if v_type = 'DISPOSITION_EXCEPTION' then
    perform recipe.check_disposition_proposal(p_batch, v_prior, p_cmd, p_person, v_out[1]);
  end if;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- NULL-safe guards (P29)
-- ---------------------------------------------------------------------------------------------

-- The state of the command must be the engine's state of this batch.
create or replace function recipe.check_state(p_batch recipe.batch_execution, p_state jsonb, p_state_hash text, p_events jsonb, p_events_hash text) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if jsonb_typeof(p_state) is distinct from 'object' or p_state ->> 'schema' is distinct from 'ebmr.batch-execution-state'
     or jsonb_typeof(p_state -> 'version') is distinct from 'number' or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The engine state or events of the command are malformed (DI-34). [EBMR-EXE-030]';
  end if;
  if recipe.canonical_hash(p_state) is distinct from p_state_hash or recipe.canonical_hash(p_events) is distinct from p_events_hash then
    raise exception using errcode = 'P0001', message = 'The engine state or events do not hash to what the command states (DI-34). [EBMR-EXE-031]';
  end if;
  if p_state ->> 'mbrHash' is distinct from p_batch.content_hash or p_state -> 'header' ->> 'batchId' is distinct from p_batch.id::text
     or p_state -> 'header' ->> 'batchNumber' is distinct from p_batch.batch_number then
    raise exception using errcode = 'P0001', message = 'The engine state belongs to another batch or MBR version (INV-02, DI-34). [EBMR-EXE-034]';
  end if;
end
$$;

-- Appends one engine call (COMMAND, PREPARE or SWEEP) to a locked batch. Checks: the validated actor, not
-- an administrator, sandbox only (Phase 2), the mapped permission, the transaction's clock marker
-- (INV-16), the sequence and the hash chain, the state and events hashes recomputed here, a unique command
-- id, the engine actor is the command's person (or, for SWEEP, a system service account), engine roles
-- from stored evaluations in the declared role at the actor's location through the role map (INV-26, D4),
-- INV-03 for verifications against the stored state, every e-signature an accepted command of a signed type
-- needs with the meaning its step allows (INV-10), an accepted exception disposition as signed (PR-49), and
-- the exceptions of the stored state changed only by the row that may change them (DI-26, INV-41). Absent
-- values are refused, never passed (every guard is NULL-safe). The INV-40 trigger checks the badge tap.
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

  r := recipe.write_row(p_batch, p.last_seq + 1, p_kind, p_command_id, p_command, v_actor, p_now_us, p_accepted, p_refusal, p_state, p_events,
                        v_roles, v_sigs, p_evidence, p.last_row_hash);
  v_n := recipe.insert_contents(p_batch, r.seq, p_contents);
  return jsonb_build_object('seq', r.seq::text, 'row_hash', r.row_hash, 'state_hash', r.state_hash, 'contents', v_n, 'signature_ids', to_jsonb(v_sigs));
end
$$;

-- Records the disposition a QA reviewer is about to sign: {outcome, justification, deviationRef}, on the
-- exception's current content version (sandbox only; the permission of DISPOSITION_EXCEPTION). The exception
-- must be open; the outcome one of the two, the justification a text that is not blank as JavaScript trims it,
-- the deviation reference the one linked in the stored state (or null); DEVIATION_RAISED needs a linked
-- deviation and an exception that needs a deviation is never NO_IMPACT (the engine's rules). An absent member
-- is refused.
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
     or coalesce(recipe.js_trim(p_proposal ->> 'justification'), '') = '' or length(p_proposal ->> 'justification') > 4000
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

-- Issues a test batch: the package, the pinned engine version, block registry and policy (with its
-- hash), the issue request, and the ISSUE row with the engine's initial state (sandbox only,
-- BATCH.ISSUE, TEST- number allocated in this transaction). The issuer named in the request is the person of
-- the command, and every engine role the request gives the issuer is backed by an evaluation stored in this
-- command in the declared role at the actor's location through the role map (INV-26, D4); the ISSUE row
-- stores that evidence.
create or replace function recipe.issue_execution(p_batch uuid, p_package_hash text, p_batch_number text, p_request jsonb, p_policy jsonb, p_policy_hash text,
                                                  p_registry_fingerprint text, p_engine_version text, p_now_us bigint, p_state jsonb, p_state_hash text,
                                                  p_events jsonb, p_events_hash text, p_contents jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Issuing a test batch');
  m       recipe.execution_clock;
  pk      recipe.test_package;
  b       recipe.batch_execution;
  r       recipe.execution_command;
  v_n     integer;
  v_eng   jsonb := p_request -> 'issuedBy';
  v_role  text;
  v_ev    jsonb;
  v_roles jsonb := '[]'::jsonb;
begin
  perform recipe.require_command_permission('ISSUE', null);
  m := recipe.assert_marker(p_batch, p_now_us);
  if m.batch_number is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The batch number was not allocated for this batch in this transaction (DI-05). [EBMR-EXE-012]';
  end if;
  perform sandbox.assert_identifier_allowed('BATCH_NUMBER', p_batch_number);
  select * into pk from recipe.test_package where package_hash = p_package_hash;
  if not found then
    raise exception using errcode = 'P0001', message = 'The test package has not been imported (DI-05). [EBMR-EXE-013]';
  end if;
  if recipe.canonical_hash(p_policy) is distinct from p_policy_hash then
    raise exception using errcode = 'P0001', message = 'The pinned engine policy does not hash to its stated hash (INV-26). [EBMR-EXE-014]';
  end if;
  if jsonb_typeof(v_eng) is distinct from 'object' or v_eng ->> 'id' is distinct from v_actor ->> 'person_id' or v_eng ->> 'kind' is distinct from 'PERSON'
     or p_request ->> 'batchId' is distinct from p_batch::text or p_request ->> 'batchNumber' is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The issue request names another person, batch or number than this command (DI-14). [EBMR-EXE-015]';
  end if;
  if jsonb_typeof(coalesce(v_eng -> 'roles', '[]'::jsonb)) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
  end if;
  for v_role in select distinct x from jsonb_array_elements_text(coalesce(v_eng -> 'roles', '[]'::jsonb)) x order by 1 loop
    select jsonb_build_object('role', mp.engine_role, 'permission', mp.via_permission, 'evaluationId', ev.id) into v_ev
      from recipe.engine_role_map mp
      join iam.authority_evaluation ev on ev.permission_code = mp.via_permission and ev.correlation_id = (v_actor ->> 'correlation_id')::uuid
                                      and ev.person_id = (v_actor ->> 'person_id')::uuid and ev.allowed
     where mp.kernel_role = v_actor ->> 'role_code' and mp.engine_role = v_role
       and recipe.role_evaluation_problem(v_actor, mp.via_permission, ev.id) is null
     order by ev.evaluated_at, ev.id
     limit 1;
    if v_ev is null then
      raise exception using errcode = 'P0001',
        message = format('The issue request gives the issuer engine role %s without a stored authority evaluation in the declared role at the actor''s location behind it; roles come from the stored evaluations, never from the client (INV-26, D4). [EBMR-EXE-037]', v_role);
    end if;
    v_roles := v_roles || jsonb_build_array(v_ev);
    v_ev := null;
  end loop;
  b.id := p_batch;
  b.batch_number := p_batch_number;
  b.package_hash := p_package_hash;
  b.content_hash := pk.content_hash;
  b.installation := kernel.installation_kind();
  b.purpose := 'SANDBOX_TEST_RUN';
  b.engine_version := p_engine_version;
  b.registry_fingerprint := p_registry_fingerprint;
  b.policy := p_policy;
  b.policy_hash := p_policy_hash;
  b.issue_request := p_request;
  b.market_set := array(select jsonb_array_elements_text(p_request -> 'marketSet'));
  b.batch_size := p_request ->> 'batchSize';
  b.site_code := coalesce(v_actor ->> 'site_code', '?');
  b.room_code := v_actor ->> 'room_code';
  b.site_zone := v_actor ->> 'site_zone';
  b.issued_at := clock_timestamp();
  b.issued_at_us := p_now_us;
  b.issued_by_person := (v_actor ->> 'person_id')::uuid;
  b.issued_by_account := (v_actor ->> 'account_id')::uuid;
  b.correlation_id := (v_actor ->> 'correlation_id')::uuid;
  insert into recipe.batch_execution select b.*;
  perform recipe.check_state(b, p_state, p_state_hash, p_events, p_events_hash);
  if (p_state ->> 'version') is distinct from '0' or p_state -> 'header' ->> 'issuedBy' is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'The issued state is not the engine''s initial state of this request (DI-34). [EBMR-EXE-030]';
  end if;
  r := recipe.write_row(p_batch, 1, 'ISSUE', 'ISSUE:' || p_batch::text, jsonb_build_object('type', 'ISSUE', 'request', p_request), v_actor, p_now_us,
                        true, null, p_state, p_events, v_roles, '{}', p_evidence, recipe.execution_genesis_hash(p_batch));
  v_n := recipe.insert_contents(p_batch, 1, p_contents);
  perform kernel.audit_business_event('batch:' || p_batch::text,
    format('Test batch %s issued from package %s (MBR %s, content %s) by %s; sandbox test run, TEST, NOT GMP', p_batch_number, left(p_package_hash, 12),
           pk.family_code, left(pk.content_hash, 12), coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('batch_number', p_batch_number, 'package_hash', p_package_hash, 'content_hash', pk.content_hash, 'engine_version', p_engine_version,
                       'registry_fingerprint', p_registry_fingerprint, 'policy_hash', p_policy_hash));
  return jsonb_build_object('batch_id', p_batch, 'batch_number', p_batch_number, 'seq', r.seq::text, 'row_hash', r.row_hash, 'contents', v_n);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the new helpers are private to the owner (called only by the definer writers above); the
-- application role reads the three configuration tables like the others of 0200. CREATE OR REPLACE kept the
-- privileges of the replaced functions (0210).
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.role_evaluation_problem(jsonb, text, uuid), recipe.hold_point_meaning(text), recipe.verification_meanings(),
                       recipe.js_trim(text), recipe.step_instance_of(jsonb, jsonb), recipe.step_node(jsonb, text),
                       recipe.step_signature_meanings(uuid, jsonb, jsonb), recipe.correction_needs_approval(uuid, jsonb, text),
                       recipe.check_disposition_proposal(uuid, jsonb, jsonb, uuid, uuid), recipe.check_disposition_state(jsonb, jsonb, jsonb, uuid, uuid[]),
                       recipe.check_exception_changes(jsonb, jsonb, text, jsonb, boolean) from public;
grant select on recipe.engine_role_map, recipe.execution_signature_meaning, recipe.block_signature_meaning to ebmr_app;

reset role;
