/**
 * TB-01@1 Potency/assay/LOD-adjusted dispensing set with compensating excipient (tablets spec B.2 TB-01; calculations
 * C-01 to C-04; builds on G-07 dispensing and K-14 calculation). Controls PR-04, PR-18, PR-19, PR-20, IN-23, IN-24,
 * DI-30, DI-33.
 *
 * One TB-01 step dispenses one active BOM line, adjusted to the approved assay of its lots, and the compensating
 * excipient that keeps the batch total at the standard (or none, where the registered formula lets the core weight
 * vary). Its entries:
 *   POTENCY_CALCULATION  one to three lots of the active, each with its approved assay result as the lot register holds
 *                        it (the server reads it inside the command; a typed value is impossible, a missing one blocks)
 *                        and, with more than one lot, its base-equivalent share. The block computes the as-is assay of
 *                        each lot, the adjusted quantity of each lot and its target (rounded UP to the readability), the
 *                        compensating excipient and its target (to the nearest step) and the totals, and stores them with
 *                        every input (DI-33). A later calculation, before anything is dispensed, supersedes it and keeps
 *                        it visible. Beyond the MBR's adjustment cap it raises POTENCY_ADJUSTMENT_CAP.
 *   CONTAINER_WEIGHING   as G-07 (same data, net, label and the same database rules), for the active from a lot of the
 *                        governing calculation, or for the compensating excipient. A lot other than the first-expiring
 *                        usable one carries the person's reason (fefoReason; FEFO_OVERRIDE is raised for the rotation
 *                        report, PR-18); on GMP the server consumes the dispensed net from the batch's reservation of
 *                        the lot (recipe.consume_lot, genealogy INV-13, INV-14) and names that consumption.
 * Before PERFORMED: a calculation, and something dispensed for each line and each lot of the calculation. At PERFORMED:
 * each line's total against its target within the MBR's tolerance (DISPENSE_OUT_OF_TOLERANCE otherwise). The step is
 * always checked by a second person (PR-20); a weighing keyed by hand raises MANUAL_ENTRY_FALLBACK and makes the check
 * mandatory (two-person mode).
 *
 * The database holds the same rules (tablets 0840 to 0843): the calculation is recomputed and a recorded target that
 * differs is refused; the lots and assays are the register's; the dispenser holds the designation; the balance has an
 * open instrument use for the batch; FEFO; and on GMP the consumption.
 */
import { Dec } from '@ebmr/expr';
import { blocks, type flow } from '@ebmr/recipe-core/pure';
import { ACTIVITY_BASIS, ASSAY_BASES, ASSAY_BASES_V2, MG_PER_UNIT, potencyTargets, type AssayBasisV2, type PotencyInput, type PotencyResult } from './dispensing/potency.ts';
import { S } from './summaries.ts';

type BlockVersion = blocks.BlockVersion;
type HandlerView = blocks.HandlerView;
type HandlerProblem = blocks.HandlerProblem;
type ExceptionDraft = blocks.ExceptionDraft;
type ConfigProblem = blocks.ConfigProblem;
type FieldSchema = blocks.FieldSchema;
type ObjectSchema = blocks.ObjectSchema;
type MbrContent = flow.MbrContent;
type PhaseNode = flow.PhaseNode;

export const TB01_CONTROLS = ['PR-04', 'PR-18', 'PR-19', 'PR-20', 'IN-23', 'IN-24', 'DI-30', 'DI-33'];
/** The engine role of the designated dispenser (kernel role DISPENSER via DISPENSE.EXECUTE, recipe-core 0270). */
export const DISPENSER_ROLE = 'DISPENSER';
export const FORMULA = 'TB-01@1';
/** The calculation of an activity lot (TB-01@2, slice 7q): standard x declared activity / the lot's activity. */
export const FORMULA_ACTIVITY = 'TB-01@2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGITS = /^[0-9]{1,20}$/;

function problem(code: string, message: string, controls: string[]): HandlerProblem {
  return { code, message: `${message} (${code}; ${controls.join(', ')})`, controls };
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const micros = (v: unknown): bigint | undefined => (typeof v === 'string' && DIGITS.test(v) ? BigInt(v) : undefined);

// ---------------------------------------------------------------------------------------------
// Schemas

const DECIMAL_POSITIVE: FieldSchema = { type: 'decimal', min: '0', minExclusive: true, description: 'A positive decimal written as text' };

/** The lot as read from the lot register at the moment of use (G-07's LOT_SCHEMA). */
export const LOT_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'The lot as read from site services at the moment of use (status evaluated on fresh data, PR-18)',
  fields: {
    id: { type: 'string', description: 'Lot or receiving/control number' },
    material: { type: 'string', description: 'Material code or MBR material reference on the scanned label' },
    status: { type: 'string', enum: ['RELEASED', 'QUARANTINE', 'ON_TEST', 'REJECTED', 'ON_HOLD', 'RECALLED', 'RETURNED', 'EXPIRED'], description: 'Material status at the moment of use' },
    expiresAtUs: { type: 'string', pattern: DIGITS, optional: true, description: 'Instant as UTC epoch microseconds (digits)' },
    retestAtUs: { type: 'string', pattern: DIGITS, optional: true, description: 'Instant as UTC epoch microseconds (digits)' },
    identityTested: { type: 'boolean', optional: true, description: 'An identity-test result exists for this lot (IN-24(c))' },
  },
};

/** The approved assay result of a lot, as the lot register holds it (tablets 0841). */
export const ASSAY_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'The approved assay result of the lot from the lot register (never typed at the step, PR-19)',
  fields: {
    resultId: { type: 'string', pattern: UUID, description: 'The register row of the result' },
    basis: { type: 'string', enum: [...ASSAY_BASES], description: 'The basis the assay is reported on (C-01)' },
    assay: { type: 'decimal', description: 'Assay, % w/w on its basis' },
    water: { type: 'decimal', optional: true, description: 'Water (KF), % w/w' },
    lod: { type: 'decimal', optional: true, description: 'Loss on drying, % w/w' },
    solvents: { type: 'decimal', optional: true, description: 'Total residual solvents, % w/w' },
  },
};

const CALCULATION_ENTRY: ObjectSchema = {
  type: 'object',
  description: 'The lots of the active with their approved assay results; the block computes the targets',
  fields: {
    lots: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description: 'One to three lots of the active, in allocation order',
      items: {
        type: 'object',
        description: 'A lot of the active, its approved assay and its base-equivalent share',
        fields: {
          lot: LOT_SCHEMA,
          assay: ASSAY_SCHEMA,
          baseEquivalent: { ...DECIMAL_POSITIVE, optional: true, description: 'Base-equivalent share of this lot in the BOM unit (mandatory with more than one lot)' },
        },
      },
    },
  },
};

const WEIGHING_ENTRY: ObjectSchema = {
  type: 'object',
  description: 'One dispensed container: lot, gross, tare; the net is computed (as G-07)',
  fields: {
    item: { type: 'string', description: 'The dispensed-quantity parameter this container counts towards' },
    bomLine: { type: 'string', description: 'BOM line the material belongs to (the active or the compensating excipient)' },
    container: { type: 'string', description: 'Unique container id (printed on its label)' },
    lot: LOT_SCHEMA,
    gross: { type: 'decimal', description: 'Gross weight from the balance' },
    tare: { type: 'decimal', description: 'Tare weight (weighed, or nominal for validated container types)' },
    unit: { type: 'string', description: 'UCUM mass unit of gross and tare' },
    balance: { type: 'string', description: 'Balance id: an instrument with an open use for this batch (checked by the database)' },
    source: { type: 'string', enum: ['DEVICE', 'MANUAL'], description: 'From the balance interface, or keyed by hand (flagged; two-person mode)' },
    fefoReason: { type: 'string', optional: true, description: 'Why a lot other than the first-expiring usable one is dispensed (PR-18)' },
    consumption: { type: 'string', pattern: UUID, optional: true, serverFilled: true, description: 'The lot consumption the server made for this container on GMP (INV-13, INV-14)' },
  },
};

const CONFIG_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'Potency-adjusted dispensing of one active with its compensating excipient',
  fields: {
    active: {
      type: 'object',
      description: 'The active BOM line and how its standard quantity is stated',
      fields: {
        bomLine: { type: 'string', description: 'BOM line of the active (role ACTIVE)' },
        basis: { type: 'string', enum: [...ASSAY_BASES], description: 'Assay basis; it must match the basis of the lot result (no default)' },
        standardIs: { type: 'string', enum: ['BASE', 'FORM'], description: 'The BOM quantity states the label-claim moiety (BASE) or the declared form at 100 % (FORM)' },
        standardBasis: { type: 'string', description: 'The standard-quantity basis in words, e.g. "salt, anhydrous, at 100.0 % as-is"' },
        form: {
          type: 'object',
          optional: true,
          description: 'Declared chemical form and its molar masses (C-02; mandatory when the standard is the base)',
          fields: {
            name: { type: 'string', description: 'Declared form, e.g. "atorvastatin calcium, anhydrous"' },
            molarMassForm: { ...DECIMAL_POSITIVE, description: 'Molar mass of the form the assay is expressed in, g/mol' },
            molarMassBase: { ...DECIMAL_POSITIVE, description: 'Molar mass of the base moiety of the label claim, g/mol' },
            baseMoieties: { type: 'integer', min: 1, max: 4, description: 'Base moieties per formula unit (2 for a hemi-calcium salt)' },
            hydrateWaters: { type: 'integer', min: 0, max: 12, description: 'Waters of hydration in the form (0 for an anhydrous form)' },
            source: { type: 'string', description: 'Source of the molar masses (master data reference)' },
          },
        },
        overagePercent: { type: 'decimal', min: '0', optional: true, description: 'Registered overage in percent (default 0; above 0 only with a registration reference)' },
        registrationRef: { type: 'string', optional: true, description: 'Registration reference of the overage (PR-04)' },
        maxLots: { type: 'integer', min: 1, max: 3, optional: true, description: 'Lots the active may be allocated across (default 3)' },
      },
    },
    compensation: {
      type: 'object',
      description: 'The compensating excipient (q.s.) and its approved range, or no compensation',
      fields: {
        mode: { type: 'string', enum: ['EXCIPIENT', 'NONE'], description: 'EXCIPIENT, or NONE where the registered formula lets the core weight vary' },
        bomLine: { type: 'string', optional: true, description: 'BOM line of the compensating excipient' },
        min: { type: 'decimal', min: '0', optional: true, description: 'Lowest approved quantity, in the BOM unit' },
        max: { type: 'decimal', min: '0', optional: true, description: 'Highest approved quantity, in the BOM unit' },
        registrationRef: { type: 'string', optional: true, description: 'Registration reference that lets the core weight vary (mode NONE)' },
      },
    },
    readability: { ...DECIMAL_POSITIVE, description: 'Balance readability the targets are rounded to, in the BOM unit (active UP, excipient to the nearest step)' },
    tolerancePercent: {
      type: 'object',
      description: 'Tolerance of each dispensed total around its target, in percent (no default)',
      fields: { active: { type: 'decimal', min: '0', description: 'Active' }, excipient: { type: 'decimal', min: '0', optional: true, description: 'Compensating excipient' } },
    },
    adjustmentCapPercent: { type: 'decimal', min: '0', optional: true, description: 'Adjustment of the active beyond which POTENCY_ADJUSTMENT_CAP is raised (default none)' },
  },
};

// ---------------------------------------------------------------------------------------------
// Configuration

export interface Tb01Config {
  active: { bomLine: string; basis: AssayBasisV2; standardIs: 'BASE' | 'FORM'; form?: { molarMassForm: string; molarMassBase: string; baseMoieties: number; hydrateWaters: number }; overagePercent: string; maxLots: number; declaredActivity?: string };
  excipient?: { bomLine: string; min: string; max: string };
  readability: string;
  tolerance: { active: string; excipient?: string };
  capPercent?: string;
}

/** The configuration as the block reads it (defaults applied; the schema has been checked). */
export function tb01Config(config: Readonly<Record<string, unknown>>): Tb01Config {
  const a = isRecord(config['active']) ? config['active'] : {};
  const c = isRecord(config['compensation']) ? config['compensation'] : {};
  const t = isRecord(config['tolerancePercent']) ? config['tolerancePercent'] : {};
  const f = isRecord(a['form']) ? a['form'] : undefined;
  return {
    active: {
      bomLine: String(a['bomLine']),
      basis: String(a['basis']) as AssayBasisV2,
      standardIs: a['standardIs'] === 'FORM' ? 'FORM' : 'BASE',
      ...(f ? { form: { molarMassForm: String(f['molarMassForm']), molarMassBase: String(f['molarMassBase']), baseMoieties: Number(f['baseMoieties']), hydrateWaters: Number(f['hydrateWaters']) } } : {}),
      overagePercent: text(a['overagePercent']) ?? '0',
      maxLots: typeof a['maxLots'] === 'number' ? a['maxLots'] : 3,
      ...(text(a['declaredActivity']) !== undefined ? { declaredActivity: text(a['declaredActivity']) as string } : {}),
    },
    ...(c['mode'] === 'EXCIPIENT' ? { excipient: { bomLine: String(c['bomLine']), min: text(c['min']) ?? '0', max: text(c['max']) ?? '0' } } : {}),
    readability: String(config['readability']),
    tolerance: { active: text(t['active']) ?? '0', ...(text(t['excipient']) !== undefined ? { excipient: text(t['excipient']) as string } : {}) },
    ...(text(config['adjustmentCapPercent']) !== undefined ? { capPercent: text(config['adjustmentCapPercent']) as string } : {}),
  };
}

function isMassUnit(unit: string | undefined): boolean {
  return blocks.isMassUnit(unit);
}

function checkConfig(phase: PhaseNode, config: Readonly<Record<string, flow.JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const err = (code: string, message: string, controls: string[]): void => {
    out.push({ code, severity: 'ERROR', message: `${message} (${code})`, controls });
  };
  const c = tb01Config(config);
  const comp = isRecord(config['compensation']) ? config['compensation'] : {};
  const active = mbr.bom.find((b) => b.id === c.active.bomLine);
  if (!active || !phase.consumes.includes(c.active.bomLine)) err('TB01-ACTIVE-LINE', `${c.active.bomLine} is not a BOM line step ${phase.id} consumes`, ['PR-19']);
  else if (active.role !== 'ACTIVE') err('TB01-ACTIVE-LINE', `${c.active.bomLine} is not an active (its role is ${active.role})`, ['PR-19']);
  if (active && !isMassUnit(active.quantity.unit)) err('TB01-UNIT', `the active's standard quantity is in ${active.quantity.unit}, not a mass`, ['PR-19', 'DI-33']);
  if (c.active.standardIs === 'BASE' && !c.active.form) err('TB01-FORM', 'a standard stated on the base needs the declared form with its molar masses (C-02)', ['PR-19']);
  // Basis consistency (C-06): a hydrate's molar mass with a water-corrected or dried assay counts the water twice.
  if (c.active.form && c.active.form.hydrateWaters > 0 && c.active.basis !== 'AS_IS') {
    err('TB01-BASIS-CONSISTENCY', `the declared form is a hydrate, but the assay is on the ${c.active.basis.toLowerCase().replaceAll('_', ' ')} basis: its molar mass would count the water twice; declare the anhydrous form`, ['PR-19', 'DI-33']);
  }
  // Outline 9.1 (the sample's data problem): the form's label, its waters of hydration and its molar mass agree. A form
  // named as a hydrate declares its waters, and a hydrate's molar mass holds them (at least the base moieties and the
  // waters at 18.015 g/mol): a hydrate label on an anhydrous molar mass would scale the salt factor wrongly (C-02).
  const form = isRecord(config['active']) && isRecord(config['active']['form']) ? config['active']['form'] : undefined;
  if (c.active.form && form) {
    const formName = typeof form['name'] === 'string' ? form['name'] : '';
    const name = formName.toLowerCase();
    const labelled = /(mono|di|tri|tetra|penta|hexa|sesqui|hemi|\b)hydrate\b/.test(name) && !/anhydr/.test(name);
    if (labelled && c.active.form.hydrateWaters === 0) {
      err('TB01-HYDRATE-LABEL', `the form is named "${formName}", a hydrate, but declares no waters of hydration; declare its waters and its hydrate molar mass, or name the anhydrous form`, ['PR-19', 'DI-33']);
    }
    if (c.active.form.hydrateWaters > 0) {
      const least = Dec.parse(c.active.form.molarMassBase).times(Dec.parse(String(c.active.form.baseMoieties))).plus(Dec.parse('18.015').times(Dec.parse(String(c.active.form.hydrateWaters))));
      if (Dec.parse(c.active.form.molarMassForm).lt(least)) {
        err('TB01-HYDRATE-MASS', `the form declares ${String(c.active.form.hydrateWaters)} waters of hydration, but its molar mass ${c.active.form.molarMassForm} is below the base's and the waters' ${least.toString()}: an anhydrous molar mass under a hydrate label`, ['PR-19', 'DI-33']);
      }
    }
  }
  if (Dec.parse(c.active.overagePercent).isPositive() && typeof (isRecord(config['active']) ? config['active'] : {})['registrationRef'] !== 'string') {
    err('TB01-OVERAGE', 'an overage above 0 % needs its registration reference', ['PR-04']);
  }
  if (comp['mode'] === 'EXCIPIENT') {
    const line = mbr.bom.find((b) => b.id === comp['bomLine']);
    if (typeof comp['bomLine'] !== 'string' || !line || !phase.consumes.includes(comp['bomLine'])) err('TB01-EXCIPIENT-LINE', `the compensating excipient ${typeof comp['bomLine'] === 'string' ? comp['bomLine'] : '(none)'} is not a BOM line step ${phase.id} consumes`, ['PR-19']);
    else if (comp['bomLine'] === c.active.bomLine) err('TB01-EXCIPIENT-LINE', 'the compensating excipient is another line than the active', ['PR-19']);
    else if (active && line.quantity.unit !== active.quantity.unit) err('TB01-UNIT', `the active (${active.quantity.unit}) and the compensating excipient (${line.quantity.unit}) are stated in one unit`, ['PR-19', 'DI-33']);
    if (typeof comp['min'] !== 'string' || typeof comp['max'] !== 'string') err('TB01-EXCIPIENT-RANGE', 'the compensating excipient states its approved range (min and max)', ['PR-19', 'PR-04']);
    else if (line && (Dec.parse(comp['min']).gt(Dec.parse(line.quantity.value)) || Dec.parse(comp['max']).lt(Dec.parse(line.quantity.value)))) {
      err('TB01-EXCIPIENT-RANGE', `the approved range ${comp['min']} to ${comp['max']} does not contain the standard ${line.quantity.value}`, ['PR-19', 'PR-04']);
    }
    if (!isRecord(config['tolerancePercent']) || typeof config['tolerancePercent']['excipient'] !== 'string') err('TB01-TOLERANCE', 'the compensating excipient has its tolerance', ['PR-19']);
  } else if (typeof comp['registrationRef'] !== 'string') {
    err('TB01-NO-COMPENSATION', 'no compensation only where the registered formula lets the core weight vary: name its registration reference', ['PR-04', 'PR-19']);
  }
  if (blocks.massItems(phase, mbr).length === 0) err('TB01-NO-ITEM', `step ${phase.id} records no dispensed mass quantity`, ['PR-19']);
  if (!phase.signatures.check) err('TB01-NO-CHECK', 'every dispensed material is checked by a second person (manual mode) or at least one verifier (scale-backed mode)', ['PR-20']);
  if (phase.signatures.perform?.role !== DISPENSER_ROLE) err('TB01-PERFORMER', `the step is performed by the designated dispenser (${DISPENSER_ROLE})`, ['PR-19']);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Execution helpers

/** The potency input of a step, from its configuration, the MBR's BOM and the lots of a calculation entry. */
export function potencyInput(c: Tb01Config, mbr: MbrContent, lots: { assay: Record<string, unknown>; baseEquivalent?: string }[]): PotencyInput {
  const active = mbr.bom.find((b) => b.id === c.active.bomLine);
  const exc = c.excipient ? mbr.bom.find((b) => b.id === c.excipient?.bomLine) : undefined;
  return {
    standardQuantity: active?.quantity.value ?? '0',
    standardIs: c.active.standardIs,
    ...(c.active.form ? { form: { molarMassForm: c.active.form.molarMassForm, molarMassBase: c.active.form.molarMassBase, baseMoieties: c.active.form.baseMoieties } } : {}),
    overagePercent: c.active.overagePercent,
    lots: lots.map((l) => ({
      assay: {
        basis: String(l.assay['basis']) as AssayBasisV2,
        assay: String(l.assay['assay']),
        ...(text(l.assay['water']) !== undefined ? { water: text(l.assay['water']) as string } : {}),
        ...(text(l.assay['lod']) !== undefined ? { lod: text(l.assay['lod']) as string } : {}),
        ...(text(l.assay['solvents']) !== undefined ? { solvents: text(l.assay['solvents']) as string } : {}),
      },
      ...(l.baseEquivalent !== undefined ? { baseEquivalent: l.baseEquivalent } : {}),
    })),
    ...(c.excipient && exc ? { excipient: { standard: exc.quantity.value, min: c.excipient.min, max: c.excipient.max } } : {}),
    readability: c.readability,
    ...(c.active.declaredActivity !== undefined && active && MG_PER_UNIT[active.quantity.unit] !== undefined
      ? { activity: { declared: c.active.declaredActivity, mgPerUnit: MG_PER_UNIT[active.quantity.unit] as string } }
      : {}),
  };
}

/**
 * The data a POTENCY_CALCULATION entry stores: the lots exactly as sent (with their register facts and approved results),
 * and each lot's results beside them, by lot, with the standard, the compensating excipient and the totals (DI-33).
 */
export function calculationData(c: Tb01Config, mbr: MbrContent, lots: { lot: Record<string, unknown>; assay: Record<string, unknown>; baseEquivalent?: string }[], r: PotencyResult): Record<string, unknown> {
  const active = mbr.bom.find((b) => b.id === c.active.bomLine);
  return {
    lots: lots.map((l) => ({ lot: { ...l.lot }, assay: { ...l.assay }, ...(l.baseEquivalent !== undefined ? { baseEquivalent: l.baseEquivalent } : {}) })),
    results: lots.map((l, i) => ({ lot: l.lot['id'], ...r.lots[i] })),
    active: {
      bomLine: c.active.bomLine,
      standardQuantity: active?.quantity.value ?? null,
      unit: active?.quantity.unit ?? null,
      standardIs: c.active.standardIs,
      overagePercent: c.active.overagePercent,
      factor: r.factor,
      standard: r.standard,
      ...(r.activity ? { activity: r.activity } : {}),
    },
    excipient: c.excipient && r.excipient ? { bomLine: c.excipient.bomLine, ...r.excipient } : null,
    total: r.total,
    adjustmentPercent: r.adjustmentPercent,
    readability: c.readability,
    formula: c.active.basis === ACTIVITY_BASIS ? FORMULA_ACTIVITY : FORMULA,
  };
}

/** The governing calculation of the step: its latest POTENCY_CALCULATION entry. */
function governing(view: HandlerView): Record<string, unknown> | undefined {
  const all = view.entries('POTENCY_CALCULATION');
  return all[all.length - 1]?.data;
}

function lotProblems(view: HandlerView, lot: Record<string, unknown>, expectedMaterial: string | undefined): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  const ref = expectedMaterial === undefined ? undefined : view.mbr.references.find((r) => r.id === expectedMaterial);
  const material = lot['material'];
  if (expectedMaterial !== undefined && material !== expectedMaterial && material !== ref?.code) {
    out.push(problem('TB01-WRONG-MATERIAL', `Lot ${String(lot['id'])} is ${String(material)}, not the item the MBR names (${ref?.code ?? expectedMaterial})`, ['PR-18', 'IN-23']));
  }
  if (lot['status'] !== 'RELEASED') out.push(problem('TB01-LOT-STATUS', `Lot ${String(lot['id'])} is ${String(lot['status']).toLowerCase()}: only released lots may be used, with no operator override`, ['PR-18', 'IN-23']));
  const exp = micros(lot['expiresAtUs']);
  if (exp !== undefined && exp <= view.nowUs) out.push(problem('TB01-LOT-EXPIRED', `Lot ${String(lot['id'])} is past its expiry date`, ['PR-18', 'IN-23']));
  const retest = micros(lot['retestAtUs']);
  if (retest !== undefined && retest <= view.nowUs) out.push(problem('TB01-LOT-RETEST', `Lot ${String(lot['id'])} is past its retest date`, ['PR-18', 'IN-23']));
  if (view.batch.marketSet.some((m) => m !== 'IN') && lot['identityTested'] !== true) {
    out.push(problem('TB01-LOT-IDENTITY', `Lot ${String(lot['id'])} has no identity-test result; a batch for ${view.batch.marketSet.join(', ')} needs one`, ['IN-24']));
  }
  return out;
}

/** net = gross - tare at the resolution of the finer weighing (recipe-core 0321), positive. */
function netOf(gross: string, tare: string): { ok: true; net: string } | { ok: false; message: string } {
  return blocks.netOf(gross, tare);
}

const METRIC_MASS = /^(?:Y|Z|E|P|T|G|M|k|h|da|d|c|m|u|n|p|f|a|z|y)?g$/;
const countableInto = (unit: string, itemUnit: string): boolean => unit === itemUnit || (METRIC_MASS.test(unit) && METRIC_MASS.test(itemUnit));
const writtenDecimals = (t: string): number => (t.indexOf('.') < 0 ? 0 : t.length - t.indexOf('.') - 1);
const atResolution = (v: Dec, decimals: number): string => v.toFixed(Math.max(decimals, v.decimalPlaces()), 'HALF_EVEN');

/** As G-07: a weight in `from` in `to` at the resolution it was weighed at (never rounded; undefined when not exact). */
function convertAtResolution(view: HandlerView, value: string, from: string, to: string): string | undefined {
  if (from === to) return value;
  const converted = view.expr.convert(value, from, to);
  if (converted === undefined) return undefined;
  const places = writtenDecimals(value);
  const step = view.expr.convert(places === 0 ? '1' : `0.${'0'.repeat(places - 1)}1`, from, to);
  return atResolution(Dec.parse(converted), step === undefined ? 0 : writtenDecimals(step));
}

function sumDecimals(values: readonly string[]): string {
  const total = values.reduce((acc, v) => acc.plus(Dec.parse(v)), Dec.ZERO);
  return atResolution(total, values.reduce((most, v) => Math.max(most, writtenDecimals(v)), 0));
}

/** The dispensed net of each line in the BOM unit (exact). */
function lineTotals(view: HandlerView, unit: string): Map<string, Dec> {
  const out = new Map<string, Dec>();
  for (const e of view.entries('CONTAINER_WEIGHING')) {
    const line = String(e.data['bomLine']);
    const net = convertAtResolution(view, String(e.data['net']), String(e.data['unit']), unit);
    if (net === undefined) continue;
    out.set(line, (out.get(line) ?? Dec.ZERO).plus(Dec.parse(net)));
  }
  return out;
}

function manualWeighingDraft(item: string, stepKey: string): ExceptionDraft {
  return {
    type: 'MANUAL_ENTRY_FALLBACK',
    title: `A weight for ${item} at ${stepKey} was keyed by hand instead of taken from the balance interface; the step now needs a second person`,
    controls: ['PR-20', 'PR-14', 'DI-30'],
    severity: 'ALERT',
    category: 'MANUAL_ENTRY',
    item,
    blocks: 'NONE',
  };
}

function acceptCalculation(view: HandlerView, entry: Readonly<Record<string, unknown>>): blocks.EntryResult {
  const c = tb01Config(view.config);
  if (view.entries('CONTAINER_WEIGHING').length > 0) {
    return { ok: false, problems: [problem('TB01-CALC-AFTER-DISPENSE', 'Material has been dispensed against the calculation already: a new calculation would move targets already weighed', ['PR-19', 'DI-33'])] };
  }
  const lots = (Array.isArray(entry['lots']) ? entry['lots'] : []).filter(isRecord).map((l) => ({
    lot: l['lot'] as Record<string, unknown>,
    assay: l['assay'] as Record<string, unknown>,
    ...(typeof l['baseEquivalent'] === 'string' ? { baseEquivalent: l['baseEquivalent'] } : {}),
  }));
  const problems: HandlerProblem[] = [];
  if (lots.length > c.active.maxLots) problems.push(problem('TB01-LOTS', `The MBR allows the active to be allocated across ${c.active.maxLots} lot(s), not ${lots.length}`, ['PR-19']));
  const bom = view.mbr.bom.find((b) => b.id === c.active.bomLine);
  const ids = new Set<string>();
  for (const l of lots) {
    problems.push(...lotProblems(view, l.lot, bom?.material));
    if (ids.has(String(l.lot['id']))) problems.push(problem('TB01-LOTS', `Lot ${String(l.lot['id'])} is named twice`, ['PR-19']));
    ids.add(String(l.lot['id']));
    if (l.assay['basis'] !== c.active.basis) {
      problems.push(problem('TB01-BASIS', `The result of lot ${String(l.lot['id'])} is reported on the ${String(l.assay['basis']).toLowerCase()} basis, the MBR calculates on ${c.active.basis.toLowerCase()}`, ['PR-19', 'DI-33']));
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const r = potencyTargets(potencyInput(c, view.mbr, lots));
  if (!r.ok) return { ok: false, problems: [problem(r.code, `The calculation cannot be made: ${r.message}`, ['PR-19', 'DI-33'])] };
  const exceptions: ExceptionDraft[] = [];
  if (c.capPercent !== undefined && Dec.parse(r.result.adjustmentPercent).gt(Dec.parse(c.capPercent))) {
    exceptions.push({
      type: 'POTENCY_ADJUSTMENT_CAP',
      title: `The adjusted quantity of ${c.active.bomLine} differs from its standard by ${r.result.adjustmentPercent} %, beyond the MBR's cap of ${c.capPercent} %; the steps after it wait for a deviation`,
      controls: ['PR-19', 'PR-04'],
      severity: 'ACTION',
      category: 'OUT_OF_LIMIT',
      blocks: 'DOWNSTREAM',
      until: 'DEVIATION',
      deviationRequired: true,
    });
  }
  // R13 (owner, 25 October 2026): a calculation made again (typically after QC updated a lot's potency) replaces the
  // targets the step had shown; QA sees the change as an exception of the step.
  const earlier = governing(view);
  if (earlier) {
    const asIs = (calc: Record<string, unknown>): string =>
      (Array.isArray(calc['results']) ? calc['results'] : [])
        .filter(isRecord)
        .map((x) => `${String(x['lot'])} ${String(x['asIsAssay'])} %`)
        .join(', ');
    exceptions.push({
      type: 'POTENCY_RECALCULATED',
      title: `The potency calculation was made again (as-is potency ${asIs(earlier)} before, ${r.result.lots.map((x, i) => `${String(lots[i]?.lot['id'])} ${x.asIsAssay} %`).join(', ')} now); QA reviews the change`,
      controls: ['PR-19', 'DI-33'],
      severity: 'ALERT',
      category: 'DEVIATION_OR_OVERRIDE',
      blocks: 'NONE',
    });
  }
  return { ok: true, data: calculationData(c, view.mbr, lots, r.result), ...(exceptions.length > 0 ? { exceptions } : {}) };
}

function acceptWeighing(view: HandlerView, entry: Readonly<Record<string, unknown>>): blocks.EntryResult {
  const c = tb01Config(view.config);
  const items = blocks.massItems(view.phase, view.mbr);
  const item = String(entry['item']);
  const problems: HandlerProblem[] = [];
  if (!items.includes(item)) problems.push(problem('TB01-ITEM', `${item} is not a dispensed quantity of ${view.phase.id}`, ['PR-19']));
  const bomLine = String(entry['bomLine']);
  const bom = view.mbr.bom.find((b) => b.id === bomLine);
  const isActive = bomLine === c.active.bomLine;
  if (!bom || !view.phase.consumes.includes(bomLine) || (!isActive && bomLine !== c.excipient?.bomLine)) {
    problems.push(problem('TB01-BOM-LINE', `${bomLine} is neither the active nor the compensating excipient of this step`, ['PR-19', 'PR-13']));
  }
  const lot = entry['lot'] as Record<string, unknown>;
  problems.push(...lotProblems(view, lot, bom?.material));
  const calc = governing(view);
  if (!calc) problems.push(problem('TB01-NO-CALCULATION', 'Nothing is dispensed before the potency calculation of the step is recorded', ['PR-19', 'DI-33']));
  else if (isActive && !(Array.isArray(calc['lots']) ? calc['lots'] : []).some((l) => isRecord(l) && isRecord(l['lot']) && l['lot']['id'] === lot['id'])) {
    problems.push(problem('TB01-LOT-NOT-CALCULATED', `Lot ${String(lot['id'])} is not a lot of the potency calculation: the active is dispensed only from the lots its target was calculated for`, ['PR-19']));
  }
  if (typeof entry['fefoReason'] === 'string' && entry['fefoReason'].trim() === '') problems.push(problem('TB01-FEFO-REASON', 'A reason is words, not blanks', ['PR-18']));
  const unit = String(entry['unit']);
  if (!isMassUnit(unit)) problems.push(problem('TB01-UNIT', `${unit} is not a mass unit`, ['DI-30']));
  else {
    const itemUnit = view.parameter(item)?.unit;
    if (itemUnit !== undefined && !countableInto(unit, itemUnit)) problems.push(problem('TB01-UNIT', `A weight in ${unit} cannot be counted into ${item} (${itemUnit})`, ['DI-30', 'INV-25']));
    if (bom && !countableInto(unit, bom.quantity.unit)) problems.push(problem('TB01-UNIT', `A weight in ${unit} cannot be compared with the target in ${bom.quantity.unit}`, ['DI-30', 'PR-19']));
  }
  const net = netOf(String(entry['gross']), String(entry['tare']));
  if (!net.ok) problems.push(problem('TB01-NET', net.message, ['PR-19', 'INV-25']));
  if (problems.length > 0 || !net.ok) return { ok: false, problems };
  const { kind: _kind, ...sent } = entry as Record<string, unknown>;
  void _kind;
  const manual = entry['source'] === 'MANUAL';
  const exceptions: ExceptionDraft[] = [];
  if (manual) exceptions.push(manualWeighingDraft(item, view.stepKey));
  if (typeof entry['fefoReason'] === 'string') {
    exceptions.push({
      type: 'FEFO_OVERRIDE',
      title: `Lot ${String(lot['id'])} was dispensed for ${bomLine} instead of the first-expiring usable lot, for the reason the dispenser gave`,
      controls: ['PR-18'],
      severity: 'ALERT',
      category: 'DEVIATION_OR_OVERRIDE',
      item,
      blocks: 'NONE',
    });
  }
  return {
    ok: true,
    data: {
      ...sent,
      lot: { ...lot },
      net: net.net,
      label: { component: bom?.material ?? bomLine, lot: lot['id'], quantity: `${net.net} ${unit}`, batch: view.batch.batchNumber, product: view.batch.productCode, container: entry['container'] },
    },
    registerContainers: [{ id: String(entry['container']), holds: bomLine, holdsKind: 'BOM_LINE', net: { value: net.net, unit } }],
    ...(exceptions.length > 0 ? { exceptions } : {}),
    ...(manual ? { verificationRequired: true } : {}),
  };
}

/** The targets of each line of the governing calculation, in the BOM unit. */
function lineTargets(calc: Record<string, unknown>): Map<string, Dec> {
  const out = new Map<string, Dec>();
  const active = isRecord(calc['active']) ? calc['active'] : {};
  let sum = Dec.ZERO;
  for (const l of Array.isArray(calc['results']) ? calc['results'] : []) if (isRecord(l) && typeof l['target'] === 'string') sum = sum.plus(Dec.parse(l['target']));
  out.set(String(active['bomLine']), sum);
  const exc = calc['excipient'];
  if (isRecord(exc) && typeof exc['target'] === 'string') out.set(String(exc['bomLine']), Dec.parse(exc['target']));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The block version

const CORE_VALUE_RULES: blocks.ExceptionRule[] = [
  { type: 'LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A value outside a limit tier (behaviour by tier)', controls: ['PR-08'] },
  { type: 'REPEAT_AFTER_FAIL', category: 'REPEAT_OR_ABORTED', severity: 'ACTION', summary: 'A new attempt after a failing result', controls: ['DI-29', 'INV-41'] },
  { type: 'MANUAL_ENTRY_FALLBACK', category: 'MANUAL_ENTRY', severity: 'ALERT', summary: 'Manual entry where device capture is configured; two-person mode', controls: ['DI-30', 'PR-14'] },
  { type: 'LATE_ENTRY', category: 'LATE_ENTRY', severity: 'ALERT', summary: 'Entry with a person-claimed time', controls: ['DI-28'] },
];

/** The nominal path: one lot assayed at 100.0 % on the MBR's basis (nothing else to correct), each target dispensed exactly. */
function nominalEntries({ phase, config, mbr }: Parameters<blocks.SimulatorModel['nominalEntries']>[0]): (Record<string, unknown> & { kind: string })[] {
  const c = tb01Config(config);
  const active = mbr.bom.find((b) => b.id === c.active.bomLine);
  const ref = (b: flow.BomLine | undefined) => mbr.references.find((r) => r.id === b?.material)?.code ?? b?.material ?? 'MAT';
  const assay: Record<string, unknown> = { resultId: '00000000-0000-4000-8000-000000000001', basis: c.active.basis, assay: c.active.basis === ACTIVITY_BASIS ? (c.active.declaredActivity ?? '1') : '100.0' };
  if (c.active.basis === 'ANHYDROUS_WATER' || c.active.basis === 'ANHYDROUS_SOLVENT_FREE') assay['water'] = '0';
  if (c.active.basis === 'ANHYDROUS_SOLVENT_FREE') assay['solvents'] = '0';
  if (c.active.basis === 'DRIED_LOD') assay['lod'] = '0';
  const lot = { id: `LOT-${c.active.bomLine}`, material: ref(active), status: 'RELEASED', identityTested: true };
  const r = potencyTargets(potencyInput(c, mbr, [{ assay }]));
  const items = blocks.massItems(phase, mbr);
  const item = items[0] ?? '';
  const unit = active?.quantity.unit ?? 'kg';
  const out: (Record<string, unknown> & { kind: string })[] = [{ kind: 'POTENCY_CALCULATION', lots: [{ lot, assay }] }];
  if (!r.ok) return out;
  out.push({ kind: 'CONTAINER_WEIGHING', item, bomLine: c.active.bomLine, container: `C-${phase.id}-1`, lot, gross: r.result.lots[0]?.target ?? '0', tare: '0', unit, balance: 'BAL-1', source: 'DEVICE' });
  if (c.excipient && r.result.excipient) {
    const exc = mbr.bom.find((b) => b.id === c.excipient?.bomLine);
    out.push({
      kind: 'CONTAINER_WEIGHING', item: items[1] ?? item, bomLine: c.excipient.bomLine, container: `C-${phase.id}-2`,
      lot: { id: `LOT-${c.excipient.bomLine}`, material: ref(exc), status: 'RELEASED', identityTested: true },
      gross: r.result.excipient.target, tare: '0', unit, balance: 'BAL-1', source: 'DEVICE',
    });
  }
  return out;
}

export const TB01: BlockVersion = {
  type: 'TB-01',
  version: '1',
  title: 'Potency/assay/LOD-adjusted dispensing with compensating excipient',
  edition: 'tablets',
  aliases: { tablets: 'TB-01' },
  level: 'PHASE',
  controls: TB01_CONTROLS,
  configSchema: CONFIG_SCHEMA,
  entrySummaries: {
    POTENCY_CALCULATION: (d, c) => {
      const active = S.rec(d['active']);
      const lots = S.list(d['lots']).map((l) => S.val(S.rec(S.rec(l)['lot'])['id']));
      const total = S.str(d['total']) !== '' ? `, ${S.amount(d['total'], active['unit'])} to dispense` : '';
      const adjust = S.str(d['adjustmentPercent']) !== '' ? `, adjusted by ${S.str(d['adjustmentPercent'])} %` : '';
      return `Potency calculation for ${c.name(active['bomLine'])}: ${lots.length === 1 ? 'lot' : 'lots'} ${lots.join(', ')}${total}${adjust}`;
    },
    CONTAINER_WEIGHING: blocks.G07.entrySummaries?.['CONTAINER_WEIGHING'] ?? ((d) => `Container ${S.val(d['container'])} weighed`),
  },
  dataSchema: { entries: { POTENCY_CALCULATION: CALCULATION_ENTRY, CONTAINER_WEIGHING: WEIGHING_ENTRY } },
  checkConfig,
  handler: {
    computedItems: (phase, mbr) => blocks.massItems(phase, mbr),
    acceptEntry: (view, entry) => (entry.kind === 'POTENCY_CALCULATION' ? acceptCalculation(view, entry) : acceptWeighing(view, entry)),
    computeItems: (view) => {
      // As G-07: each container counts into the quantity it names, in that quantity's unit at its resolution (INV-25).
      const byItem = new Map<string, { nets: string[]; entries: string[] }>();
      const items = blocks.massItems(view.phase, view.mbr);
      for (const e of view.entries('CONTAINER_WEIGHING')) {
        const item = typeof e.data['item'] === 'string' ? e.data['item'] : undefined;
        if (item === undefined || !items.includes(item)) continue;
        const p = view.parameter(item);
        const net = convertAtResolution(view, String(e.data['net']), String(e.data['unit']), p?.unit ?? String(e.data['unit']));
        if (net === undefined) continue;
        const acc = byItem.get(item) ?? { nets: [], entries: [] };
        acc.nets.push(net);
        acc.entries.push(e.id);
        byItem.set(item, acc);
      }
      return [...byItem].map(([item, acc]) => ({ item, value: { kind: 'DECIMAL' as const, value: sumDecimals(acc.nets), unit: view.parameter(item)?.unit ?? 'kg' }, entries: acc.entries }));
    },
    beforePerform: (view) => {
      const c = tb01Config(view.config);
      const calc = governing(view);
      if (!calc) return [problem('TB01-NO-CALCULATION', 'The potency calculation of the step has not been recorded', ['PR-19', 'DI-33'])];
      const weighed = view.entries('CONTAINER_WEIGHING');
      const out: HandlerProblem[] = [];
      for (const line of [c.active.bomLine, ...(c.excipient ? [c.excipient.bomLine] : [])]) {
        if (!weighed.some((e) => e.data['bomLine'] === line)) out.push(problem('TB01-INCOMPLETE', `Nothing has been dispensed yet for ${line}`, ['PR-19', 'PR-21']));
      }
      for (const l of Array.isArray(calc['lots']) ? calc['lots'] : []) {
        const id = isRecord(l) && isRecord(l['lot']) ? l['lot']['id'] : undefined;
        if (!weighed.some((e) => e.data['bomLine'] === c.active.bomLine && isRecord(e.data['lot']) && e.data['lot']['id'] === id)) {
          out.push(problem('TB01-INCOMPLETE', `Nothing has been dispensed yet from lot ${String(id)}, a lot of the calculation`, ['PR-19']));
        }
      }
      return out;
    },
    onPerform: (view) => {
      const c = tb01Config(view.config);
      const calc = governing(view);
      const unit = view.mbr.bom.find((b) => b.id === c.active.bomLine)?.quantity.unit;
      if (!calc || unit === undefined) return {};
      const totals = lineTotals(view, unit);
      const out: ExceptionDraft[] = [];
      for (const [line, target] of lineTargets(calc)) {
        // A line with nothing dispensed yet is beforePerform's (this runs at every PERFORMED attempt, refused ones too).
        if (!totals.has(line)) continue;
        const tol = line === c.active.bomLine ? c.tolerance.active : (c.tolerance.excipient ?? '0');
        const total = totals.get(line) ?? Dec.ZERO;
        if (total.minus(target).abs().lte(target.abs().times(Dec.parse(tol)).div(Dec.HUNDRED))) continue;
        out.push({
          type: 'DISPENSE_OUT_OF_TOLERANCE',
          title: `${line}: ${total.toString()} ${unit} dispensed is outside ${tol} % of its target ${target.toString()} ${unit}; it cannot be confirmed without this exception and a deviation`,
          controls: ['PR-19', 'PR-08'],
          severity: 'ACTION',
          category: 'OUT_OF_LIMIT',
          blocks: 'DOWNSTREAM',
          until: 'DEVIATION',
          deviationRequired: true,
        });
      }
      return { exceptions: out };
    },
    meanings: { check: ['CONTAINER_CHECKED'] },
  },
  exceptionRules: [
    { type: 'DISPENSE_OUT_OF_TOLERANCE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A dispensed total outside the tolerance of its potency-adjusted target', controls: ['PR-19'] },
    { type: 'POTENCY_ADJUSTMENT_CAP', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'The adjusted quantity of the active beyond the MBR\'s adjustment cap', controls: ['PR-19', 'PR-04'] },
    { type: 'FEFO_OVERRIDE', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A lot other than the first-expiring usable one dispensed, with the dispenser\'s reason (rotation report)', controls: ['PR-18'] },
    { type: 'POTENCY_RECALCULATED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'The potency calculation made again before dispensing (e.g. after QC updated a lot\'s potency); QA reviews the change', controls: ['PR-19', 'DI-33'] },
    ...CORE_VALUE_RULES,
  ],
  simulatorModel: {
    exceptionTypes: () => ['DISPENSE_OUT_OF_TOLERANCE', 'POTENCY_ADJUSTMENT_CAP', 'FEFO_OVERRIDE', 'MANUAL_ENTRY_FALLBACK'],
    nominalEntries,
  },
  goldenFixture: {
    description: 'Atorvastatin (C-06): the lot assayed 99.2 % anhydrous with 4.6 % water raises the active to 8.742 kg and lowers the filler to 19.531 kg; both dispensed into labelled containers and checked',
    controls: ['PR-19', 'DI-33'],
    phase: {
      block: { type: 'TB-01', version: '1' },
      config: {
        active: { bomLine: 'BOM-API', basis: 'ANHYDROUS_WATER', standardIs: 'BASE', standardBasis: 'salt, anhydrous, at 100.0 % as-is', form: { name: 'atorvastatin calcium, anhydrous', molarMassForm: '1155.36', molarMassBase: '558.64', baseMoieties: 2, hydrateWaters: 0, source: 'MD-MW-ATV rev 1' } },
        compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '18.000', max: '22.000' },
        readability: '0.001',
        tolerancePercent: { active: '0.5', excipient: '1.0' },
      },
      records: ['dispApi', 'dispMcc'],
      consumes: ['BOM-API', 'BOM-MCC'],
      signatures: { perform: { role: DISPENSER_ROLE }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
    },
    bom: [
      { id: 'BOM-API', material: 'MAT-ATV', role: 'ACTIVE', quantity: { value: '8.000', unit: 'kg' } },
      { id: 'BOM-MCC', material: 'MAT-MCC', role: 'EXCIPIENT', quantity: { value: '20.000', unit: 'kg' } },
    ],
    parameters: [
      { id: 'dispApi', name: 'Atorvastatin calcium dispensed', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      { id: 'dispMcc', name: 'Microcrystalline cellulose dispensed', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'NON_CRITICAL', riskClass: 'MEDIUM', capture: 'DEVICE' },
    ],
    script: [
      {
        entry: {
          kind: 'POTENCY_CALCULATION',
          lots: [{ lot: { id: 'AR-ATV-1', material: 'MAT-ATV', status: 'RELEASED', identityTested: true }, assay: { resultId: '00000000-0000-4000-8000-0000000000a1', basis: 'ANHYDROUS_WATER', assay: '99.2', water: '4.6' } }],
        },
      },
      { entry: { kind: 'CONTAINER_WEIGHING', item: 'dispApi', bomLine: 'BOM-API', container: 'C-001', lot: { id: 'AR-ATV-1', material: 'MAT-ATV', status: 'RELEASED', identityTested: true }, gross: '9.992', tare: '1.250', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' } },
      { entry: { kind: 'CONTAINER_WEIGHING', item: 'dispMcc', bomLine: 'BOM-MCC', container: 'C-002', lot: { id: 'AR-MCC-1', material: 'MAT-MCC', status: 'RELEASED', identityTested: true }, gross: '21.031', tare: '1.500', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED', values: { dispApi: '8.742', dispMcc: '19.531' } },
  },
  tests: ['apps/tablets-server/test/blocks/dispensing/potency.test.ts', 'apps/tablets-server/test/blocks/dispensing/tb-01.test.ts', 'apps/tablets-server/test/blocks/dispensing/tb-01-db.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// TB-01@2 (Phase 7 slice 7q, requirement R8 capability C2): potency adjustment in enzyme activity units
// ---------------------------------------------------------------------------------------------

/**
 * TB-01@2: as TB-01@1, and an active whose lots are judged by their enzyme activity (U/mg, the lot register's approved
 * result from LIMS or the CoA, basis ACTIVITY) instead of a percent assay. The MBR states the activity its standard
 * quantity is at (active.declaredActivity, U/mg, with the standard on the material itself, standardIs FORM); a lot of
 * activity A takes standard x declared / A (rounded UP to the readability, so the batch never holds fewer units than its
 * label claim), and the compensating excipient keeps the batch total as for an assay. The calculation stores each lot's
 * activity, its activity relative to the declared one and the label claim of the batch in units (the standard with its
 * overage x the declared activity), exactly; the database repeats it (tablets 1662). TB-01@1 stays as released for the
 * masters and batches that use it (ADR 0010: a released version never changes).
 */
function checkConfigV2(phase: PhaseNode, config: Readonly<Record<string, flow.JsonValue>>, mbr: MbrContent): ConfigProblem[] {
  const out = checkConfig(phase, config, mbr);
  const c = tb01Config(config);
  const err = (message: string): void => {
    out.push({ code: 'TB01-ACTIVITY', severity: 'ERROR', message: `${message} (TB01-ACTIVITY)`, controls: ['PR-19', 'DI-33'] });
  };
  if (c.active.basis === ACTIVITY_BASIS) {
    if (c.active.declaredActivity === undefined) err('an active judged by its activity states the activity (U/mg) its standard quantity is at');
    if (c.active.standardIs !== 'FORM' || c.active.form) err('an active judged by its activity states its standard on the material itself (FORM), without a salt form');
    const active = mbr.bom.find((b) => b.id === c.active.bomLine);
    if (active && MG_PER_UNIT[active.quantity.unit] === undefined) err(`the active's standard quantity is in ${active.quantity.unit}; the label claim in units needs kg, g or mg`);
  } else if (c.active.declaredActivity !== undefined) {
    err(`a declared activity is stated only with the ACTIVITY basis, not ${c.active.basis}`);
  }
  return out;
}

const ACTIVE_V1 = CONFIG_SCHEMA.fields['active'] as ObjectSchema;
const CONFIG_SCHEMA_V2: ObjectSchema = {
  ...CONFIG_SCHEMA,
  fields: {
    ...CONFIG_SCHEMA.fields,
    active: {
      ...ACTIVE_V1,
      fields: {
        ...ACTIVE_V1.fields,
        basis: { type: 'string', enum: [...ASSAY_BASES_V2], description: 'Assay basis (or ACTIVITY: the lot\'s enzyme activity in U/mg); it must match the basis of the lot result (no default)' },
        declaredActivity: { ...DECIMAL_POSITIVE, optional: true, description: 'ACTIVITY basis: the activity in U/mg the BOM\'s standard quantity is stated at (slice 7q, C2)' },
      },
    },
  },
};

const ASSAY_SCHEMA_V2: ObjectSchema = {
  ...ASSAY_SCHEMA,
  fields: {
    ...ASSAY_SCHEMA.fields,
    basis: { type: 'string', enum: [...ASSAY_BASES_V2], description: 'The basis the assay is reported on (C-01), or ACTIVITY (U/mg)' },
    assay: { type: 'decimal', description: 'Assay, % w/w on its basis; for ACTIVITY the activity in U/mg' },
  },
};
const LOTS_V1 = CALCULATION_ENTRY.fields['lots'] as Extract<FieldSchema, { type: 'array' }>;
const LOT_ITEM_V1 = LOTS_V1.items as ObjectSchema;
const CALCULATION_ENTRY_V2: ObjectSchema = {
  ...CALCULATION_ENTRY,
  fields: { lots: { ...LOTS_V1, items: { ...LOT_ITEM_V1, fields: { ...LOT_ITEM_V1.fields, assay: ASSAY_SCHEMA_V2 } } } },
};

const ENZYME_LOT = { id: 'AR-FDS-1', material: 'MAT-FDS', status: 'RELEASED', identityTested: true };

export const TB01_V2: BlockVersion = {
  ...TB01,
  version: '2',
  title: 'Potency/assay/LOD- or activity-adjusted dispensing with compensating excipient',
  configSchema: CONFIG_SCHEMA_V2,
  dataSchema: { entries: { POTENCY_CALCULATION: CALCULATION_ENTRY_V2, CONTAINER_WEIGHING: WEIGHING_ENTRY } },
  checkConfig: checkConfigV2,
  goldenFixture: {
    description:
      'Fungal diastase (slice 7q, C2): the standard 2.000 kg at a declared 100 U/mg (a label claim of 200,000,000 U); the lot assayed 125 U/mg takes 1.600 kg and the lactose rises to 10.400 kg; both dispensed into labelled containers and checked',
    controls: ['PR-19', 'DI-33'],
    phase: {
      block: { type: 'TB-01', version: '2' },
      config: {
        active: { bomLine: 'BOM-FDS', basis: 'ACTIVITY', standardIs: 'FORM', standardBasis: 'fungal diastase at 100 U/mg', declaredActivity: '100' },
        compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-LAC', min: '9.000', max: '11.000' },
        readability: '0.001',
        tolerancePercent: { active: '0.5', excipient: '1.0' },
      },
      records: ['dispFds', 'dispLac'],
      consumes: ['BOM-FDS', 'BOM-LAC'],
      signatures: { perform: { role: DISPENSER_ROLE }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } },
    },
    bom: [
      { id: 'BOM-FDS', material: 'MAT-FDS', role: 'ACTIVE', quantity: { value: '2.000', unit: 'kg' } },
      { id: 'BOM-LAC', material: 'MAT-LAC', role: 'EXCIPIENT', quantity: { value: '10.000', unit: 'kg' } },
    ],
    parameters: [
      { id: 'dispFds', name: 'Fungal diastase dispensed', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' },
      { id: 'dispLac', name: 'Lactose dispensed', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'NON_CRITICAL', riskClass: 'MEDIUM', capture: 'DEVICE' },
    ],
    script: [
      { entry: { kind: 'POTENCY_CALCULATION', lots: [{ lot: ENZYME_LOT, assay: { resultId: '00000000-0000-4000-8000-0000000000b1', basis: 'ACTIVITY', assay: '125' } }] } },
      { entry: { kind: 'CONTAINER_WEIGHING', item: 'dispFds', bomLine: 'BOM-FDS', container: 'C-101', lot: ENZYME_LOT, gross: '2.850', tare: '1.250', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' } },
      { entry: { kind: 'CONTAINER_WEIGHING', item: 'dispLac', bomLine: 'BOM-LAC', container: 'C-102', lot: { id: 'AR-LAC-1', material: 'MAT-LAC', status: 'RELEASED', identityTested: true }, gross: '11.900', tare: '1.500', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED', values: { dispFds: '1.600', dispLac: '10.400' } },
  },
  tests: [...(TB01.tests ?? []), 'apps/tablets-server/test/blocks/dispensing/tb-01-activity.test.ts'],
};
