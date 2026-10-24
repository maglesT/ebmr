/**
 * A new master record from an approved formula, without a template (Phase 7 slice 7j, R4; decisions D-7j-5, D-7j-6).
 *
 * The header comes from the formula and the product master (name, dosage form), the discrete batch sizes from the
 * formula's sizes (PR-01: the reference size is the formula's theoretical batch mass, each further size that mass scaled
 * to its units, three decimals, half up; never typed), the bill of materials line by line from the formula's computed
 * batch quantities (INV-25), and each material is pinned (material-refs.ts). The database pins the formula version and
 * checks the content carries exactly its composition (recipe-core 0640, 0690). Three starts:
 *  - SKELETON: the required skeleton of a processing master: a dispensing stage (room clearance, balance status, SOP,
 *    dispensing quantities, weighing of the actives, the other unit components and the processing aids, reconciliation)
 *    and a blending stage (clearance, equipment status, charge, blend, QA hold point, discharge, yield), with their
 *    parameters, calculations (from the formula's per-unit quantities), yield checkpoints, hold time and golden cases,
 *    shaped as the dc-mini demo master's two stages; the author adds, removes and reorders stages and steps in the designer;
 *  - BLANK: the header, the bill of materials and one dispensing stage with its clearance and balance status only;
 *  - COPY: the procedure of an approved master with this header and bill of materials: a BOM line of the same material
 *    keeps its id, the steps lose the lines that are no longer in the bill, and the validator shows what is left to do.
 * No JavaScript number holds a quantity: every value is decimal text (Dec, exact).
 */
import { Dec } from '@ebmr/expr';
import type { formula } from '@ebmr/recipe-core';
import { flow as flowNs, type flow } from '@ebmr/recipe-core/pure';
import { FamilyInputError, KNOWN_MARKETS, scaleDecimal } from './family.ts';
import { bomOverage, withOverageQuantity } from './formula-choice.ts';
import { materialReference, type MaterialMaster } from './material-refs.ts';
import type { MbrTemplate } from './templates/index.ts';

export type FormulaStart = 'SKELETON' | 'BLANK' | 'COPY';

export interface FormulaFamilyRequest {
  familyCode: string;
  markets: string[];
  start: FormulaStart;
}

export interface FormulaSource {
  chosen: formula.FormulaChoice;
  target: formula.FormulaTarget | null;
  product: { name: string; dosageForm: string };
  materials: readonly MaterialMaster[];
}

/** The demo references (SOPs, systems, equipment classes, risk scale, validation and hold studies) the skeleton pins, from dc-mini. */
const SKELETON_REFS = ['SOP-DISP-001', 'SOP-BLEND-002', 'SOP-CLEAN-003', 'SYS-WEIGH-01', 'VR-BLEND-01', 'QRM-SCALE', 'EQC-BAL', 'EQC-BLENDER', 'HS-PCM-01'];

const bomId = (l: formula.FormulaLine): string => `BOM-${l.lineId.toUpperCase()}`;
const BOM_ROLE: Readonly<Record<formula.FormulaLineRole, flow.BomRole>> = { ACTIVE: 'ACTIVE', EXCIPIENT: 'EXCIPIENT', COATING: 'EXCIPIENT', PROCESSING_AID: 'PROCESSING_AID' };

/** The quantity of one unit, mg, the overage and salt factor applied: (q + overage q) x (100 + overage) / 100 x factor (exact). */
export function unitMg(l: formula.FormulaLine): string {
  return Dec.parse(withOverageQuantity(l)).times(Dec.parse('100').plus(Dec.parse(l.overagePercent ?? '0'))).div(Dec.parse('100')).times(Dec.parse(l.saltFactor ?? '1')).toString();
}

const sum = (xs: readonly string[]): string => xs.reduce((a, x) => a.plus(Dec.parse(x)), Dec.parse('0')).toString();

function checkRequest(req: FormulaFamilyRequest): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(req.familyCode)) {
    throw new FamilyInputError('DESIGNER_FAMILY_CODE', 'A family code is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit.', ['PR-01']);
  }
  if (new Set(req.markets).size !== req.markets.length) throw new FamilyInputError('DESIGNER_MARKETS', 'A market is listed twice.', ['IN-52']);
  const unknown = req.markets.filter((m) => !(KNOWN_MARKETS as readonly string[]).includes(m));
  if (unknown.length > 0) throw new FamilyInputError('DESIGNER_MARKETS', `Unknown market ${unknown.join(', ')}; the markets are ${KNOWN_MARKETS.join(', ')}.`, ['IN-52']);
  if (!req.markets.includes('IN')) {
    throw new FamilyInputError('DESIGNER_MARKETS', 'India (IN) must be in every market set: every batch is made under an Indian licence, so Revised Schedule M always applies.', ['INV-28', 'IN-52']);
  }
  return ['IN', ...KNOWN_MARKETS.filter((m) => m !== 'IN' && req.markets.includes(m))];
}

/** The discrete batch sizes: the formula's batch mass for its units, then each further size scaled (PR-01, INV-25). */
export function formulaBatchSizes(src: FormulaSource): flow.MbrHeader['batchSizes'] {
  const units = src.target?.batchSizesUnits ?? [src.chosen.batchSizeUnits];
  const ref = src.chosen.batchSizeUnits;
  return units.map((u) => ({ id: `BS-${u}U`, quantity: { value: u === ref ? src.chosen.batchMassKg : scaleDecimal(src.chosen.batchMassKg, u, ref, 3), unit: 'kg' } }));
}

function header(src: FormulaSource, req: FormulaFamilyRequest, markets: string[]): flow.MbrHeader {
  const c = src.chosen;
  return {
    family: req.familyCode,
    title: `${src.product.name} ${c.strength}: processing`,
    edition: 'tablets',
    recordKind: 'PROCESSING',
    product: { code: c.productCode, name: src.product.name, strength: c.strength, dosageForm: src.product.dosageForm },
    batchSizes: formulaBatchSizes(src),
    marketSet: markets,
    predicates: {},
    variants: [],
  };
}

function materialRefs(src: FormulaSource): flow.Reference[] {
  return src.chosen.lines.map((l) => {
    const m = src.materials.find((x) => x.code === l.materialCode);
    if (!m) throw new FamilyInputError('DESIGNER_MATERIAL', `Material ${l.materialCode} of the formula is not in effect in the material master.`, ['PR-17']);
    return materialReference(m);
  });
}

const bomOf = (src: FormulaSource): flow.BomLine[] =>
  src.chosen.lines.map((l) => {
    const overage = bomOverage(l);
    return { id: bomId(l), material: l.materialCode, role: BOM_ROLE[l.role], quantity: { value: l.batchQuantity, unit: 'kg' }, ...(overage ? { overage } : {}) };
  });

function parsed(content: flow.MbrContent): flow.MbrContent {
  const check = flowNs.parseMbr(JSON.parse(JSON.stringify(content)));
  if (!check.ok) throw new FamilyInputError('DESIGNER_CONTENT', `The new content does not parse: ${check.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`, ['PR-03']);
  return check.mbr;
}

const walk = (n: unknown, visit: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(n)) n.forEach((x) => walk(x, visit));
  else if (n && typeof n === 'object') {
    visit(n as Record<string, unknown>);
    Object.values(n).forEach((x) => walk(x, visit));
  }
};

/** The skeleton (header comment), shaped from the dc-mini demo master's two stages. */
function skeleton(base: MbrTemplate, src: FormulaSource, req: FormulaFamilyRequest, markets: string[], timeSystem?: flow.Reference): flow.MbrContent {
  const t = structuredClone(base.content);
  const c = src.chosen;
  const actives = c.lines.filter((l) => l.basis === 'PER_UNIT' && l.role === 'ACTIVE');
  const others = c.lines.filter((l) => l.basis === 'PER_UNIT' && l.role !== 'ACTIVE');
  const aids = c.lines.filter((l) => l.basis === 'PER_BATCH');
  if (actives.length === 0) throw new FamilyInputError('DESIGNER_FORMULA', 'The formula has no active given per unit; a processing master dispenses its actives.', ['PR-01']);
  const mgText = (ls: formula.FormulaLine[]): string => sum(ls.map(unitMg));
  const refUnits = c.batchSizeUnits;
  const kg = (mg: string): string => Dec.parse(mg).times(Dec.parse(refUnits)).div(Dec.parse('1000000')).toString();

  const param = (id: string, name: string): flow.Parameter =>
    ({ id, name, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
  const calc = (id: string, name: string, expression: string, unit = 'kg', tag?: string): flow.Calculation =>
    ({ id, name, expression, output: { valueType: 'DECIMAL', unit, ...(tag ? { semanticTag: tag } : {}) }, criticality: 'CRITICAL', riskClass: 'HIGH' });
  const groups = [
    { key: 'act', lines: actives, name: 'Actives', tol: '0.5' },
    { key: 'exc', lines: others, name: 'Other unit components', tol: '1.0' },
    { key: 'aid', lines: aids, name: 'Processing aids', tol: '1.0' },
  ].filter((g) => g.lines.length > 0);
  const charged = groups.filter((g) => g.key !== 'aid');

  const calculations: flow.Calculation[] = groups.map((g) =>
    g.key === 'aid'
      ? calc('aidTarget', 'Processing aids to dispense (per batch, scaled to the batch size)', `${sum(g.lines.map((l) => l.quantity))} [kg] * tabletsPerBatch / ${refUnits}`)
      : calc(`${g.key}Target`, `${g.name} to dispense (${mgText(g.lines)} mg per tablet)`, `${mgText(g.lines)} [mg] * tabletsPerBatch`),
  );
  calculations.push(calc('dispTarget', 'Total to dispense', groups.map((g) => `${g.key}Target`).join(' + ')));
  calculations.push(calc('dispRecon', 'Dispensing reconciliation', `yield(${groups.map((g) => `${g.key}Dispensed`).join(' + ')}, dispTarget)`, '%', 'yield'));
  calculations.push(calc('blendInput', 'Materials charged to the blender', charged.map((g) => `${g.key}Dispensed`).join(' + ')));
  calculations.push(calc('blendYield', 'Blend yield', 'yield(blendNet, blendInput)', '%', 'yield'));

  // Blending and lubrication is the tablet block TB-07 (D-7j-6): its times come from the step's timed entries on the
  // trusted clock, within the validated ranges (the author sets this product's validated times in the designer).
  const timed = (id: string, name: string, low: string, high: string): flow.Parameter =>
    ({
      id,
      name,
      valueType: 'DECIMAL',
      unit: 's',
      precision: { kind: 'DECIMALS', digits: 0 },
      role: 'PROCESS_PARAMETER',
      criticality: 'CRITICAL',
      riskClass: 'HIGH',
      capture: 'AUTOMATION',
      limits: { unit: 's', ranges: [{ tier: 'VALIDATED', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, low: { value: low, inclusive: true }, high: { value: high, inclusive: true } }] },
    });
  const blendNet = t.parameters.filter((p) => p.id === 'blendNet');
  t.parameters = [
    ...groups.map((g) => param(`${g.key}Dispensed`, `${g.name} dispensed (net total)`)),
    timed('blendTime', 'Main blend time', '60', '900'),
    timed('lubeTime', 'Lubrication time', '30', '300'),
    ...blendNet,
  ];
  t.calculations = calculations;

  // Golden cases (DI-04): the targets at the reference size, the reconciliation and the yield at the target.
  const targets: Record<string, flow.GoldenValue> = {};
  for (const g of groups) targets[`${g.key}Target`] = { value: g.key === 'aid' ? sum(g.lines.map((l) => l.quantity)) : kg(mgText(g.lines)), unit: 'kg' };
  const total = sum(Object.values(targets).map((v) => (v as { value: string }).value));
  const dispensed: Record<string, flow.GoldenValue> = {};
  for (const g of groups) dispensed[`${g.key}Dispensed`] = { value: (targets[`${g.key}Target`] as { value: string }).value, unit: 'kg' };
  const chargedTotal = sum(charged.map((g) => (targets[`${g.key}Target`] as { value: string }).value));
  t.goldenCases = [
    { id: 'G-TARGETS', description: `Dispensing quantities for ${refUnits} tablets`, inputs: { tabletsPerBatch: { value: refUnits } }, expected: { ...targets, dispTarget: { value: total, unit: 'kg' } } },
    { id: 'G-DISP-RECON', description: 'Dispensing reconciliation at the targets', inputs: { ...dispensed, dispTarget: { value: total, unit: 'kg' } }, expected: { dispRecon: { value: '100.00', unit: '%' } } },
    {
      id: 'G-BLEND-YIELD',
      description: 'Blend yield: everything charged is discharged',
      inputs: { blendNet: { value: chargedTotal, unit: 'kg' }, ...Object.fromEntries(charged.map((g) => [`${g.key}Dispensed`, dispensed[`${g.key}Dispensed`] as flow.GoldenValue])) },
      expected: { blendInput: { value: chargedTotal, unit: 'kg' }, blendYield: { value: '100.00', unit: '%' } },
    },
  ];

  // The procedure: dc-mini's two stages with the dispensing steps per group.
  const seq = (t.procedure.body as flow.SequenceNode).children;
  const disp = seq.find((n) => n.id === 'S-DISP') as flow.StageNode;
  const blend = seq.find((n) => n.id === 'S-BLEND') as flow.StageNode;
  let weigh: flow.PhaseNode | undefined;
  walk(disp, (o) => {
    if (o['id'] === 'p-disp-pcm') weigh = o as unknown as flow.PhaseNode;
  });
  if (!weigh) throw new Error('the dc-mini dispensing step p-disp-pcm is missing');
  const proto = weigh;
  const weighs: flow.PhaseNode[] = groups.map((g) => ({
    ...structuredClone(proto),
    id: `p-disp-${g.key}`,
    name: `Dispense ${g.name.toLowerCase()}`,
    records: [`${g.key}Dispensed`],
    reads: [`${g.key}Target`],
    consumes: g.lines.map(bomId),
    config: { tolerance: { percent: g.tol } },
  }));
  walk(disp, (o) => {
    if (o['kind'] === 'sequence' && Array.isArray(o['children'])) {
      o['children'] = (o['children'] as flow.FlowNode[]).flatMap((n) => (n.id === 'p-disp-pcm' ? weighs : n.id === 'p-disp-exc' ? [] : [n]));
    }
  });
  walk(disp, (o) => {
    if (o['id'] === 'p-disp-calc') o['computes'] = calculations.filter((x) => x.id.endsWith('Target')).map((x) => x.id);
  });
  walk(blend, (o) => {
    if (o['id'] === 'p-blend-charge') o['consumes'] = charged.flatMap((g) => g.lines.map(bomId));
    if (o['id'] === 'p-blend') {
      o['name'] = 'Blending and lubrication';
      o['block'] = { type: 'TB-07', version: '1' };
      o['config'] = {
        blendTime: { min: { value: '60', unit: 's' }, max: { value: '900', unit: 's' }, item: 'blendTime' },
        lubrication: { min: { value: '30', unit: 's' }, max: { value: '300', unit: 's' }, item: 'lubeTime' },
      };
      o['records'] = ['blendTime', 'lubeTime'];
      o['signatures'] = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
      o['system'] = { kind: 'OTHER', ref: 'SYS-EBMR-TIME' };
    }
  });
  t.procedure = { ...t.procedure, id: `PROC-${c.productCode}`, name: `${src.product.name} ${c.strength}: dispensing and blending` };
  t.timeConstraints = t.timeConstraints.map((tc) => ({ ...tc, from: { ...tc.from, node: 'p-disp-act' } }));
  t.intermediates = t.intermediates.map((i) => ({ ...i, name: 'Final blend' }));

  // The clearance and equipment status stay the sandbox versions (G-10@1, G-09@1) the demo plant runs (D-7j-6); the
  // validator says a GMP batch refuses them, and the author inserts the database-backed versions from the palette.
  t.header = header(src, req, markets);
  t.references = [...base.content.references.filter((r) => SKELETON_REFS.includes(r.id)), ...(timeSystem ? [timeSystem] : []), ...materialRefs(src)];
  t.bom = bomOf(src);
  return t;
}

/** BLANK (header comment): the header, the bill of materials and a dispensing stage with its clearance and balance status. */
function blank(base: MbrTemplate, src: FormulaSource, req: FormulaFamilyRequest, markets: string[]): flow.MbrContent {
  const t = skeleton(base, src, req, markets, undefined);
  const disp = (t.procedure.body as flow.SequenceNode).children.find((n) => n.id === 'S-DISP') as flow.StageNode;
  walk(disp, (o) => {
    if (o['kind'] === 'sequence' && Array.isArray(o['children'])) {
      o['children'] = (o['children'] as flow.FlowNode[]).filter((n) => n.kind !== 'phase' || n.id === 'p-disp-clear' || n.id === 'p-disp-bal');
    }
  });
  (t.procedure.body as flow.SequenceNode).children = [disp];
  t.parameters = [];
  t.calculations = [];
  t.yieldCheckpoints = [];
  t.timeConstraints = [];
  t.goldenCases = [];
  t.intermediates = [];
  t.riskReductions = [];
  t.references = t.references.filter((r) => r.kind === 'MATERIAL' || ['SOP-CLEAN-003', 'QRM-SCALE', 'EQC-BAL'].includes(r.id));
  return t;
}

/** COPY (header comment): the approved master's procedure with this header and bill of materials. */
function copy(source: flow.MbrContent, src: FormulaSource, req: FormulaFamilyRequest, markets: string[]): flow.MbrContent {
  const t = structuredClone(source);
  const codeOf = (b: flow.BomLine): string => t.references.find((r) => r.id === b.material)?.code ?? b.material;
  const bom: flow.BomLine[] = src.chosen.lines.map((l) => {
    const same = t.bom.find((b) => codeOf(b) === l.materialCode);
    return { id: same?.id ?? bomId(l), material: l.materialCode, role: BOM_ROLE[l.role], quantity: { value: l.batchQuantity, unit: 'kg' } };
  });
  const kept = new Set(bom.map((b) => b.id));
  const packaging = t.bom.filter((b) => !['ACTIVE', 'EXCIPIENT', 'PROCESSING_AID'].includes(b.role) && !kept.has(b.id));
  walk(t.procedure, (o) => {
    if (o['kind'] === 'phase' && Array.isArray(o['consumes'])) o['consumes'] = (o['consumes'] as string[]).filter((id) => kept.has(id) || packaging.some((p) => p.id === id));
  });
  const oldMaterials = new Set(t.bom.map((b) => b.material));
  const keepRef = (r: flow.Reference): boolean => r.kind !== 'MATERIAL' || !oldMaterials.has(r.id) || packaging.some((p) => p.material === r.id);
  t.references = [...t.references.filter((r) => keepRef(r) && !src.chosen.lines.some((l) => l.materialCode === r.code && r.kind === 'MATERIAL')), ...materialRefs(src)];
  t.bom = [...bom, ...packaging];
  t.header = { ...header(src, req, markets), recordKind: source.header.recordKind, predicates: source.header.predicates, variants: source.header.variants };
  return t;
}

/**
 * The DRAFT content of a new family from an approved formula (throws FamilyInputError with a plain message). `base` is
 * the dc-mini demo master the skeleton is shaped from; `timeSystem` the trusted-time system TB-07 relies on (DI-04).
 */
export function contentFromFormula(base: MbrTemplate, src: FormulaSource, req: FormulaFamilyRequest, copySource?: flow.MbrContent, timeSystem?: flow.Reference): flow.MbrContent {
  const markets = checkRequest(req);
  if (req.start === 'COPY') {
    if (!copySource) throw new FamilyInputError('DESIGNER_COPY', 'Name the approved master to copy.', ['PR-01']);
    return parsed(copy(copySource, src, req, markets));
  }
  return parsed(req.start === 'BLANK' ? blank(base, src, req, markets) : skeleton(base, src, req, markets, timeSystem));
}
