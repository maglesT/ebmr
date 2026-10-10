-- Recipe core, execution store (module C3): the hand-over of a step in progress (Phase 3 slice 2, plan item 3; outline
-- 5.2.3, L-07; DI-14, DI-24, DI-26, DI-35, PR-14, INV-03, INV-31; engine 1.6.0). Part 1: the catalogue.
--
-- Until this migration recipe.require_command_permission (0210) refused HAND_OVER_STEP and TAKE_OVER_STEP as not
-- available (EBMR-EXE-003): recipe.execution_command_permission had no row for them. This migration adds:
--   * the permission each needs, and whether it is signed:
--       HAND_OVER_STEP  recorded by a production supervisor (STEP.SUPERVISE), who signs it (HANDOVER_APPROVED) in the
--                       command, with QA's approval (HANDOVER_APPROVED, signed in its own ceremony). The kernel's meaning
--                       catalogue (kernel 0210) already limits who may sign HANDOVER_APPROVED to STEP.SUPERVISE or
--                       QA.FLOOR_APPROVE;
--       TAKE_OVER_STEP  by the incoming performer the hand-over names (STEP.EXECUTE or DISPENSE.EXECUTE), unsigned: it
--                       attests nothing; the incoming performer signs their own entries when they sign the step
--                       performed;
--   * the meanings each part of HAND_OVER_STEP may carry (recipe.execution_signature_meaning);
--   * recipe.command_shape (0335, last replaced by 0452) with the members of the two commands (engine types.ts
--     HandOverStepCommand, TakeOverStepCommand).
-- Both signatures of a hand-over are on the batch record at the state version the row acts on (0450's `batch_record`):
-- the step's own content is not changed by the hand-over (its exception is an act, engine signing-content.ts
-- ACT_EXCEPTION_TYPES), and a record-level approval is never superseded by the act it approves. 0462 checks the
-- signatures and the signers' roles, 0463 what an accepted row may store.
--
-- CREATE OR REPLACE keeps the owner, privileges (none for PUBLIC) and search_path of recipe.command_shape. Applied as a
-- new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0461_hand_over_catalogue)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the hand-over of a step in progress and its take-over by the incoming performer (L-07, PR-14, DI-35)'));

insert into recipe.execution_command_permission (command_type, permissions, signed) values
  ('HAND_OVER_STEP', array['STEP.SUPERVISE'], true),
  ('TAKE_OVER_STEP', array['STEP.EXECUTE', 'DISPENSE.EXECUTE'], false);

insert into recipe.execution_signature_meaning (command_type, part, meaning_code) values
  ('HAND_OVER_STEP', 'signature', 'HANDOVER_APPROVED'),
  ('HAND_OVER_STEP', 'approval', 'HANDOVER_APPROVED');

select kernel.set_actor_context(null);

do $$
begin
  if not exists (select 1 from esig.meaning_type t where t.code = 'HANDOVER_APPROVED' and t.status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'HANDOVER_APPROVED is not in the e-signature catalogue (DI-35)';
  end if;
end
$$;

-- DI-05, DI-30: the shape of a command (0335, 0452), with the members of engine 1.6.0's hand-over and take-over.
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
    when 'HAND_OVER_STEP' then jsonb_build_object('step', txt, 'context', frames || opt, 'outgoing', txt, 'incoming', txt, 'reason', txt, 'signature', sig, 'approval', approval)
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
