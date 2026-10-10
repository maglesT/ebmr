/**
 * Process tags of the tablet press and the film coater (Phase 3 slice 3a, G-06; the tag names are the 3a interface
 * of docs/build-plan/phase-3/slice-3-plan.md and never change once released).
 *
 * Each tag has its engineering unit, the number of fraction digits its values carry on the wire (a value with more
 * is refused, never rounded), whether it is a counter (whole and never negative) and whether the equipment takes a
 * setpoint for it (downloaded by the server and read back by the gateway).
 */

export const EQUIPMENT_KINDS = ['PRESS', 'COATER'] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export interface TagSpec {
  readonly tag: string;
  readonly equipment: EquipmentKind;
  readonly unit: string;
  /** Fraction digits of a value on the wire. */
  readonly scale: number;
  /** A count: whole, never negative, never decreasing while the equipment runs. */
  readonly counter: boolean;
  /** The equipment takes a setpoint for this tag (setpoint download and read-back). */
  readonly setpoint: boolean;
}

const spec = <T extends string>(tag: T, equipment: EquipmentKind, unit: string, scale: number, setpoint: boolean, counter = false): TagSpec & { readonly tag: T } => ({
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

export type PressTag = (typeof PRESS_TAGS)[number]['tag'];
export type CoaterTag = (typeof COATER_TAGS)[number]['tag'];
export type ProcessTag = PressTag | CoaterTag;

export const PROCESS_TAGS: readonly TagSpec[] = [...PRESS_TAGS, ...COATER_TAGS];
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
