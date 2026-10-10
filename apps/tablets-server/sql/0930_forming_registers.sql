-- Tablets server, Phase 3 slice 3d (builder B): the block versions TB-06@1 (dry granulation by roller compaction) and
-- TB-16@1 (bilayer compression) in the database's own registers, and the process equipment their G-06 values come from
-- (tablets spec B.2; controls IN-26, IN-35, IN-36, PR-21, PR-29, DI-30, DI-31; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the two versions as src/blocks/tb-06.ts and
--     tb-16.ts declare them (both take G-06's six kinds unchanged; TB-16 takes TB-11's run and test kinds unchanged); a
--     parity test compares them with the registry (test/blocks/forming/db-guards.test.ts). A version's schemas never
--     change (ADR 0010).
--   * recipe.engine_name: the two block types and their rule codes (a test run's record may hold them, recipe-core 0346),
--     the codes only the database gives included (TB06-PRESS, TB16-CHARGE and the others).
--   * tab.process_tag and tab.process_device: one more kind of process equipment (ROLLER_COMPACTOR) and its tags, and the
--     layer settings of a bilayer press (integration-sdk process/tags.ts ROLLER_COMPACTOR_TAGS, BILAYER_PRESS_TAGS), so a
--     compaction or bilayer step's values arrive and are claimed exactly as a press's (tablets 0820). The kind lists of
--     the two check constraints are widened from what they hold when this runs (another migration may have widened them
--     already), never narrowed.
--   * tab.process_block_type: TB-06 and TB-16 run on a process device (tab.g06_step_node, tab.bind_step_device and the
--     interface-loss close rule of tablets 0870 and 0874 read it).
--   * tab.ipc_overdue_alarm: the missed-check alarm (tablets 0893) also records the ribbon check of a roller compaction
--     (test RIBBON), widened the same way.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0930_forming_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-06@1 and TB-16@1 of Phase 3 slice 3d in the registers every entry is checked against (DI-30, IN-36)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-06', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-06', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-06', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-06', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-06', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-06', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-06', '1', 'ENTRY', 'RUN_START', '{"type":"object","fields":{"press":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"}}}'),
  ('TB-06', '1', 'ENTRY', 'FEED', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}}}}'),
  ('TB-06', '1', 'ENTRY', 'RIBBON_CHECK', '{"type":"object","fields":{"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"density":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"solidFraction":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"appearance":{"type":"string","enum":["COMPLIES","DOES_NOT_COMPLY"]}}}'),
  ('TB-06', '1', 'ENTRY', 'SCREEN_CHECK', '{"type":"object","fields":{"screen":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"aperture":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string","enum":["um","mm","mesh"]}}},"when":{"type":"string","enum":["BEFORE","AFTER"]},"result":{"type":"string","enum":["INTACT","DAMAGED"]}}}'),
  ('TB-06', '1', 'ENTRY', 'GRANULE_OUTPUT', '{"type":"object","fields":{"screen":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"granules":{"type":"object","fields":{"value":{"type":"decimal","min":"0"},"unit":{"type":"string"}}},"fines":{"type":"object","fields":{"value":{"type":"decimal","min":"0"},"unit":{"type":"string"}}}}}'),
  ('TB-06', '1', 'ENTRY', 'FINES_RECYCLED', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}}}}'),
  ('TB-06', '1', 'ENTRY', 'RUN_END', '{"type":"object","fields":{}}'),
  ('TB-06', '1', 'ENTRY', 'YIELD', '{"type":"object","fields":{}}'),
  ('TB-16', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-16', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-16', '1', 'ENTRY', 'HOPPER_CHARGE', '{"type":"object","fields":{"layer":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$"},"hopper":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"blend":{"type":"string","pattern":"^[A-Z][A-Z0-9_]{0,39}$"},"chargeId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}}'),
  ('TB-16', '1', 'ENTRY', 'RUN_START', '{"type":"object","fields":{"press":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"counter":{"type":"integer","min":0,"optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'STOPPAGE_START', '{"type":"object","fields":{}}'),
  ('TB-16', '1', 'ENTRY', 'STOPPAGE_END', '{"type":"object","fields":{}}'),
  ('TB-16', '1', 'ENTRY', 'CHANGE', '{"type":"object","fields":{"change":{"type":"string","enum":["SETTING","TOOLING"]}}}'),
  ('TB-16', '1', 'ENTRY', 'RUN_END', '{"type":"object","fields":{}}'),
  ('TB-16', '1', 'ENTRY', 'STATION_SWEEP', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"stations":{"type":"array","items":{"type":"object","fields":{"station":{"type":"integer","min":1,"max":100},"weight":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"hardness":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":100}}}'),
  ('TB-16', '1', 'ENTRY', 'WEIGHT_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100,"optional":true},"groupWeight":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assay":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"assayRef":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'WEIGHT_SECOND_STAGE', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"check":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$"},"weights":{"type":"array","items":{"type":"decimal","min":"0","minExclusive":true},"minItems":1,"maxItems":100}}}'),
  ('TB-16', '1', 'ENTRY', 'PHYSICAL_CHECK', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"array","items":{"type":"object","fields":{"thickness":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"diameter":{"type":"decimal","min":"0","minExclusive":true,"optional":true},"hardness":{"type":"decimal","min":"0","minExclusive":true,"optional":true}}},"minItems":1,"maxItems":20},"defects":{"type":"array","items":{"type":"string","enum":["CAPPING","LAMINATION","STICKING","PICKING","CHIPPING","EMBOSSING","BLACK_SPECKS","OIL_CONTAMINATION"]},"maxItems":8,"optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'FRIABILITY_RUN', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"tablets":{"type":"integer","min":1,"max":200},"initialMass":{"type":"decimal","min":"0","minExclusive":true},"finalMass":{"type":"decimal"},"rotations":{"type":"integer","min":1,"max":1000},"rpm":{"type":"decimal","min":"0","minExclusive":true},"broken":{"type":"boolean"},"doubtful":{"type":"boolean","optional":true},"repeatOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'DT_START', '{"type":"object","fields":{"instrument":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":300,"optional":true},"sampledAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true},"stream":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$","optional":true},"counter":{"type":"integer","min":0,"optional":true},"bathTemperature":{"type":"decimal"},"stage":{"type":"string","enum":["MAIN","ACID","BUFFER"]},"retestOf":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true}}}'),
  ('TB-16', '1', 'ENTRY', 'DT_END', '{"type":"object","fields":{"start":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true},"capture":{"type":"string","enum":["DEVICE","MANUAL"]},"readings":{"type":"array","items":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"minItems":1,"maxItems":12,"optional":true},"units":{"type":"array","items":{"type":"object","fields":{"disintegrated":{"type":"boolean"},"seconds":{"type":"decimal","min":"0","optional":true}}},"minItems":1,"maxItems":12}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-06', 'BLOCK_TYPE'), ('TB-16', 'BLOCK_TYPE'),
  ('TB06-AFTER-CHECK-MISSING', 'RULE_CODE'), ('TB06-AFTER-YIELD', 'RULE_CODE'), ('TB06-APERTURE', 'RULE_CODE'),
  ('TB06-CHECK-ORDER', 'RULE_CODE'), ('TB06-DISCHARGE', 'RULE_CODE'), ('TB06-DUPLICATE-SCREEN', 'RULE_CODE'),
  ('TB06-END-CHECK', 'RULE_CODE'), ('TB06-ENDED', 'RULE_CODE'), ('TB06-ENTRY', 'RULE_CODE'), ('TB06-FINES-LIMIT', 'RULE_CODE'),
  ('TB06-FINES-QUANTITY', 'RULE_CODE'), ('TB06-NO-EQUIPMENT', 'RULE_CODE'), ('TB06-NO-FEED', 'RULE_CODE'),
  ('TB06-NO-PRE-CHECK', 'RULE_CODE'), ('TB06-NO-RIBBON', 'RULE_CODE'), ('TB06-NO-YIELD', 'RULE_CODE'),
  ('TB06-NOT-STARTED', 'RULE_CODE'), ('TB06-NOTHING-DISCHARGED', 'RULE_CODE'), ('TB06-PRESS', 'RULE_CODE'),
  ('TB06-PROCESS-LIMITS', 'RULE_CODE'), ('TB06-QRM', 'RULE_CODE'), ('TB06-RECYCLE', 'RULE_CODE'),
  ('TB06-RECYCLE-NOT-ALLOWED', 'RULE_CODE'), ('TB06-RIBBON', 'RULE_CODE'), ('TB06-RIBBON-PARAMETERS', 'RULE_CODE'),
  ('TB06-RUNNING', 'RULE_CODE'), ('TB06-SCREEN', 'RULE_CODE'), ('TB06-SCREEN-DAMAGED', 'RULE_CODE'), ('TB06-TWICE', 'RULE_CODE'),
  ('TB06-UNIT', 'RULE_CODE'), ('TB06-YIELD', 'RULE_CODE'),
  ('TB16-CEILING', 'RULE_CODE'), ('TB16-CHARGE', 'RULE_CODE'), ('TB16-DEVICE', 'RULE_CODE'), ('TB16-DISCHARGE', 'RULE_CODE'),
  ('TB16-ENDED', 'RULE_CODE'), ('TB16-ENTRY', 'RULE_CODE'), ('TB16-HOPPER', 'RULE_CODE'), ('TB16-INSTRUMENT', 'RULE_CODE'),
  ('TB16-LAYER', 'RULE_CODE'), ('TB16-LAYER-ONLY', 'RULE_CODE'), ('TB16-LAYER-UNCHARGED', 'RULE_CODE'), ('TB16-LAYERS', 'RULE_CODE'),
  ('TB16-NO-EQUIPMENT', 'RULE_CODE'), ('TB16-NO-SETUP', 'RULE_CODE'), ('TB16-PLAN', 'RULE_CODE'), ('TB16-PRESS', 'RULE_CODE'),
  ('TB16-PROCESS-LIMITS', 'RULE_CODE'), ('TB16-QRM', 'RULE_CODE'), ('TB16-SEPARATION', 'RULE_CODE'), ('TB16-STREAM', 'RULE_CODE'),
  ('TB16-STREAM-CLASH', 'RULE_CODE'), ('TB16-WRONG-BLEND', 'RULE_CODE');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- The roller compactor and the bilayer press settings (integration-sdk FORMING_EQUIPMENT_KINDS, FORMING_TAGS)

-- The values a check constraint p_constraint of table p_table allows column p_column to take, read exactly (review 3d):
-- the constraint is accepted only in the form PostgreSQL gives a list check (column = ANY (<constant text array>), from
-- IN (...), ANY (ARRAY[...]) or ANY ('{...}'::text[])); the constant is evaluated as written, so every literal comes back
-- whole (digits, hyphens and quotes included). Any other form, or a constant that is not a text array, fails loudly.
create function tab.forming_constraint_values(p_table regclass, p_constraint text, p_column text) returns text[]
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
declare
  v_def  text;
  v_expr text;
  v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c where c.conrelid = p_table and c.conname = p_constraint and c.contype = 'c';
  if v_def is null then
    raise exception 'SETUP: no check constraint % on %', p_constraint, p_table;
  end if;
  v_expr := (regexp_match(v_def, format('^CHECK \(\(\(?%s\)?(?:::text)? = ANY \((ARRAY\[.*\]|''(?:[^'']|'''')*''::text\[\])\)\)\)$', quote_ident(p_column))))[1];
  if v_expr is null then
    raise exception 'SETUP: constraint % on % is not a list of values of %: %', p_constraint, p_table, p_column, v_def;
  end if;
  begin
    execute format('select (%s)::text[]', v_expr) into strict v_vals;
  exception when others then
    raise exception 'SETUP: the values of constraint % on % cannot be read (%): %', p_constraint, p_table, sqlerrm, v_def;
  end;
  if v_vals is null or cardinality(v_vals) = 0 or array_position(v_vals, null) is not null then
    raise exception 'SETUP: constraint % on % lists no values, or a null one: %', p_constraint, p_table, v_def;
  end if;
  return v_vals;
end
$$;
revoke all on function tab.forming_constraint_values(regclass, text, text) from public;

-- Widens the check constraints of the equipment kinds (equipment_kind in (...)) and of the alarm's test (test in (...)),
-- keeping every value each holds when this runs.
do $$
declare
  r      record;
  v_vals text[];
begin
  for r in select * from (values ('tab.process_tag'::regclass, 'process_tag_equipment_kind_check', 'equipment_kind', 'ROLLER_COMPACTOR'),
                                 ('tab.process_device'::regclass, 'process_device_equipment_kind_check', 'equipment_kind', 'ROLLER_COMPACTOR'),
                                 ('tab.ipc_overdue_alarm'::regclass, 'ipc_overdue_alarm_test_check', 'test', 'RIBBON')) x (tbl, con, col, addition) loop
    v_vals := array(select distinct x from unnest(tab.forming_constraint_values(r.tbl, r.con, r.col) || r.addition) x order by x);
    execute format('alter table %s drop constraint %I', r.tbl, r.con);
    execute format('alter table %s add constraint %I check (%I = any (%L::text[]))', r.tbl, r.con, r.col, v_vals);
  end loop;
end
$$;

insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values
  ('roller.force_kN', 'ROLLER_COMPACTOR', 'kN', 2, false, true),
  ('roller.gap_mm', 'ROLLER_COMPACTOR', 'mm', 2, false, true),
  ('roller.speed_rpm', 'ROLLER_COMPACTOR', 'rpm', 1, false, true),
  ('roller.feed_screw_rpm', 'ROLLER_COMPACTOR', 'rpm', 1, false, true),
  ('roller.vacuum_mbar', 'ROLLER_COMPACTOR', 'mbar', 0, false, true),
  ('roller.mill_rpm', 'ROLLER_COMPACTOR', 'rpm', 0, false, true),
  ('layer1.fill_depth_mm', 'PRESS', 'mm', 2, false, true),
  ('layer1.tamp_kN', 'PRESS', 'kN', 2, false, true),
  ('layer2.fill_depth_mm', 'PRESS', 'mm', 2, false, true),
  ('layer2.tamp_kN', 'PRESS', 'kN', 2, false, true);

insert into tab.process_block_type (block_type) values ('TB-06'), ('TB-16');

reset role;
