-- Recipe core, execution store (module C3): a row records the engine command of its type with exactly the members that
-- type declares, each of the JSON type it declares, and evidence of the shape the server records; a test batch pins
-- exactly the engine policy's members (Phase 2 exit review F12, the round-6 verification; DI-05, DI-30; ADR 0012:
-- the rules hold when the application's own database credentials are used directly).
--
-- Correction of 0332's header and of decision F12.4, stated here because applied migrations are never edited. 0332 says
-- that, a refused row never holding a member no block version declares, "a real identifier cannot sit unread in a refused
-- row's command (DI-05; tablets 0370 reads the members an entry names)". That did not hold. 0332 reads only the entry of
-- a RECORD_ENTRY and the start data of a START_STEP; recipe.block_schema_unknown_member walks a value only where its JSON
-- type is the one the schema declares, so a text or a list in the place of an object passed; tablets 0370 reads only the
-- container, batch-number and lot-id members of an entry; and nothing read the command's other members, the members of
-- a preparation's or an issue's command, or the evidence stored with a row. The engine's decodeCommand keeps a member it
-- does not know and the engine ignores it, so the release gate's replay (REPLAY-GATE.1) reproduces such a row exactly
-- and never flags it either. Through the application role the round-6 verification stored in a test run's record, each
-- 'ok' with no violation reported, the real-format lot number L2409-0017:
--   A. as a member of the command of an accepted line clearance ({..., lotNumber});
--   C. as a member of the evidence of that row ({lotNumber});
--   D. in an entry carried by an accepted START_STEP, which takes no entry;
--   E. in a refused clearance answered NO: a member at the top of its command, its answers as a text or as a list of
--      lists, and start data on its RECORD_ENTRY;
--   F. in a refused START_STEP: its start data as a text or as a list, or an entry carried by it.
-- The same hole, read for this migration in every member the application can write into a row (the probes of
-- apps/tablets-server/test/execution/db-guards-row-shape.test.ts, written through the application role, were each stored
-- 'ok' before this migration; packages/recipe-core/test/execution/entry-data-sql.test.ts, round 7, reads the rest):
--   * every command type: a member of its own at the top, in its actor, in a frame of its context, in its occurredAt, in
--     a signature or an approval, in a value or a source of a value, in a correction's evidence; a member only another
--     command type declares; a member of another JSON type (a list where a text is declared, a text where an object is);
--   * a preparation for a signature (kind PREPARE): a member of its own at the top or in its target, a meaning that is
--     no signature meaning of the kernel;
--   * a sweep (kind SWEEP): any member besides its type;
--   * an issue (kind ISSUE): a member of its own in the issue request (recipe.batch_execution.issue_request is the same
--     value), in an input of the batch header, in the issuer; and in the engine policy the batch pins
--     (recipe.batch_execution.policy, which recipe.issue_execution checks only against its own hash), a member of its
--     own or a role that is no engine role;
--   * the command id of a row (recipe.execution_command.command_id, and the command's commandId), any text;
--   * the signature a refused row carries (the dry run's placeholder, read by nothing): any id, meaning or signer;
--   * the evidence: any member, and in the members the server writes any value: a lot stated otherwise than its entry
--     names it, a manual record of another room or balance, a scale that is no test device, readings on a weighing keyed
--     by hand, a scanned label other than the container charged, a signature other than the one applied, an idempotency
--     key that is no UUID, an issue's package other than the batch's.
--
-- What changed (recipe.execution_command, constraint trigger zz_execution_row_shape, after insert, not deferred: after
-- every check made before a row is inserted and after the attribution check zz_execution_attribution (INV-40), before the
-- state the row writes is checked; recipe.batch_execution, trigger ad_execution_policy_shape; EBMR-EXE-126):
--   * recipe.command_shape: the members of every engine command type (engine/types.ts Command, the 21 types; a test
--     keeps the member names equal to the TypeScript at compile time and compares every command of the engine's own runs
--     with it), of a preparation ({type PREPARE, target {type, step, context}, actor, meaning}), of a sweep ({type SWEEP})
--     and of an issue ({type ISSUE, request: the engine's IssueRequest}), each member's JSON type, the enumerations the
--     engine types fix (actor kind, time trust, severity, hold type, outcome, value kinds, source modes, purpose), and
--     the codec's microsecond form ({"$u": digits});
--   * recipe.command_member_problem: reads a value against such a shape: no member the shape does not declare, at any
--     depth; every member it requires; each of its JSON type. An entry (RECORD_ENTRY) and start data (START_STEP) are an
--     object; on an accepted row 0332 holds them to their block version's schema; on a refused row each member a block
--     version's schema declares has the JSON type that schema declares wherever it is an object, a list or a map, and
--     a single value (text, number, true or false) wherever the schema declares one
--     (recipe.block_schema_container_problem), so 0332's walk for members no block declares reaches every leaf. A
--     single value of another kind than declared (a weight sent as a number) stays recordable on a refused row, as 0332
--     and decision F12.4 decided: it carries no member;
--   * recipe.execution_row_problem: the shape of the row's command for its kind and type; its command id as the server
--     gives it (<uuid>, ESIG:<uuid>, ESIG-DRY:<uuid>, PREPARE:<uuid>, SWEEP:<uuid>, ISSUE:<batch id>); every signature
--     of a command (its own and an approval's) with a signature id or the dry run's placeholder, a meaning of the
--     kernel's catalogue (esig.meaning_type) and the person of the command (or of the approval) as its signer; the
--     meaning a preparation is made for a meaning of that catalogue; and the evidence (recipe.row_evidence_problem);
--   * recipe.row_evidence_problem: the evidence is an object with only the members the server records for the row's
--     kind, command type and entry kind (apps/tablets-server features/execution: intents.ts, signable.ts, index.ts), each
--     of the shape the server writes and bound to the row: idempotencyKey (a UUID: the request's key, which the server
--     requires to be one); an issue's packageHash (the batch's package); a value keyed by hand's unattestedScan {code,
--     recordedAs MANUAL}; a weighing's readings or namedReadings (only with an entry captured from a device, never both;
--     each {purpose TARE or GROSS, readingId UUID, deviceCode a test device label, value, unit, raw, sourceTimeUs digits,
--     trust}; tablets 0520 and 0590 bind them to the stored readings), manual (only with an entry keyed by hand; {room:
--     the row's room, balance: the entry's, declaredBalance: the entry's or null, scales: [{deviceCode a test device
--     label, status, lastHeartbeatUs}]}) and lot (exactly {code, material, status} of the lot its entry names); a
--     container charge's scanned label (the container its entry names); an accepted signed command's signatureId (the
--     signature its command applies) and a refused one's {signing: 'refused before signing', meaning: its signature's};
--     a preparation and a sweep record none. The evidence of an entry of a kind no block version records is not read:
--     0332 refuses that row whatever its verdict, in its own words;
--   * recipe.engine_policy_problem (trigger ad_execution_policy_shape on recipe.batch_execution, before insert or update
--     of policy, after 0334's ac_execution_witness_window): the pinned policy is exactly the engine's EnginePolicy (three
--     switches, five role lists, the witness window), every role in it an engine role (recipe.engine_role_permission).
--
-- Not decided by the database, stated so it is not over-read (decision F12.5, which lists the members): a member a type
-- declares as free text holds what was entered or sent, so a text in the format of a real identifier can still sit
-- there: in an accepted row, the reasons, descriptions, justifications, comments, deviation references, TEXT and
-- CATEGORY values a person typed; in a refused row also what was sent and refused (a check id or a step key the engine
-- did not know, round-6 verification probe H); a scanned code the terminal reports (unattestedScan.code). The sandbox's
-- identifier rule applies to the members that are identifiers (tablets 0370, 0380, 0390: batch numbers, lots,
-- containers; here: device codes of the evidence). What the engine writes into the state and the events (a member of
-- its own on a step instance or an event) and the signable content a writer stores stay with the release gate's replay
-- (REPLAY-GATE.1).
--
-- New functions are owned by ebmr_owner and private to the owner; the trigger functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last. Applied as a new migration because applied migrations are checksummed
-- and never edited.

set local role ebmr_owner;

-- DI-05, DI-30 (F12, round-6 verification): the shape of the command of a row of kind p_kind (COMMAND, PREPARE, SWEEP,
-- ISSUE) and, for a COMMAND row, command type p_type: {t: object, of: what it is, fields: {member: shape}} where a shape
-- is {t: text [enum] [pattern] | int | bool | micros | object | list (items) | map (values) | union (tag, variants) |
-- entry | startData} with opt (the member may be left out) and null (it may be JSON null). NULL for a kind or command
-- type the database does not know.
create function recipe.command_shape(p_kind text, p_type text) returns jsonb
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
    when 'INVALIDATE_RESULT' then jsonb_build_object('point', txt, 'investigationRef', txt, 'reason', txt, 'approval', approval)
    when 'ABORT_BATCH' then jsonb_build_object('reason', txt, 'approvals', jsonb_build_object('t', 'list', 'items', approval))
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

-- DI-05, DI-30 (F12, round-6 verification): why value p_value of a refused row's entry or start data does not have, at
-- path p_path, the JSON type block schema p_schema declares where it declares an object, a list or a map, or is no
-- single value where it declares one; NULL when it has. Members the schema does not declare are not read here (0332
-- refuses them); single values of another kind than declared are kept (header).
create function recipe.block_schema_container_problem(p_schema jsonb, p_value jsonb, p_path text) returns text
language plpgsql immutable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := jsonb_typeof(p_value);
  v_problem text;
  k         text;
  v         jsonb;
  n         bigint;
begin
  case p_schema ->> 'type'
    when 'object' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      for k, v in select f.key, f.value from jsonb_each(p_value) f where coalesce((p_schema -> 'fields') ? f.key, false) order by f.key collate "C" loop
        v_problem := recipe.block_schema_container_problem(p_schema -> 'fields' -> k, v, p_path || '.' || k);
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    when 'array' then
      if v_kind is distinct from 'array' then
        return p_path || ' must be a list';
      end if;
      for v, n in select a.v, a.i from jsonb_array_elements(p_value) with ordinality a (v, i) order by a.i loop
        v_problem := recipe.block_schema_container_problem(p_schema -> 'items', v, p_path || '[' || (n - 1) || ']');
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    when 'record' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      for k, v in select f.key, f.value from jsonb_each(p_value) f order by f.key collate "C" loop
        v_problem := recipe.block_schema_container_problem(p_schema -> 'values', v, p_path || '.' || k);
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    else
      if v_kind in ('object', 'array') then
        return p_path || ' must be a single value (a text, a number, true or false), not ' || case when v_kind = 'object' then 'an object' else 'a list' end;
      end if;
  end case;
  return null;
end
$$;

-- DI-05, DI-30 (F12, round-6 verification): the first problem of value p_value against command shape p_shape (above)
-- at path p_path, or NULL; p_refused: the row is refused (an entry or start data is then read with
-- recipe.block_schema_container_problem against the schemas of the block versions that record it; on an accepted row
-- 0332 holds it to its step's block version).
create function recipe.command_member_problem(p_shape jsonb, p_value jsonb, p_path text, p_refused boolean) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := jsonb_typeof(p_value);
  v_num     numeric;
  v_problem text;
  k         text;
  v         jsonb;
  s         jsonb;
  n         bigint;
begin
  if v_kind = 'null' and (p_shape -> 'null') = 'true'::jsonb then
    return null;
  end if;
  case p_shape ->> 't'
    when 'text' then
      if v_kind is distinct from 'string' then
        return p_path || ' must be a text';
      end if;
      if jsonb_typeof(p_shape -> 'enum') = 'array' and not ((p_shape -> 'enum') @> jsonb_build_array(p_value)) then
        return p_path || ' must be one of ' || (select string_agg(x.e #>> '{}', ', ' order by x.i) from jsonb_array_elements(p_shape -> 'enum') with ordinality x (e, i));
      end if;
      if jsonb_typeof(p_shape -> 'pattern') = 'string' and (p_value #>> '{}') !~ (p_shape ->> 'pattern') then
        return p_path || ' has an invalid format';
      end if;
    when 'int' then
      if v_kind = 'number' then
        v_num := (p_value #>> '{}')::numeric;
      end if;
      if v_kind is distinct from 'number' or v_num <> trunc(v_num) or abs(v_num) > 9007199254740991 then
        return p_path || ' must be a whole number';
      end if;
    when 'bool' then
      if v_kind is distinct from 'boolean' then
        return p_path || ' must be true or false';
      end if;
    when 'micros' then
      -- The codec's form of a bigint (engine codec.ts): exactly {"$u": "<digits>"}.
      if v_kind is distinct from 'object' then
        return p_path || ' must be a microsecond count ({"$u": "<digits>"})';
      end if;
      if (select count(*) from jsonb_object_keys(p_value)) <> 1 or jsonb_typeof(p_value -> '$u') is distinct from 'string'
         or coalesce((p_value ->> '$u') !~ '^-?(0|[1-9][0-9]*)$', true) then
        return p_path || ' must be a microsecond count ({"$u": "<digits>"})';
      end if;
    when 'object' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      select min(x collate "C") into k from jsonb_object_keys(p_value) x where not coalesce((p_shape -> 'fields') ? x, false);
      if k is not null then
        return format('%s.%s is a member %s does not declare', p_path, k, coalesce(p_shape ->> 'of', p_path));
      end if;
      for k, s in select f.key, f.value from jsonb_each(p_shape -> 'fields') f order by f.key collate "C" loop
        if not (p_value ? k) then
          if (s -> 'opt') is distinct from 'true'::jsonb then
            return p_path || '.' || k || ' is missing';
          end if;
        else
          v_problem := recipe.command_member_problem(s, p_value -> k, p_path || '.' || k, p_refused);
          if v_problem is not null then
            return v_problem;
          end if;
        end if;
      end loop;
    when 'list' then
      if v_kind is distinct from 'array' then
        return p_path || ' must be a list';
      end if;
      for v, n in select a.v, a.i from jsonb_array_elements(p_value) with ordinality a (v, i) order by a.i loop
        v_problem := recipe.command_member_problem(p_shape -> 'items', v, p_path || '[' || (n - 1) || ']', p_refused);
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    when 'map' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      for k, v in select f.key, f.value from jsonb_each(p_value) f order by f.key collate "C" loop
        v_problem := recipe.command_member_problem(p_shape -> 'values', v, p_path || '.' || k, p_refused);
        if v_problem is not null then
          return v_problem;
        end if;
      end loop;
    when 'union' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      k := case when jsonb_typeof(p_value -> (p_shape ->> 'tag')) = 'string' then p_value ->> (p_shape ->> 'tag') end;
      if k is null or not ((p_shape -> 'variants') ? k) then
        return format('%s.%s must be one of %s', p_path, p_shape ->> 'tag', (select string_agg(x, ', ' order by x collate "C") from jsonb_object_keys(p_shape -> 'variants') x));
      end if;
      return recipe.command_member_problem(p_shape -> 'variants' -> k, p_value, p_path, p_refused);
    when 'entry', 'startData' then
      if v_kind is distinct from 'object' then
        return p_path || ' must be an object';
      end if;
      if p_refused then
        -- An entry naming no kind, or a kind no block version records, is 0332's to refuse.
        v_problem := null;
        for s in select x.schema from recipe.block_data_schema x
                  where x.part = case when p_shape ->> 't' = 'entry' then 'ENTRY' else 'START' end
                    and x.entry_kind = case when p_shape ->> 't' = 'entry' then p_value ->> 'kind' else 'START_DATA' end
                  order by x.block_type, x.block_version loop
          v_problem := recipe.block_schema_container_problem(s, case when p_shape ->> 't' = 'entry' then p_value - 'kind' else p_value end, p_path);
          exit when v_problem is null;
        end loop;
        return v_problem;
      end if;
    else
      return p_path || ' has a shape the database does not read (' || coalesce(p_shape ->> 't', 'none') || ')';
  end case;
  return null;
end
$$;

-- DI-05, DI-30, PR-18, PR-20, DI-31, DI-32 (F12, round-6 verification): why evidence p_evidence is not what the server
-- records with a row of kind p_kind, command p_command (accepted: p_accepted), room p_room, of a batch of package
-- p_package_hash in an installation of kind p_installation (the batch's: SANDBOX, 0200); NULL when it is (header).
create function recipe.row_evidence_problem(p_kind text, p_command jsonb, p_accepted boolean, p_evidence jsonb, p_room text, p_package_hash text,
                                            p_installation text) returns text
language plpgsql stable set search_path = pg_catalog, recipe, sandbox, pg_temp as $$
declare
  uuid      constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  reading   constant jsonb := '{"t": "list", "items": {"t": "object", "fields": {"purpose": {"t": "text", "enum": ["TARE", "GROSS"]},
                                "readingId": {"t": "text", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}, "deviceCode": {"t": "text"},
                                "value": {"t": "text"}, "unit": {"t": "text"}, "raw": {"t": "text", "null": true},
                                "sourceTimeUs": {"t": "text", "pattern": "^[0-9]{1,20}$", "null": true}, "trust": {"t": "text", "null": true}}}}';
  manual    constant jsonb := '{"t": "object", "fields": {"room": {"t": "text"}, "balance": {"t": "text"}, "declaredBalance": {"t": "text", "null": true},
                                "scales": {"t": "list", "items": {"t": "object", "fields": {"deviceCode": {"t": "text"},
                                "status": {"t": "text", "enum": ["ONLINE", "OFFLINE", "UNKNOWN"]}, "lastHeartbeatUs": {"t": "text", "pattern": "^[0-9]{1,20}$", "null": true}}}}}}';
  scan      constant jsonb := '{"t": "object", "fields": {"code": {"t": "text"}, "recordedAs": {"t": "text", "enum": ["MANUAL"]}}}';
  v_type    text := case when jsonb_typeof(p_command) = 'object' then p_command ->> 'type' end;
  v_entry   jsonb := case when p_kind = 'COMMAND' and v_type = 'RECORD_ENTRY' and jsonb_typeof(p_command -> 'entry') = 'object' then p_command -> 'entry' end;
  v_ekind   text := v_entry ->> 'kind';
  v_signed  boolean := p_kind = 'COMMAND' and v_type in ('SIGN_PERFORMED', 'VERIFY', 'DISPOSITION_HOLD_POINT', 'SIGN_OFF_STAGE', 'DISPOSITION_EXCEPTION');
  v_allowed text[];
  v_what    text;
  v_problem text;
  k         text;
  e         jsonb;
  n         bigint;
begin
  if jsonb_typeof(p_evidence) is distinct from 'object' then
    return 'evidence must be an object';
  end if;
  -- An entry of a kind no block version records is 0332's to refuse (whatever the row's verdict), with its own words.
  if v_entry is not null and not exists (select 1 from recipe.block_data_schema s where s.part = 'ENTRY' and s.entry_kind = v_ekind) then
    return null;
  end if;
  v_what := case when p_kind = 'PREPARE' then 'a preparation for a signature' when p_kind = 'SWEEP' then 'a sweep' when p_kind = 'ISSUE' then 'an issue'
                 when v_entry is not null then format('a RECORD_ENTRY command of a %s entry', coalesce(v_ekind, 'nameless'))
                 else format('a %s command', coalesce(v_type, 'nameless')) end;
  v_allowed := case
    when p_kind in ('PREPARE', 'SWEEP') then '{}'::text[]
    when p_kind = 'ISSUE' then array['packageHash']
    when p_kind is distinct from 'COMMAND' then '{}'::text[]
    when v_type = 'RECORD_DATA' then array['idempotencyKey', 'unattestedScan']
    when v_ekind = 'CONTAINER_WEIGHING' then array['idempotencyKey', 'readings', 'namedReadings', 'manual', 'lot']
    when v_ekind = 'OUTPUT_CONTAINER' then array['idempotencyKey', 'readings', 'namedReadings', 'manual']
    when v_ekind = 'CHARGE_CONTAINER' then array['idempotencyKey', 'scanned']
    when v_signed and p_accepted is true then array['idempotencyKey', 'signatureId']
    when v_signed then array['idempotencyKey', 'signing', 'meaning']
    else array['idempotencyKey'] end;
  select min(x collate "C") into k from jsonb_object_keys(p_evidence) x where not (x = any (v_allowed));
  if k is not null then
    return format('evidence.%s is a member the server does not record with %s', k, v_what);
  end if;
  if p_evidence ? 'idempotencyKey' and (jsonb_typeof(p_evidence -> 'idempotencyKey') is distinct from 'string' or (p_evidence ->> 'idempotencyKey') !~ uuid) then
    return 'evidence.idempotencyKey must be the idempotency key of the request (a UUID)';
  end if;
  if p_evidence ? 'packageHash' and (p_evidence -> 'packageHash') is distinct from to_jsonb(p_package_hash) then
    return 'evidence.packageHash must be the package the batch is issued from';
  end if;
  if p_evidence ? 'unattestedScan' then
    if p_command -> 'source' ->> 'mode' is distinct from 'MANUAL' then
      return 'evidence.unattestedScan is recorded only with a value keyed by hand';
    end if;
    v_problem := recipe.command_member_problem(scan, p_evidence -> 'unattestedScan', 'evidence.unattestedScan', false);
    if v_problem is not null then
      return v_problem;
    end if;
  end if;
  if p_evidence ? 'readings' and p_evidence ? 'namedReadings' then
    return 'evidence names its readings both as used (readings) and as not used (namedReadings)';
  end if;
  foreach k in array array['readings', 'namedReadings'] loop
    if p_evidence ? k then
      if v_entry ->> 'source' is distinct from 'DEVICE' then
        return format('evidence.%s is recorded only with an entry captured from a device', k);
      end if;
      v_problem := recipe.command_member_problem(reading, p_evidence -> k, 'evidence.' || k, false);
      if v_problem is not null then
        return v_problem;
      end if;
      for e, n in select a.v, a.i from jsonb_array_elements(p_evidence -> k) with ordinality a (v, i) order by a.i loop
        v_problem := sandbox.identifier_problem_for(p_installation, 'DEVICE_LABEL', e ->> 'deviceCode');
        if v_problem is not null then
          return format('evidence.%s[%s].deviceCode %s', k, n - 1, regexp_replace(v_problem, '\.? \[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
        end if;
      end loop;
    end if;
  end loop;
  if p_evidence ? 'manual' then
    if v_entry ->> 'source' is distinct from 'MANUAL' then
      return 'evidence.manual is recorded only with an entry keyed by hand';
    end if;
    v_problem := recipe.command_member_problem(manual, p_evidence -> 'manual', 'evidence.manual', false);
    if v_problem is not null then
      return v_problem;
    end if;
    if (p_evidence -> 'manual' -> 'room') is distinct from to_jsonb(p_room) then
      return format('evidence.manual.room must be the room of the row (%s)', coalesce(p_room, 'none'));
    end if;
    if (p_evidence -> 'manual' -> 'balance') is distinct from (v_entry -> 'balance') then
      return 'evidence.manual.balance must be the balance its entry names';
    end if;
    if jsonb_typeof(p_evidence -> 'manual' -> 'declaredBalance') = 'string' and (p_evidence -> 'manual' -> 'declaredBalance') is distinct from (v_entry -> 'balance') then
      return 'evidence.manual.declaredBalance must be the balance its entry names, or null';
    end if;
    for e, n in select a.v, a.i from jsonb_array_elements(p_evidence -> 'manual' -> 'scales') with ordinality a (v, i) order by a.i loop
      v_problem := sandbox.identifier_problem_for(p_installation, 'DEVICE_LABEL', e ->> 'deviceCode');
      if v_problem is not null then
        return format('evidence.manual.scales[%s].deviceCode %s', n - 1, regexp_replace(v_problem, '\.? \[EBMR-[A-Z]+-[0-9]{3}\]$', ''));
      end if;
    end loop;
  end if;
  if p_evidence ? 'lot'
     and (p_evidence -> 'lot') is distinct from jsonb_build_object('code', v_entry -> 'lot' -> 'id', 'material', v_entry -> 'lot' -> 'material', 'status', v_entry -> 'lot' -> 'status') then
    return 'evidence.lot must be the code, material and status of the lot its entry names';
  end if;
  if p_evidence ? 'scanned' and (jsonb_typeof(p_evidence -> 'scanned') is distinct from 'string' or (p_evidence -> 'scanned') is distinct from (v_entry -> 'container')) then
    return 'evidence.scanned must be the container label its entry charges';
  end if;
  if p_evidence ? 'signatureId' and (jsonb_typeof(p_evidence -> 'signatureId') is distinct from 'string' or (p_evidence -> 'signatureId') is distinct from (p_command -> 'signature' -> 'id')) then
    return 'evidence.signatureId must be the signature its command applies';
  end if;
  if (p_evidence ? 'signing') is distinct from (p_evidence ? 'meaning') then
    return 'evidence.signing and evidence.meaning are recorded together';
  end if;
  if p_evidence ? 'signing' and ((p_evidence -> 'signing') is distinct from '"refused before signing"'::jsonb
                                 or jsonb_typeof(p_evidence -> 'meaning') is distinct from 'string'
                                 or (p_evidence -> 'meaning') is distinct from (p_command -> 'signature' -> 'meaning')) then
    return 'evidence of a signed command refused before signing is {signing: "refused before signing", meaning: the meaning of its signature}';
  end if;
  return null;
end
$$;

-- DI-05, DI-30 (F12, round-6 verification): why a row of kind p_kind with command id p_command_id, command p_command
-- (accepted: p_accepted) and evidence p_evidence, recorded at room p_room for a batch of package p_package_hash in an
-- installation of kind p_installation, does not record its command and evidence as the server does (header); NULL when
-- it does. The text completes "This <row> cannot
-- be recorded: ...".
create function recipe.execution_row_problem(p_kind text, p_command_id text, p_command jsonb, p_accepted boolean, p_evidence jsonb, p_room text,
                                             p_package_hash text, p_installation text) returns text
language plpgsql stable set search_path = pg_catalog, recipe, esig, pg_temp as $$
declare
  uuid      constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_type    text := case when jsonb_typeof(p_command) = 'object' and jsonb_typeof(p_command -> 'type') = 'string' then p_command ->> 'type' end;
  v_shape   jsonb := recipe.command_shape(p_kind, case when p_kind = 'COMMAND' then v_type end);
  v_problem text;
  v_path    text;
  v_sig     jsonb;
  v_signer  jsonb;
begin
  if v_shape is null then
    return format('its command is of type %s, which a %s row does not record', coalesce(v_type, '(none)'), coalesce(p_kind, '(no kind)'));
  end if;
  v_problem := recipe.command_member_problem(v_shape, p_command, 'command', p_accepted is not true);
  if v_problem is not null then
    return v_problem;
  end if;
  if coalesce(p_command_id !~ case p_kind when 'COMMAND' then '^((ESIG|ESIG-DRY):)?' || uuid || '$'
                                          when 'PREPARE' then '^PREPARE:' || uuid || '$'
                                          when 'SWEEP' then '^SWEEP:' || uuid || '$'
                                          else '^ISSUE:' || uuid || '$' end, true) then
    return format('its command id %s is not one the server gives a %s row', coalesce(left(p_command_id, 64), '(none)'), p_kind);
  end if;
  -- Every signature a command carries: a signature id or the dry run's placeholder, a meaning of the kernel, its signer
  -- the person of the command (of the approval, for an approval's signature).
  if p_kind = 'COMMAND' then
    for v_path, v_sig, v_signer in
      select 'command.signature', p_command -> 'signature', p_command -> 'actor' -> 'id' where p_command ? 'signature'
      union all
      select 'command.approval.signature', p_command -> 'approval' -> 'signature', p_command -> 'approval' -> 'approver' -> 'id' where p_command ? 'approval'
      union all
      select 'command.approvals[' || (a.i - 1) || '].signature', a.v -> 'signature', a.v -> 'approver' -> 'id'
        from jsonb_array_elements(case when jsonb_typeof(p_command -> 'approvals') = 'array' then p_command -> 'approvals' else '[]'::jsonb end) with ordinality a (v, i)
    loop
      if (v_sig ->> 'id') !~ ('^' || uuid || '$') and (v_sig ->> 'id') is distinct from '$dry-run' then
        return v_path || '.id must be a signature id, or the placeholder of a dry run';
      end if;
      if not exists (select 1 from esig.meaning_type m where m.code = v_sig ->> 'meaning') then
        return format('%s.meaning "%s" is not a signature meaning of the kernel', v_path, left(v_sig ->> 'meaning', 64));
      end if;
      if (v_sig -> 'signer') is distinct from v_signer then
        return v_path || '.signer must be the person who gives it';
      end if;
    end loop;
  end if;
  if p_kind = 'PREPARE' and p_command ? 'meaning' and not exists (select 1 from esig.meaning_type m where m.code = p_command ->> 'meaning') then
    return format('command.meaning "%s" is not a signature meaning of the kernel', left(p_command ->> 'meaning', 64));
  end if;
  return recipe.row_evidence_problem(p_kind, p_command, p_accepted, p_evidence, p_room, p_package_hash, p_installation);
end
$$;

-- DI-05, DI-30 (F12, round-6 verification): a row records its command and evidence as the server does (header).
-- EBMR-EXE-126. Raises; returns nothing.
create function recipe.execution_row_shape_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  b         recipe.batch_execution;
  v_problem text;
begin
  select * into b from recipe.batch_execution where id = new.batch_id;
  v_problem := recipe.execution_row_problem(new.kind, new.command_id, new.command, new.accepted, new.evidence, new.room_code, b.package_hash, b.installation);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row cannot be recorded: %s. A row records the engine command of its type with exactly the members that type declares, each of the JSON type it declares, and with evidence of the shape the server records, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       case new.kind when 'PREPARE' then 'preparation' when 'SWEEP' then 'sweep' when 'ISSUE' then 'issue' else case when new.accepted then 'accepted' else 'refused' end end,
                       coalesce(new.command_type, new.kind, 'unknown'), v_problem);
  end if;
  return null;
end
$$;

create constraint trigger zz_execution_row_shape after insert on recipe.execution_command
  for each row execute function recipe.execution_row_shape_check();

-- DI-05, DI-30 (F12, round-6 verification): why engine policy p_policy is not exactly the engine's EnginePolicy
-- (engine/types.ts) with engine roles; NULL when it is.
create function recipe.engine_policy_problem(p_policy jsonb) returns text
language plpgsql stable set search_path = pg_catalog, recipe, pg_temp as $$
declare
  roles     constant jsonb := '{"t": "list", "items": {"t": "text"}}';
  v_problem text;
  k         text;
  v_role    text;
  n         bigint;
begin
  v_problem := recipe.command_member_problem(jsonb_build_object('t', 'object', 'of', 'the engine policy', 'fields', jsonb_build_object(
    'oneVerifierMode', '{"t": "bool"}'::jsonb, 'voidNeedsQaApproval', '{"t": "bool"}'::jsonb, 'criticalCorrectionNeedsApproval', '{"t": "bool"}'::jsonb,
    'qaRoles', roles, 'supervisorRoles', roles, 'productionHeadRoles', roles, 'replicateCountRoles', roles, 'fallbackVerifierRoles', roles,
    'witnessWindowUs', '{"t": "micros"}'::jsonb)), p_policy, 'policy', false);
  if v_problem is not null then
    return v_problem;
  end if;
  foreach k in array array['fallbackVerifierRoles', 'productionHeadRoles', 'qaRoles', 'replicateCountRoles', 'supervisorRoles'] loop
    for v_role, n in select a.v, a.i from jsonb_array_elements_text(p_policy -> k) with ordinality a (v, i) order by a.i loop
      if not exists (select 1 from recipe.engine_role_permission rp where rp.engine_role = v_role) then
        return format('policy.%s[%s] "%s" is not an engine role', k, n - 1, left(v_role, 64));
      end if;
    end loop;
  end loop;
  return null;
end
$$;

-- DI-05, DI-30: a test batch pins exactly the engine policy's members (header). EBMR-EXE-126. Raises; returns the row.
create function recipe.execution_policy_shape_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_problem text := recipe.engine_policy_problem(new.policy);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('The pinned engine policy of test batch %s cannot be recorded: %s. A batch pins exactly the members of the engine policy, its roles engine roles, so nothing sits in the record unread (DI-05, DI-30). [EBMR-EXE-126]',
                       new.batch_number, v_problem);
  end if;
  return new;
end
$$;

create trigger ad_execution_policy_shape before insert or update of policy on recipe.batch_execution
  for each row execute function recipe.execution_policy_shape_check();

revoke all on function recipe.command_shape(text, text), recipe.block_schema_container_problem(jsonb, jsonb, text),
                       recipe.command_member_problem(jsonb, jsonb, text, boolean),
                       recipe.row_evidence_problem(text, jsonb, boolean, jsonb, text, text, text),
                       recipe.execution_row_problem(text, text, jsonb, boolean, jsonb, text, text, text), recipe.execution_row_shape_check(),
                       recipe.engine_policy_problem(jsonb), recipe.execution_policy_shape_check() from public;

reset role;
