-- Recipe core, execution store (module C3): the facts a PERFORMED attempt is judged on (Injectables I-6, INV-23 (c), lead
-- ruling of 15 November 2026: the engine raises the APS lapse of a filling line at the step's sign-off).
--
-- The server reads facts from its registers for a PERFORMED attempt and states them in the SIGN_PERFORMED command and in
-- the target of its PREPARE row (engine types.ts PerformFacts), so the attempt replays on the same facts. The row shape
-- (recipe.command_shape, latest body from 0480) gains the one optional member `facts`:
--   apsValidUntilUs   optional map, line code to the end of its APS validity (a microsecond count, or null without a
--                     valid APS), as tablets 1915 plant.aps_sign_off_facts reads it.
-- Nothing else changes. CREATE OR REPLACE keeps owner, privileges and search_path; applied migrations are never edited.

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
  facts    constant jsonb := '{"t": "object", "opt": true, "of": "the facts of a PERFORMED attempt", "fields": {"apsValidUntilUs": {"t": "map", "opt": true, "values": {"t": "micros", "null": true}}}}';
  f        jsonb;
begin
  if p_kind = 'SWEEP' then
    return '{"t": "object", "of": "a sweep", "fields": {"type": {"t": "text", "enum": ["SWEEP"]}}}';
  elsif p_kind = 'PREPARE' then
    return jsonb_build_object('t', 'object', 'of', 'a preparation for a signature', 'fields', jsonb_build_object(
      'type', '{"t": "text", "enum": ["PREPARE"]}'::jsonb,
      'target', jsonb_build_object('t', 'object', 'fields', jsonb_build_object('type', jsonb_build_object('t', 'text', 'enum', types), 'step', txt || opt, 'context', frames || opt, 'facts', facts)),
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
    when 'SIGN_PERFORMED' then jsonb_build_object('step', txt, 'context', frames || opt, 'signature', sig || opt, 'occurredAt', occurred || opt, 'facts', facts)
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

reset role;
