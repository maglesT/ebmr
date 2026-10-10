-- Tablets server, Phase 3 slice 3c (builder B): the block versions TB-11@1 (periodic IPC scheduler with streams and the
-- bracketing hold), TB-12@1 (weight), TB-13@1 (breaking force, thickness, diameter, appearance), TB-14@1 (friability) and
-- TB-15@1 (disintegration) in the database's own registers, and the compendial rule sets they are evaluated against
-- (tablets spec B.2, E.1 to E.5; D-S3-2; controls IN-34, IN-35, PR-29, DI-10, DI-30; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the five versions as src/blocks/tb-1x.ts declare
--     them (TB-11 takes the test entry kinds of TB-12 to TB-15 unchanged); a parity test compares them with the registry
--     (test/blocks/ipc/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the five block types and their rule codes (a test run's record may hold them, recipe-core
--     0346), the codes only the database gives included (TB11-PRESS, TB12-INSTRUMENT and the others).
--   * tab.compendial_rule_set: the compendial rule sets as versioned master data (tablets spec E.1, S-8): code, version,
--     pharmacopoeia, test, the markets whose batches it binds in-process (none for an in-house table an MBR opts into),
--     the tablet types it covers, its parameters (decimal text), its confidence, its source reference and the dates it is
--     effective from and to. Values paraphrased from the spec's tables, never pharmacopoeia text. The rows equal
--     src/blocks/ipc/rule-sets.ts RULE_SETS (a parity test). Insert-only and audited; a change is a new version. Codes
--     hold no digit: a test run's record holds them and the sandbox identifier rule reads a word with a letter and a
--     digit as a possible real batch or lot number.
--   * tab.ipc_rule: the ceiling between compression samples, the tablets rule table's key
--     tablets.compression.ipcSampleMaxInterval (India, HARD) as the IPC guards read it (src/blocks/tb-11.ts
--     COMPRESSION_SAMPLE_CEILING; a parity test). Insert-only and audited.
--
-- Not here, stated so it is not over-read: the QA verification record of a rule set against the official text (tablets
-- spec E.1: no GMP use before it) is not modelled yet; every row is evaluated as shipped and its confidence is recorded.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0890_ipc_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-11@1 to TB-15@1 of Phase 3 slice 3c and the compendial rule sets in the registers every IPC entry is checked against (DI-30, IN-34)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-11', '1', 'ENTRY', 'RUN_START', '{"type":"object","fields":{"press":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"counter":{"type":"integer","min":0,"optional":true}}}'),
  ('TB-11', '1', 'ENTRY', 'STOPPAGE_START', '{"type":"object","fields":{}}'),
  ('TB-11', '1', 'ENTRY', 'STOPPAGE_END', '{"type":"object","fields":{}}'),
  ('TB-11', '1', 'ENTRY', 'CHANGE', '{"type":"object","fields":{"change":{"type":"string","enum":["SETTING","TOOLING"]}}}'),
  ('TB-11', '1', 'ENTRY', 'RUN_END', '{"type":"object","fields":{}}'),
  ('TB-11', '1', 'ENTRY', 'STATION_SWEEP', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"stations":{"type":"array","items":{"type":"object","fields":{"station":{"type":"integer","min":1,"max":100},"weight":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"hardness":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":100}}}'),
  ('TB-11', '1', 'ENTRY', 'WEIGHT_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100,"optional":true},"groupWeight":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assay":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assayRef":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$","optional":true}}}'),
  ('TB-11', '1', 'ENTRY', 'WEIGHT_SECOND_STAGE', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"check":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$"},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100}}}'),
  ('TB-11', '1', 'ENTRY', 'PHYSICAL_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"array","items":{"type":"object","fields":{"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"diameter":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"hardness":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":20},"defects":{"type":"array","items":{"type":"string","enum":["CAPPING","LAMINATION","STICKING","PICKING","CHIPPING","EMBOSSING","BLACK_SPECKS","OIL_CONTAMINATION"]},"maxItems":8,"optional":true}}}'),
  ('TB-11', '1', 'ENTRY', 'FRIABILITY_RUN', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"integer","min":1,"max":200},"initialMass":{"type":"decimal","min":"0","minExclusive":true},"finalMass":{"type":"decimal"},"rotations":{"type":"integer","min":1,"max":1000},"rpm":{"type":"decimal","min":"0","minExclusive":true},"broken":{"type":"boolean"},"doubtful":{"type":"boolean","optional":true},"repeatOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-11', '1', 'ENTRY', 'DT_START', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"bathTemperature":{"type":"decimal"},"stage":{"type":"string","enum":["MAIN","ACID","BUFFER"]},"retestOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-11', '1', 'ENTRY', 'DT_END', '{"type":"object","fields":{"start":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":12,"optional":true},"units":{"type":"array","items":{"type":"object","fields":{"disintegrated":{"type":"boolean"},"seconds":{"type":"decimal","min":"0","optional":true}}},"minItems":1,"maxItems":12}}}'),
  ('TB-12', '1', 'ENTRY', 'WEIGHT_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100,"optional":true},"groupWeight":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assay":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assayRef":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$","optional":true}}}'),
  ('TB-12', '1', 'ENTRY', 'WEIGHT_SECOND_STAGE', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"check":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$"},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100}}}'),
  ('TB-13', '1', 'ENTRY', 'PHYSICAL_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"array","items":{"type":"object","fields":{"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"diameter":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"hardness":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":20},"defects":{"type":"array","items":{"type":"string","enum":["CAPPING","LAMINATION","STICKING","PICKING","CHIPPING","EMBOSSING","BLACK_SPECKS","OIL_CONTAMINATION"]},"maxItems":8,"optional":true}}}'),
  ('TB-14', '1', 'ENTRY', 'FRIABILITY_RUN', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"integer","min":1,"max":200},"initialMass":{"type":"decimal","min":"0","minExclusive":true},"finalMass":{"type":"decimal"},"rotations":{"type":"integer","min":1,"max":1000},"rpm":{"type":"decimal","min":"0","minExclusive":true},"broken":{"type":"boolean"},"doubtful":{"type":"boolean","optional":true},"repeatOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-15', '1', 'ENTRY', 'DT_START', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"bathTemperature":{"type":"decimal"},"stage":{"type":"string","enum":["MAIN","ACID","BUFFER"]},"retestOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-15', '1', 'ENTRY', 'DT_END', '{"type":"object","fields":{"start":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":12,"optional":true},"units":{"type":"array","items":{"type":"object","fields":{"disintegrated":{"type":"boolean"},"seconds":{"type":"decimal","min":"0","optional":true}}},"minItems":1,"maxItems":12}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-11', 'BLOCK_TYPE'), ('TB-12', 'BLOCK_TYPE'), ('TB-13', 'BLOCK_TYPE'), ('TB-14', 'BLOCK_TYPE'),
  ('TB-15', 'BLOCK_TYPE'), ('TB11-CEILING', 'RULE_CODE'), ('TB11-COUNTER', 'RULE_CODE'),
  ('TB11-COUNTER-BACK', 'RULE_CODE'), ('TB11-DEVICE', 'RULE_CODE'), ('TB11-END-CHECK', 'RULE_CODE'),
  ('TB11-ENDED', 'RULE_CODE'), ('TB11-ENTRY', 'RULE_CODE'), ('TB11-FIRST-OFF', 'RULE_CODE'), ('TB11-GRACE', 'RULE_CODE'), ('TB11-HOLD', 'RULE_CODE'),
  ('TB11-INSTRUMENT', 'RULE_CODE'), ('TB11-MISSED', 'RULE_CODE'), ('TB11-NO-SWEEP', 'RULE_CODE'),
  ('TB11-NOT-PLANNED', 'RULE_CODE'), ('TB11-NOT-STARTED', 'RULE_CODE'), ('TB11-NOT-STOPPED', 'RULE_CODE'),
  ('TB11-PENDING', 'RULE_CODE'), ('TB11-PLAN', 'RULE_CODE'), ('TB11-PRESS', 'RULE_CODE'), ('TB11-QRM', 'RULE_CODE'),
  ('TB11-READINGS', 'RULE_CODE'), ('TB11-RESTART', 'RULE_CODE'), ('TB11-RUNNING', 'RULE_CODE'),
  ('TB11-SAMPLED-EARLY', 'RULE_CODE'), ('TB11-SAMPLED-LATER', 'RULE_CODE'), ('TB11-STOPPED', 'RULE_CODE'),
  ('TB11-STREAM', 'RULE_CODE'), ('TB11-STREAMS', 'RULE_CODE'), ('TB11-SWEEP-INCOMPLETE', 'RULE_CODE'),
  ('TB11-SWEEP-PARAMETERS', 'RULE_CODE'), ('TB11-TEST-CONFIG', 'RULE_CODE'), ('TB11-TWICE', 'RULE_CODE'),
  ('TB12-ASSAY', 'RULE_CODE'), ('TB12-CONFIG', 'RULE_CODE'), ('TB12-COUNT', 'RULE_CODE'),
  ('TB12-DEVICE', 'RULE_CODE'), ('TB12-ENTRY', 'RULE_CODE'), ('TB12-INSTRUMENT', 'RULE_CODE'),
  ('TB12-LOOSER', 'RULE_CODE'), ('TB12-NO-CHECK', 'RULE_CODE'), ('TB12-NO-FIRST-STAGE', 'RULE_CODE'),
  ('TB12-NO-RULE-SET', 'RULE_CODE'), ('TB12-READINGS', 'RULE_CODE'), ('TB12-SAMPLED-EARLY', 'RULE_CODE'),
  ('TB12-SAMPLED-LATER', 'RULE_CODE'), ('TB12-SECOND-STAGE-PENDING', 'RULE_CODE'), ('TB12-RULE-SETS-DIFFER', 'RULE_CODE'), ('TB14-RULE-SETS-DIFFER', 'RULE_CODE'), ('TB15-RULE-SETS-DIFFER', 'RULE_CODE'),
  ('TB12-SECOND-STAGE-STREAM', 'RULE_CODE'), ('TB12-SECOND-STAGE-TWICE', 'RULE_CODE'), ('TB12-STREAM', 'RULE_CODE'),
  ('TB12-WEIGHTS', 'RULE_CODE'), ('TB13-APPEARANCE', 'RULE_CODE'), ('TB13-COUNT', 'RULE_CODE'),
  ('TB13-DEVICE', 'RULE_CODE'), ('TB13-ENTRY', 'RULE_CODE'), ('TB13-INSTRUMENT', 'RULE_CODE'),
  ('TB13-LIMITS', 'RULE_CODE'), ('TB13-NO-CHECK', 'RULE_CODE'), ('TB13-NOTHING', 'RULE_CODE'),
  ('TB13-PARAMETERS', 'RULE_CODE'), ('TB13-READINGS', 'RULE_CODE'), ('TB13-SAMPLED-EARLY', 'RULE_CODE'),
  ('TB13-SAMPLED-LATER', 'RULE_CODE'), ('TB13-STREAM', 'RULE_CODE'), ('TB14-DEVICE', 'RULE_CODE'),
  ('TB14-DOUBTFUL', 'RULE_CODE'), ('TB14-ENTRY', 'RULE_CODE'), ('TB14-INSTRUMENT', 'RULE_CODE'),
  ('TB14-LOOSER', 'RULE_CODE'), ('TB14-MASS', 'RULE_CODE'), ('TB14-NO-RULE-SET', 'RULE_CODE'),
  ('TB14-NO-RUN', 'RULE_CODE'), ('TB14-NOT-REPEATED', 'RULE_CODE'), ('TB14-RATE', 'RULE_CODE'),
  ('TB14-READINGS', 'RULE_CODE'), ('TB14-REPEAT-PENDING', 'RULE_CODE'), ('TB14-ROTATIONS', 'RULE_CODE'),
  ('TB14-SAMPLE', 'RULE_CODE'), ('TB14-SAMPLED-EARLY', 'RULE_CODE'), ('TB14-SAMPLED-LATER', 'RULE_CODE'),
  ('TB14-STREAM', 'RULE_CODE'), ('TB15-ACID-SHORT', 'RULE_CODE'), ('TB15-BATH-TEMP', 'RULE_CODE'),
  ('TB15-BUFFER-PENDING', 'RULE_CODE'), ('TB15-DEVICE', 'RULE_CODE'), ('TB15-ENTRY', 'RULE_CODE'),
  ('TB15-INSTRUMENT', 'RULE_CODE'), ('TB15-NO-ACID', 'RULE_CODE'), ('TB15-NO-LIMIT', 'RULE_CODE'),
  ('TB15-NO-RULE-SET', 'RULE_CODE'), ('TB15-NO-RUN', 'RULE_CODE'), ('TB15-NOT-RETESTED', 'RULE_CODE'),
  ('TB15-NOT-STARTED', 'RULE_CODE'), ('TB15-PENDING', 'RULE_CODE'), ('TB15-READINGS', 'RULE_CODE'),
  ('TB15-RETEST-PENDING', 'RULE_CODE'), ('TB15-RUNNING', 'RULE_CODE'), ('TB15-SAMPLED-EARLY', 'RULE_CODE'),
  ('TB15-SAMPLED-LATER', 'RULE_CODE'), ('TB15-STAGE', 'RULE_CODE'), ('TB15-STREAM', 'RULE_CODE'),
  ('TB15-TIME', 'RULE_CODE'), ('TB15-UNITS', 'RULE_CODE'), ('TB15-WHICH-START', 'RULE_CODE');

-- ---------------------------------------------------------------------------------------------
-- Compendial rule sets (tablets spec E.1 to E.5)

create table tab.compendial_rule_set (
  code            text not null check (code ~ '^[A-Z][A-Z-]{1,39}$'),
  version         integer not null check (version >= 1),
  test            text not null check (test in ('UNIFORMITY_OF_WEIGHT', 'WEIGHT_VARIATION', 'SUBDIVISION', 'FRIABILITY', 'DISINTEGRATION')),
  pharmacopoeia   text not null check (pharmacopoeia in ('IP', 'PH_EUR', 'USP', 'IN_HOUSE')),
  markets         text[] not null,
  tablet_types    text[] not null check (cardinality(tablet_types) >= 1),
  params          jsonb not null check (jsonb_typeof(params) = 'object'),
  confidence      text not null check (confidence in ('HIGH', 'MEDIUM_HIGH', 'MEDIUM', 'MEDIUM_LOW', 'LOW', 'NOT_APPLICABLE')),
  source          text not null check (btrim(source) <> ''),
  effective_from  date not null,
  effective_to    date,
  note            text,
  primary key (code, version),
  check (effective_to is null or effective_to > effective_from),
  check (pharmacopoeia = 'IN_HOUSE' or cardinality(markets) >= 1)
);
revoke all on tab.compendial_rule_set from public;
create trigger aa_compendial_rule_set_insert_only before update or delete on tab.compendial_rule_set for each row execute function kernel.reject_mutation();
create trigger aa_compendial_rule_set_no_truncate before truncate on tab.compendial_rule_set for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.compendial_rule_set', 'compendial_rule_set', 'code', true);

insert into tab.compendial_rule_set (code, version, test, pharmacopoeia, markets, tablet_types, params, confidence, source, effective_from, effective_to, note) values
  ('IP-UOW', 1, 'UNIFORMITY_OF_WEIGHT', 'IP', '{IN}', '{UNCOATED,FILM_COATED}', '{"units":20,"bands":[{"upToMg":"80","inclusive":true,"percent":"10"},{"upToMg":"250","inclusive":false,"percent":"7.5"},{"percent":"5"}],"maxOutside":2,"maxOutsideDouble":0}', 'MEDIUM', 'Indian Pharmacopoeia uniformity of weight, bands as tablets spec E.2 and control IN-34 (IP 2026 text not seen)', '2023-12-28', null, 'Consistent with the sample BMR (plus or minus 7.5 % of the average); confirm against IP 2026 (India G-8).'),
  ('PHEUR-UOW', 1, 'UNIFORMITY_OF_WEIGHT', 'PH_EUR', '{EU}', '{UNCOATED,FILM_COATED}', '{"units":20,"bands":[{"upToMg":"80","inclusive":true,"percent":"10"},{"upToMg":"250","inclusive":false,"percent":"7.5"},{"percent":"5"}],"maxOutside":2,"maxOutsideDouble":0}', 'HIGH', 'Ph. Eur. uniformity of mass of single-dose preparations, tablet row (tablets spec E.2)', '2023-12-28', null, 'Sugar-coated tablets are outside the tablet row (medium confidence). Effective date not verified.'),
  ('LEGACY-UOW', 1, 'UNIFORMITY_OF_WEIGHT', 'IN_HOUSE', '{}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE,CHEWABLE}', '{"units":20,"bands":[{"upToMg":"130","inclusive":true,"percent":"10"},{"upToMg":"324","inclusive":true,"percent":"7.5"},{"percent":"5"}],"maxOutside":2,"maxOutsideDouble":0}', 'NOT_APPLICABLE', 'In-house legacy table of control IN-34 (the dietary-supplement values, not a USP requirement for drug tablets)', '2023-12-28', null, 'Bound only where the MBR opts in; IP and Ph. Eur. are equal or tighter at every weight. Inclusivity at 324 mg not verified.'),
  ('IP-UDU', 1, 'WEIGHT_VARIATION', 'IP', '{IN}', '{UNCOATED,FILM_COATED}', '{"firstUnits":10,"totalUnits":30,"firstK":"2.4","secondK":"2.0","acceptanceLimit":"15.0","unitLimitPercent":"25.0","referenceLow":"98.5","referenceHigh":"101.5","avDecimals":1}', 'LOW', 'Indian Pharmacopoeia uniformity of dosage units by weight variation (adoption of the harmonised chapter not confirmed; tablets spec E.3)', '2023-12-28', null, null),
  ('PHEUR-UDU', 1, 'WEIGHT_VARIATION', 'PH_EUR', '{EU}', '{UNCOATED,FILM_COATED}', '{"firstUnits":10,"totalUnits":30,"firstK":"2.4","secondK":"2.0","acceptanceLimit":"15.0","unitLimitPercent":"25.0","referenceLow":"98.5","referenceHigh":"101.5","avDecimals":1}', 'MEDIUM_HIGH', 'Ph. Eur. uniformity of dosage units, weight variation by acceptance value (harmonised; tablets spec C-14, E.3)', '2023-12-28', null, null),
  ('USP-UDU', 1, 'WEIGHT_VARIATION', 'USP', '{US}', '{UNCOATED,FILM_COATED}', '{"firstUnits":10,"totalUnits":30,"firstK":"2.4","secondK":"2.0","acceptanceLimit":"15.0","unitLimitPercent":"25.0","referenceLow":"98.5","referenceHigh":"101.5","avDecimals":1}', 'MEDIUM_HIGH', 'USP uniformity of dosage units, weight variation by acceptance value (harmonised; tablets spec C-14, E.3)', '2023-08-01', null, null),
  ('PHEUR-SUBDIVISION', 1, 'SUBDIVISION', 'PH_EUR', '{EU}', '{UNCOATED,FILM_COATED}', '{"units":30,"innerPercent":"15","outerPercent":"25","maxOutsideInner":1,"maxOutsideOuter":0}', 'MEDIUM', 'Ph. Eur. monograph Tablets, subdivision of scored tablets (tablets spec TB-12 mode (e))', '2023-12-28', null, 'Recollection; verify against the current text.'),
  ('IP-FRIABILITY', 1, 'FRIABILITY', 'IP', '{IN}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE,CHEWABLE}', '{"maxLossPercent":"1.0","rotations":100,"rpmMin":"24","rpmMax":"26","targetSampleGrams":"6.5","heavyUnitMg":"650","heavyUnitCount":10,"repeatRuns":3,"lossDecimals":1}', 'MEDIUM_LOW', 'Indian Pharmacopoeia friability, expected to follow the harmonised procedure (tablets spec E.4; IP 2026 not seen)', '2023-12-28', null, null),
  ('PHEUR-FRIABILITY', 1, 'FRIABILITY', 'PH_EUR', '{EU}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE,CHEWABLE}', '{"maxLossPercent":"1.0","rotations":100,"rpmMin":"24","rpmMax":"26","targetSampleGrams":"6.5","heavyUnitMg":"650","heavyUnitCount":10,"repeatRuns":3,"lossDecimals":1}', 'HIGH', 'Ph. Eur. friability of uncoated tablets (harmonised; tablets spec E.4)', '2023-08-01', null, null),
  ('USP-FRIABILITY', 1, 'FRIABILITY', 'USP', '{US}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE,CHEWABLE}', '{"maxLossPercent":"1.0","rotations":100,"rpmMin":"24","rpmMax":"26","targetSampleGrams":"6.5","heavyUnitMg":"650","heavyUnitCount":10,"repeatRuns":3,"lossDecimals":1}', 'HIGH', 'USP tablet friability (informational chapter, harmonised; tablets spec E.4): the 1.0 % binds once the specification adopts it', '2023-08-01', null, null),
  ('IP-DISINTEGRATION', 1, 'DISINTEGRATION', 'IP', '{IN}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE}', '{"units":6,"staging":{"failMin":1,"failMax":2,"retestUnits":12,"passMin":16},"types":{"UNCOATED":{"minutes":"15","tempMin":"35","tempMax":"39"},"FILM_COATED":{"minutes":"30","tempMin":"35","tempMax":"39"},"SUGAR_COATED":{"minutes":"60","tempMin":"35","tempMax":"39"},"OTHER_COATED":{"minutes":"60","tempMin":"35","tempMax":"39"},"GASTRO_RESISTANT":{"minutes":"60","acidMinutes":"120","tempMin":"35","tempMax":"39"},"EFFERVESCENT":{"minutes":"5","tempMin":"15","tempMax":"25"},"SOLUBLE":{"minutes":"3","tempMin":"15","tempMax":"25"},"DISPERSIBLE":{"minutes":"3","tempMin":"15","tempMax":"25"},"ORODISPERSIBLE":{"minutes":"3","tempMin":"35","tempMax":"39"}}}', 'LOW', 'Indian Pharmacopoeia disintegration, expected to follow the limits of tablets spec E.5 (IP 2026 not seen)', '2023-12-28', null, null),
  ('PHEUR-DISINTEGRATION', 1, 'DISINTEGRATION', 'PH_EUR', '{EU}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE}', '{"units":6,"staging":{"failMin":1,"failMax":2,"retestUnits":12,"passMin":16},"types":{"UNCOATED":{"minutes":"15","tempMin":"35","tempMax":"39"},"FILM_COATED":{"minutes":"30","tempMin":"35","tempMax":"39"},"SUGAR_COATED":{"minutes":"60","tempMin":"35","tempMax":"39"},"OTHER_COATED":{"minutes":"60","tempMin":"35","tempMax":"39"},"GASTRO_RESISTANT":{"minutes":"60","acidMinutes":"120","tempMin":"35","tempMax":"39"},"EFFERVESCENT":{"minutes":"5","tempMin":"15","tempMax":"25"},"SOLUBLE":{"minutes":"3","tempMin":"15","tempMax":"25"},"DISPERSIBLE":{"minutes":"3","tempMin":"15","tempMax":"25"},"ORODISPERSIBLE":{"minutes":"3","tempMin":"35","tempMax":"39"}}}', 'MEDIUM', 'Ph. Eur. disintegration of tablets and the monograph Tablets (tablets spec E.5)', '2023-12-28', null, 'Uncoated 15 min high confidence; the other types medium or lower; retest staging as harmonised wording.'),
  ('USP-DISINTEGRATION', 1, 'DISINTEGRATION', 'USP', '{US}', '{UNCOATED,FILM_COATED,SUGAR_COATED,OTHER_COATED,GASTRO_RESISTANT,EFFERVESCENT,SOLUBLE,DISPERSIBLE,ORODISPERSIBLE}', '{"units":6,"staging":{"failMin":1,"failMax":2,"retestUnits":12,"passMin":16},"types":{"UNCOATED":{"tempMin":"35","tempMax":"39"},"FILM_COATED":{"tempMin":"35","tempMax":"39"},"SUGAR_COATED":{"tempMin":"35","tempMax":"39"},"OTHER_COATED":{"tempMin":"35","tempMax":"39"},"GASTRO_RESISTANT":{"tempMin":"35","tempMax":"39"},"EFFERVESCENT":{"tempMin":"35","tempMax":"39"},"SOLUBLE":{"tempMin":"35","tempMax":"39"},"DISPERSIBLE":{"tempMin":"35","tempMax":"39"},"ORODISPERSIBLE":{"tempMin":"35","tempMax":"39"}}}', 'HIGH', 'USP disintegration (harmonised apparatus and staging; the time is the monograph''s, tablets spec E.5)', '2023-12-28', null, null);

-- Review 3c finding 5: a batch market whose pharmacopoeia has, by decision recorded here, no in-process rule set for a
-- test. Any other batch market without a rule set for the test and tablet type fails the check closed (0892). The rows
-- equal src/blocks/ipc/rule-sets.ts NOT_APPLICABLE (a parity test). Insert-only and audited.
create table tab.compendial_not_applicable (
  test            text not null check (test in ('UNIFORMITY_OF_WEIGHT', 'WEIGHT_VARIATION', 'SUBDIVISION', 'FRIABILITY', 'DISINTEGRATION')),
  market          text not null references market.market (code),
  reason          text not null check (btrim(reason) <> ''),
  source          text not null check (btrim(source) <> ''),
  effective_from  date not null,
  primary key (test, market)
);
revoke all on tab.compendial_not_applicable from public;
create trigger aa_compendial_not_applicable_insert_only before update or delete on tab.compendial_not_applicable for each row execute function kernel.reject_mutation();
create trigger aa_compendial_not_applicable_no_truncate before truncate on tab.compendial_not_applicable for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.compendial_not_applicable', 'compendial_not_applicable', 'test', true);

insert into tab.compendial_not_applicable (test, market, reason, source, effective_from) values
  ('UNIFORMITY_OF_WEIGHT', 'US', 'USP-NF sets no compendial in-process weight band for drug tablets; in-process limits are in-house, derived from process data, and uniformity is judged at release by uniformity of dosage units',
   '21 CFR 211.110(b); tablets spec E.2 (USP-NF row)', '2023-12-28');

create table tab.ipc_rule (
  key             text primary key check (key ~ '^[a-z][a-zA-Z0-9.]{1,127}$'),
  value           text not null check (value ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'),
  unit            text not null,
  source          text not null check (btrim(source) <> ''),
  effective_from  date not null
);
revoke all on tab.ipc_rule from public;
create trigger aa_ipc_rule_insert_only before update or delete on tab.ipc_rule for each row execute function kernel.reject_mutation();
create trigger aa_ipc_rule_no_truncate before truncate on tab.ipc_rule for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.ipc_rule', 'ipc_rule', 'key', true);

insert into tab.ipc_rule (key, value, unit, source, effective_from) values
  ('tablets.compression.ipcSampleMaxInterval', '30', 'min', 'Schedule M Part VIII 3.8', '2023-12-28');

select kernel.set_actor_context(null);

grant select on tab.compendial_rule_set, tab.compendial_not_applicable, tab.ipc_rule to ebmr_app;

reset role;
