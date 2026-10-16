-- Recipe core, execution store: the batch's product is part of the scope a step's work and its signatures are
-- authorised in, so a qualification (training) requirement limited to one product applies to batches of that product
-- only (Phase 6 exit review 6jc-R16; IN-04, DI-21, DI-17, INV-26; DI-31 unchanged).
--
-- Handbook: modules/recipe-core.md
--
-- What was wrong. A step command was authorised at the actor's location only ({site, area}: recipe.require_command_
-- permission, the engine-role evaluations of tablets 0200 that recipe.check_engine_roles holds the row to), and the
-- content providers of a batch's step, stage, exception, data point, record and approved act gave the signature the
-- scope {site} only. iam.requirement_applies (kernel 0100) applies a requirement limited to a product whenever the
-- request names no product (fail closed: the request may be work on that product). So a requirement limited to
-- product A was applied to every step and step signature at the site, and the performers of every other product were
-- refused for want of product A's training. A grant limited to a product, for the same reason, never covered step work.
--
-- What changed (every guard kept; the added member only narrows which grants and requirements match):
--   * recipe.batch_scope_members(batch): {product: code} of the batch (recipe.batch_product, 0504), or {} when the batch
--     does not exist or names no product. It never raises (a content provider also serves reads and verification); a
--     batch without a product keeps the scope it had, so a product-limited requirement still applies to it.
--   * The content providers batch_step, batch_stage, batch_exception and batch_point (through recipe.with_batch_scope)
--     and batch_record, batch_act (replaced from 0450 and 0470, one change) add the batch's product to their scope.
--     esig.sign (kernel 0230) evaluates the signer's permission in that scope: a requirement limited to another product
--     no longer applies; one limited to this product, or to none, applies as before, and its qualification must still
--     come from a fresh source (STALE_QUALIFICATION_SOURCE, kernel 0130 and 1181).
--   * recipe.require_command_permission(type, meaning, batch): the 2-argument check at the actor's location with the
--     batch's product added. recipe.role_evaluation_problem(actor, permission, evaluation, batch) accepts an engine-role
--     evaluation made at the actor's location, either as before or with the batch's own product added (a location-only
--     evaluation that was allowed is the stricter of the two: no product-limited grant covers it, and every
--     product-limited requirement applied to it); one made for another product, or any other scope, is refused.
--     recipe.check_engine_roles(actor, evidence, batch) is 0270's with that check. recipe.append_execution (from 0295)
--     calls the batch forms; nothing else in it changes. The batch issue keeps the location-only checks.
--
-- CREATE OR REPLACE keeps the owners, privileges, SECURITY DEFINER and search_path of the replaced functions (and the
-- content providers' registrations, which name the same functions). The new functions are owner-only. Applied as a new
-- migration because applied migrations are never edited.

set local role ebmr_owner;

-- The batch's own scope members beyond the site: {product} (header).
create function recipe.batch_scope_members(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_strip_nulls(jsonb_build_object('product', nullif(btrim(recipe.batch_product(p_batch) ->> 'code'), ''))), '{}'::jsonb)
$$;

-- A content provider's output for an execution record "<batch uuid>:<key>" with the batch's product in its scope.
create function recipe.with_batch_scope(p_out jsonb, p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select case
           when (p_out ->> 'exists')::boolean is true and p_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:'
             then p_out || jsonb_build_object('scope', coalesce(p_out -> 'scope', '{}'::jsonb) || recipe.batch_scope_members(split_part(p_id, ':', 1)::uuid))
           else p_out
         end
$$;

-- As 0210; the batch's product added to the scope.
create or replace function recipe.batch_step_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.with_batch_scope(recipe.execution_content_of('batch_step', p_id), p_id) $$;
create or replace function recipe.batch_stage_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.with_batch_scope(recipe.execution_content_of('batch_stage', p_id), p_id) $$;
create or replace function recipe.batch_exception_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.with_batch_scope(recipe.execution_content_of('batch_exception', p_id), p_id) $$;
create or replace function recipe.batch_point_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.with_batch_scope(recipe.execution_content_of('batch_point', p_id), p_id) $$;

-- As 0450_change_path_catalogue.sql; the batch's product added to the scope.
create or replace function recipe.batch_record_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b         recipe.batch_execution;
  v_status  text;
  v_current integer;
  v_version integer;
begin
  if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:record@(0|[1-9][0-9]{0,8})$' then
    return jsonb_build_object('exists', false);
  end if;
  v_version := split_part(p_id, '@', 2)::integer;
  select * into b from recipe.batch_execution where id = split_part(p_id, ':', 1)::uuid;
  select s.status, s.state_version into v_status, v_current from recipe.execution_state s where s.batch_id = b.id;
  if b.id is null or v_status is null or v_version > v_current then
    return jsonb_build_object('exists', false);
  end if;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', v_status, 'entered_by', '[]'::jsonb,
    'scope', jsonb_build_object('site', b.site_code) || recipe.batch_scope_members(b.id),
    'content', jsonb_build_object(
      'batchId', b.id::text, 'batchNumber', b.batch_number, 'installation', b.installation, 'purpose', b.purpose,
      'packageHash', b.package_hash, 'mbrHash', b.content_hash, 'engineVersion', b.engine_version,
      'policyHash', b.policy_hash, 'marketSet', to_jsonb(b.market_set), 'batchSize', b.batch_size,
      'siteCode', b.site_code, 'issuedAtUs', b.issued_at_us::text, 'stateVersion', v_version));
end
$$;

-- As 0470_approved_act.sql; the batch's product added to the scope.
create or replace function recipe.batch_act_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  a        recipe.execution_act_proposal;
  b        recipe.batch_execution;
  v_status text;
begin
  select * into a from recipe.execution_act_proposal where aggregate_id = p_id;
  if a.aggregate_id is null then
    return jsonb_build_object('exists', false);
  end if;
  select * into b from recipe.batch_execution where id = a.batch_id;
  select s.status into v_status from recipe.execution_state s where s.batch_id = a.batch_id;
  return jsonb_build_object(
    'exists', true, 'content_version', 1, 'state', v_status, 'entered_by', '[]'::jsonb,
    'scope', jsonb_build_object('site', b.site_code) || recipe.batch_scope_members(b.id),
    'content', jsonb_build_object(
      'batchId', b.id::text, 'batchNumber', b.batch_number, 'mbrHash', b.content_hash, 'engineVersion', b.engine_version,
      'stateVersion', a.state_version, 'act', a.act));
end
$$;

-- As recipe.require_command_permission(text, text) of 0210, in the scope of the actor's location with the batch's
-- product added (header).
create function recipe.require_command_permission(p_type text, p_meaning text, p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_perms text[];
  v_held  text[];
  v_perm  text;
begin
  select permissions into v_perms from recipe.execution_command_permission where command_type = p_type;
  if v_perms is null then
    raise exception using errcode = 'P0001',
      message = format('%s is not available on test runs in this release; it arrives with the next increment (DI-34). [EBMR-EXE-003]', coalesce(p_type, 'This command'));
  end if;
  if p_type = 'VERIFY' then
    v_perm := case when p_meaning = 'WITNESSED' then 'STEP.WITNESS' else 'STEP.VERIFY' end;
  else
    v_held := iam.role_permissions_at(v_actor ->> 'role_code', clock_timestamp());
    select p into v_perm from unnest(v_perms) with ordinality as x (p, i) where p = any (v_held) order by i limit 1;
    v_perm := coalesce(v_perm, v_perms[1]);
  end if;
  return iam.require_permission(v_perm, iam.actor_location_scope() || recipe.batch_scope_members(p_batch));
end
$$;

-- As recipe.role_evaluation_problem(jsonb, text, uuid) of 0270, except the scope: the evaluation was made at the
-- actor's location, as it is or with the batch's own product added (header).
create function recipe.role_evaluation_problem(p_actor jsonb, p_permission text, p_evaluation uuid, p_batch uuid) returns text
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
  if ev.scope is distinct from v_scope and ev.scope is distinct from v_scope || recipe.batch_scope_members(p_batch) then
    return format('evaluation %s was made for scope %s, not at the actor''s location %s on this batch (%s)', ev.id, ev.scope, v_scope,
                  v_scope || recipe.batch_scope_members(p_batch));
  end if;
  return null;
end
$$;

-- As recipe.check_engine_roles(jsonb, jsonb) of 0270, each evaluation checked by the batch form above.
create function recipe.check_engine_roles(p_engine_actor jsonb, p_evidence jsonb, p_batch uuid) returns jsonb
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
    v_problem := recipe.role_evaluation_problem(v_actor, e ->> 'permission', v_eval, p_batch);
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

-- As 0295_signed_decisions.sql; the command's permission and its engine roles checked in the batch's scope (header).
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
    perform recipe.require_command_permission(v_type, v_mean, p_batch);
    v_roles := recipe.check_engine_roles(v_eng, p_roles, p_batch);
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

revoke all on function recipe.batch_scope_members(uuid), recipe.with_batch_scope(jsonb, text), recipe.require_command_permission(text, text, uuid),
                       recipe.role_evaluation_problem(jsonb, text, uuid, uuid), recipe.check_engine_roles(jsonb, jsonb, uuid) from public;

reset role;
