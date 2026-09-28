-- Recipe core, execution store (module C3), part 2: the writers (SECURITY DEFINER), the INV-40
-- constraint trigger, the e-signature content providers and the invariant query.
--
-- Write path of one engine call (the server's command, one transaction, kernel.begin_command first):
--   1. recipe.lock_execution(batch): locks the batch, writes the transaction's clock marker (INV-16) and
--      returns the projection and the trusted time;
--   2. the pure engine runs at that time (TypeScript);
--   3. recipe.append_execution(...) re-checks what the database can check and writes the row, its events,
--      the projection, the changed signable content and one plain-language business entry on the batch's
--      audit chain; refused engine calls are written too (their refusal is part of the record).
-- A test batch is issued with recipe.begin_issue (clock and TEST- number) and recipe.issue_execution.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Actor, permission, roles
-- ---------------------------------------------------------------------------------------------

-- The validated actor of the command with its session facts (device class, room, site) and the
-- badge-tap event the command consumed (INV-40). Refuses administrators (DI-18) and GMP databases
-- (Phase 2: test runs only, DI-05, INV-18).
create function recipe.execution_actor(p_action text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, sandbox, pg_temp as $$
declare
  v jsonb := iam.assert_validated_actor();
  s iam.session%rowtype;
begin
  perform iam.assert_not_administrator();
  perform sandbox.assert_sandbox_installation(p_action);
  select * into s from iam.session where id = (v ->> 'session_id')::uuid;
  if not found then
    raise exception using errcode = 'P0001', message = 'The command names no session, so it cannot be attributed (DI-14). [EBMR-EXE-001]';
  end if;
  return v || jsonb_build_object('device_class', s.device_class, 'room_code', s.room_code, 'site_code', s.site_code,
                                 'command_auth_event', iam.current_command_auth_event());
end
$$;

-- The permission a command needs, checked in the declared role at the actor's location (DI-17, INV-26).
-- Of a list, the first permission the declared role holds is required (a VERIFY names STEP.WITNESS when
-- its signature means WITNESSED). A command type without a row is not available in Phase 2.
create function recipe.require_command_permission(p_type text, p_meaning text) returns jsonb
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
  return iam.require_permission(v_perm, iam.actor_location_scope());
end
$$;

-- INV-26: every engine role the command's actor carries is backed by a stored authority evaluation of
-- the role's permission, allowed, for this person and account, made in this very command. Returns the
-- normalised evidence ([{role, permission, evaluationId}]).
create function recipe.check_engine_roles(p_engine_actor jsonb, p_evidence jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_role  text;
  e       jsonb;
  ev      iam.authority_evaluation%rowtype;
  v_out   jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'The role evidence of the command is malformed (INV-26). [EBMR-EXE-035]';
  end if;
  for e in select * from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb)) loop
    if not exists (select 1 from recipe.engine_role_permission rp where rp.engine_role = e ->> 'role' and rp.permission = e ->> 'permission') then
      raise exception using errcode = 'P0001',
        message = format('Engine role %s cannot be held through permission %s (INV-26). [EBMR-EXE-035]', e ->> 'role', e ->> 'permission');
    end if;
    begin
      select * into ev from iam.authority_evaluation where id = (e ->> 'evaluationId')::uuid;
    exception when invalid_text_representation then
      ev := null;
    end;
    if ev.id is null or not ev.allowed or ev.person_id is distinct from (v_actor ->> 'person_id')::uuid
       or ev.account_id is distinct from (v_actor ->> 'account_id')::uuid or ev.permission_code is distinct from e ->> 'permission'
       or ev.correlation_id is distinct from (v_actor ->> 'correlation_id')::uuid then
      raise exception using errcode = 'P0001',
        message = format('Engine role %s is not backed by an allowed authority evaluation of %s made for this person in this command (INV-26). [EBMR-EXE-036]',
                         e ->> 'role', e ->> 'permission');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('role', e ->> 'role', 'permission', e ->> 'permission', 'evaluationId', ev.id));
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
-- Signatures and involvement
-- ---------------------------------------------------------------------------------------------

-- The aggregate id of a step or stage instance: <batch>:<id>@<context key>.
create function recipe.instance_aggregate(p_batch uuid, p_id text, p_context jsonb) returns text
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select p_batch::text || ':' || p_id || '@' || recipe.ctx_key(coalesce(p_context, '[]'::jsonb))
$$;

-- INV-10: every e-signature an accepted command uses exists, has the command's meaning, belongs to the
-- aggregate the command acts on, is valid (not superseded), and was made by the person who uses it.
-- Returns the signature ids.
create function recipe.check_signatures(p_batch uuid, p_cmd jsonb, p_person uuid) returns uuid[]
language plpgsql volatile security definer set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  v_type  text := p_cmd ->> 'type';
  v_refs  jsonb := '[]'::jsonb;
  v_agg   text;
  v_atype text;
  r       jsonb;
  v_id    uuid;
  v_out   uuid[] := '{}';
begin
  case v_type
    when 'SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT' then
      v_atype := 'batch_step';
      v_agg := recipe.instance_aggregate(p_batch, p_cmd ->> 'step', p_cmd -> 'context');
      if p_cmd ? 'signature' then v_refs := jsonb_build_array(jsonb_build_object('ref', p_cmd -> 'signature', 'signer', p_person)); end if;
    when 'SIGN_OFF_STAGE' then
      v_atype := 'batch_stage';
      v_agg := recipe.instance_aggregate(p_batch, p_cmd ->> 'stage', p_cmd -> 'context');
      v_refs := jsonb_build_array(jsonb_build_object('ref', p_cmd -> 'signature', 'signer', p_person));
    when 'DISPOSITION_EXCEPTION' then
      v_atype := 'batch_exception';
      v_agg := p_batch::text || ':' || (p_cmd ->> 'exception');
      v_refs := jsonb_build_array(jsonb_build_object('ref', p_cmd -> 'signature', 'signer', p_person));
    when 'CORRECT_ENTRY' then
      v_atype := 'batch_point';
      v_agg := p_batch::text || ':' || (p_cmd ->> 'point');
      v_refs := jsonb_build_array(jsonb_build_object('ref', p_cmd -> 'signature', 'signer', p_person));
      if p_cmd ? 'approval' then
        v_refs := v_refs || jsonb_build_array(jsonb_build_object('ref', p_cmd -> 'approval' -> 'signature', 'signer', p_cmd -> 'approval' -> 'approver' ->> 'id'));
      end if;
    else
      if p_cmd ? 'signature' or p_cmd ? 'approval' or p_cmd ? 'approvals' then
        raise exception using errcode = 'P0001',
          message = format('%s carries e-signatures, which test runs do not accept in this release (DI-35). [EBMR-EXE-050]', v_type);
      end if;
      return v_out;
  end case;
  for r in select * from jsonb_array_elements(v_refs) loop
    begin
      v_id := (r -> 'ref' ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = 'P0001',
        message = format('%s names signature %s, which is not an e-signature of this system (DI-35, INV-10). [EBMR-EXE-051]', v_type, coalesce(r -> 'ref' ->> 'id', 'none'));
    end;
    if v_id is null then
      raise exception using errcode = 'P0001', message = format('%s needs an e-signature (DI-35, INV-10). [EBMR-EXE-051]', v_type);
    end if;
    if (r -> 'ref' ->> 'signer') is distinct from (r ->> 'signer') then
      raise exception using errcode = 'P0001',
        message = format('Signature %s is used by %s but names %s as its signer: nobody signs for someone else (DI-35, INV-10). [EBMR-EXE-052]',
                         v_id, r ->> 'signer', r -> 'ref' ->> 'signer');
    end if;
    perform esig.assert_signature(v_id, r -> 'ref' ->> 'meaning', v_atype, v_agg);
    if not exists (select 1 from esig.signature g where g.id = v_id and g.signer_person::text = r ->> 'signer') then
      raise exception using errcode = 'P0001', message = format('Signature %s was not made by %s (DI-35, INV-10). [EBMR-EXE-052]', v_id, r ->> 'signer');
    end if;
    v_out := v_out || v_id;
  end loop;
  return v_out;
end
$$;

-- INV-03 in the database: an accepted VERIFY (verified or witnessed) is never by a person who started,
-- performed, entered data in or corrected the step instance, according to the stored state before it.
create function recipe.check_verifier(p_prior jsonb, p_cmd jsonb) returns void
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_inst jsonb;
  v_who  text := p_cmd -> 'actor' ->> 'id';
begin
  if p_cmd ->> 'type' <> 'VERIFY' then
    return;
  end if;
  select i.value into v_inst from jsonb_each(coalesce(p_prior -> 'steps', '{}'::jsonb)) i
   where i.value ->> 'step' = p_cmd ->> 'step' and coalesce(i.value -> 'frames', '[]'::jsonb) = coalesce(p_cmd -> 'context', '[]'::jsonb);
  if v_inst is null then
    raise exception using errcode = 'P0001', message = 'The step to verify does not exist in the stored state (DI-34). [EBMR-EXE-032]';
  end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(v_inst -> 'performers', '[]') || coalesce(v_inst -> 'dataEnterers', '[]')
                                                      || coalesce(v_inst -> 'correctors', '[]') || coalesce(v_inst -> 'performedSigners', '[]')) p
             where p = v_who) then
    raise exception using errcode = 'P0001',
      message = format('%s performed, entered data in or corrected step %s, so the verification is refused: the verifier is always another person (INV-03). [EBMR-EXE-033]',
                       v_who, v_inst ->> 'key');
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Clock (INV-16)
-- ---------------------------------------------------------------------------------------------

-- The trusted time of this transaction for a batch: written once, then reused (the dry run and the
-- apply of a signing see the same instant).
create function recipe.execution_marker(p_batch uuid, p_batch_number text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, recipe, platform, pg_temp as $$
declare
  v_now bigint;
begin
  delete from recipe.execution_clock c where c.backend_pid = pg_backend_pid() and c.xact_id <> pg_current_xact_id();
  select now_us into v_now from recipe.execution_clock c
   where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
  if v_now is null then
    v_now := platform.epoch_micros(clock_timestamp());
    insert into recipe.execution_clock (xact_id, backend_pid, batch_id, now_us, batch_number)
    values (pg_current_xact_id(), pg_backend_pid(), p_batch, v_now, p_batch_number);
  end if;
  return v_now;
end
$$;

create function recipe.assert_marker(p_batch uuid, p_now_us bigint) returns recipe.execution_clock
language plpgsql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  m recipe.execution_clock;
begin
  select * into m from recipe.execution_clock c
   where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
  if m.now_us is null or m.now_us is distinct from p_now_us then
    raise exception using errcode = 'P0001',
      message = format('The engine ran at %s, not at the trusted database time of this transaction (%s): the recorded time always comes from the database clock (INV-16). [EBMR-EXE-021]',
                       coalesce(p_now_us::text, 'no time'), coalesce(m.now_us::text, 'none: lock the batch first'));
  end if;
  return m;
end
$$;

-- Locks the batch for this command and returns the projection and the trusted time (INV-16). With
-- p_skip_locked (the sweeper) a batch another command holds is skipped: the result is null.
create function recipe.lock_execution(p_batch uuid, p_skip_locked boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Running a test batch');
  b       recipe.batch_execution;
  p       recipe.execution_state;
  v_now   bigint;
begin
  if p_skip_locked then
    select * into b from recipe.batch_execution where id = p_batch for update skip locked;
    if not found then
      return null;
    end if;
  else
    select * into b from recipe.batch_execution where id = p_batch for update;
  end if;
  if not found then
    raise exception using errcode = 'P0001', message = 'There is no test batch with this id (DI-34). [EBMR-EXE-010]';
  end if;
  select * into p from recipe.execution_state where batch_id = p_batch;
  v_now := recipe.execution_marker(p_batch, b.batch_number);
  return jsonb_build_object('batch', to_jsonb(b), 'state', p.state, 'state_version', p.state_version, 'state_hash', p.state_hash,
                            'last_seq', p.last_seq::text, 'now_us', v_now::text, 'actor', v_actor);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Content versions
-- ---------------------------------------------------------------------------------------------

-- Inserts a new version for every aggregate whose content hash changed ([{type, key, content,
-- contentHash}]); the e-signature triggers supersede the signatures made on the previous version.
create function recipe.insert_contents(p_batch uuid, p_seq bigint, p_contents jsonb) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  c       jsonb;
  v_table regclass;
  v_agg   text;
  v_hash  text;
  v_last  record;
  n       integer := 0;
begin
  if jsonb_typeof(coalesce(p_contents, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = 'P0001', message = 'The signable content of the command is malformed (DI-37). [EBMR-EXE-055]';
  end if;
  for c in select * from jsonb_array_elements(coalesce(p_contents, '[]'::jsonb)) loop
    v_table := recipe.content_table(c ->> 'type');
    if v_table is null or coalesce(c ->> 'key', '') = '' or jsonb_typeof(c -> 'content') <> 'object' then
      raise exception using errcode = 'P0001', message = format('Unknown signable aggregate %s (DI-37). [EBMR-EXE-055]', coalesce(c ->> 'type', 'none'));
    end if;
    v_agg := p_batch::text || ':' || (c ->> 'key');
    v_hash := recipe.canonical_hash(c -> 'content');
    if v_hash is distinct from c ->> 'contentHash' then
      raise exception using errcode = 'P0001',
        message = format('The content of %s:%s does not hash to %s (DI-37). [EBMR-EXE-056]', c ->> 'type', v_agg, coalesce(c ->> 'contentHash', 'none'));
    end if;
    execute format('select content_version, content_hash from %s where aggregate_id = $1 order by content_version desc limit 1', v_table)
      into v_last using v_agg;
    if v_last.content_hash is not distinct from v_hash then
      continue;
    end if;
    execute format('insert into %s (batch_id, aggregate_key, aggregate_id, content_version, content, content_hash, row_seq) values ($1, $2, $3, $4, $5, $6, $7)', v_table)
      using p_batch, c ->> 'key', v_agg, coalesce(v_last.content_version, 0) + 1, c -> 'content', v_hash, p_seq;
    n := n + 1;
  end loop;
  return n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Rows
-- ---------------------------------------------------------------------------------------------

-- Writes one row with its events and projection and the business entry. Internal (owner only).
create function recipe.write_row(p_batch uuid, p_seq bigint, p_kind text, p_command_id text, p_cmd jsonb, p_actor jsonb, p_now bigint,
                                 p_accepted boolean, p_refusal jsonb, p_state jsonb, p_events jsonb, p_roles jsonb, p_signatures uuid[],
                                 p_evidence jsonb, p_prev_hash text) returns recipe.execution_command
language plpgsql volatile security definer set search_path = pg_catalog, recipe, kernel, pg_temp as $$
declare
  r       recipe.execution_command;
  e       jsonb;
  i       integer := 0;
  v_type  text := case p_kind when 'COMMAND' then p_cmd ->> 'type' when 'PREPARE' then 'PREPARE:' || coalesce(p_cmd -> 'target' ->> 'type', '?') else p_kind end;
  v_what  text;
begin
  r.batch_id := p_batch;
  r.seq := p_seq;
  r.kind := p_kind;
  r.command_id := p_command_id;
  r.command_type := v_type;
  r.command := p_cmd;
  r.command_hash := recipe.canonical_hash(p_cmd);
  r.actor_person := (p_actor ->> 'person_id')::uuid;
  r.actor_account := (p_actor ->> 'account_id')::uuid;
  r.actor_role := p_actor ->> 'role_code';
  r.actor_legal_name := p_actor ->> 'legal_name';
  r.source := p_actor ->> 'source';
  r.session_id := (p_actor ->> 'session_id')::uuid;
  r.device_id := nullif(p_actor ->> 'device_id', '')::uuid;
  r.device_class := p_actor ->> 'device_class';
  r.room_code := p_actor ->> 'room_code';
  r.auth_event_id := nullif(p_actor ->> 'command_auth_event', '')::uuid;
  r.now_us := p_now;
  r.accepted := p_accepted;
  r.refusal := p_refusal;
  r.state_version := (p_state ->> 'version')::integer;
  r.state_hash := recipe.canonical_hash(p_state);
  r.events_hash := recipe.canonical_hash(p_events);
  r.event_count := jsonb_array_length(p_events);
  r.roles := coalesce(p_roles, '[]'::jsonb);
  r.signature_ids := coalesce(p_signatures, '{}');
  r.evidence := coalesce(p_evidence, '{}'::jsonb);
  r.prev_row_hash := p_prev_hash;
  r.correlation_id := (p_actor ->> 'correlation_id')::uuid;
  r.recorded_at := clock_timestamp();
  r.row_hash := recipe.execution_row_hash(p_prev_hash, r);
  insert into recipe.execution_command select r.*;
  for e in select * from jsonb_array_elements(p_events) loop
    insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event) values (p_batch, p_seq, i, coalesce(e ->> 'type', '?'), e);
    i := i + 1;
  end loop;
  insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status)
  values (p_batch, p_state, r.state_version, r.state_hash, p_seq, r.row_hash, coalesce(p_state ->> 'status', '?'))
  on conflict (batch_id) do update set state = excluded.state, state_version = excluded.state_version, state_hash = excluded.state_hash,
                                        last_seq = excluded.last_seq, last_row_hash = excluded.last_row_hash, status = excluded.status,
                                        updated_at = clock_timestamp();
  v_what := coalesce(p_cmd ->> 'step', p_cmd ->> 'stage', p_cmd ->> 'exception', p_cmd ->> 'point', p_cmd -> 'target' ->> 'step', '');
  perform kernel.audit_business_event('batch:' || p_batch::text,
    format('%s %s%s by %s (%s): %s', p_kind, v_type, case when v_what = '' then '' else ' ' || v_what || '@' || recipe.ctx_key(coalesce(p_cmd -> 'context', p_cmd -> 'target' -> 'context')) end,
           coalesce(p_actor ->> 'legal_name', p_actor ->> 'person_id'), p_actor ->> 'role_code',
           case when p_accepted then format('accepted, %s event(s)', r.event_count) else format('refused (%s: %s)', p_refusal ->> 'code', p_refusal ->> 'message') end),
    jsonb_build_object('seq', p_seq, 'kind', p_kind, 'command_type', v_type, 'command_id', p_command_id, 'accepted', p_accepted,
                       'row_hash', r.row_hash, 'state_hash', r.state_hash, 'now_us', p_now::text, 'signature_ids', to_jsonb(r.signature_ids)));
  return r;
end
$$;

-- The state of the command must be the engine's state of this batch.
create function recipe.check_state(p_batch recipe.batch_execution, p_state jsonb, p_state_hash text, p_events jsonb, p_events_hash text) returns void
language plpgsql immutable security definer set search_path = pg_catalog, recipe, pg_temp as $$
begin
  if jsonb_typeof(p_state) <> 'object' or p_state ->> 'schema' <> 'ebmr.batch-execution-state' or jsonb_typeof(p_events) <> 'array' then
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
-- from stored evaluations (INV-26), INV-03 for verifications against the stored state, and every
-- e-signature an accepted command uses (INV-10). The INV-40 trigger checks the badge tap.
create function recipe.append_execution(p_batch uuid, p_expected_seq bigint, p_kind text, p_command jsonb, p_command_id text, p_now_us bigint,
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
  if p_kind not in ('COMMAND', 'PREPARE', 'SWEEP') then
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
  if not p_accepted and (jsonb_typeof(p_refusal) <> 'object' or coalesce(p_refusal ->> 'code', '') = '') then
    raise exception using errcode = 'P0001', message = 'A refused engine call is recorded with its refusal (DI-34). [EBMR-EXE-030]';
  end if;

  if p_kind = 'SWEEP' then
    -- A time sweep is a system act: a SYSTEM-source service account, never a person (INV-20).
    if v_actor ->> 'source' <> 'SYSTEM' or p_command ->> 'type' <> 'SWEEP' or not p_accepted then
      raise exception using errcode = 'P0001', message = 'Only the system sweeper records a time sweep (INV-20). [EBMR-EXE-038]';
    end if;
    perform recipe.require_command_permission('SWEEP', null);
  else
    if v_actor ->> 'source' not in ('UI', 'API') then
      raise exception using errcode = 'P0001', message = 'Only a person executes and signs steps (DI-14). [EBMR-EXE-038]';
    end if;
    v_eng := p_command -> 'actor';
    if v_eng ->> 'id' is distinct from v_actor ->> 'person_id' or v_eng ->> 'kind' <> 'PERSON' then
      raise exception using errcode = 'P0001',
        message = 'The engine command names another person than the one signed in: a command is attributed to the person who gives it (DI-14, INV-26). [EBMR-EXE-039]';
    end if;
    if p_kind = 'COMMAND' and p_command ->> 'commandId' is distinct from p_command_id then
      raise exception using errcode = 'P0001', message = 'The command id of the row and of the engine command differ (outline 5.7). [EBMR-EXE-024]';
    end if;
    v_type := case when p_kind = 'PREPARE' then p_command -> 'target' ->> 'type' else p_command ->> 'type' end;
    v_mean := p_command -> 'signature' ->> 'meaning';
    perform recipe.require_command_permission(v_type, v_mean);
    v_roles := recipe.check_engine_roles(v_eng, p_roles);
    if p_kind = 'COMMAND' and p_accepted then
      perform recipe.check_verifier(p.state, p_command);
      v_sigs := recipe.check_signatures(p_batch, p_command, (v_actor ->> 'person_id')::uuid);
    end if;
  end if;

  r := recipe.write_row(p_batch, p.last_seq + 1, p_kind, p_command_id, p_command, v_actor, p_now_us, p_accepted, p_refusal, p_state, p_events,
                        v_roles, v_sigs, p_evidence, p.last_row_hash);
  v_n := recipe.insert_contents(p_batch, r.seq, p_contents);
  return jsonb_build_object('seq', r.seq::text, 'row_hash', r.row_hash, 'state_hash', r.state_hash, 'contents', v_n, 'signature_ids', to_jsonb(v_sigs));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Issue of a test batch
-- ---------------------------------------------------------------------------------------------

-- The trusted time and the TEST- batch number of a test batch about to be issued (sandbox only,
-- BATCH.ISSUE). Numbers come from a sequence: TEST-B<yy>-<nnnn>.
create function recipe.begin_issue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_actor  jsonb := recipe.execution_actor('Issuing a test batch');
  v_number text;
  v_now    bigint;
begin
  perform recipe.require_command_permission('ISSUE', null);
  if exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = 'A test batch with this id exists already (DI-34). [EBMR-EXE-011]';
  end if;
  select c.batch_number into v_number from recipe.execution_clock c
   where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.batch_id = p_batch;
  if v_number is null then
    v_number := format('TEST-B%s-%s', to_char(clock_timestamp() at time zone iam.policy_text('site.zone'), 'YY'),
                       lpad(nextval('recipe.test_batch_number_seq')::text, 4, '0'));
  end if;
  v_now := recipe.execution_marker(p_batch, v_number);
  return jsonb_build_object('now_us', v_now::text, 'batch_number', v_number, 'site_code', v_actor ->> 'site_code', 'room_code', v_actor ->> 'room_code');
end
$$;

-- Issues a test batch: the package, the pinned engine version, block registry and policy (with its
-- hash), the issue request, and the ISSUE row with the engine's initial state (sandbox only,
-- BATCH.ISSUE, TEST- number allocated in this transaction).
create function recipe.issue_execution(p_batch uuid, p_package_hash text, p_batch_number text, p_request jsonb, p_policy jsonb, p_policy_hash text,
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
  if p_request -> 'issuedBy' ->> 'id' is distinct from v_actor ->> 'person_id' or p_request ->> 'batchId' is distinct from p_batch::text
     or p_request ->> 'batchNumber' is distinct from p_batch_number then
    raise exception using errcode = 'P0001', message = 'The issue request names another person, batch or number than this command (DI-14). [EBMR-EXE-015]';
  end if;
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
  if (p_state ->> 'version')::integer <> 0 or p_state -> 'header' ->> 'issuedBy' is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'The issued state is not the engine''s initial state of this request (DI-34). [EBMR-EXE-030]';
  end if;
  r := recipe.write_row(p_batch, 1, 'ISSUE', 'ISSUE:' || p_batch::text, jsonb_build_object('type', 'ISSUE', 'request', p_request), v_actor, p_now_us,
                        true, null, p_state, p_events, '[]'::jsonb, '{}', p_evidence, recipe.execution_genesis_hash(p_batch));
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
-- Import of a test package (sandbox only, BATCH.ISSUE): hashes recomputed here, GMP origin required.
-- The server parses the MBR and defines it for the sandbox before calling this (unexecutable content is
-- refused there, with the reason).
-- ---------------------------------------------------------------------------------------------

create function recipe.import_test_package(p_package jsonb, p_file_name text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, recipe, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := recipe.execution_actor('Importing a test package');
  v_hash  text;
  pk      recipe.test_package;
begin
  perform recipe.require_command_permission('ISSUE', null);
  if jsonb_typeof(p_package) <> 'object' or p_package ->> 'format' is distinct from 'ebmr.mbr-test-package' or p_package -> 'formatVersion' is distinct from '1'::jsonb then
    raise exception using errcode = 'P0001', message = 'The file is not an ebmr.mbr-test-package version 1 (DI-05). [EBMR-EXE-016]';
  end if;
  v_hash := recipe.canonical_hash(p_package - 'packageHash');
  if v_hash is distinct from p_package ->> 'packageHash' or p_file_name is distinct from v_hash || '.json' then
    raise exception using errcode = 'P0001',
      message = 'The package hash does not match its content or its file name: the file was changed after export (DI-05, DI-37). [EBMR-EXE-017]';
  end if;
  if recipe.canonical_hash(p_package -> 'content') is distinct from p_package ->> 'contentHash' then
    raise exception using errcode = 'P0001', message = 'The MBR content does not match its content hash (DI-04). [EBMR-EXE-017]';
  end if;
  if p_package -> 'source' ->> 'installationKind' is distinct from 'GMP' or jsonb_typeof(p_package -> 'source' -> 'watermark') is distinct from 'null' then
    raise exception using errcode = 'P0001',
      message = 'The package does not come from a GMP installation; only MBR versions exported from GMP are test-run (DI-05, INV-18). [EBMR-EXE-018]';
  end if;
  if exists (select 1 from recipe.test_package where package_hash = v_hash) then
    raise exception using errcode = 'P0001', message = 'This test package has been imported already (DI-05). [EBMR-EXE-019]';
  end if;
  pk.package_hash := v_hash;
  pk.file_name := p_file_name;
  pk.package := p_package;
  pk.content := p_package -> 'content';
  pk.content_hash := p_package ->> 'contentHash';
  pk.family_id := (p_package -> 'family' ->> 'familyId')::uuid;
  pk.family_code := p_package -> 'family' ->> 'familyCode';
  pk.product := p_package -> 'family' -> 'product';
  pk.version_id := (p_package -> 'version' ->> 'versionId')::uuid;
  pk.version_number := p_package -> 'version' ->> 'number';
  pk.revision := (p_package -> 'version' ->> 'revision')::integer;
  pk.version_state := p_package -> 'version' ->> 'state';
  pk.exporter := p_package -> 'exporter';
  pk.exported_at_us := (p_package ->> 'exportedAtUs')::bigint;
  pk.source := p_package -> 'source';
  pk.imported_at := clock_timestamp();
  pk.imported_by_person := (v_actor ->> 'person_id')::uuid;
  pk.imported_by_account := (v_actor ->> 'account_id')::uuid;
  pk.correlation_id := (v_actor ->> 'correlation_id')::uuid;
  insert into recipe.test_package select pk.*;
  perform kernel.audit_business_event('test_package:' || v_hash,
    format('Test package %s imported (MBR %s version %s revision %s, %s; content %s) by %s', left(v_hash, 12), pk.family_code, pk.version_number,
           pk.revision, pk.version_state, left(pk.content_hash, 12), coalesce(v_actor ->> 'legal_name', v_actor ->> 'person_id')),
    jsonb_build_object('package_hash', v_hash, 'content_hash', pk.content_hash, 'version_id', pk.version_id));
  return jsonb_build_object('package_hash', v_hash, 'imported_at', recipe.utc_text(pk.imported_at));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- INV-40: a row written on a shared terminal carries the badge-tap event this very command consumed.
-- ---------------------------------------------------------------------------------------------

create function recipe.execution_attribution_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, iam, pg_temp as $$
declare
  v_event uuid;
begin
  v_event := iam.current_command_auth_event();
  if new.device_class in ('SHARED', 'GRADE_A_B') and (new.auth_event_id is null or new.auth_event_id is distinct from v_event) then
    raise exception using errcode = 'P0001',
      message = 'An entry on a shared terminal must carry the fresh badge tap of the person that this command consumed (INV-40). [EBMR-EXE-040]';
  end if;
  if new.auth_event_id is not null and new.auth_event_id is distinct from v_event then
    raise exception using errcode = 'P0001', message = 'The row names an authentication event this command did not consume (INV-40). [EBMR-EXE-040]';
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_attribution after insert on recipe.execution_command
  for each row execute function recipe.execution_attribution_check();

-- ---------------------------------------------------------------------------------------------
-- Content providers of the e-signature module (contract: esig 0200). Content and version come from the
-- latest content row; state, the persons involved, the scope and the witnessed act from the projection.
-- ---------------------------------------------------------------------------------------------

create function recipe.execution_content_of(p_type text, p_id text) returns jsonb
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
          v_act := jsonb_build_object('device_id', v_dev, 'at', timestamptz 'epoch' + make_interval(secs => 0) + (v_ended::text || ' microseconds')::interval);
        end if;
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
    when 'batch_point' then
      x := st -> 'points' -> v_key;
      v_state := x ->> 'status';
      v_by := recipe.person_ids(jsonb_build_array(x ->> 'enteredBy'));
  end case;
  return jsonb_strip_nulls(jsonb_build_object(
    'exists', true, 'content_version', v_row.content_version, 'content', v_row.content, 'state', v_state,
    'entered_by', to_jsonb(v_by), 'scope', jsonb_build_object('site', b.site_code), 'act', v_act));
end
$$;

create function recipe.batch_step_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.execution_content_of('batch_step', p_id) $$;
create function recipe.batch_stage_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.execution_content_of('batch_stage', p_id) $$;
create function recipe.batch_exception_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.execution_content_of('batch_exception', p_id) $$;
create function recipe.batch_point_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$ select recipe.execution_content_of('batch_point', p_id) $$;

select esig.register_content_provider('batch_step', 'recipe.batch_step_content(text)', 'A step or hold-point instance of a batch: its data, entries, derived values and data exceptions (C3)');
select esig.register_content_provider('batch_stage', 'recipe.batch_stage_content(text)', 'A stage frame of a batch: its steps with their content hashes and statuses (C3)');
select esig.register_content_provider('batch_exception', 'recipe.batch_exception_content(text)', 'An exception of a batch as raised, with its deviation link (C3)');
select esig.register_content_provider('batch_point', 'recipe.batch_point_content(text)', 'A data point of a batch as recorded (the subject of a correction) (C3)');
select esig.register_signed_table('recipe.execution_step_content', 'batch_step', 'aggregate_id');
select esig.register_signed_table('recipe.execution_stage_content', 'batch_stage', 'aggregate_id');
select esig.register_signed_table('recipe.execution_exception_content', 'batch_exception', 'aggregate_id');
select esig.register_signed_table('recipe.execution_point_content', 'batch_point', 'aggregate_id');

-- ---------------------------------------------------------------------------------------------
-- The invariant query: no rows in a correct database.
-- ---------------------------------------------------------------------------------------------

create function recipe.execution_violations() returns table (batch_id uuid, problem text)
language plpgsql stable security definer set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
#variable_conflict use_column
declare
  v_kind text := kernel.installation_kind();
  r      record;
  rw     recipe.execution_command;
  v_prev text;
  v_bat  uuid;
  v_seq  bigint;
begin
  -- DI-05, INV-18: in Phase 2 nothing of this store exists in a GMP database; SANDBOX_ONLY blocks never do.
  if v_kind = 'GMP' then
    for r in select id from recipe.batch_execution loop
      batch_id := r.id; problem := 'a test batch exists in a GMP database (DI-05, INV-18)'; return next;
    end loop;
    for r in select package_hash from recipe.test_package loop
      batch_id := null; problem := format('test package %s exists in a GMP database (DI-05, INV-18)', r.package_hash); return next;
    end loop;
  end if;
  for r in
    select distinct t.package_hash, s.block_type, s.block_version
    from recipe.test_package t
    cross join lateral jsonb_path_query(t.content, 'strict $.**.block') blk
    join recipe.sandbox_only_block s on s.block_type = blk ->> 'type' and s.block_version = blk ->> 'version'
    where v_kind = 'GMP'
  loop
    batch_id := null; problem := format('SANDBOX_ONLY block %s@%s in package %s held by a GMP database (DI-05, INV-18)', r.block_type, r.block_version, r.package_hash);
    return next;
  end loop;
  for r in select id, batch_number from recipe.batch_execution where sandbox.identifier_problem('BATCH_NUMBER', batch_number) is not null loop
    batch_id := r.id; problem := format('batch number %s is not allowed in this installation (DI-05)', r.batch_number); return next;
  end loop;

  -- Sequence, kinds and the hash chain.
  for r in select b.id, count(k.seq) as n, min(k.seq) as lo, max(k.seq) as hi from recipe.batch_execution b left join recipe.execution_command k on k.batch_id = b.id group by b.id loop
    if r.n = 0 or r.lo <> 1 or r.hi <> r.n then
      batch_id := r.id; problem := format('rows are not numbered 1..n without gaps (%s rows, %s..%s) (DI-34)', r.n, r.lo, r.hi); return next;
    end if;
  end loop;
  v_bat := null;
  for rw in select * from recipe.execution_command x order by x.batch_id, x.seq loop
    if v_bat is distinct from rw.batch_id then
      v_bat := rw.batch_id;
      v_prev := recipe.execution_genesis_hash(rw.batch_id);
    end if;
    if rw.prev_row_hash is distinct from v_prev then
      batch_id := rw.batch_id; problem := format('row %s does not link to the previous row hash (DI-34)', rw.seq); return next;
    end if;
    if rw.row_hash is distinct from recipe.execution_row_hash(rw.prev_row_hash, rw) then
      batch_id := rw.batch_id; problem := format('row %s does not match its row hash (changed after it was written) (DI-34)', rw.seq); return next;
    end if;
    if rw.command_hash is distinct from recipe.canonical_hash(rw.command) then
      batch_id := rw.batch_id; problem := format('row %s: the command does not match its hash (DI-34)', rw.seq); return next;
    end if;
    if rw.events_hash is distinct from (select recipe.canonical_hash(coalesce(jsonb_agg(e.event order by e.idx), '[]'::jsonb)) from recipe.execution_event e where e.batch_id = rw.batch_id and e.row_seq = rw.seq) then
      batch_id := rw.batch_id; problem := format('row %s: the stored events do not match the events hash (DI-34)', rw.seq); return next;
    end if;
    if rw.device_class in ('SHARED', 'GRADE_A_B') and rw.auth_event_id is null then
      batch_id := rw.batch_id; problem := format('row %s was written on a shared terminal without a badge-tap event (INV-40)', rw.seq); return next;
    end if;
    v_prev := rw.row_hash;
  end loop;

  -- The projection is the state of the last row.
  for r in
    select p.batch_id as id, p.state_hash, p.state_version, p.last_seq, p.last_row_hash, recipe.canonical_hash(p.state) as computed,
           k.state_hash as row_state, k.state_version as row_version, k.row_hash as row_hash, (select max(x.seq) from recipe.execution_command x where x.batch_id = p.batch_id) as hi
    from recipe.execution_state p left join recipe.execution_command k on k.batch_id = p.batch_id and k.seq = p.last_seq
  loop
    if r.computed is distinct from r.state_hash or r.row_state is distinct from r.state_hash or r.row_version is distinct from r.state_version
       or r.last_seq is distinct from r.hi or r.last_row_hash is distinct from r.row_hash then
      batch_id := r.id; problem := 'the stored state is not the state of the last row (DI-34)'; return next;
    end if;
  end loop;
  for r in select b.id from recipe.batch_execution b where not exists (select 1 from recipe.execution_state p where p.batch_id = b.id) loop
    batch_id := r.id; problem := 'a test batch has no state (DI-34)'; return next;
  end loop;

  -- Content versions: numbered 1..n per aggregate and matching their hash.
  for r in
    select x.aggregate_id, x.batch_id as bid, count(*) as n, max(x.content_version) as hi,
           bool_and(x.content_hash = recipe.canonical_hash(x.content)) as hashes
    from (select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_step_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_stage_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_exception_content
          union all select aggregate_id, batch_id, content_version, content, content_hash from recipe.execution_point_content) x
    group by x.aggregate_id, x.batch_id
  loop
    if r.n <> r.hi or not r.hashes then
      batch_id := r.bid; problem := format('signable content of %s is not versioned 1..n or does not match its hash (DI-37)', r.aggregate_id); return next;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the app role may call the writers (each checks the actor itself) and the invariant query.
-- ---------------------------------------------------------------------------------------------

revoke all on function recipe.execution_actor(text), recipe.require_command_permission(text, text), recipe.check_engine_roles(jsonb, jsonb),
                       recipe.instance_aggregate(uuid, text, jsonb), recipe.check_signatures(uuid, jsonb, uuid), recipe.check_verifier(jsonb, jsonb),
                       recipe.execution_marker(uuid, text), recipe.assert_marker(uuid, bigint), recipe.insert_contents(uuid, bigint, jsonb),
                       recipe.write_row(uuid, bigint, text, text, jsonb, jsonb, bigint, boolean, jsonb, jsonb, jsonb, jsonb, uuid[], jsonb, text),
                       recipe.check_state(recipe.batch_execution, jsonb, text, jsonb, text), recipe.execution_attribution_check(),
                       recipe.execution_content_of(text, text), recipe.batch_step_content(text), recipe.batch_stage_content(text),
                       recipe.batch_exception_content(text), recipe.batch_point_content(text) from public;
grant execute on function recipe.lock_execution(uuid, boolean),
                          recipe.append_execution(uuid, bigint, text, jsonb, text, bigint, boolean, jsonb, jsonb, text, jsonb, text, jsonb, jsonb, jsonb),
                          recipe.begin_issue(uuid),
                          recipe.issue_execution(uuid, text, text, jsonb, jsonb, text, text, text, bigint, jsonb, text, jsonb, text, jsonb, jsonb),
                          recipe.import_test_package(jsonb, text), recipe.execution_violations(), recipe.instance_aggregate(uuid, text, jsonb) to ebmr_app;

reset role;
