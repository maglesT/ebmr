-- Tablets server, Phase 3 slice 4b (builder A): the block versions TB-21@1 (blister or strip line set-up, independent
-- line check and sealing) and TB-22@1 (blister leak test) in the database's own registers, the blister machine as process
-- equipment, the leak test in the missed-check alarm, and the isolation flag of a packaging line (tablets spec B.2 TB-21,
-- TB-22; controls IN-38, PR-29, PR-33, PR-34, PR-35, PR-37, DI-30; ADR 0012: the rules hold when the application's own
-- database credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the two versions as src/blocks/tb-21.ts and
--     tb-22.ts declare them (TB-21 takes G-06's six kinds unchanged); a parity test compares them with the registry
--     (test/blocks/blister/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the two block types and their rule codes, the codes only the database gives included
--     (TB21-LINE, TB21-ISOLATION, TB21-LOT, TB21-FOIL-NOT-ISSUED, TB21-NO-LINE-CHECK and the others).
--   * tab.process_tag and tab.process_device: one more kind of process equipment (BLISTER_MACHINE) and its tags
--     (integration-sdk process/tags.ts BLISTER_TAGS), so a blister run's values arrive and are claimed exactly as a
--     press's (tablets 0820). The kind lists of the two check constraints are widened from what they hold when this runs
--     (tab.forming_constraint_values, tablets 0930), never narrowed.
--   * tab.process_block_type: TB-21 runs on a process device (tab.g06_step_node, tab.bind_step_device, the G-06
--     exception rule of 0913 and the interface-loss close rule of 0874 read it).
--   * tab.ipc_overdue_alarm: the missed-check alarm (tablets 0893) also records the leak test of TB-22 (test LEAK),
--     widened the same way.
--   * tab.line_isolation (insert-only, audited): whether a packaging line (plant.area of kind LINE) is isolated, with the
--     reference of the qualification it rests on; the latest row of a line holds (a line without one is not isolated).
--     Written only by tab.record_line_isolation, a MASTERDATA.CHANGE holder and never an administrator (EBMR-TAB-372).
--     A potent or beta-lactam uncoated product is packed only on an isolated line (Sched M VIII 7.2, IN-38 (d); the
--     guard of 0972 reads tab.line_isolated). The plant area table is recipe-core's and stays as it is.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0970_blister_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-21@1 and TB-22@1 of Phase 3 slice 4b in the registers every entry is checked against (DI-30, IN-38)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-21', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-21', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-21', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-21', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-21', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-21', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-21', '1', 'ENTRY', 'LINE_SETUP', '{"type":"object","fields":{"machine":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"artworkSet":{"type":"string","pattern":"^[!-~]{1,128}$"},"changeParts":{"type":"array","items":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"minItems":1,"maxItems":30},"materials":{"type":"array","items":{"type":"object","fields":{"role":{"type":"string","enum":["FORMING_FILM","LIDDING_FOIL","STRIP_FOIL"]},"material":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$"},"lot":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$"}}},"minItems":1,"maxItems":3}}}'),
  ('TB-21', '1', 'ENTRY', 'EQUIPMENT_CHECK', '{"type":"object","fields":{"rogueRemoved":{"type":"boolean"},"changePartsFitted":{"type":"boolean"},"emptyPocketDetector":{"type":"string","enum":["PASS","FAIL"]}}}'),
  ('TB-21', '1', 'ENTRY', 'RUN_START', '{"type":"object","fields":{"machine":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"}}}'),
  ('TB-21', '1', 'ENTRY', 'REEL_CHANGE', '{"type":"object","fields":{"role":{"type":"string","enum":["FORMING_FILM","LIDDING_FOIL","STRIP_FOIL"]},"material":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$"},"lot":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$"}}}'),
  ('TB-21', '1', 'ENTRY', 'DEFECT_CHECK', '{"type":"object","fields":{"examined":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"defects":{"type":"object","fields":{"MISPRINT":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"FOIL_CUT":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"MISSING_TABLET":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"IMPROPER_SEAL":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true}}}}}'),
  ('TB-21', '1', 'ENTRY', 'REJECTS', '{"type":"object","fields":{"emptyPocket":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"brokenPocket":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true},"vision":{"type":"string","pattern":"^[0-9]{1,18}$","optional":true}}}'),
  ('TB-21', '1', 'ENTRY', 'RUN_END', '{"type":"object","fields":{}}'),
  ('TB-21', '1', 'ENTRY', 'COUNT', '{"type":"object","fields":{"formed":{"type":"string","pattern":"^[0-9]{1,18}$"},"good":{"type":"string","pattern":"^[0-9]{1,18}$"},"setupWaste":{"type":"string","pattern":"^[0-9]{1,18}$"},"samples":{"type":"string","pattern":"^[0-9]{1,18}$"}}}'),
  ('TB-22', '1', 'ENTRY', 'RUN_START', '{"type":"object","fields":{"machine":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,63}$"},"counter":{"type":"integer","min":0,"optional":true}}}'),
  ('TB-22', '1', 'ENTRY', 'EVENT', '{"type":"object","fields":{"event":{"type":"string","enum":["RESTART","REEL_CHANGE","ADJUSTMENT"]},"counter":{"type":"integer","min":0,"optional":true}}}'),
  ('TB-22', '1', 'ENTRY', 'LEAK_TEST', '{"type":"object","fields":{"track":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$"},"tested":{"type":"string","pattern":"^[1-9][0-9]{0,17}$"},"vacuum":{"type":"decimal","min":"0","minExclusive":true},"holdSeconds":{"type":"decimal","min":"0","minExclusive":true},"leaking":{"type":"string","pattern":"^[0-9]{1,18}$"},"counter":{"type":"integer","min":0,"optional":true}}}'),
  ('TB-22', '1', 'ENTRY', 'RUN_END', '{"type":"object","fields":{"counter":{"type":"integer","min":0,"optional":true}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-21', 'BLOCK_TYPE'), ('TB-22', 'BLOCK_TYPE'),
  ('TB21-CHANGE-PART', 'RULE_CODE'), ('TB21-CHECK', 'RULE_CODE'), ('TB21-COUNT-TWICE', 'RULE_CODE'), ('TB21-COUNTED', 'RULE_CODE'),
  ('TB21-DEFECTS', 'RULE_CODE'), ('TB21-DISCHARGE', 'RULE_CODE'), ('TB21-ENDED', 'RULE_CODE'), ('TB21-ENTRY', 'RULE_CODE'),
  ('TB21-FOIL-NOT-ISSUED', 'RULE_CODE'), ('TB21-FORMAT', 'RULE_CODE'), ('TB21-FORMING', 'RULE_CODE'), ('TB21-INDEPENDENT', 'RULE_CODE'),
  ('TB21-ISOLATION', 'RULE_CODE'), ('TB21-LAST-CHECK', 'RULE_CODE'), ('TB21-LINE', 'RULE_CODE'), ('TB21-LOT', 'RULE_CODE'),
  ('TB21-MATERIAL', 'RULE_CODE'), ('TB21-MATERIALS', 'RULE_CODE'), ('TB21-NO-CHECK', 'RULE_CODE'), ('TB21-NO-COUNT', 'RULE_CODE'),
  ('TB21-NO-EQUIPMENT', 'RULE_CODE'), ('TB21-NO-LINE-CHECK', 'RULE_CODE'), ('TB21-NO-SETUP', 'RULE_CODE'), ('TB21-NOT-STARTED', 'RULE_CODE'),
  ('TB21-PART', 'RULE_CODE'), ('TB21-PRESS', 'RULE_CODE'), ('TB21-PRINTED', 'RULE_CODE'), ('TB21-RUNNING', 'RULE_CODE'),
  ('TB21-SAMPLE', 'RULE_CODE'), ('TB21-SEALING', 'RULE_CODE'), ('TB21-SETUP-TWICE', 'RULE_CODE'), ('TB21-TWICE', 'RULE_CODE'),
  ('TB22-COUNTER', 'RULE_CODE'), ('TB22-COUNTER-BACK', 'RULE_CODE'), ('TB22-DISCHARGE', 'RULE_CODE'), ('TB22-END-TEST', 'RULE_CODE'),
  ('TB22-ENDED', 'RULE_CODE'), ('TB22-ENTRY', 'RULE_CODE'), ('TB22-LEAKING', 'RULE_CODE'), ('TB22-METHOD', 'RULE_CODE'),
  ('TB22-NO-LINE-CHECK', 'RULE_CODE'), ('TB22-NOT-STARTED', 'RULE_CODE'), ('TB22-PARAMETERS', 'RULE_CODE'), ('TB22-PRESS', 'RULE_CODE'),
  ('TB22-QRM', 'RULE_CODE'), ('TB22-RUNNING', 'RULE_CODE'), ('TB22-SAMPLE', 'RULE_CODE'), ('TB22-SCHEDULE', 'RULE_CODE'),
  ('TB22-TRACK', 'RULE_CODE'), ('TB22-TRACKS', 'RULE_CODE'), ('TB22-TWICE', 'RULE_CODE');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- The blister machine (integration-sdk BLISTER_EQUIPMENT_KINDS, BLISTER_TAGS) and the leak test of the alarm

do $$
declare
  r      record;
  v_vals text[];
begin
  for r in select * from (values ('tab.process_tag'::regclass, 'process_tag_equipment_kind_check', 'equipment_kind', 'BLISTER_MACHINE'),
                                 ('tab.process_device'::regclass, 'process_device_equipment_kind_check', 'equipment_kind', 'BLISTER_MACHINE'),
                                 ('tab.ipc_overdue_alarm'::regclass, 'ipc_overdue_alarm_test_check', 'test', 'LEAK')) x (tbl, con, col, addition) loop
    v_vals := array(select distinct x from unnest(tab.forming_constraint_values(r.tbl, r.con, r.col) || r.addition) x order by x);
    execute format('alter table %s drop constraint %I', r.tbl, r.con);
    execute format('alter table %s add constraint %I check (%I = any (%L::text[]))', r.tbl, r.con, r.col, v_vals);
  end loop;
end
$$;

insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values
  ('blister.form_temp_C', 'BLISTER_MACHINE', 'degC', 1, false, true),
  ('blister.seal_temp_C', 'BLISTER_MACHINE', 'degC', 1, false, true),
  ('blister.seal_pressure_bar', 'BLISTER_MACHINE', 'bar', 2, false, true),
  ('blister.seal_dwell_s', 'BLISTER_MACHINE', 's', 2, false, true),
  ('blister.speed_cpm', 'BLISTER_MACHINE', '/min', 0, false, true),
  ('blister.cycles', 'BLISTER_MACHINE', 'count', 0, true, false);

insert into tab.process_block_type (block_type) values ('TB-21');

-- ---------------------------------------------------------------------------------------------
-- The isolation flag of a packaging line (header)

create table tab.line_isolation (
  id            uuid primary key default gen_random_uuid(),
  area_id       uuid not null references plant.area (id),
  isolated      boolean not null,
  reference     text not null check (reference ~ '^[!-~][ -~]{0,127}$'),
  person_id     uuid not null,
  account_id    uuid not null,
  recorded_at   timestamptz not null default clock_timestamp(),
  correlation_id uuid not null
);
create index line_isolation_by_area on tab.line_isolation (area_id, recorded_at);
revoke all on tab.line_isolation from public;
create trigger aa_line_isolation_insert_only before update or delete on tab.line_isolation for each row execute function kernel.reject_mutation();
create trigger aa_line_isolation_no_truncate before truncate on tab.line_isolation for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.line_isolation', array['recorded_at']);
select kernel.register_audited_table('tab.line_isolation', 'line_isolation', 'area_id', true);

-- IN-38 (d) (header): records whether line p_area (its code) is isolated, citing p_reference. Returns the record's id.
create function tab.record_line_isolation(p_area text, p_isolated boolean, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.area;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  select * into a from plant.area where code = p_area;
  if a.id is null or a.kind <> 'LINE' then
    raise exception using errcode = 'P0001', message = format('%s is no packaging line of the plant (IN-38). [EBMR-TAB-372]', left(coalesce(p_area, '(none)'), 64));
  end if;
  if p_isolated is null or coalesce(p_reference, '') !~ '^[!-~][ -~]{0,127}$' then
    raise exception using errcode = 'P0001', message = 'State whether the line is isolated and cite the qualification it rests on (IN-38). [EBMR-TAB-372]';
  end if;
  perform pg_advisory_xact_lock(hashtext('tab.line_isolation:' || a.id::text));
  insert into tab.line_isolation (area_id, isolated, reference, person_id, account_id, correlation_id)
  values (a.id, p_isolated, p_reference, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- Whether line p_area is isolated now (its latest record; none: not isolated).
create function tab.line_isolated(p_area uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce((select i.isolated from tab.line_isolation i where i.area_id = p_area order by i.recorded_at desc, i.id desc limit 1), false)
$$;

revoke all on function tab.record_line_isolation(text, boolean, text), tab.line_isolated(uuid) from public;
grant execute on function tab.record_line_isolation(text, boolean, text), tab.line_isolated(uuid) to ebmr_app;
grant select on tab.line_isolation to ebmr_app;

reset role;
