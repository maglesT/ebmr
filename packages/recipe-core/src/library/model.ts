/**
 * Library block definitions (decision 0026; plan `docs/build-plan/dynamic-library/plan.html` section 4).
 *
 * A library block is a digital form defined as DATA: sections of typed fields plus the signatures the step needs. The
 * field types below are the only vendor code; a block built from them is data that QA approves and versions. A
 * definition says WHAT is recorded. The product's own values (limits, counts, frequency, equipment class) fill the
 * definition's slots when the block is used in a formulation (`BlockUse`).
 *
 * Every GMP value is a decimal STRING (never a JavaScript `number`); units are UCUM codes checked by the expression
 * language. Version numbers, counts of options and similar structure are plain integers (they are not GMP values).
 */
import type { LimitSpec } from '../limits/model.ts';

/** The fixed field types (decision 0026 point 1). Adding one is a code change and an owner decision. */
export const FIELD_TYPES = [
  'NUMBER',
  'TEXT',
  'YES_NO',
  'CHOICE',
  'DATE_TIME',
  'TIMER',
  'WEIGHING',
  'MATERIAL_LOT',
  'EQUIPMENT',
  'CONTAINER',
  'SAMPLE',
  'TEST_RESULT',
  'CALC',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const BLOCK_CATEGORIES = ['PROCESS', 'COATING', 'TEST_IPC', 'TEST_RELEASE', 'CONTROL', 'PACKAGING'] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

/** Statistics a test result can be judged on, each with its own limit slot. */
export const TEST_STATISTICS = ['INDIVIDUAL', 'MEAN', 'MIN', 'MAX', 'RSD', 'RANGE'] as const;
export type TestStatistic = (typeof TEST_STATISTICS)[number];

export const SIGNATURE_MEANINGS = ['PERFORMED', 'CHECKED', 'VERIFIED', 'QA_APPROVED'] as const;
export type SignatureMeaning = (typeof SIGNATURE_MEANINGS)[number];

interface FieldBase {
  /** Identifier, usable in calculations: a lower-case letter, then letters, digits or underscores. */
  id: string;
  label: string;
  /** Default true. A CALC field is never typed, so `required` does not apply to it. */
  required?: boolean;
  help?: string;
}

export interface NumberField extends FieldBase {
  type: 'NUMBER';
  /** UCUM unit ("1" for a plain number). */
  unit: string;
  /** Decimals shown and entered (display only; full precision is stored). */
  decimals?: number;
  /** Name of the limit slot the product fills. */
  limitSlot?: string;
  /** A CPP or IPC: must have a limit slot (PR-03). */
  critical?: boolean;
}

export interface TextField extends FieldBase {
  type: 'TEXT';
  /** JavaScript regular expression the whole text must match (e.g. a punch set id). */
  pattern?: string;
  maxLength?: number;
}

export interface YesNoField extends FieldBase {
  type: 'YES_NO';
  /** The expected answer; the other answer raises an exception. */
  expected?: boolean;
}

export interface ChoiceField extends FieldBase {
  type: 'CHOICE';
  options: string[];
  /** Options that may be recorded but raise an exception (e.g. "Damaged"). */
  notAllowed?: string[];
}

export interface DateTimeField extends FieldBase {
  type: 'DATE_TIME';
}

export interface TimerField extends FieldBase {
  type: 'TIMER';
  /** Unit the duration is shown and limited in (a time unit, default "min"). */
  durationUnit?: string;
  limitSlot?: string;
  critical?: boolean;
}

export interface WeighingField extends FieldBase {
  type: 'WEIGHING';
  /** A mass unit. */
  unit: string;
  /** The weighing dispenses a line of the bill of materials (the formulation names the line). */
  bomLine?: boolean;
  limitSlot?: string;
}

export interface MaterialLotField extends FieldBase {
  type: 'MATERIAL_LOT';
}

export const EQUIPMENT_KINDS = ['EQUIPMENT', 'ROOM', 'LINE', 'BALANCE', 'INSTRUMENT'] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export interface EquipmentField extends FieldBase {
  type: 'EQUIPMENT';
  kind: EquipmentKind;
  /** Slot where the formulation names the equipment class (e.g. "RMG"). */
  classSlot: string;
}

export interface ContainerField extends FieldBase {
  type: 'CONTAINER';
  action: 'REGISTER' | 'CONSUME';
}

export interface SampleField extends FieldBase {
  type: 'SAMPLE';
  /** Slot where the formulation gives the number of units to take. */
  unitsSlot: string;
  purpose?: string;
}

export interface TestResultField extends FieldBase {
  type: 'TEST_RESULT';
  unit: string;
  /** Slot where the formulation gives the number of replicates (e.g. 20 tablets). */
  replicatesSlot: string;
  /** Statistics judged against limits; each has its own limit slot. */
  statistics: { statistic: TestStatistic; limitSlot: string }[];
  /** True for a profile: the formulation gives the time points (or stages), each with its own limits. */
  perPoint?: boolean;
}

export interface CalcField extends FieldBase {
  type: 'CALC';
  /** Expression (@ebmr/expr) over fields declared EARLIER in the definition (so calculations never form a cycle). */
  expression: string;
  unit: string;
  limitSlot?: string;
  critical?: boolean;
}

export type FieldDef =
  | NumberField
  | TextField
  | YesNoField
  | ChoiceField
  | DateTimeField
  | TimerField
  | WeighingField
  | MaterialLotField
  | EquipmentField
  | ContainerField
  | SampleField
  | TestResultField
  | CalcField;

/**
 * How a section repeats: once (default), a fixed count the product gives, once per container, at an interval the
 * product gives (IPC rounds), or until a field passes its limits (the LOD drying loop, a coating weight-gain check).
 */
export type SectionRepeat =
  | { kind: 'ONCE' }
  | { kind: 'COUNT'; countSlot: string }
  | { kind: 'PER_CONTAINER' }
  | { kind: 'PER_INTERVAL'; intervalSlot: string }
  | { kind: 'UNTIL_PASS'; untilField: string; maxRepeatsSlot?: string };

export interface SectionDef {
  id: string;
  title: string;
  fields: FieldDef[];
  repeat?: SectionRepeat;
}

export interface SignatureDef {
  meaning: SignatureMeaning;
  /** Role code that may sign (checked against the role vocabulary when the library item is stored). */
  role: string;
}

/** A guide limit shown to the author, e.g. a common compendial value (O-5: a looser product limit needs a reason). */
export interface ReferenceLimit {
  unit: string;
  low?: string;
  high?: string;
  note: string;
}

export interface BlockDefinition {
  /** Upper-case code, e.g. "IPC-FRIAB". */
  code: string;
  /** Positive whole number; each approved change is a new version. */
  version: number;
  title: string;
  category: BlockCategory;
  description?: string;
  /** Standing instructions shown with the form; the formulation may add product text. */
  instructions?: string;
  sections: SectionDef[];
  signatures: SignatureDef[];
  referenceLimits?: Record<string, ReferenceLimit>;
}

/** The kinds of slot a definition exposes to the formulation. */
export type SlotKind = 'LIMIT' | 'EQUIPMENT_CLASS' | 'COUNT' | 'INTERVAL';

export interface Slot {
  name: string;
  kind: SlotKind;
  /** The field (or section, for COUNT and INTERVAL slots of a repeat) the slot belongs to. */
  owner: string;
  /** For LIMIT slots: the unit of the field the limit applies to. */
  unit?: string;
  /** A LIMIT slot of a critical field, or any slot without which the form cannot run. */
  required: boolean;
}

/** The product's values for one use of a library block in a formulation. */
export interface BlockUse {
  block: { code: string; version: number };
  limits?: Record<string, LimitSpec>;
  /** Targets for limit slots (a decimal in the limit's unit). */
  targets?: Record<string, string>;
  equipmentClasses?: Record<string, string>;
  /** Whole numbers as decimal text, e.g. "20". */
  counts?: Record<string, string>;
  intervals?: Record<string, { value: string; unit: string }>;
  /** Written reasons, by limit slot, for a limit looser than the block's reference limit (O-5). */
  justifications?: Record<string, string>;
  /** Time points or stages of a per-point test result, by field id. */
  points?: Record<string, { id: string; label: string; limits: LimitSpec }[]>;
}

export interface LibraryProblem {
  /** Stable code, e.g. "LIB-FIELD-UNIT". */
  code: string;
  severity: 'ERROR' | 'WARNING';
  /** Where: "sections[0].fields[2]", "limits.loss" ... */
  path: string;
  /** Plain language first, then rule and controls in brackets. */
  message: string;
  controls: string[];
}
