-- Tablets server, Phase 3 slice 3c (builder A): the block versions TB-09@1 (tooling custody and inspection), TB-10@1
-- (compression set-up and first-off approval) and TB-17@1 (reject and detection devices) in the database's own registers
-- (tablets spec B.2; controls DI-30, IN-36, INV-24; ADR 0012: the rules hold when the application's own database
-- credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the three versions as src/blocks/tb-09.ts,
--     tb-10.ts and tb-17.ts declare them (TB-10 and TB-17 take G-06's six kinds unchanged); a parity test compares them
--     with the registry (test/blocks/compression/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the three block types and their rule codes (a test run's record may hold them, recipe-core
--     0346), the codes only the database gives included (TB09-SPEC, TB10-TOOLING and others).
-- TB-10 and TB-17 run on a process device (tab.process_block_type, tablets 0870).
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0873_compression_blocks)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-09@1, TB-10@1 and TB-17@1 of Phase 3 slice 3c in the registers every entry is checked against (DI-30, IN-36)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-09', '1', 'ENTRY', 'TOOLING_INSPECTED', '{"type":"object","fields":{"set":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"inspectionId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"when":{"type":"string","enum":["BEFORE","AFTER"]},"result":{"type":"string","enum":["PASS","FAIL"]}}}'),
  ('TB-09', '1', 'ENTRY', 'TOOLING_ISSUED', '{"type":"object","fields":{"set":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"issueId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"press":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"}}}'),
  ('TB-09', '1', 'ENTRY', 'TOOLING_RETURNED', '{"type":"object","fields":{"set":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"issueId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"strokes":{"type":"string","pattern":"^[0-9]{1,18}$"},"strokeSource":{"type":"string","enum":["PRESS_COUNTER","MANUAL"]},"countMismatch":{"type":"boolean"},"limitExceeded":{"type":"boolean"}}}'),
  ('TB-10', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-10', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-10', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-10', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-10', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-10', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-10', '1', 'ENTRY', 'PRESS_SETUP', '{"type":"object","fields":{"press":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"useId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"issueId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}}'),
  ('TB-10', '1', 'ENTRY', 'PRE_USE_CHECKLIST', '{"type":"object","fields":{"items":{"type":"array","items":{"type":"object","fields":{"item":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"ok":{"type":"boolean"}}},"minItems":1,"maxItems":23}}}'),
  ('TB-10', '1', 'ENTRY', 'HOPPER_CHARGE', '{"type":"object","fields":{"chargeId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}}'),
  ('TB-10', '1', 'ENTRY', 'FIRST_OFF', '{"type":"object","fields":{"result":{"type":"string","enum":["PASS","FAIL"]},"observations":{"type":"string","optional":true}}}'),
  ('TB-10', '1', 'ENTRY', 'SETTING_CHANGE', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"reason":{"type":"string"}}}'),
  ('TB-17', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-17', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-17', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-17', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-17', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-17', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-17', '1', 'ENTRY', 'CHALLENGE', '{"type":"object","fields":{"challengeId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"device":{"type":"string","enum":["METAL_DETECTOR","REJECT_GATE"]},"timing":{"type":"string","enum":["START","INTERVAL","AFTER_STOPPAGE","END"]},"passed":{"type":"boolean"}}}'),
  ('TB-17', '1', 'ENTRY', 'REJECT_COUNT', '{"type":"object","fields":{"device":{"type":"string","enum":["METAL_DETECTOR","REJECT_GATE","DEDUSTER","SETUP"]},"count":{"type":"string","pattern":"^[0-9]{1,9}$"},"disposition":{"type":"string","enum":["DESTRUCTION","INSPECTION_THEN_DESTRUCTION"]}}}'),
  ('TB-17', '1', 'ENTRY', 'DEDUSTING', '{"type":"object","fields":{"deDuster":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"inUse":{"type":"boolean"}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-09', 'BLOCK_TYPE'), ('TB-10', 'BLOCK_TYPE'), ('TB-17', 'BLOCK_TYPE'),
  ('TB09-AFTER-CHECK-MISSING', 'RULE_CODE'), ('TB09-ENTRY', 'RULE_CODE'), ('TB09-INSPECTED-TWICE', 'RULE_CODE'),
  ('TB09-ISSUED-TWICE', 'RULE_CODE'), ('TB09-NO-SPECIFICATION', 'RULE_CODE'), ('TB09-NOT-INSPECTED', 'RULE_CODE'),
  ('TB09-NOT-ISSUED', 'RULE_CODE'), ('TB09-NOT-RETURNED', 'RULE_CODE'), ('TB09-PART', 'RULE_CODE'), ('TB09-REGISTER', 'RULE_CODE'),
  ('TB09-RETURNED-TWICE', 'RULE_CODE'), ('TB09-SPEC', 'RULE_CODE'),
  ('TB10-CHARGE', 'RULE_CODE'), ('TB10-CHECKLIST', 'RULE_CODE'), ('TB10-CHECKLIST-OPEN', 'RULE_CODE'), ('TB10-DEVICE', 'RULE_CODE'),
  ('TB10-DUPLICATE-SETTING', 'RULE_CODE'), ('TB10-ENTRY', 'RULE_CODE'), ('TB10-FIRST-OFF', 'RULE_CODE'), ('TB10-NO-EQUIPMENT', 'RULE_CODE'),
  ('TB10-NO-SETUP', 'RULE_CODE'), ('TB10-NOT-CHARGED', 'RULE_CODE'), ('TB10-PRESS', 'RULE_CODE'), ('TB10-SETTING-RANGE', 'RULE_CODE'),
  ('TB10-SETTING-TAG', 'RULE_CODE'), ('TB10-SETTING-UNIT', 'RULE_CODE'), ('TB10-SETUP-TWICE', 'RULE_CODE'), ('TB10-TOOLING', 'RULE_CODE'),
  ('TB17-AFTER-END', 'RULE_CODE'), ('TB17-DEDUSTER', 'RULE_CODE'), ('TB17-DEVICE', 'RULE_CODE'), ('TB17-END-CHALLENGE', 'RULE_CODE'),
  ('TB17-ENTRY', 'RULE_CODE'), ('TB17-NO-DEDUSTING', 'RULE_CODE'), ('TB17-NO-DEVICE', 'RULE_CODE'), ('TB17-NO-PIECES', 'RULE_CODE'),
  ('TB17-NO-REJECT-COUNT', 'RULE_CODE'), ('TB17-PIECES', 'RULE_CODE'), ('TB17-REGISTER', 'RULE_CODE'), ('TB17-START-FIRST', 'RULE_CODE');

select kernel.set_actor_context(null);

reset role;
