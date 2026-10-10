-- Tablets server, Phase 3 slice 3b (builder A): the block version TB-01@1 (potency/assay/LOD-adjusted dispensing with a
-- compensating excipient; tablets spec B.2 TB-01, calculations C-01 to C-04) in the database's own registers (controls
-- PR-18, PR-19, PR-20, DI-30, DI-33; ADR 0012: the rules hold when the application's own database credentials are used
-- directly).
--
--   * recipe.block_data_schema: the data schemas of TB-01@1's two entry kinds as src/blocks/tb-01.ts declares them
--     (POTENCY_CALCULATION, and CONTAINER_WEIGHING: G-07's members with the dispenser's FEFO reason and the lot
--     consumption the server made on GMP); a parity test compares them with the registry
--     (test/blocks/dispensing/tb-01-db.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.block_signature_meaning: TB-01@1 is checked with G-07's meaning CONTAINER_CHECKED (PR-20).
--   * recipe.engine_name: the block type TB-01 and the block's rule codes (a test run's record may hold them, recipe-core
--     0346; the identifier rule reads every other word with a letter and a digit as a possible real identifier).
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0840_tb01_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version TB-01@1 of Phase 3 slice 3b in the registers every entry is checked against (DI-30, PR-19)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-01', '1', 'ENTRY', 'POTENCY_CALCULATION', '{"type":"object","fields":{"lots":{"type":"array","items":{"type":"object","fields":{"lot":{"type":"object","fields":{"id":{"type":"string"},"material":{"type":"string"},"status":{"type":"string","enum":["RELEASED","QUARANTINE","ON_TEST","REJECTED","ON_HOLD","RECALLED","RETURNED","EXPIRED"]},"expiresAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"retestAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"identityTested":{"type":"boolean","optional":true}}},"assay":{"type":"object","fields":{"resultId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"basis":{"type":"string","enum":["AS_IS","ANHYDROUS_WATER","DRIED_LOD","ANHYDROUS_SOLVENT_FREE"]},"assay":{"type":"decimal"},"water":{"type":"decimal","optional":true},"lod":{"type":"decimal","optional":true},"solvents":{"type":"decimal","optional":true}}},"baseEquivalent":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":3}}}'),
  ('TB-01', '1', 'ENTRY', 'CONTAINER_WEIGHING', '{"type":"object","fields":{"item":{"type":"string"},"bomLine":{"type":"string"},"container":{"type":"string"},"lot":{"type":"object","fields":{"id":{"type":"string"},"material":{"type":"string"},"status":{"type":"string","enum":["RELEASED","QUARANTINE","ON_TEST","REJECTED","ON_HOLD","RECALLED","RETURNED","EXPIRED"]},"expiresAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"retestAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"identityTested":{"type":"boolean","optional":true}}},"gross":{"type":"decimal"},"tare":{"type":"decimal"},"unit":{"type":"string"},"balance":{"type":"string"},"source":{"type":"string","enum":["DEVICE","MANUAL"]},"fefoReason":{"type":"string","optional":true},"consumption":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true}}}');

insert into recipe.block_signature_meaning (block_type, block_version, part, meaning_code) values
  ('TB-01', '1', 'check', 'CONTAINER_CHECKED');

insert into recipe.engine_name (name, kind) values
  ('TB-01', 'BLOCK_TYPE'),
  ('TB01-ACTIVE-LINE', 'RULE_CODE'), ('TB01-ALLOCATION', 'RULE_CODE'), ('TB01-ASSAY', 'RULE_CODE'), ('TB01-BASIS', 'RULE_CODE'),
  ('TB01-BASIS-CONSISTENCY', 'RULE_CODE'), ('TB01-BOM-LINE', 'RULE_CODE'), ('TB01-CALC-AFTER-DISPENSE', 'RULE_CODE'),
  ('TB01-CONSUMPTION', 'RULE_CODE'), ('TB01-DESIGNATION', 'RULE_CODE'), ('TB01-EXCIPIENT-LINE', 'RULE_CODE'),
  ('TB01-EXCIPIENT-NEGATIVE', 'RULE_CODE'), ('TB01-EXCIPIENT-RANGE', 'RULE_CODE'), ('TB01-FEFO', 'RULE_CODE'),
  ('TB01-FEFO-REASON', 'RULE_CODE'), ('TB01-FORM', 'RULE_CODE'), ('TB01-INCOMPLETE', 'RULE_CODE'), ('TB01-INSTRUMENT', 'RULE_CODE'),
  ('TB01-ITEM', 'RULE_CODE'), ('TB01-LOT-EXPIRED', 'RULE_CODE'), ('TB01-LOT-IDENTITY', 'RULE_CODE'),
  ('TB01-LOT-NOT-CALCULATED', 'RULE_CODE'), ('TB01-LOT-RETEST', 'RULE_CODE'), ('TB01-LOT-STATUS', 'RULE_CODE'),
  ('TB01-LOTS', 'RULE_CODE'), ('TB01-NET', 'RULE_CODE'), ('TB01-NO-CALCULATION', 'RULE_CODE'), ('TB01-NO-CHECK', 'RULE_CODE'),
  ('TB01-NO-COMPENSATION', 'RULE_CODE'), ('TB01-NO-ITEM', 'RULE_CODE'), ('TB01-OVERAGE', 'RULE_CODE'),
  ('TB01-PERFORMER', 'RULE_CODE'), ('TB01-READABILITY', 'RULE_CODE'), ('TB01-RECOMPUTE', 'RULE_CODE'),
  ('TB01-REGISTER', 'RULE_CODE'), ('TB01-TOLERANCE', 'RULE_CODE'), ('TB01-UNIT', 'RULE_CODE'), ('TB01-WRONG-MATERIAL', 'RULE_CODE');

select kernel.set_actor_context(null);

reset role;
