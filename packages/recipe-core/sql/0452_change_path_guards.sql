-- Recipe core, execution store (module C3): the change paths of a test run, part 3: what an accepted row of each may
-- store (Phase 3 slice 2, plan item 2; outline 5.2.2, 5.2.3; DI-24, DI-29, PR-12, PR-13, IN-06; INV-41; ADR 0012: the
-- rules hold when the application's own database credentials are used directly). 0450 catalogues the commands, 0451
-- checks their e-signatures and approvers; the database does not re-run the engine, so it checks here, from the stored
-- state before and after the row, the batch's MBR content and the row's command, what the engine's guards decide
-- (engine corrections.ts, steps.ts requestSkip, batch.ts abortBatch and cancelBatch):
--
--   REQUEST_SKIP       only a phase the MBR declares skippable (config.skippable true), never a hold point, a step of
--                      a block that clears, dispenses, charges in, reconciles yield, reprocesses or signs off (G-07,
--                      G-08, G-10, G-20, G-24, G-25), one that records a value not declared NON_CRITICAL (CRITICAL until
--                      classified, DI-07; the stricter reading of the engine's CPP/CQA rule), moves material, carries a
--                      yield checkpoint or an acceptance scheme, or records or computes a value another step reads; the
--                      instance is left SKIPPED with the skip record naming the requester, the approver and the
--                      approval's signature, and the reason as given;
--   VOID_ATTEMPT       only before a result exists: the data point the command names, if any, holds no result, and
--                      the row adds exactly one data point, the voided attempt (kind ABORTED, no value, valid), of the
--                      command's item and step instance, entered by the requester with the reason as given;
--   INVALIDATE_RESULT  a valid result, with the linked investigation and the assignable cause it concluded, neither
--                      blank; the result stays in the record, marked INVALIDATED with its invalidation record naming
--                      that investigation and cause (0303 holds the approval and that nothing else of it changes);
--   CORRECT_ENTRY      INV-41: a value that failed its limits becomes a passing one only with attached objective
--                      evidence and the approval of QA; that approval is the invalidation record (outline 5.2.3 (a));
--   ABORT_BATCH        from ISSUED, IN_PROGRESS, ON_HOLD or EXECUTION_COMPLETE to ABORTED, with a reason that is not
--                      blank and every item of the checklist confirmed, the abort record holding the reason, the
--                      checklist and the two approvers; nothing else of the record changes;
--   CANCEL_BATCH       only from ISSUED with no step started (every step instance PENDING, ENABLED or NOT_APPLICABLE),
--                      to CANCELLED, with a reason that is not blank; nothing else of the record changes.
-- And on every row, whatever its kind or source: the batch becomes ABORTED only by an accepted ABORT_BATCH and
-- CANCELLED only by an accepted CANCEL_BATCH, and a batch ABORTED or CANCELLED never leaves that status (a direct
-- write of the state cannot abort, cancel or revive a batch).
-- The exception each failing evaluation raised stays open until dispositioned whatever the path: 0270/0298
-- (recipe.check_exception_changes) already let only an accepted DISPOSITION_EXCEPTION change it.
--
-- recipe.command_shape (0335) also gains the members the engine added for these paths (engine types.ts): the
-- assignable cause of an invalidation and the checklist of an abort.
--
-- Messages: EBMR-EXE-172 (skip), 173 (void), 174 (invalidation), 175 (correction from fail to pass), 176 (abort),
-- 177 (cancellation), 178 (batch status). New functions are owned by ebmr_owner and private to the owner; the trigger
-- function is SECURITY DEFINER; every function pins its search_path with pg_temp last. Applied as a new migration
-- because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-05, DI-30: the shape of a command (0335), with the members of engine 1.5.0's change paths.
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
                               "CANCEL_BATCH"]';
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
  end;
  if f is null then
    return null;
  end if;
  return jsonb_build_object('t', 'object', 'of', case when left(p_type, 1) in ('A', 'E', 'I', 'O', 'U') then 'an ' else 'a ' end || p_type || ' command',
    'fields', f || jsonb_build_object('type', jsonb_build_object('t', 'text', 'enum', jsonb_build_array(p_type)), 'commandId', txt, 'actor', actor,
                                      'expectedVersion', '{"t": "int", "opt": true}'::jsonb));
end
$$;

-- Whether text member p of a command is missing or blank as the engine reads it (recipe.reason_is_blank, 0301).
create function recipe.member_blank(p jsonb) returns boolean
language sql immutable set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_typeof(p) is distinct from 'string' or recipe.reason_is_blank(p #>> '{}')
$$;

-- PR-13, PR-16, DI-07: why phase p_node of MBR content p_content may not be skipped; NULL when it may (header).
create function recipe.skip_problem(p_content jsonb, p_node jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_items text[];
  v_item  text;
begin
  if p_node is null then
    return 'the step is not a step of the batch''s MBR';
  end if;
  if p_node ->> 'kind' is distinct from 'phase' then
    return 'it is a QA hold point: release signatures are never skipped';
  end if;
  if (p_node -> 'config' -> 'skippable') is distinct from 'true'::jsonb then
    return 'the MBR does not declare it skippable';
  end if;
  if p_node -> 'block' ->> 'type' in ('G-07', 'G-08', 'G-10', 'G-20', 'G-24', 'G-25') then
    return format('it is a step of block %s: line clearance, dispensing, charge-in, reconciliation, reprocessing and sign-off steps are never skipped', p_node -> 'block' ->> 'type');
  end if;
  if exists (select 1 from unnest(array['consumes', 'produces', 'uses']) k
              where jsonb_typeof(p_node -> k) is distinct from 'array' or jsonb_array_length(p_node -> k) > 0)
     or (p_node ? 'yieldCheckpoint' and (p_node -> 'yieldCheckpoint') <> 'null'::jsonb)
     or (p_node ? 'acceptanceScheme' and (p_node -> 'acceptanceScheme') <> 'null'::jsonb) then
    return 'it moves material or carries a yield or acceptance check';
  end if;
  v_items := array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'records') = 'array' then p_node -> 'records' else '[]' end));
  foreach v_item in array v_items loop
    if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'parameters') = 'array' then p_content -> 'parameters' else '[]' end) p
                    where p ->> 'id' = v_item and p ->> 'criticality' = 'NON_CRITICAL') then
      return format('it records %s, which is not declared NON_CRITICAL: CPP and CQA inputs are never skipped', v_item);
    end if;
  end loop;
  v_items := v_items || array(select jsonb_array_elements_text(case when jsonb_typeof(p_node -> 'computes') = 'array' then p_node -> 'computes' else '[]' end));
  foreach v_item in array v_items loop
    if jsonb_path_exists(p_content -> 'procedure', 'strict $.** ? (@.reads.type() == "array" && exists (@.reads[*] ? (@ == $item)))', jsonb_build_object('item', v_item)) then
      return format('it writes %s, which another step reads', v_item);
    end if;
  end loop;
  return null;
end
$$;

-- DI-24, DI-29, PR-12, PR-13, IN-06, INV-41: why state p_new, stored by a row of kind p_kind with command p_cmd
-- (accepted: p_accepted) of person p_person after state p_old, takes a change path otherwise than the engine does;
-- NULL when it does not (header). p_content is the batch's MBR content.
create function recipe.change_path_problem(p_old jsonb, p_new jsonb, p_kind text, p_cmd jsonb, p_accepted boolean, p_person text, p_content jsonb)
returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_type   text := case when p_kind = 'COMMAND' and p_accepted is true then p_cmd ->> 'type' end;
  v_from   text := p_old ->> 'status';
  v_to     text := p_new ->> 'status';
  v_key    text;
  v_node   jsonb;
  v_prob   text;
  x        jsonb;
  y        jsonb;
  n        jsonb;
  v_new    text[];
  m        text;
begin
  -- The batch status (every row).
  if v_from in ('ABORTED', 'CANCELLED') and v_to is distinct from v_from then
    return format('takes a batch that is %s to %s; an aborted or cancelled batch stays so', v_from, coalesce(v_to, 'no status'));
  end if;
  if v_to = 'ABORTED' and v_from is distinct from 'ABORTED' and v_type is distinct from 'ABORT_BATCH' then
    return 'aborts the batch; only an accepted ABORT_BATCH with its two approvals does';
  end if;
  if v_to = 'CANCELLED' and v_from is distinct from 'CANCELLED' and v_type is distinct from 'CANCEL_BATCH' then
    return 'cancels the batch; only an accepted CANCEL_BATCH does';
  end if;
  if v_type is null or v_type not in ('REQUEST_SKIP', 'VOID_ATTEMPT', 'INVALIDATE_RESULT', 'CORRECT_ENTRY', 'ABORT_BATCH', 'CANCEL_BATCH') then
    return null;
  end if;

  if v_type in ('ABORT_BATCH', 'CANCEL_BATCH') then
    if v_type = 'ABORT_BATCH' and (v_from is null or v_from not in ('ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE')) then
      return format('[176] aborts a batch that is %s; a batch is aborted while issued, in progress, on hold or complete', coalesce(v_from, 'without a status'));
    end if;
    if v_type = 'CANCEL_BATCH' then
      if v_from is distinct from 'ISSUED' then
        return format('[177] cancels a batch that is %s; only an issued batch where nothing has started is cancelled, any other is aborted', coalesce(v_from, 'without a status'));
      end if;
      select i.key into v_key from jsonb_each(case when jsonb_typeof(p_old -> 'steps') = 'object' then p_old -> 'steps' else '{}' end) i
       where coalesce(i.value ->> 'status', '') not in ('PENDING', 'ENABLED', 'NOT_APPLICABLE') order by i.key limit 1;
      if v_key is not null then
        return format('[177] cancels a batch whose step %s has started; only a batch where nothing has started is cancelled, any other is aborted', v_key);
      end if;
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return format('[%s] has a blank reason', case v_type when 'ABORT_BATCH' then '176' else '177' end);
    end if;
    if v_to is distinct from (case v_type when 'ABORT_BATCH' then 'ABORTED' else 'CANCELLED' end) then
      return format('[%s] leaves the batch %s', case v_type when 'ABORT_BATCH' then '176' else '177' end, coalesce(v_to, 'without a status'));
    end if;
    foreach m in array array['steps', 'points', 'entries', 'containers', 'derived', 'decisions', 'stages', 'holds', 'subLots'] loop
      if (p_new -> m) is distinct from (p_old -> m) then
        return format('[%s] changes the %s of the record; an abort or a cancellation changes only the batch status', case v_type when 'ABORT_BATCH' then '176' else '177' end, m);
      end if;
    end loop;
    if v_type = 'ABORT_BATCH' then
      if exists (select 1 from unnest(array['outputsHeld', 'equipmentSetDirty', 'materialsSecured']) k where (p_cmd -> 'checklist' -> k) is distinct from 'true'::jsonb) then
        return '[176] does not confirm every item of the abort checklist (outputs held for QA, equipment set dirty, materials secured)';
      end if;
      x := p_new -> 'abort';
      if jsonb_typeof(x) is distinct from 'object' or (x -> 'reason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason'))
         or (x -> 'checklist') is distinct from (p_cmd -> 'checklist')
         or jsonb_typeof(x -> 'approvals') is distinct from 'array'
         or (select coalesce(array_agg(a order by a), '{}') from jsonb_array_elements_text(x -> 'approvals') a)
            is distinct from (select coalesce(array_agg(a -> 'approver' ->> 'id' order by a -> 'approver' ->> 'id'), '{}') from jsonb_array_elements(p_cmd -> 'approvals') a) then
        return '[176] stores an abort record that is not the command''s reason, checklist and approvers';
      end if;
    end if;
    return null;
  end if;

  if v_type = 'REQUEST_SKIP' then
    v_node := recipe.step_node(p_content, p_cmd ->> 'step');
    v_prob := recipe.skip_problem(p_content, v_node);
    if v_prob is not null then
      return format('[172] skips step %s, which cannot be skipped: %s', coalesce(p_cmd ->> 'step', 'null'), v_prob);
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[172] has a blank reason';
    end if;
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context');
    y := p_new -> 'steps' -> v_key;
    x := y -> 'skip';
    if y ->> 'status' is distinct from 'SKIPPED' or jsonb_typeof(x) is distinct from 'object'
       or x ->> 'requestedBy' is distinct from p_person or x ->> 'approvedBy' is distinct from p_cmd -> 'approval' -> 'approver' ->> 'id'
       or x ->> 'signature' is distinct from p_cmd -> 'approval' -> 'signature' ->> 'id'
       or (x -> 'reason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason')) then
      return format('[172] leaves step %s without the skip the command records (SKIPPED, requested by its person, approved and signed by its approver, with its reason)', v_key);
    end if;
    return null;
  end if;

  if v_type = 'VOID_ATTEMPT' then
    if p_cmd ? 'point' then
      x := p_old -> 'points' -> (p_cmd ->> 'point');
      if x is null or x ->> 'kind' is distinct from 'ABORTED' then
        return format('[173] voids %s, which %s; once a result exists it is never voided: correct an entry error or invalidate it with an investigation',
                      coalesce(p_cmd ->> 'point', 'null'), case when x is null then 'is not a data point of the record' else 'holds a result' end);
      end if;
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[173] has a blank reason';
    end if;
    v_key := (p_cmd ->> 'step') || '@' || recipe.ctx_key(p_cmd -> 'context');
    v_new := array(select k from jsonb_object_keys(case when jsonb_typeof(p_new -> 'points') = 'object' then p_new -> 'points' else '{}' end) k
                    where not ((p_old -> 'points') ? k) order by k);
    n := p_new -> 'points' -> v_new[1];
    if cardinality(v_new) <> 1 or n ->> 'kind' is distinct from 'ABORTED' or n ? 'value' or n ->> 'status' is distinct from 'VALID'
       or n ->> 'item' is distinct from p_cmd ->> 'item' or n ->> 'stepKey' is distinct from v_key
       or n ->> 'enteredBy' is distinct from p_person or (n -> 'voidReason') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'reason')) then
      return format('[173] adds %s data point(s) where a void adds exactly one: the voided attempt of %s in %s (kind ABORTED, no value), entered by its person with the reason given',
                    cardinality(v_new), coalesce(p_cmd ->> 'item', 'null'), v_key);
    end if;
    return null;
  end if;

  if v_type = 'INVALIDATE_RESULT' then
    if recipe.member_blank(p_cmd -> 'investigationRef') or recipe.member_blank(p_cmd -> 'assignableCause') then
      return '[174] names no investigation or no assignable cause; a result is invalidated only with a linked OOS or deviation investigation that concluded an assignable cause';
    end if;
    if recipe.member_blank(p_cmd -> 'reason') then
      return '[174] has a blank reason';
    end if;
    x := p_old -> 'points' -> (p_cmd ->> 'point');
    y := p_new -> 'points' -> (p_cmd ->> 'point');
    if x ->> 'kind' is distinct from 'VALUE' or x ->> 'status' is distinct from 'VALID' then
      return format('[174] invalidates %s, which is not a valid result', coalesce(p_cmd ->> 'point', 'null'));
    end if;
    if y ->> 'status' is distinct from 'INVALIDATED'
       or (y -> 'invalidation' -> 'investigationRef') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'investigationRef'))
       or (y -> 'invalidation' -> 'assignableCause') is distinct from to_jsonb(recipe.js_trim(p_cmd ->> 'assignableCause')) then
      return format('[174] does not keep %s in the record as invalidated with the investigation and the assignable cause the command gives', p_cmd ->> 'point');
    end if;
    return null;
  end if;

  -- CORRECT_ENTRY: INV-41.
  x := p_old -> 'points' -> (p_cmd ->> 'point');
  n := p_new -> 'points' -> (p_new -> 'points' -> (p_cmd ->> 'point') ->> 'supersededBy');
  if (x -> 'failed') = 'true'::jsonb and (n -> 'failed') is distinct from 'true'::jsonb then
    if jsonb_typeof(p_cmd -> 'evidence') is distinct from 'object' then
      return format('[175] makes %s, which failed its limits, pass without objective evidence of the true value; without it only an invalidation with an investigation applies', p_cmd ->> 'point');
    end if;
    if jsonb_typeof(p_cmd -> 'approval') is distinct from 'object'
       or not ('QA' = any (recipe.signer_engine_roles(nullif(p_cmd -> 'approval' -> 'signature' ->> 'id', '')::uuid))) then
      return format('[175] makes %s, which failed its limits, pass without the approval of QA, which is its invalidation record', p_cmd ->> 'point');
    end if;
  end if;
  return null;
exception when invalid_text_representation then
  return 'names an approval signature that is not an e-signature of this system';
end
$$;

-- The rules of recipe.change_path_problem on every row (header). EBMR-EXE-172..178. Raises; returns nothing.
create function recipe.execution_change_path_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text := '178';
begin
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  select pk.content into v_content from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = new.batch_id;
  v_problem := recipe.change_path_problem(old.state, new.state, r.kind, r.command, r.accepted, r.actor_person::text, v_content);
  if v_problem is not null then
    if v_problem ~ '^\[1[0-9]{2}\] ' then
      v_code := substr(v_problem, 2, 3);
      v_problem := substr(v_problem, 7);
    end if;
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: it %s. A skip, a void, an invalidation, a correction from fail to pass, an abort and a cancellation are recorded only on the conditions the engine sets, and nothing else aborts, cancels or revives a batch',
                       case when r.kind = 'PREPARE' then 'preparation' when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem)
                || case v_code
                     when '172' then ' (PR-13, DI-07, DI-34). [EBMR-EXE-172]'
                     when '173' then ' (DI-24, DI-29). [EBMR-EXE-173]'
                     when '174' then ' (DI-29, INV-41). [EBMR-EXE-174]'
                     when '175' then ' (INV-41, PR-12, DI-24). [EBMR-EXE-175]'
                     when '176' then ' (DI-34, DI-35). [EBMR-EXE-176]'
                     when '177' then ' (PR-10, DI-34). [EBMR-EXE-177]'
                     else ' (DI-34, DI-24). [EBMR-EXE-178]'
                   end;
  end if;
  return null;
end
$$;

create trigger zzn_execution_change_paths after update on recipe.execution_state
  for each row execute function recipe.execution_change_path_check();

revoke all on function recipe.member_blank(jsonb), recipe.skip_problem(jsonb, jsonb),
                       recipe.change_path_problem(jsonb, jsonb, text, jsonb, boolean, text, jsonb), recipe.execution_change_path_check() from public;

reset role;
