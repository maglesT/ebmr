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
import { EDITIONS } from '../flow/model.ts';
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

/**
 * The edition a library block belongs to (injectables plan I-0; ADR 0001 amendment of 4 November 2026: on the platform
 * one database holds every edition, and the edition is data). A block of an edition may be used only in a master of that
 * edition; a `generic` block in any. A definition that names no edition is a Tablets block, as every block was before.
 */
export const LIBRARY_EDITIONS = ['generic', ...EDITIONS] as const;
export type LibraryEdition = (typeof LIBRARY_EDITIONS)[number];

/** The markets a block may be tagged for (India, the US, the EU). */
export const BLOCK_MARKETS = ['IN', 'US', 'EU'] as const;
export type BlockMarket = (typeof BLOCK_MARKETS)[number];

/** The edition of a definition: its own, or `tablets` when it names none. */
export function blockEdition(def: { edition?: unknown }): string {
  return typeof def.edition === 'string' ? def.edition : 'tablets';
}

/** Whether a block of edition `block` may be used in a master of edition `master`. */
export function editionFits(block: string, master: string): boolean {
  return block === 'generic' || block === master;
}

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
  /**
   * Shown (and then required, if `required`) only when an EARLIER yes/no or choice field has the given answer, e.g.
   * rework fields when "Rework added" is yes, or a peel test only when the pack is a peel-off blister.
   */
  showWhen?: { field: string; equals: string | boolean };
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
  /** S6: slot where the formulation names the BOM line whose material the lot must be (the lot's material is checked). */
  bomLineSlot?: string;
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
  /**
   * Decimals the value is shown with in the entry's sentence (display only, half-up; default 4). The exact value is
   * stored and a limit judges it at the limit's own written decimals (owner report item 24, G6).
   */
  decimals?: number;
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
  /**
   * `false` marks an event or conditional section (an extra binder addition, an alarm acknowledgement, a rework): it is
   * recorded when the event happens, and the step may end without it (R-flow item 3). It names the event in `when`. A
   * section that is the step's processing record stays required (21 CFR 211.188(b)), so at least one section is.
   */
  required?: boolean;
  /** The event that calls for an optional section, shown to the operator (e.g. "Only if the granules need more binder"). */
  when?: string;
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

/**
 * A value a calculation reads from outside the step (review addition 1). The id is usable in calculations like a field
 * id. Where it comes from is filled by the formulation (BOM line, earlier step) or is the batch itself.
 *  - FORMULA_LINE: the scaled quantity of a bill-of-materials line for this batch (`slot` names the line to fill);
 *  - BATCH_SIZE: the batch's approved size;
 *  - LOT_ASSAY: the approved assay or potency of the lot recorded in a MATERIAL_LOT or WEIGHING field of this block
 *    (`lotField`), as potency-adjusted dispensing needs;
 *  - STEP_VALUE: a value recorded in an earlier step of the formulation, e.g. the LOD or the granule yield (`slot`
 *    names the step and field to fill).
 */
export type ExternalInput =
  | { id: string; label: string; kind: 'FORMULA_LINE'; unit: string; slot: string }
  | { id: string; label: string; kind: 'BATCH_SIZE'; unit: string }
  | { id: string; label: string; kind: 'LOT_ASSAY'; unit: string; lotField: string }
  | { id: string; label: string; kind: 'STEP_VALUE'; unit: string; slot: string };

/**
 * Validator roles a library block may take (decision 0026, S4): the ones whose meaning needs no block code. A line or
 * room clearance block is CLEARANCE, a yield or reconciliation block YIELD_RECONCILIATION (its phase names the
 * formulation's yield checkpoint), and so on. Automated phases, dispensing, charge-in, timers with time constraints,
 * printed materials, containers, returns and reprocessing stay with their system blocks.
 */
export const LIBRARY_ROLES = ['INSTRUCTION', 'PARAMETER_RECORD', 'OBSERVATION', 'IPC', 'SAMPLING', 'CLEARANCE', 'EQUIPMENT_STATUS_CHECK', 'ENVIRONMENT_CHECK', 'VERIFICATION', 'YIELD_RECONCILIATION', 'SIGN_OFF', 'CALCULATION'] as const;
export type LibraryRole = (typeof LIBRARY_ROLES)[number];

/**
 * Whether a block records nothing but its signatures (R-flow item 5): an INSTRUCTION or SIGN_OFF block whose sections
 * hold no field. Its PERFORMED signature, with who and when, is the record; its sections only carry the text the
 * operator reads.
 */
export function fieldlessBlock(def: Pick<BlockDefinition, 'roles' | 'sections'>): boolean {
  return Array.isArray(def.roles) && def.roles.length > 0 && def.roles.every((r) => r === 'INSTRUCTION' || r === 'SIGN_OFF') && Array.isArray(def.sections) && def.sections.every((s) => (s.fields ?? []).length === 0);
}

export interface BlockDefinition {
  /** Upper-case code, e.g. "IPC-FRIAB". */
  code: string;
  /** Positive whole number; each approved change is a new version. */
  version: number;
  title: string;
  category: BlockCategory;
  /** The edition the block belongs to (default `tablets`); `generic` blocks fit every edition. */
  edition?: LibraryEdition;
  /**
   * Metadata only: the markets whose binding clause alone asks for this block (an Annex 1 item is `['EU']`), so a master
   * for other markets leaves it out (injectables plan, owner Q0; lead, 6 November 2026). Absent: every market. The engine
   * does not read it.
   */
  markets?: readonly BlockMarket[];
  /** Validator roles (default: IPC for tests, PARAMETER_RECORD otherwise). */
  roles?: LibraryRole[];
  description?: string;
  /** Standing instructions shown with the form; the formulation may add product text. */
  instructions?: string;
  /** Values from outside the step that calculations read. */
  inputs?: ExternalInput[];
  sections: SectionDef[];
  signatures: SignatureDef[];
  referenceLimits?: Record<string, ReferenceLimit>;
}

/** The kinds of slot a definition exposes to the formulation. */
export type SlotKind = 'LIMIT' | 'EQUIPMENT_CLASS' | 'COUNT' | 'INTERVAL' | 'BOM_LINE' | 'STEP_VALUE';

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
  /**
   * The library version, pinned with its content hash (`definitionHash`) when the formulation is approved (review
   * addition 4): batches inherit what the formulation pinned, and a new block version needs a new formulation version.
   */
  block: { code: string; version: number; hash?: string };
  limits?: Record<string, LimitSpec>;
  /** Targets for limit slots (a decimal in the limit's unit). */
  targets?: Record<string, string>;
  equipmentClasses?: Record<string, string>;
  /** Whole numbers as decimal text, e.g. "20". */
  counts?: Record<string, string>;
  intervals?: Record<string, { value: string; unit: string }>;
  /**
   * S9 (O-5): limit slots bound to a market rule (the registered value for each market); the validator refuses a limit
   * looser than the value the rule resolves to, as it does for an MBR parameter (validator rules-market).
   */
  marketRules?: Record<string, { key: string; bound: 'LOW' | 'HIGH' }>;
  /** Written reasons, by limit slot, for a limit looser than the block's reference limit (O-5). */
  justifications?: Record<string, string>;
  /** BOM line ids for FORMULA_LINE inputs, by slot. */
  bomLines?: Record<string, string>;
  /** Earlier step and field for STEP_VALUE inputs, by slot (resolved against the formulation in S9). */
  stepValues?: Record<string, { step: string; field: string }>;
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
