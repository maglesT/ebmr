-- Tablets server, Phase 3 slice 5b: the block version TB-08@1 (rework or recovered-material addition across batches;
-- tablets spec B.2 TB-08; outline 5.2.9 cases 2 and 3; controls PR-47, IN-19, IN-18, PR-57, INV-33) in the database's
-- own registers (ADR 0012: the rules hold when the application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schema of its ADDITION entry as src/blocks/tb-08.ts declares it (the source facts
--     are recipe-core's SOURCE_FACTS_SCHEMA); a parity test compares them with the registry
--     (test/blocks/reprocessing/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the block type and the rule codes the block gives (a test run's record may hold them,
--     recipe-core 0346).
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1020_tb08_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block version TB-08@1 of Phase 3 slice 5b in the registers every entry is checked against (DI-30, PR-47, IN-19)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-08', '1', 'ENTRY', 'ADDITION', '{"type":"object","fields":{"container":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"gross":{"type":"decimal","min":"0","minExclusive":true},"tare":{"type":"decimal","min":"0"},"unit":{"type":"string","enum":["kg","g"]},"authorisation":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"authorisedBy":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"source":{"type":"object","fields":{"container":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"sourceBatchId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"product":{"type":"string"},"strength":{"type":"string"},"stage":{"type":"string"},"unit":{"type":"string","enum":["kg","g","units"]},"case":{"type":"string","enum":["REPROCESSING_ADDITION","RECOVERY"],"optional":true},"generatedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$"},"manufacturedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$"},"containsRecovered":{"type":"boolean"},"remaining":{"type":"string","pattern":"^(0|[1-9][0-9]*)(\\.[0-9]*[1-9])?$"},"expiry":{"type":"string","pattern":"^[0-9]{4}-(0[1-9]|1[0-2])$","optional":true}}}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-08', 'BLOCK_TYPE'), ('TB08-ADDED-ITEM', 'RULE_CODE'), ('TB08-AD-HOC', 'RULE_CODE'), ('TB08-AGE-FROM', 'RULE_CODE'),
  ('TB08-AUTHORISATION', 'RULE_CODE'), ('TB08-AUTHORISATION-USED', 'RULE_CODE'), ('TB08-BATCH-MASS', 'RULE_CODE'),
  ('TB08-CHAINED', 'RULE_CODE'), ('TB08-ENTRY', 'RULE_CODE'), ('TB08-NET', 'RULE_CODE'), ('TB08-NO-ADDITION', 'RULE_CODE'),
  ('TB08-NO-CASE', 'RULE_CODE'), ('TB08-NOT-AUTHORISED', 'RULE_CODE'), ('TB08-OTHER-PRODUCT', 'RULE_CODE'),
  ('TB08-OVER-REMAINING', 'RULE_CODE'), ('TB08-OWN-BATCH', 'RULE_CODE'), ('TB08-PRETREATMENT', 'RULE_CODE'),
  ('TB08-SELF-AUTHORISED', 'RULE_CODE'), ('TB08-SOURCE-STATUS', 'RULE_CODE'), ('TB08-SOURCE-TYPE', 'RULE_CODE'),
  ('TB08-TOO-MANY-SOURCES', 'RULE_CODE'), ('TB08-TOO-MUCH', 'RULE_CODE'), ('TB08-TOO-OLD', 'RULE_CODE'), ('TB08-UNIT', 'RULE_CODE');

select kernel.set_actor_context(null);

reset role;
