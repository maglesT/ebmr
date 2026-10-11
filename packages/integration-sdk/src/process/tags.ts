/**
 * Process tags of the tablet press and the film coater (Phase 3 slice 3a, G-06; the tag names are the 3a interface
 * of docs/build-plan/phase-3/slice-3-plan.md and never change once released), and of the granulation-side equipment
 * the TB-04, TB-05 and TB-07 blocks run on (Phase 3 slice 3b: high-shear granulator, fluid-bed dryer, blender; no
 * simulator speaks them yet, the gateway forwards their readings like the press's), of the roller compactor of TB-06 and
 * the layer settings of a bilayer press of TB-16 (Phase 3 slice 3d; no simulator speaks them yet either), and of the
 * blister machine of TB-21 (Phase 3 slice 4b: forming and sealing; no simulator speaks them yet either).
 *
 * Each tag has its engineering unit, the number of fraction digits its values carry on the wire (a value with more
 * is refused, never rounded), whether it is a counter (whole and never negative) and whether the equipment takes a
 * setpoint for it (downloaded by the server and read back by the gateway).
 */

/** The kinds the process simulators and the gateway's simulator driver speak (slice 3a). */
export const EQUIPMENT_KINDS = ['PRESS', 'COATER'] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

/** Granulation-side process equipment (slice 3b): high-shear granulator, fluid-bed dryer, blender. */
export const GRANULATION_EQUIPMENT_KINDS = ['GRANULATOR', 'DRYER', 'BLENDER'] as const;
export type GranulationEquipmentKind = (typeof GRANULATION_EQUIPMENT_KINDS)[number];

/** Dry-granulation process equipment (slice 3d, TB-06): the roller compactor with its integrated mill. */
export const FORMING_EQUIPMENT_KINDS = ['ROLLER_COMPACTOR'] as const;
export type FormingEquipmentKind = (typeof FORMING_EQUIPMENT_KINDS)[number];

/** Primary packaging process equipment (slice 4b, TB-21): the blister or strip machine (forming and sealing). */
export const BLISTER_EQUIPMENT_KINDS = ['BLISTER_MACHINE'] as const;
export type BlisterEquipmentKind = (typeof BLISTER_EQUIPMENT_KINDS)[number];

/** Every kind of process equipment whose readings the server takes (tab.process_tag, tab.process_device). */
export const PROCESS_EQUIPMENT_KINDS = [...EQUIPMENT_KINDS, ...GRANULATION_EQUIPMENT_KINDS, ...FORMING_EQUIPMENT_KINDS, ...BLISTER_EQUIPMENT_KINDS] as const;
export type ProcessEquipmentKind = (typeof PROCESS_EQUIPMENT_KINDS)[number];

export interface TagSpec {
  readonly tag: string;
  readonly equipment: ProcessEquipmentKind;
  readonly unit: string;
  /** Fraction digits of a value on the wire. */
  readonly scale: number;
  /** A count: whole, never negative, never decreasing while the equipment runs. */
  readonly counter: boolean;
  /** The equipment takes a setpoint for this tag (setpoint download and read-back). */
  readonly setpoint: boolean;
}

const spec = <T extends string>(tag: T, equipment: ProcessEquipmentKind, unit: string, scale: number, setpoint: boolean, counter = false): TagSpec & { readonly tag: T } => ({
  tag,
  equipment,
  unit,
  scale,
  counter,
  setpoint,
});

export const PRESS_TAGS = [
  spec('turret.speed_rpm', 'PRESS', 'rpm', 1, true),
  spec('force.main_kN', 'PRESS', 'kN', 2, true),
  spec('force.pre_kN', 'PRESS', 'kN', 2, true),
  spec('fill.depth_mm', 'PRESS', 'mm', 2, true),
  spec('tablet.count', 'PRESS', 'count', 0, false, true),
  spec('reject.count', 'PRESS', 'count', 0, false, true),
  spec('stroke.count', 'PRESS', 'count', 0, false, true),
] as const satisfies readonly TagSpec[];

export const COATER_TAGS = [
  spec('pan.speed_rpm', 'COATER', 'rpm', 1, true),
  spec('inlet.temp_C', 'COATER', 'degC', 1, true),
  spec('exhaust.temp_C', 'COATER', 'degC', 1, false),
  spec('bed.temp_C', 'COATER', 'degC', 1, false),
  spec('spray.rate_g_min', 'COATER', 'g/min', 1, true),
  spec('atomisation.bar', 'COATER', 'bar', 2, true),
  spec('airflow.m3_h', 'COATER', 'm3/h', 0, true),
] as const satisfies readonly TagSpec[];

/** Slice 3b: the granulation-side tags (tablets 0850 ships the same rows in tab.process_tag). */
export const GRANULATION_TAGS = [
  spec('granulator.impeller_rpm', 'GRANULATOR', 'rpm', 0, true),
  spec('granulator.chopper_rpm', 'GRANULATOR', 'rpm', 0, true),
  spec('granulator.power_kW', 'GRANULATOR', 'kW', 2, false),
  spec('granulator.torque_Nm', 'GRANULATOR', 'N.m', 1, false),
  spec('granulator.product_temp_C', 'GRANULATOR', 'degC', 1, false),
  spec('granulator.binder_kg', 'GRANULATOR', 'kg', 3, false),
  spec('dryer.inlet_temp_C', 'DRYER', 'degC', 1, true),
  spec('dryer.bed_temp_C', 'DRYER', 'degC', 1, false),
  spec('dryer.exhaust_temp_C', 'DRYER', 'degC', 1, false),
  spec('dryer.airflow_m3_h', 'DRYER', 'm3/h', 0, true),
  spec('blender.speed_rpm', 'BLENDER', 'rpm', 1, true),
  spec('blender.revolutions', 'BLENDER', 'count', 0, false, true),
] as const satisfies readonly TagSpec[];

/** Slice 3d (TB-06): the roller compactor's tags (tablets 0930 ships the same rows in tab.process_tag). */
export const ROLLER_COMPACTOR_TAGS = [
  spec('roller.force_kN', 'ROLLER_COMPACTOR', 'kN', 2, true),
  spec('roller.gap_mm', 'ROLLER_COMPACTOR', 'mm', 2, true),
  spec('roller.speed_rpm', 'ROLLER_COMPACTOR', 'rpm', 1, true),
  spec('roller.feed_screw_rpm', 'ROLLER_COMPACTOR', 'rpm', 1, true),
  spec('roller.vacuum_mbar', 'ROLLER_COMPACTOR', 'mbar', 0, true),
  spec('roller.mill_rpm', 'ROLLER_COMPACTOR', 'rpm', 0, true),
] as const satisfies readonly TagSpec[];

/**
 * Slice 3d (TB-16): the layer settings of a bilayer press, beside the press tags (the last layer's fill and the final
 * compression keep fill.depth_mm, force.pre_kN and force.main_kN). Kept out of PRESS_TAGS, so the press simulator's
 * tag set does not change; tablets 0930 ships the same rows in tab.process_tag.
 */
export const BILAYER_PRESS_TAGS = [
  spec('layer1.fill_depth_mm', 'PRESS', 'mm', 2, true),
  spec('layer1.tamp_kN', 'PRESS', 'kN', 2, true),
  spec('layer2.fill_depth_mm', 'PRESS', 'mm', 2, true),
  spec('layer2.tamp_kN', 'PRESS', 'kN', 2, true),
] as const satisfies readonly TagSpec[];

/**
 * Slice 4b (TB-21): the blister or strip machine's forming and sealing values (tablets 0970 ships the same rows in
 * tab.process_tag). The sealing temperature, pressure and dwell are the values whose validated ranges TB-21 requires.
 */
export const BLISTER_TAGS = [
  spec('blister.form_temp_C', 'BLISTER_MACHINE', 'degC', 1, true),
  spec('blister.seal_temp_C', 'BLISTER_MACHINE', 'degC', 1, true),
  spec('blister.seal_pressure_bar', 'BLISTER_MACHINE', 'bar', 2, true),
  spec('blister.seal_dwell_s', 'BLISTER_MACHINE', 's', 2, true),
  spec('blister.speed_cpm', 'BLISTER_MACHINE', '/min', 0, true),
  spec('blister.cycles', 'BLISTER_MACHINE', 'count', 0, false, true),
] as const satisfies readonly TagSpec[];

export type PressTag = (typeof PRESS_TAGS)[number]['tag'];
export type CoaterTag = (typeof COATER_TAGS)[number]['tag'];
export type GranulationTag = (typeof GRANULATION_TAGS)[number]['tag'];
export type FormingTag = (typeof ROLLER_COMPACTOR_TAGS)[number]['tag'] | (typeof BILAYER_PRESS_TAGS)[number]['tag'];
export type BlisterTag = (typeof BLISTER_TAGS)[number]['tag'];
export type ProcessTag = PressTag | CoaterTag | GranulationTag | FormingTag | BlisterTag;

/** Slice 3d: the tags of the forming blocks TB-06 and TB-16. */
export const FORMING_TAGS: readonly TagSpec[] = [...ROLLER_COMPACTOR_TAGS, ...BILAYER_PRESS_TAGS];

export const PROCESS_TAGS: readonly TagSpec[] = [...PRESS_TAGS, ...COATER_TAGS, ...GRANULATION_TAGS, ...FORMING_TAGS, ...BLISTER_TAGS];
export const PROCESS_TAG_NAMES = PROCESS_TAGS.map((t) => t.tag) as readonly ProcessTag[];

const BY_TAG = new Map(PROCESS_TAGS.map((t) => [t.tag, t]));

/** The specification of `tag`, or null when it is not a process tag. */
export function tagSpec(tag: string): TagSpec | null {
  return BY_TAG.get(tag) ?? null;
}

/** The tags of one kind of equipment. */
export function tagsOf(kind: EquipmentKind): readonly TagSpec[] {
  return kind === 'PRESS' ? PRESS_TAGS : COATER_TAGS;
}

/** The tags of any kind of process equipment (the simulators use tagsOf). */
export function processTagsOf(kind: ProcessEquipmentKind): readonly TagSpec[] {
  return PROCESS_TAGS.filter((t) => t.equipment === kind);
}
