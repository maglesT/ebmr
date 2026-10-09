-- Recipe core, execution store (module C3): an operator's exception is stored as the command raised it, and a test
-- batch starts from the engine's initial state, with nothing already done in it (review finding P25 and its round-1
-- verification; PR-49, PR-13, PR-45, DI-26, DI-34, INV-41; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
-- An operator's exception (RAISE_EXCEPTION). recipe.check_exception_changes (0270) only required an exception a row
-- adds to be open, without disposition or deviation link. It never compared the exception with the command that
-- raised it, so an exception raised with severity ACTION could be stored as ALERT with deviationRequired false and
-- no block, then dispositioned NO_IMPACT under a valid signature; only the replay verification noticed. The engine
-- derives every fact of that exception from the command (batch.ts raiseException, exceptions.ts engineDraft, tx.ts
-- raise), and so does the database now (recipe.operator_exception_record):
--   * id, type OPERATOR_RAISED, category DEVIATION_OR_OVERRIDE, controls PR-13 and PR-49;
--   * title: the actor's id, a colon, and the description trimmed as JavaScript trims it (recipe.js_trim);
--   * raisedBy: the command's person;
--   * severity ACTION and deviationRequired true when the command asks for ACTION, else ALERT and false;
--     registrationRelevant, qaOnly, stageSignOffBlocked and releaseBlocking false; status OPEN;
--   * source: the step, its instance key and the command's frames, or the frames alone when no step is named;
--   * block: for ACTION at a step, the steps after that step (the step's node in the execution graph, task:<id> or
--     hold:<id> by the kind of the step in the batch's own MBR content, recipe.step_node) until a deviation is
--     linked; none otherwise.
-- Only the time of raising (raisedAt, raisedSeq) is left to the engine. An accepted RAISE_EXCEPTION adds exactly
-- one OPERATOR_RAISED exception, with those facts; no other row adds one. Relabelling the operator's exception as
-- another type therefore leaves the command without its exception, and is refused too. Other exception types keep
-- the rules of 0270 and 0280 (their facts come from limits, time and flow, which the replay verification checks).
--
-- The initial state (ISSUE). recipe.issue_execution (0270) checked the state's hashes, version 0 and issuer only.
-- An ISSUE row whose state already recorded a hold-point decision, a disposition or a deviation link, a data point,
-- a performer or a signature was accepted, and the guards of later rows (check_hold_point_changes,
-- check_exception_changes) then kept it as recorded. The engine's issue (engine.ts issue, batch.ts initialState,
-- advance.ts) records no act of a person: its steps are enabled, or not applicable, with nobody in them, and the
-- only decisions are the ones the engine takes itself. Now recipe.check_issued_state requires that:
--   * no step records a hold-point decision (check_hold_point_changes against an empty state: EBMR-EXE-044);
--   * every exception is open, without disposition or link, and none is an operator's exception
--     (check_exception_changes against an empty state: EBMR-EXE-044). An open exception the engine raises while
--     advancing at issue (a replicate count or a data decision it cannot evaluate from the header) stays allowed:
--     it is the engine's own output, and it only stops the batch until QA dispositions it;
--   * every step is ENABLED or NOT_APPLICABLE and untouched: no performer, data enterer, corrector or PERFORMED
--     signer, no signature, no start, end or completion, no skip, no re-verification, no targets or computed items;
--   * no data point, entry, container, derived value or hold, no applied command and no used signature; neither
--     the request nor the header names an issue signature (the database checks none at issue);
--   * every decision is the engine's own (decidedBy SYSTEM) and no stage is signed off.
-- Anything else is refused with EBMR-EXE-030, like the other ways the state is not the engine's initial state.
--
-- CREATE OR REPLACE keeps the owner (ebmr_owner), the privileges (check_exception_changes: none for PUBLIC, 0270;
-- issue_execution: the application role's, 0210), SECURITY DEFINER and the search_path of 0270.
-- check_exception_changes now reads the batch's MBR content, so it is declared STABLE instead of IMMUTABLE. The new
-- helpers are private to the owner. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers (owner only)
-- ---------------------------------------------------------------------------------------------

-- PR-49, PR-13, DI-26: the exception p_id the engine raises for the accepted RAISE_EXCEPTION p_cmd (engine 1.1.0:
-- batch.ts raiseException, exceptions.ts engineDraft, tx.ts raise), without its time of raising (raisedAt,
-- raisedSeq), as the state encodes it (codec.ts: a text holding U+0000 is written {"$s": ...}). p_content is the
-- batch's MBR content (read only for ACTION at a step, whose block names the step's node). NULL when the command
-- cannot have raised one (a malformed member, an unknown step): nothing then matches, so the row is refused.
create function recipe.operator_exception_record(p_content jsonb, p_cmd jsonb, p_id text) returns jsonb
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_person text := case when jsonb_typeof(p_cmd -> 'actor' -> 'id') = 'string' then p_cmd -> 'actor' ->> 'id' end;
  v_action boolean := coalesce((p_cmd -> 'severity') = '"ACTION"'::jsonb, false);
  v_frames jsonb;
  v_step   text;
  v_title  jsonb;
  v_source jsonb;
  v_node   jsonb;
  v_rec    jsonb;
begin
  if v_person is null or p_id is null then
    return null;
  end if;
  -- The frames are the command's context (none: []).
  v_frames := case when p_cmd -> 'context' is null or (p_cmd -> 'context') = 'null'::jsonb then '[]'::jsonb
                   when jsonb_typeof(p_cmd -> 'context') = 'array' then p_cmd -> 'context' end;
  if v_frames is null then
    return null;
  end if;
  -- The title: "<actor id>: <description trimmed>".
  v_title := case when jsonb_typeof(p_cmd -> 'description') = 'string'
                    then to_jsonb(v_person || ': ' || recipe.js_trim(p_cmd ->> 'description'))
                  when jsonb_typeof(p_cmd -> 'description') = 'object' and (select count(*) from jsonb_object_keys(p_cmd -> 'description')) = 1
                       and jsonb_typeof(p_cmd -> 'description' -> '$s') = 'string'
                    then jsonb_build_object('$s', v_person || ': ' || recipe.js_trim(p_cmd -> 'description' ->> '$s')) end;
  if v_title is null then
    return null;
  end if;
  if p_cmd ? 'step' then
    if jsonb_typeof(p_cmd -> 'step') is distinct from 'string' then
      return null;
    end if;
    v_step := p_cmd ->> 'step';
    v_source := jsonb_build_object('stepKey', v_step || '@' || recipe.ctx_key(v_frames), 'step', v_step, 'frames', v_frames);
  else
    v_source := jsonb_build_object('frames', v_frames);
  end if;
  v_rec := jsonb_build_object(
    'id', p_id, 'type', 'OPERATOR_RAISED', 'category', 'DEVIATION_OR_OVERRIDE', 'title', v_title, 'controls', '["PR-13", "PR-49"]'::jsonb,
    'severity', case when v_action then 'ACTION' else 'ALERT' end, 'source', v_source, 'raisedBy', v_person,
    'deviationRequired', v_action, 'registrationRelevant', false, 'qaOnly', false, 'stageSignOffBlocked', false, 'releaseBlocking', false,
    'status', 'OPEN');
  -- ACTION at a step stops the steps after it until a deviation is linked: the block names the step's graph node.
  if v_action and v_step is not null then
    v_node := recipe.step_node(p_content, v_step);
    if v_node ->> 'kind' is null or v_node ->> 'kind' not in ('phase', 'holdPoint') then
      return null;
    end if;
    v_rec := v_rec || jsonb_build_object('block', jsonb_build_object(
      'steps', '[]'::jsonb, 'until', 'DEVIATION',
      'downstream', jsonb_build_object('node', case v_node ->> 'kind' when 'holdPoint' then 'hold:' else 'task:' end || v_step, 'frames', v_frames)));
  end if;
  return v_rec;
end
$$;

-- DI-26, INV-41, PR-49, PR-13: what a row may do to the exceptions of the stored state p_prior. An exception stays in
-- the state (never removed) and as it was raised: its status and disposition change only through an accepted
-- DISPOSITION_EXCEPTION of that exception (checked in full by check_disposition_state), its deviation link only
-- through an accepted ATTACH_DEVIATION of that exception that links the command's reference (trimmed) by the
-- command's person to an open exception without one. An exception the row raises is open, without disposition or
-- link. An accepted RAISE_EXCEPTION raises exactly one operator's exception (OPERATOR_RAISED), with the facts the
-- engine derives from the command (recipe.operator_exception_record); no other row raises one.
create or replace function recipe.check_exception_changes(p_prior jsonb, p_state jsonb, p_kind text, p_cmd jsonb, p_accepted boolean) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  e0      jsonb := coalesce(p_prior -> 'exceptions', '{}'::jsonb);
  e1      jsonb := p_state -> 'exceptions';
  v_act   text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_ex    text := p_cmd ->> 'exception';
  v_ref   text := recipe.js_trim(p_cmd ->> 'deviationRef');
  v_raise boolean;
  v_n     integer := 0;
  v_want  jsonb;
  v_cont  jsonb;
  k       text;
  x0      jsonb;
  x1      jsonb;
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
  -- The operator's exception is the one the command raised (PR-49, PR-13).
  v_raise := coalesce(v_act = 'RAISE_EXCEPTION', false);
  for k, x1 in select key, value from jsonb_each(e1) where not (e0 ? key) and value ->> 'type' = 'OPERATOR_RAISED' order by key loop
    v_n := v_n + 1;
    if not v_raise or v_n > 1 then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is an operator''s exception, which only an accepted RAISE_EXCEPTION raises, one per command; this %s row does not (PR-13, PR-49, DI-26). [EBMR-EXE-044]',
                         k, coalesce(p_kind, 'null'));
    end if;
    if (p_cmd -> 'severity') = '"ACTION"'::jsonb and p_cmd ? 'step' then
      select pk.content into v_cont from recipe.test_package pk where pk.content_hash = p_state ->> 'mbrHash' limit 1;
    end if;
    v_want := recipe.operator_exception_record(v_cont, p_cmd, k);
    if v_want is null or (x1 - 'raisedAt' - 'raisedSeq') is distinct from v_want then
      raise exception using errcode = 'P0001',
        message = format('Exception %s is not the exception its command raised: its type, severity, need of a deviation, block, QA-only and release-blocking flags, title, source and raiser come from the command (PR-49, PR-13, DI-26). [EBMR-EXE-044]', k);
    end if;
  end loop;
  if v_raise and v_n = 0 then
    raise exception using errcode = 'P0001',
      message = 'The accepted RAISE_EXCEPTION of this row is not recorded in the state as the operator''s exception it raises (PR-13, PR-49, DI-26). [EBMR-EXE-044]';
  end if;
end
$$;

-- DI-34, INV-41, PR-45, PR-49: the state p_state an ISSUE row stores for request p_request by person p_person is the
-- engine's initial state as far as the acts of persons go: nothing decided, dispositioned, linked, entered,
-- performed or signed (the header of this migration lists the rules).
create function recipe.check_issued_state(p_state jsonb, p_request jsonb, p_person uuid) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_cmd  jsonb := jsonb_build_object('type', 'ISSUE', 'request', p_request);
  v_what text;
begin
  perform recipe.check_hold_point_changes('{"steps": {}}'::jsonb, p_state, 'ISSUE', v_cmd, true, p_person, '{}'::uuid[]);
  perform recipe.check_exception_changes('{"exceptions": {}}'::jsonb, p_state, 'ISSUE', v_cmd, true);
  v_what := case
    when p_state ->> 'status' is distinct from 'ISSUED' then format('the status %s', coalesce(p_state ->> 'status', 'none'))
    when (p_state -> 'points') is distinct from '{}'::jsonb then 'data points'
    when (p_state -> 'entries') is distinct from '{}'::jsonb then 'block entries'
    when (p_state -> 'containers') is distinct from '{}'::jsonb then 'containers'
    when (p_state -> 'derived') is distinct from '{}'::jsonb then 'derived values'
    when (p_state -> 'holds') is distinct from '{}'::jsonb then 'holds'
    when (p_state -> 'appliedCommands') is distinct from '[]'::jsonb then 'applied commands'
    when (p_state -> 'usedSignatures') is distinct from '{}'::jsonb or p_state -> 'header' ? 'issueSignature' or p_request ? 'issueSignature'
      then 'a signature'
    when jsonb_typeof(p_state -> 'decisions') is distinct from 'object'
         or exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'decisions') = 'object' then p_state -> 'decisions' else '{}'::jsonb end) d where d.value ->> 'decidedBy' is distinct from 'SYSTEM')
      then 'a decision taken by a person'
    when jsonb_typeof(p_state -> 'stages') is distinct from 'object'
         or exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'stages') = 'object' then p_state -> 'stages' else '{}'::jsonb end) g where jsonb_typeof(g.value) is distinct from 'object' or g.value ? 'signOff')
      then 'a stage sign-off'
    when exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' else '{}'::jsonb end) i
                  where coalesce(i.value ->> 'status', '') not in ('ENABLED', 'NOT_APPLICABLE')
                     or (i.value -> 'performers') is distinct from '[]'::jsonb or (i.value -> 'dataEnterers') is distinct from '[]'::jsonb
                     or (i.value -> 'correctors') is distinct from '[]'::jsonb or (i.value -> 'performedSigners') is distinct from '[]'::jsonb
                     or (i.value -> 'signatures') is distinct from '[]'::jsonb
                     or i.value ?| array['startedAt', 'startedSeq', 'endedAt', 'completedAt', 'skip', 'disposition']
                     or (i.value -> 'reverification') is distinct from 'false'::jsonb
                     or coalesce(i.value -> 'targets', '{}'::jsonb) is distinct from '{}'::jsonb
                     or coalesce(i.value -> 'blockComputed', '{}'::jsonb) is distinct from '{}'::jsonb)
      then 'a step that was worked on'
  end;
  if v_what is not null then
    raise exception using errcode = 'P0001',
      message = format('The issued state already records %s; a batch starts with nothing done, entered, decided or signed by a person (DI-34, INV-41). [EBMR-EXE-030]', v_what);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- recipe.issue_execution (0270) with the initial-state check
-- ---------------------------------------------------------------------------------------------

-- Issues a test batch: the package, the pinned engine version, block registry and policy (with its
-- hash), the issue request, and the ISSUE row with the engine's initial state (sandbox only,
-- BATCH.ISSUE, TEST- number allocated in this transaction). The issuer named in the request is the person of
-- the command, and every engine role the request gives the issuer is backed by an evaluation stored in this
-- command in the declared role at the actor's location through the role map (INV-26, D4); the ISSUE row
-- stores that evidence. The initial state records no act of a person (recipe.check_issued_state).
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
  perform recipe.check_issued_state(p_state, p_request, (v_actor ->> 'person_id')::uuid);
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
-- Privileges: the new helpers are private to the owner (called only by the definer writers above). CREATE OR REPLACE
-- kept the privileges of the replaced functions.
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.operator_exception_record(jsonb, jsonb, text), recipe.check_issued_state(jsonb, jsonb, uuid) from public;

reset role;
