-- Recipe core, execution store (module C3): the hand-over quick review fixes (Phase 3 slice 2; outline 5.2.3, L-07;
-- PR-13, PR-14, PR-49, DI-14, DI-24, INV-03, INV-31; engine 1.6.0, unreleased; ADR 0012).
--
-- Findings fixed (the 0461-0463 hand-over; applied migrations are never edited, so the functions are replaced here from
-- their latest bodies):
--   1. A step could wait for good: only the named incoming person leaves ATTEMPT_HANDED_OVER, and nothing checked that
--      person could. Now the command names the incoming performer as an actor with the engine roles they hold
--      (recipe.command_shape, from 0461), and recipe.hand_over_problem refuses a hand-over to a person who is not active,
--      has no active human account able to sign in, or does not hold now (recipe.person_engine_roles, from the role
--      grants and the role map) the roles the command names, the step's perform role among them. A step waiting for its
--      incoming performer is handed over again (recipe.step_status_problem from 0463: HAND_OVER_STEP also from
--      ATTEMPT_HANDED_OVER), from that person, under the same supervisor and QA rules.
--   2. The hand-over's supervisor, QA approver, outgoing and incoming persons could disposition its STEP_HANDED_OVER
--      exception. recipe.exception_step_involvement (from 0315), which the exception content provider (kernel refusal
--      EBMR-ESIG-044) and the register sync (0440/0441, EBMR-EXE-163) read, now holds every person a step's hand-overs
--      name (recipe.hand_over_involvement: the stored record and the accepted rows).
--   4. The outgoing performer could still correct the step's data and raise an exception at it: refused (EBMR-EXE-185).
--   6. The hand-over's supervisor and QA approver could later verify the step: refused (EBMR-EXE-185;
--      recipe.hand_over_persons gains the approvers).
--   (Finding 3, the approvals bound to the act, was fixed by 0470/0471: HANDOVER_APPROVED signs the approved act.)
--
-- New functions are owned by ebmr_owner and private to the owner; every function pins its search_path with pg_temp
-- last; CREATE OR REPLACE keeps owner, privileges and search_path. Applied as a new migration because applied migrations
-- are checksummed and never edited.

set local role ebmr_owner;

create or replace function recipe.command_shape(p_kind text, p_type text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  txt      constant jsonb := '{"t": "text"}';
  opt      constant jsonb := '{"opt": true}';
  actor    constant jsonb := '{"t": "object", "fields": {"id": {"t": "text"}, "kind": {"t": "text", "enum": ["PERSON", "SYSTEM"]}, "roles": {"t": "list", "items": {"t": "text"}}}}';
  frames   constant jsonb := '{"t": "list", "items": {"t": "object", "fields": {"construct": {"t": "text"}, "index": {"t": "int"}}}}';
  occurred constant jsonb := '{"t": "object", "fields": {"us": {"t": "micros"}, "trust": {"t": "text", "enum": ["DEVICE_SYNCED", "DEVICE_UNSYNCED", "USER_CLAIMED", "PAPER"]}}}';
  sig      constant jsonb := '{"t": "object", "fields": {"id": {"t": "text"}, "meaning": {"t": "text"}, "signer": {"t": "text"}}}';
  val      constant jsonb := '{"t": "union", "tag": "kind", "variants": {
    "DECIMAL": {"t": "object", "fields": {"kind": {"t": "text"}, "value": {"t": "text"}, "unit": {"t": "text"}}},
    "COUNT": {"t": "object", "fields": {"kind": {"t": "text"}, "value": {"t": "text"}}},
    "BOOLEAN": {"t": "object", "fields": {"kind": {"t": "text"}, "value": {"t": "bool"}}},
    "CATEGORY": {"t": "object", "fields": {"kind": {"t": "text"}, "value": {"t": "text"}}},
    "TEXT": {"t": "object", "fields": {"kind": {"t": "text"}, "value": {"t": "text"}}},
    "INSTANT": {"t": "object", "fields": {"kind": {"t": "text"}, "us": {"t": "micros"}}},
    "SERIES": {"t": "object", "fields": {"kind": {"t": "text"}, "values": {"t": "list", "items": {"t": "text"}}, "unit": {"t": "text"}}}}}';
  src      constant jsonb := '{"t": "union", "tag": "mode", "variants": {
    "MANUAL": {"t": "object", "fields": {"mode": {"t": "text"}, "evidence": {"t": "object", "opt": true, "fields": {"kind": {"t": "text", "enum": ["PHOTO", "PRINTOUT"]}, "sha256": {"t": "text", "pattern": "^[0-9a-f]{64}$"}}}}},
    "DEVICE": {"t": "object", "fields": {"mode": {"t": "text"}, "device": {"t": "text"}, "raw": {"t": "text", "opt": true}}},
    "SCAN": {"t": "object", "fields": {"mode": {"t": "text"}, "code": {"t": "text"}}},
    "AUTOMATION": {"t": "object", "fields": {"mode": {"t": "text"}, "system": {"t": "text"}, "tag": {"t": "text", "opt": true}}},
    "LIMS": {"t": "object", "fields": {"mode": {"t": "text"}, "resultRef": {"t": "text"}}},
    "BLOCK": {"t": "object", "fields": {"mode": {"t": "text"}, "entries": {"t": "list", "items": {"t": "text"}}}}}}';
  types    constant jsonb := '["START_STEP", "RECORD_DATA", "RECORD_ENTRY", "SIGN_PERFORMED", "VERIFY", "CHOOSE_ALTERNATIVE", "CHOOSE_REPLICATE_COUNT",
                               "COMPLETE_LOOP_ITERATION", "REQUEST_SKIP", "DISPOSITION_HOLD_POINT", "SIGN_OFF_STAGE", "RAISE_EXCEPTION", "ATTACH_DEVIATION",
                               "DISPOSITION_EXCEPTION", "HOLD_BATCH", "RELEASE_HOLD", "CORRECT_ENTRY", "VOID_ATTEMPT", "INVALIDATE_RESULT", "ABORT_BATCH",
                               "CANCEL_BATCH",
                               "HAND_OVER_STEP", "TAKE_OVER_STEP"]';
  approval jsonb := jsonb_build_object('t', 'object', 'fields', jsonb_build_object('approver', actor, 'signature', sig));
  f        jsonb;
begin
  if p_kind = 'SWEEP' then
    return '{"t": "object", "of": "a sweep", "fields": {"type": {"t": "text", "enum": ["SWEEP"]}}}';
  elsif p_kind = 'PREPARE' then
    return jsonb_build_object('t', 'object', 'of', 'a preparation for a signature', 'fields', jsonb_build_object(
      'type', '{"t": "text", "enum": ["PREPARE"]}'::jsonb,
      'target', jsonb_build_object('t', 'object', 'fields', jsonb_build_object('type', jsonb_build_object('t', 'text', 'enum', types), 'step', txt || opt, 'context', frames || opt)),
      'actor', actor,
      'meaning', txt || opt));
  elsif p_kind = 'ISSUE' then
    return jsonb_build_object('t', 'object', 'of', 'an issue', 'fields', jsonb_build_object(
      'type', '{"t": "text", "enum": ["ISSUE"]}'::jsonb,
      'request', jsonb_build_object('t', 'object', 'of', 'an issue request', 'fields', jsonb_build_object(
        'batchId', txt, 'batchNumber', txt, 'batchSize', txt,
        'marketSet', '{"t": "list", "items": {"t": "text"}}'::jsonb,
        'purpose', '{"t": "text", "enum": ["COMMERCIAL", "PPQ", "EXHIBIT", "VALIDATION"], "opt": true}'::jsonb,
        'variants', '{"t": "map", "values": {"t": "text"}, "opt": true}'::jsonb,
        'inputs', jsonb_build_object('t', 'map', 'values', jsonb_build_object('t', 'object', 'fields', jsonb_build_object('value', val, 'source', txt))),
        'issuedBy', actor,
        'issueSignature', sig || opt))));
  elsif p_kind is distinct from 'COMMAND' then
    return null;
  end if;
  f := case p_type
    when 'START_STEP' then jsonb_build_object('step', txt, 'context', frames || opt, 'occurredAt', occurred || opt, 'blockData', '{"t": "startData", "opt": true}'::jsonb)
    when 'RECORD_DATA' then jsonb_build_object('step', txt, 'context', frames || opt, 'item', txt, 'value', val, 'source', src, 'occurredAt', occurred || opt, 'reason', txt || opt)
    when 'RECORD_ENTRY' then jsonb_build_object('step', txt, 'context', frames || opt, 'entry', '{"t": "entry"}'::jsonb, 'occurredAt', occurred || opt)
    when 'SIGN_PERFORMED' then jsonb_build_object('step', txt, 'context', frames || opt, 'signature', sig || opt, 'occurredAt', occurred || opt)
    when 'VERIFY' then jsonb_build_object('step', txt, 'context', frames || opt, 'signature', sig)
    when 'CHOOSE_ALTERNATIVE' then jsonb_build_object('construct', txt, 'context', frames || opt, 'branch', txt, 'reason', txt)
    when 'CHOOSE_REPLICATE_COUNT' then jsonb_build_object('construct', txt, 'context', frames || opt, 'count', '{"t": "int"}'::jsonb, 'reason', txt)
    when 'COMPLETE_LOOP_ITERATION' then jsonb_build_object('construct', txt, 'context', frames)
    when 'REQUEST_SKIP' then jsonb_build_object('step', txt, 'context', frames || opt, 'reason', txt, 'approval', approval)
    when 'DISPOSITION_HOLD_POINT' then jsonb_build_object('step', txt, 'context', frames || opt, 'disposition', txt, 'signature', sig, 'comment', txt || opt)
    when 'SIGN_OFF_STAGE' then jsonb_build_object('stage', txt, 'context', frames || opt, 'signature', sig)
    when 'RAISE_EXCEPTION' then jsonb_build_object('step', txt || opt, 'context', frames || opt, 'description', txt, 'severity', '{"t": "text", "enum": ["ALERT", "ACTION"]}'::jsonb)
    when 'ATTACH_DEVIATION' then jsonb_build_object('exception', txt, 'deviationRef', txt)
    when 'DISPOSITION_EXCEPTION' then jsonb_build_object('exception', txt, 'outcome', '{"t": "text", "enum": ["NO_IMPACT", "DEVIATION_RAISED"]}'::jsonb, 'justification', txt, 'signature', sig)
    when 'HOLD_BATCH' then jsonb_build_object('holdType', '{"t": "text", "enum": ["SUPERVISOR", "QA"]}'::jsonb, 'reason', txt)
    when 'RELEASE_HOLD' then jsonb_build_object('hold', txt, 'reason', txt)
    when 'CORRECT_ENTRY' then jsonb_build_object('point', txt, 'value', val, 'reason', txt, 'signature', sig,
      'evidence', '{"t": "object", "opt": true, "fields": {"kind": {"t": "text", "enum": ["DEVICE_RAW", "PRINTOUT", "PHOTO"]}, "sha256": {"t": "text", "pattern": "^[0-9a-f]{64}$"}}}'::jsonb,
      'approval', approval || opt)
    when 'VOID_ATTEMPT' then jsonb_build_object('step', txt, 'context', frames || opt, 'item', txt, 'reason', txt, 'point', txt || opt, 'approval', approval || opt)
    when 'INVALIDATE_RESULT' then jsonb_build_object('point', txt, 'investigationRef', txt, 'assignableCause', txt, 'reason', txt, 'approval', approval)
    when 'ABORT_BATCH' then jsonb_build_object('reason', txt,
      'checklist', '{"t": "object", "fields": {"outputsHeld": {"t": "bool"}, "equipmentSetDirty": {"t": "bool"}, "materialsSecured": {"t": "bool"}}}'::jsonb,
      'approvals', jsonb_build_object('t', 'list', 'items', approval))
    when 'CANCEL_BATCH' then jsonb_build_object('reason', txt, 'signature', sig)
    when 'HAND_OVER_STEP' then jsonb_build_object('step', txt, 'context', frames || opt, 'outgoing', txt, 'incoming', actor, 'reason', txt, 'signature', sig, 'approval', approval)
    when 'TAKE_OVER_STEP' then jsonb_build_object('step', txt, 'context', frames || opt)
  end;
  if f is null then
    return null;
  end if;
  return jsonb_build_object('t', 'object', 'of', case when left(p_type, 1) in ('A', 'E', 'I', 'O', 'U') then 'an ' else 'a ' end || p_type || ' command',
    'fields', f || jsonb_build_object('type', jsonb_build_object('t', 'text', 'enum', jsonb_build_array(p_type)), 'commandId', txt, 'actor', actor,
                                      'expectedVersion', '{"t": "int", "opt": true}'::jsonb));
end
$$;

-- DI-14, DI-30, PR-14 (0480, review finding 1): the engine roles person p_person holds now: the person active, with an
-- active human account able to sign in, through a role grant held now whose role carries the permission the role map
-- (decision D4) maps to the engine role. Sorted, without duplicates.
create function recipe.person_engine_roles(p_person uuid) returns text[]
language sql stable set search_path = pg_catalog, recipe, iam, pg_temp as $$
  select coalesce(array_agg(distinct m.engine_role order by m.engine_role), '{}')
    from iam.person p
    join iam.account a on a.person_id = p.id and a.kind = 'HUMAN' and a.gmp_capable
                       and coalesce(iam.account_status_at(a.id, clock_timestamp()), 'NONE') = 'ACTIVE'
    join iam.role_grant g on g.account_id = a.id and g.person_id = p.id
                          and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
    join recipe.engine_role_map m on m.kernel_role = g.role_code
    join iam.role_permission rp on rp.role_code = g.role_code and rp.permission_code = m.via_permission
                                and iam.role_permission_live_at(rp.added_at, rp.removed_at, clock_timestamp())
   where p.id = p_person and coalesce(iam.person_status_at(p.id, clock_timestamp()), 'NONE') = 'ACTIVE'
$$;

create or replace function recipe.step_status_problem(p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_command jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' then p_command ->> 'type' end;
  v_need  text := case when p_kind = 'COMMAND' and p_accepted is true then recipe.act_status_before(p_command ->> 'type') end;
  v_own   text;
  v_point text;
  v_ok    boolean;
  k       text;
  x       jsonb;
  y       jsonb;
  a       text;
  b       text;
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return 'stores a state whose steps are malformed';
  end if;
  if v_need is not null then
    if jsonb_typeof(p_command -> 'step') is distinct from 'string' then
      return 'names no step to act on';
    end if;
    v_own := (p_command ->> 'step') || '@' || recipe.ctx_key(coalesce(p_command -> 'context', '[]'::jsonb));
    a := p_old -> 'steps' -> v_own ->> 'status';
    -- A step waiting for its incoming performer is handed over again when they do not come (0480).
    if a is distinct from v_need and not (v_type = 'HAND_OVER_STEP' and a = 'ATTEMPT_HANDED_OVER') then
      return format('acts on step %s, which is %s before it; the engine takes a %s only on a step that is %s',
                    v_own, coalesce(lower(replace(a, '_', ' ')), 'not in the state'), v_type, lower(replace(v_need, '_', ' ')));
    end if;
  end if;
  if v_done and v_type = 'INVALIDATE_RESULT' and jsonb_typeof(p_command -> 'point') = 'string' then
    v_point := p_old -> 'points' -> (p_command ->> 'point') ->> 'stepKey';
  end if;
  for k, x in select e.key, e.value from jsonb_each(p_old -> 'steps') e order by e.key loop
    y := p_new -> 'steps' -> k;
    a := x ->> 'status';
    b := y ->> 'status';
    if jsonb_typeof(y) is distinct from 'object' then
      return format('removes step instance %s', k);
    end if;
    continue when a is not distinct from b;
    v_ok := case
      when a = 'ENABLED' and b = 'IN_PROGRESS' then k = v_own and v_type = 'START_STEP'
      when a = 'ENABLED' and b = 'SKIPPED' then k = v_own and v_type = 'REQUEST_SKIP'
      when a = 'ENABLED' and b = 'COMPLETED' then k = v_own and v_type = 'DISPOSITION_HOLD_POINT'
      when a = 'IN_PROGRESS' and b in ('AWAITING_VERIFICATION', 'COMPLETED') then k = v_own and v_type = 'SIGN_PERFORMED'
      when a = 'AWAITING_VERIFICATION' and b = 'COMPLETED' then k = v_own and v_type = 'VERIFY'
      when a = 'COMPLETED' and b = 'AWAITING_VERIFICATION' then v_done and v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT')
      when a in ('COMPLETED', 'AWAITING_VERIFICATION') and b = 'IN_PROGRESS' then k = v_point
      when a = 'IN_PROGRESS' and b = 'ATTEMPT_HANDED_OVER' then k = v_own and v_type = 'HAND_OVER_STEP'
      when a = 'ATTEMPT_HANDED_OVER' and b = 'IN_PROGRESS' then k = v_own and v_type = 'TAKE_OVER_STEP'
      else false
    end;
    if not coalesce(v_ok, false) then
      return format('moves step instance %s from %s to %s; the engine moves a step only along its life cycle, by the act that moves it',
                    k, coalesce(lower(replace(a, '_', ' ')), 'no status'), coalesce(lower(replace(b, '_', ' ')), 'no status'));
    end if;
  end loop;
  return null;
end
$$;

create or replace function recipe.hand_over_persons(p_batch uuid, p_key text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object(
    'outgoing', coalesce(jsonb_agg(c.command -> 'outgoing') filter (where c.command_type = 'HAND_OVER_STEP' and jsonb_typeof(c.command -> 'outgoing') = 'string'), '[]'::jsonb),
    'incoming', coalesce(jsonb_agg(c.command -> 'incoming' -> 'id') filter (where c.command_type = 'HAND_OVER_STEP' and jsonb_typeof(c.command -> 'incoming' -> 'id') = 'string'), '[]'::jsonb),
    'approvers', coalesce(jsonb_agg(to_jsonb(c.actor_person::text)) filter (where c.command_type = 'HAND_OVER_STEP' and c.actor_person is not null), '[]'::jsonb)
                 || coalesce(jsonb_agg(c.command -> 'approval' -> 'approver' -> 'id') filter (where c.command_type = 'HAND_OVER_STEP' and jsonb_typeof(c.command -> 'approval' -> 'approver' -> 'id') = 'string'), '[]'::jsonb),
    'takers', coalesce(jsonb_agg(to_jsonb(c.actor_person::text)) filter (where c.command_type = 'TAKE_OVER_STEP' and c.actor_person is not null), '[]'::jsonb),
    'lastIncoming', (array_agg(c.command -> 'incoming' -> 'id' order by c.seq desc) filter (where c.command_type = 'HAND_OVER_STEP'))[1])
    from recipe.execution_command c
   where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and c.command_type in ('HAND_OVER_STEP', 'TAKE_OVER_STEP')
     and (p_before is null or c.seq < p_before)
     and jsonb_typeof(c.command -> 'step') = 'string'
     and (c.command ->> 'step') || '@' || recipe.ctx_key(coalesce(c.command -> 'context', '[]'::jsonb)) = p_key
$$;

-- PR-13, PR-49, INV-03 (0480, review finding 2): every person a step's hand-overs name, from its stored record (outgoing,
-- incoming, the supervisor who signed and QA who approved) and from the accepted hand-over and take-over rows on it
-- before row p_before (every row when NULL). A JSON array of person ids.
create function recipe.hand_over_involvement(p_batch uuid, p_inst jsonb, p_key text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select jsonb_agg(h -> f)
                     from jsonb_array_elements(case when jsonb_typeof(p_inst -> 'handOvers') = 'array' then p_inst -> 'handOvers' else '[]'::jsonb end) h
                    cross join unnest(array['outgoing', 'incoming', 'supervisor', 'qaApprover']) f
                    where jsonb_typeof(h -> f) = 'string'), '[]'::jsonb)
         || (q -> 'outgoing') || (q -> 'incoming') || (q -> 'takers') || (q -> 'approvers')
    from (select recipe.hand_over_persons(p_batch, p_key, p_before) as q) x
$$;

create or replace function recipe.hand_over_problem(p_batch uuid, p_old jsonb, p_new jsonb, p_kind text, p_accepted boolean, p_cmd jsonb, p_person text, p_seq bigint)
returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_done  boolean := p_kind = 'COMMAND' and p_accepted is true;
  v_type  text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_key   text;
  v_pkey  text;
  v_who   jsonb;
  v_inv   jsonb;
  v_ho    jsonb;
  v_ap    jsonb;
  v_n     integer;
  h0      jsonb;
  h1      jsonb;
  hl      jsonb;
  k       text;
  x       jsonb;
  y       jsonb;
  e       jsonb;
  v_in    jsonb := p_cmd -> 'incoming' -> 'id';
  v_role  text;
  v_held  text[];
begin
  if jsonb_typeof(p_old -> 'steps') is distinct from 'object' or jsonb_typeof(p_new -> 'steps') is distinct from 'object' then
    return null; -- 0300 refuses malformed steps
  end if;
  if p_kind = 'COMMAND' and jsonb_typeof(p_cmd -> 'step') = 'string' then
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(coalesce(p_cmd -> 'context', '[]'::jsonb));
  end if;
  v_who := to_jsonb(p_person);

  -- Every row: a step's hand-over record changes only by its own hand-over (one more) or take-over (marked taken over).
  for k, x in select s.key, s.value from jsonb_each(p_old -> 'steps') s order by s.key loop
    y := p_new -> 'steps' -> k;
    h0 := coalesce(x -> 'handOvers', '[]'::jsonb);
    h1 := coalesce(y -> 'handOvers', '[]'::jsonb);
    continue when h1 = h0 or y is null;
    if jsonb_typeof(h0) is distinct from 'array' or jsonb_typeof(h1) is distinct from 'array' then
      return format('stores a malformed hand-over record of step %s', k);
    end if;
    if v_type = 'HAND_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) + 1
       and (h1 - (jsonb_array_length(h1) - 1)) = h0 then
      continue;
    end if;
    if v_type = 'TAKE_OVER_STEP' and k = v_key and jsonb_array_length(h1) = jsonb_array_length(h0) and jsonb_array_length(h0) > 0
       and (h1 - (jsonb_array_length(h1) - 1)) = (h0 - (jsonb_array_length(h0) - 1))
       and not ((h0 -> -1) ? 'takenOverAt') and (h1 -> -1) ? 'takenOverAt' and ((h1 -> -1) - 'takenOverAt') = (h0 -> -1) then
      continue;
    end if;
    return format('changes the hand-over record of step %s; only that step''s own accepted hand-over adds one, and its take-over marks it taken over', k);
  end loop;
  for k, y in select s.key, s.value from jsonb_each(p_new -> 'steps') s where not ((p_old -> 'steps') ? s.key) order by s.key loop
    if y ? 'handOvers' then
      return format('brings in step instance %s with a hand-over record', k);
    end if;
  end loop;

  -- Every row: a STEP_HANDED_OVER exception is raised only by an accepted HAND_OVER_STEP, exactly one, at its step, by its person.
  v_n := 0;
  for k, e in select s.key, s.value from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) s
               where not coalesce((p_old -> 'exceptions') ? s.key, false) and s.value ->> 'type' = 'STEP_HANDED_OVER' order by s.key loop
    v_n := v_n + 1;
    if v_type is distinct from 'HAND_OVER_STEP' then
      return format('raises exception %s (STEP_HANDED_OVER); only an accepted hand-over raises one', k);
    end if;
    if e -> 'source' ->> 'stepKey' is distinct from v_key or e ->> 'raisedBy' is distinct from p_person then
      return format('raises exception %s (STEP_HANDED_OVER) at %s by %s; a hand-over raises it at its own step, by the supervisor who records it',
                    k, coalesce(e -> 'source' ->> 'stepKey', 'no step'), coalesce(e ->> 'raisedBy', 'nobody'));
    end if;
  end loop;
  if v_type = 'HAND_OVER_STEP' and v_n <> 1 then
    return format('raises %s STEP_HANDED_OVER exceptions; a hand-over raises exactly one, so it stands in the exception register', v_n);
  end if;

  if not v_done then
    return null;
  end if;

  -- A correction or an invalidation waits until the incoming performer has taken the step over; the outgoing performer
  -- does not correct the step they handed over (0480, review finding 4).
  if v_type in ('CORRECT_ENTRY', 'INVALIDATE_RESULT') and jsonb_typeof(p_cmd -> 'point') = 'string' then
    v_pkey := p_old -> 'points' -> (p_cmd ->> 'point') ->> 'stepKey';
    if p_old -> 'steps' -> v_pkey ->> 'status' = 'ATTEMPT_HANDED_OVER' then
      return format('changes data of step %s while it waits for the incoming performer of its hand-over', v_pkey);
    end if;
    if v_type = 'CORRECT_ENTRY' and v_pkey is not null
       and (recipe.hand_over_persons(p_batch, v_pkey, p_seq) -> 'outgoing') @> jsonb_build_array(v_who) then
      return format('is %s''s correction in step %s, which they handed over; the performer who took it over completes it', p_person, v_pkey);
    end if;
    return null;
  end if;
  if v_key is null then
    return null;
  end if;
  v_ho := recipe.hand_over_persons(p_batch, v_key, p_seq);

  -- A performer who handed the step over no longer acts in it.
  if v_type in ('RECORD_DATA', 'RECORD_ENTRY', 'SIGN_PERFORMED', 'VOID_ATTEMPT', 'START_STEP', 'RAISE_EXCEPTION') and (v_ho -> 'outgoing') @> jsonb_build_array(v_who) then
    return format('is %s''s act in step %s, which they handed over; the performer who took it over completes it', p_person, v_key);
  end if;

  -- INV-03, INV-31, PR-14: the verifier is none of the persons involved, from the rows and the hand-overs.
  if v_type = 'VERIFY' then
    if recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) @> jsonb_build_array(v_who)
       or (v_ho -> 'outgoing') @> jsonb_build_array(v_who) or (v_ho -> 'incoming') @> jsonb_build_array(v_who) or (v_ho -> 'takers') @> jsonb_build_array(v_who)
       or (v_ho -> 'approvers') @> jsonb_build_array(v_who) then
      return format('verifies step %s by %s, who performed, entered data in or corrected it, or handed it over, took it over, or signed or approved its hand-over; the verifier is always another person', v_key, p_person);
    end if;
    return null;
  end if;

  x := p_old -> 'steps' -> v_key;
  y := p_new -> 'steps' -> v_key;
  if v_type = 'TAKE_OVER_STEP' then
    if (v_ho -> 'lastIncoming') is distinct from v_who or (x -> 'handOvers' -> -1 -> 'incoming') is distinct from v_who then
      return format('takes step %s over by %s, whom its last hand-over does not name as the incoming performer', v_key, p_person);
    end if;
    if not coalesce((y -> 'performers') @> jsonb_build_array(v_who)
                    and (y -> 'performers') <@ (coalesce(x -> 'performers', '[]'::jsonb) || jsonb_build_array(v_who))
                    and (y - array['status', 'handOvers', 'performers']) = (x - array['status', 'handOvers', 'performers']), false) then
      return format('changes step %s otherwise than a take-over does (the incoming performer added to its performers, the hand-over marked taken over)', v_key);
    end if;
    return null;
  end if;
  if v_type is distinct from 'HAND_OVER_STEP' then
    return null;
  end if;

  if recipe.member_blank(p_cmd -> 'reason') then
    return 'has a blank reason';
  end if;
  v_inv := recipe.step_involvement(x) || recipe.recorded_involvement(p_batch, p_old -> 'points', v_key, p_seq) || (v_ho -> 'takers');
  if x ->> 'status' = 'ATTEMPT_HANDED_OVER' then
    -- Handed over again (0480): from the incoming performer who did not come.
    if (p_cmd -> 'outgoing') is distinct from (x -> 'handOvers' -> -1 -> 'incoming') or (p_cmd -> 'outgoing') is distinct from (v_ho -> 'lastIncoming') then
      return format('hands step %s, which waits for %s, over from %s; a step waiting for its incoming performer is handed over again from that person', v_key,
                    coalesce(x -> 'handOvers' -> -1 ->> 'incoming', 'nobody'), left(coalesce(p_cmd ->> 'outgoing', 'nobody'), 64));
    end if;
  elsif not recipe.is_person_id(p_cmd -> 'outgoing') or not (v_inv @> jsonb_build_array(p_cmd -> 'outgoing')) or (v_ho -> 'outgoing') @> jsonb_build_array(p_cmd -> 'outgoing') then
    return format('hands step %s over from %s, who is not a performer of it still on it', v_key, left(coalesce(p_cmd ->> 'outgoing', 'nobody'), 64));
  end if;
  if not recipe.is_person_id(v_in) or p_cmd -> 'incoming' ->> 'kind' is distinct from 'PERSON' or v_in = (p_cmd -> 'outgoing') or (v_ho -> 'outgoing') @> jsonb_build_array(v_in) then
    return format('hands step %s over to %s, who is not another person of this installation or handed the step over before', v_key, left(coalesce(v_in #>> '{}', 'nobody'), 64));
  end if;
  v_ap := p_cmd -> 'approval' -> 'approver' -> 'id';
  if v_who in (p_cmd -> 'outgoing', v_in) or v_ap in (p_cmd -> 'outgoing', v_in)
     or v_inv @> jsonb_build_array(v_who) or v_inv @> jsonb_build_array(v_ap) then
    return format('is signed or approved by a performer of step %s or a person its hand-over names; the supervisor and QA who approve a hand-over are neither', v_key);
  end if;
  -- 0480 (review finding 1): the incoming performer is active, can sign in, and holds the roles the command names, one
  -- of them the step's perform role; so the step never waits for a person who cannot take it over.
  v_held := recipe.person_engine_roles((v_in #>> '{}')::uuid);
  select recipe.step_node(pk.content, p_cmd ->> 'step') -> 'signatures' -> 'perform' ->> 'role' into v_role
    from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = p_batch;
  if cardinality(v_held) = 0
     or jsonb_typeof(p_cmd -> 'incoming' -> 'roles') is distinct from 'array'
     or exists (select 1 from jsonb_array_elements_text(p_cmd -> 'incoming' -> 'roles') r where not (r = any (v_held)))
     or (v_role is not null and not (v_role = any (v_held) and (p_cmd -> 'incoming' -> 'roles') ? v_role)) then
    return format('hands step %s over to %s, who is not an active person with an active account holding %s now (holds %s)', v_key, v_in #>> '{}',
                  coalesce('the step''s perform role ' || v_role, 'the roles the command names'), coalesce(nullif(array_to_string(v_held, ', '), ''), 'no engine role'));
  end if;
  hl := y -> 'handOvers' -> -1;
  if (y -> 'verificationRequired') is distinct from 'true'::jsonb
     or (y - array['status', 'handOvers', 'verificationRequired']) is distinct from (x - array['status', 'handOvers', 'verificationRequired'])
     or jsonb_typeof(hl) is distinct from 'object' or hl ? 'takenOverAt'
     or hl -> 'outgoing' is distinct from p_cmd -> 'outgoing' or hl -> 'incoming' is distinct from v_in
     or hl -> 'reason' is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason'))
     or hl -> 'supervisor' is distinct from v_who or hl -> 'supervisorSignature' is distinct from p_cmd -> 'signature' -> 'id'
     or hl -> 'qaApprover' is distinct from v_ap or hl -> 'qaSignature' is distinct from p_cmd -> 'approval' -> 'signature' -> 'id' then
    return format('leaves step %s otherwise than the hand-over the command records (the outgoing and incoming performers, the reason, the supervisor and QA with their signatures, the second person''s check required, nothing else changed)', v_key);
  end if;
  return null;
end
$$;

create or replace function recipe.exception_step_involvement(p_batch uuid, p_state jsonb, p_exception text, p_before bigint) returns jsonb
language sql stable set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce(jsonb_agg(distinct p.v order by p.v), '[]'::jsonb)
    from unnest(recipe.exception_raising_steps(p_batch, p_state, p_exception)) k (step_key)
   cross join lateral jsonb_array_elements(recipe.step_involvement(p_state -> 'steps' -> k.step_key)
                                           || recipe.recorded_involvement(p_batch, p_state -> 'points', k.step_key, p_before)
                                           || recipe.hand_over_involvement(p_batch, p_state -> 'steps' -> k.step_key, k.step_key, p_before)) p (v)
$$;

revoke all on function recipe.person_engine_roles(uuid), recipe.hand_over_involvement(uuid, jsonb, text, bigint) from public;

reset role;
