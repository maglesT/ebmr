-- Tablets server, Phase 3 slice 3b (builder B): the block versions TB-02@1 (sifting and milling with screen integrity),
-- TB-03@1 (solutions with use-by), TB-04@1 (wet granulation end point), TB-05@1 (drying with the LOD loop) and TB-07@1
-- (blending, lubrication and blend uniformity) in the database's own registers, and the granulation-side process
-- equipment their G-06 values come from (tablets spec B.2; controls IN-36, IN-13, PR-29, DI-30, DI-31; ADR 0012: the
-- rules hold when the application's own database credentials are used directly).
--
--   * recipe.block_data_schema: the data schemas of every entry kind of the five versions as src/blocks/tb-0x.ts declare
--     them (TB-04, TB-05 and TB-07 take G-06's six kinds unchanged); a parity test compares them with the registry
--     (test/blocks/granulation/db-guards.test.ts). A version's schemas never change (ADR 0010).
--   * recipe.engine_name: the five block types and their rule codes (a test run's record may hold them, recipe-core
--     0346), the codes only the database gives included (TB04-BINDER-EXPIRED and others).
--   * tab.process_tag and tab.process_device: three more kinds of process equipment (GRANULATOR, DRYER, BLENDER) and
--     their tags (integration-sdk process/tags.ts GRANULATION_TAGS), so a granulation step's values arrive and are
--     claimed exactly as a press's (tablets 0820).
--   * tab.g06_step_node (CREATE OR REPLACE from 0820): a step bound to a process device is a G-06 step or a TB-04, TB-05
--     or TB-07 step (they carry G-06's configuration), so their values stand on the claimed reading of the step's device.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 0850_granulation_registers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the block versions TB-02@1, TB-03@1, TB-04@1, TB-05@1 and TB-07@1 of Phase 3 slice 3b in the registers every entry is checked against (DI-30, IN-36)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
('TB-02', '1', 'ENTRY', 'SCREEN_CHECK', '{"type":"object","fields":{"screen":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"aperture":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string","enum":["um","mm","mesh"]}}},"when":{"type":"string","enum":["BEFORE","AFTER"]},"result":{"type":"string","enum":["INTACT","DAMAGED"]}}}'),
  ('TB-02', '1', 'ENTRY', 'MATERIAL_PASS', '{"type":"object","fields":{"screen":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"material":{"type":"string"},"lot":{"type":"string","optional":true},"quantityIn":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"quantityOut":{"type":"object","fields":{"value":{"type":"decimal","min":"0"},"unit":{"type":"string"}}},"oversize":{"type":"object","fields":{"value":{"type":"decimal","min":"0"},"unit":{"type":"string"}},"optional":true},"foreignMatter":{"type":"boolean"},"foreignMatterDescription":{"type":"string","optional":true}}}'),
  ('TB-03', '1', 'ENTRY', 'PREPARED', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"appearance":{"type":"string","enum":["COMPLIES","DOES_NOT_COMPLY"]}}}'),
  ('TB-03', '1', 'ENTRY', 'DISCARD', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"method":{"type":"string"}}}'),
  ('TB-04', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-04', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-04', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-04', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-04', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-04', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-04', '1', 'ENTRY', 'MASSING_START', '{"type":"object","fields":{}}'),
  ('TB-04', '1', 'ENTRY', 'END_POINT', '{"type":"object","fields":{"actual":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$","optional":true},"reason":{"type":"string","optional":true}}}'),
  ('TB-04', '1', 'ENTRY', 'BINDER_ADDITION', '{"type":"object","fields":{"preparation":{"type":"string","pattern":"^EN-[1-9][0-9]{0,8}$"},"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}}}}'),
  ('TB-04', '1', 'ENTRY', 'EXTRA_FLUID', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"reason":{"type":"string"}}}'),
  ('TB-05', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-05', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-05', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-05', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-05', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-05', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-05', '1', 'ENTRY', 'DRYING_START', '{"type":"object","fields":{}}'),
  ('TB-05', '1', 'ENTRY', 'DRYING_END', '{"type":"object","fields":{}}'),
  ('TB-05', '1', 'ENTRY', 'LOD_SAMPLE', '{"type":"object","fields":{"analyser":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"sampleMass":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}}}}'),
  ('TB-05', '1', 'ENTRY', 'BAG_CHECK', '{"type":"object","fields":{"bag":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"when":{"type":"string","enum":["BEFORE","AFTER"]},"result":{"type":"string","enum":["INTACT","DAMAGED"]},"lastProduct":{"type":"string","optional":true},"washRecord":{"type":"string","optional":true},"dedicatedTo":{"type":"string","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'SETPOINT_READBACK', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'ACTUAL', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'ALARM', '{"type":"object","fields":{"tag":{"type":"string","pattern":"^[a-z][a-z0-9_]*(\\.[a-zA-Z0-9_]+)+$"},"value":{"type":"decimal"},"unit":{"type":"string"},"source":{"type":"string","enum":["EQUIPMENT","MANUAL"]},"readingId":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$","optional":true},"quality":{"type":"string","enum":["GOOD","UNCERTAIN","BAD","STALE"],"optional":true},"receivedAtUs":{"type":"string","pattern":"^[0-9]{1,20}$","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'ALARM_ACK', '{"type":"object","fields":{"alarm":{"type":"string"},"comment":{"type":"string","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'INTERFACE_LOSS', '{"type":"object","fields":{"reason":{"type":"string"}}}'),
  ('TB-07', '1', 'ENTRY', 'RECIPE_CHECK', '{"type":"object","fields":{"recipe":{"type":"string"},"recipeVersion":{"type":"string"}}}'),
  ('TB-07', '1', 'ENTRY', 'BLEND_START', '{"type":"object","fields":{}}'),
  ('TB-07', '1', 'ENTRY', 'BLEND_END', '{"type":"object","fields":{}}'),
  ('TB-07', '1', 'ENTRY', 'LUBRICANT_ADDED', '{"type":"object","fields":{"quantity":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"lot":{"type":"string","optional":true}}}'),
  ('TB-07', '1', 'ENTRY', 'LUBRICATION_END', '{"type":"object","fields":{}}'),
  ('TB-07', '1', 'ENTRY', 'BU_SAMPLE', '{"type":"object","fields":{"location":{"type":"string","pattern":"^[A-Z0-9][A-Z0-9_-]{0,31}$"},"replicate":{"type":"integer","min":1,"max":6},"mass":{"type":"object","fields":{"value":{"type":"decimal","min":"0","minExclusive":true},"unit":{"type":"string"}}},"justification":{"type":"string","optional":true}}}');

insert into recipe.engine_name (name, kind) values
  ('TB-02', 'BLOCK_TYPE'), ('TB-03', 'BLOCK_TYPE'), ('TB-04', 'BLOCK_TYPE'), ('TB-05', 'BLOCK_TYPE'),
  ('TB-07', 'BLOCK_TYPE'), ('TB02-AFTER-CHECK-MISSING', 'RULE_CODE'), ('TB02-APERTURE', 'RULE_CODE'),
  ('TB02-CHECK-ORDER', 'RULE_CODE'), ('TB02-DUPLICATE-SCREEN', 'RULE_CODE'), ('TB02-ENTRY', 'RULE_CODE'),
  ('TB02-EQUIPMENT-UNCHECKED', 'RULE_CODE'), ('TB02-FOREIGN-MATTER', 'RULE_CODE'),
  ('TB02-NO-EQUIPMENT', 'RULE_CODE'), ('TB02-NO-PRE-CHECK', 'RULE_CODE'), ('TB02-NOTHING-PROCESSED', 'RULE_CODE'),
  ('TB02-OVERSIZE', 'RULE_CODE'), ('TB02-QUANTITY', 'RULE_CODE'), ('TB02-SCREEN', 'RULE_CODE'),
  ('TB02-SCREEN-DAMAGED', 'RULE_CODE'), ('TB03-DISCARD', 'RULE_CODE'), ('TB03-ENTRY', 'RULE_CODE'),
  ('TB03-NO-USE-BY', 'RULE_CODE'), ('TB03-NOT-PREPARED', 'RULE_CODE'), ('TB03-TWICE', 'RULE_CODE'),
  ('TB03-USE-BY', 'RULE_CODE'), ('TB04-BINDER-EXPIRED', 'RULE_CODE'), ('TB04-BINDER-OVERUSE', 'RULE_CODE'),
  ('TB04-BINDER-PREPARATION', 'RULE_CODE'), ('TB04-BINDER-RANGE', 'RULE_CODE'), ('TB04-BINDER-UNIT', 'RULE_CODE'),
  ('TB04-ENDPOINT', 'RULE_CODE'), ('TB04-ENDPOINT-COMPUTED', 'RULE_CODE'), ('TB04-ENDPOINT-EARLY', 'RULE_CODE'),
  ('TB04-ENDPOINT-ITEM', 'RULE_CODE'), ('TB04-ENDPOINT-TAG', 'RULE_CODE'), ('TB04-ENDPOINT-TWICE', 'RULE_CODE'),
  ('TB04-ENDPOINT-VALUE', 'RULE_CODE'), ('TB04-ENTRY', 'RULE_CODE'), ('TB04-EXTRA-NOT-ALLOWED', 'RULE_CODE'),
  ('TB04-EXTRA-NOT-IN-BRANCH', 'RULE_CODE'), ('TB04-EXTRA-ROLE', 'RULE_CODE'), ('TB04-EXTRA-UNIT', 'RULE_CODE'),
  ('TB04-MANUAL-ENDPOINT', 'RULE_CODE'), ('TB04-MASSING-TWICE', 'RULE_CODE'), ('TB04-NO-ENDPOINT', 'RULE_CODE'),
  ('TB04-NO-EXTRA', 'RULE_CODE'), ('TB04-NO-MASSING-START', 'RULE_CODE'), ('TB04-NOTHING', 'RULE_CODE'),
  ('TB05-BAG-AFTER-MISSING', 'RULE_CODE'), ('TB05-BAG-DAMAGED', 'RULE_CODE'), ('TB05-BAG-DEDICATED', 'RULE_CODE'),
  ('TB05-BAG-ORDER', 'RULE_CODE'), ('TB05-BAG-TWICE', 'RULE_CODE'), ('TB05-BAG-UNCHECKED', 'RULE_CODE'),
  ('TB05-BAG-WASH', 'RULE_CODE'), ('TB05-DRYING-TWICE', 'RULE_CODE'), ('TB05-ENTRY', 'RULE_CODE'),
  ('TB05-ITERATIONS', 'RULE_CODE'), ('TB05-LOD-ITEM', 'RULE_CODE'), ('TB05-LOD-LIMITS', 'RULE_CODE'),
  ('TB05-LOOP-BOUND', 'RULE_CODE'), ('TB05-NO-BAG', 'RULE_CODE'), ('TB05-NO-LOOP', 'RULE_CODE'),
  ('TB05-NO-SAMPLE', 'RULE_CODE'), ('TB05-NOT-DRIED', 'RULE_CODE'), ('TB05-NOT-STARTED', 'RULE_CODE'),
  ('TB05-SAMPLE-EARLY', 'RULE_CODE'), ('TB05-SAMPLE-TWICE', 'RULE_CODE'), ('TB07-BLEND-SHORT', 'RULE_CODE'),
  ('TB07-BU-EARLY', 'RULE_CODE'), ('TB07-BU-PLAN', 'RULE_CODE'), ('TB07-BU-RESULTS', 'RULE_CODE'),
  ('TB07-ENTRY', 'RULE_CODE'), ('TB07-LUBRICANT-EARLY', 'RULE_CODE'), ('TB07-LUBRICATION-SHORT', 'RULE_CODE'),
  ('TB07-NO-BU-PLAN', 'RULE_CODE'), ('TB07-NO-LUBRICANT', 'RULE_CODE'), ('TB07-NO-LUBRICATION', 'RULE_CODE'),
  ('TB07-NOT-BLENDED', 'RULE_CODE'), ('TB07-NOT-LUBRICATED', 'RULE_CODE'), ('TB07-NOT-PLANNED', 'RULE_CODE'),
  ('TB07-NOT-STARTED', 'RULE_CODE'), ('TB07-SAMPLE-SIZE', 'RULE_CODE'), ('TB07-SAMPLE-TWICE', 'RULE_CODE'),
  ('TB07-SAMPLE-UNIT', 'RULE_CODE'), ('TB07-TIME', 'RULE_CODE'), ('TB07-TIME-COMPUTED', 'RULE_CODE'),
  ('TB07-TIME-ITEM', 'RULE_CODE'), ('TB07-TWICE', 'RULE_CODE');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Granulation-side process equipment (integration-sdk GRANULATION_EQUIPMENT_KINDS, GRANULATION_TAGS)

alter table tab.process_tag drop constraint process_tag_equipment_kind_check;
alter table tab.process_tag add constraint process_tag_equipment_kind_check
  check (equipment_kind in ('PRESS', 'COATER', 'GRANULATOR', 'DRYER', 'BLENDER'));
alter table tab.process_device drop constraint process_device_equipment_kind_check;
alter table tab.process_device add constraint process_device_equipment_kind_check
  check (equipment_kind in ('PRESS', 'COATER', 'GRANULATOR', 'DRYER', 'BLENDER'));

insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values
  ('granulator.impeller_rpm', 'GRANULATOR', 'rpm', 0, false, true),
  ('granulator.chopper_rpm', 'GRANULATOR', 'rpm', 0, false, true),
  ('granulator.power_kW', 'GRANULATOR', 'kW', 2, false, false),
  ('granulator.torque_Nm', 'GRANULATOR', 'N.m', 1, false, false),
  ('granulator.product_temp_C', 'GRANULATOR', 'degC', 1, false, false),
  ('granulator.binder_kg', 'GRANULATOR', 'kg', 3, false, false),
  ('dryer.inlet_temp_C', 'DRYER', 'degC', 1, false, true),
  ('dryer.bed_temp_C', 'DRYER', 'degC', 1, false, false),
  ('dryer.exhaust_temp_C', 'DRYER', 'degC', 1, false, false),
  ('dryer.airflow_m3_h', 'DRYER', 'm3/h', 0, false, true),
  ('blender.speed_rpm', 'BLENDER', 'rpm', 1, false, true),
  ('blender.revolutions', 'BLENDER', 'count', 0, true, false);

-- As 0820: the phase p_step of batch p_batch's MBR that runs on a process device: a G-06 step, or a TB-04, TB-05 or
-- TB-07 step (G-06's configuration and entry kinds inside a granulation block); refuses anything else.
create or replace function tab.g06_step_node(p_batch uuid, p_step text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_node jsonb := recipe.step_node(recipe.batch_mbr_content(p_batch), p_step);
begin
  if v_node is null or v_node -> 'block' ->> 'type' is null or v_node -> 'block' ->> 'type' not in ('G-06', 'TB-04', 'TB-05', 'TB-07') then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-130 %s is not an automated equipment step (G-06, or a TB-04, TB-05 or TB-07 step) of this batch', coalesce(p_step, 'NULL'));
  end if;
  return v_node;
end
$$;

reset role;
