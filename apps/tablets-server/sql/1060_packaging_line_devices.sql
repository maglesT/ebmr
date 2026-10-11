-- Tablets edition, Phase 3 slice 6c (D-S6-8): the packaging-line process equipment behind the site gateway.
--
--   * tab.process_tag and tab.process_device: two more kinds of process equipment, the bottle line of TB-23
--     (BOTTLE_LINE) and the cartoner of TB-24 (CARTONER), with their run values exactly as the integration SDK names
--     them (integration-sdk process/tags.ts PACKAGING_LINE_TAGS), so their readings arrive and are taken exactly as a
--     press's (tablets 0820). The kind lists of the two check constraints are widened from what they hold when this
--     runs (tab.forming_constraint_values, tablets 0930), never narrowed.
--   * The fluid-bed dryer keeps its released kind DRYER (tablets 0850); no kind is renamed.
--   * tab.bind_step_device and the reading checks of 0820 are unchanged: a step binds the process device of the unit
--     its equipment use names whatever its kind, and a reading is taken only for a tag of its device's kind.
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

do $$
declare
  r      record;
  v_vals text[];
begin
  for r in select * from (values ('tab.process_tag'::regclass, 'process_tag_equipment_kind_check', 'equipment_kind'),
                                 ('tab.process_device'::regclass, 'process_device_equipment_kind_check', 'equipment_kind')) x (tbl, con, col) loop
    v_vals := array(select distinct x from unnest(tab.forming_constraint_values(r.tbl, r.con, r.col) || array['BOTTLE_LINE', 'CARTONER']) x order by x);
    execute format('alter table %s drop constraint %I', r.tbl, r.con);
    execute format('alter table %s add constraint %I check (%I = any (%L::text[]))', r.tbl, r.con, r.col, v_vals);
  end loop;
end
$$;

insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values
  ('bottle.speed_bpm', 'BOTTLE_LINE', '/min', 0, false, true),
  ('bottle.induction_power_pct', 'BOTTLE_LINE', '%', 1, false, true),
  ('bottle.count', 'BOTTLE_LINE', 'count', 0, true, false),
  ('bottle.reject_count', 'BOTTLE_LINE', 'count', 0, true, false),
  ('cartoner.speed_cpm', 'CARTONER', '/min', 0, false, true),
  ('cartoner.count', 'CARTONER', 'count', 0, true, false),
  ('cartoner.reject_count', 'CARTONER', 'count', 0, true, false);

reset role;
