/**
 * Generic material blocks, version 1 (outline 6.6; tablets spec K-07, K-08, K-22, K-23): G-07 weighing
 * and dispensing, G-08 identification and charge-in, G-22 output containers, G-23 returns, rejects and
 * destruction.
 *
 * Material status comes with each entry as read from site services at the moment of use (the database
 * check and the reservation arrive in Phase 3); the engine hard-blocks anything but a released lot
 * within its retest and expiry dates of exactly the item the MBR names (PR-18, IN-23). Net weights and
 * container totals are computed, never typed (INV-25).
 */
import { Dec } from '@ebmr/expr';
import type { MbrContent, PhaseNode } from '../../flow/model.ts';
import type { BlockVersion, ComputedItem, ExceptionDraft, HandlerProblem, HandlerView } from '../contract.ts';
import { configRecord, convert, convertAtResolution, CORE_VALUE_RULES, countableInto, isMassUnit, LOT_SCHEMA, massItems, micros, netOf, problem, QUANTITY_SCHEMA, sumDecimals } from './common.ts';
import * as S from '../summary.ts';

const WEIGHING_FIELDS = {
  gross: { type: 'decimal' as const, description: 'Gross weight from the balance' },
  tare: { type: 'decimal' as const, description: 'Tare weight (weighed, or nominal for validated container types)' },
  unit: { type: 'string' as const, description: 'UCUM mass unit of gross and tare' },
  balance: { type: 'string' as const, description: 'Balance id (calibrated, daily check passed; Phase 3 checks its status)' },
  source: { type: 'string' as const, enum: ['DEVICE', 'MANUAL'], description: 'From the balance interface, or keyed by hand (flagged; two-person mode)' },
};

function lotProblems(view: HandlerView, lot: Record<string, unknown>, expectedMaterial: string | undefined): HandlerProblem[] {
  const out: HandlerProblem[] = [];
  const ref = expectedMaterial === undefined ? undefined : view.mbr.references.find((r) => r.id === expectedMaterial);
  const material = lot['material'];
  if (expectedMaterial !== undefined && material !== expectedMaterial && material !== ref?.code) {
    out.push(problem('G07-WRONG-MATERIAL', `Lot ${String(lot['id'])} is ${String(material)}, not the item the MBR names (${ref?.code ?? expectedMaterial})`, ['PR-18', 'IN-23', 'PR-21']));
  }
  if (lot['status'] !== 'RELEASED') out.push(problem('G07-LOT-STATUS', `Lot ${String(lot['id'])} is ${String(lot['status']).toLowerCase()}: only released lots may be used, with no operator override`, ['PR-18', 'IN-23', 'PR-46']));
  const exp = micros(lot['expiresAtUs']);
  if (exp !== undefined && exp <= view.nowUs) out.push(problem('G07-LOT-EXPIRED', `Lot ${String(lot['id'])} is past its expiry date`, ['PR-18', 'IN-23']));
  const retest = micros(lot['retestAtUs']);
  if (retest !== undefined && retest <= view.nowUs) out.push(problem('G07-LOT-RETEST', `Lot ${String(lot['id'])} is past its retest date`, ['PR-18', 'IN-23']));
  const usOrEu = view.batch.marketSet.some((m) => m !== 'IN');
  if (usOrEu && lot['identityTested'] === false) out.push(problem('G07-LOT-IDENTITY', `Lot ${String(lot['id'])} has no identity-test result; a batch for ${view.batch.marketSet.join(', ')} needs one`, ['IN-24']));
  return out;
}

/**
 * A weight in `unit` is counted into the quantity `item` records (engine 1.3.0): in the item's own unit, or both in
 * metric mass units, so that the total keeps the resolution of every weighing and the database can check it exactly
 * (recipe-core 0322, EBMR-EXE-138). None when no quantity is computed from it.
 */
function countingProblems(code: string, view: HandlerView, unit: string, item: string | undefined): HandlerProblem[] {
  const itemUnit = item === undefined ? undefined : view.parameter(item)?.unit;
  if (itemUnit === undefined || countableInto(unit, itemUnit)) return [];
  return [problem(code, `A weight in ${unit} cannot be counted into ${item ?? ''} (${itemUnit}): weigh in ${itemUnit}, or both in metric mass units such as kg, g and mg`, ['DI-30', 'INV-25'])];
}

function containerTotals(view: HandlerView, kind: string, itemOf: (data: Record<string, unknown>) => string | undefined): ComputedItem[] {
  const byItem = new Map<string, { nets: string[]; entries: string[] }>();
  const items = massItems(view.phase, view.mbr);
  for (const e of view.entries(kind)) {
    const item = itemOf(e.data);
    if (item === undefined || !items.includes(item)) continue;
    const p = view.parameter(item);
    // In the item's unit at the resolution of the weighings (8000.0 g counts as 8.0000 kg; engine 1.3.0).
    const net = convertAtResolution(view, String(e.data['net']), String(e.data['unit']), p?.unit ?? String(e.data['unit']));
    if (net === undefined) continue;
    const acc = byItem.get(item) ?? { nets: [], entries: [] };
    acc.nets.push(net);
    acc.entries.push(e.id);
    byItem.set(item, acc);
  }
  return [...byItem].map(([item, acc]) => ({ item, value: { kind: 'DECIMAL', value: sumDecimals(acc.nets), unit: view.parameter(item)?.unit ?? 'kg' }, entries: acc.entries }));
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

// ---------------------------------------------------------------------------------------------
// G-07 Weighing and dispensing

function dispensingTarget(view: HandlerView): { item: string; value: string; unit: string } | undefined {
  for (const r of view.phase.reads) {
    const t = view.target(r);
    if (t?.kind === 'DECIMAL' && isMassUnit(t.unit)) return { item: r, value: t.value, unit: t.unit };
  }
  return undefined;
}

function toleranceOf(config: Readonly<Record<string, unknown>>): { percent: string } | { absolute: { value: string; unit: string } } | undefined {
  const t = configRecord(config, 'tolerance');
  if (typeof t['percent'] === 'string') return { percent: t['percent'] };
  const abs = t['absolute'];
  if (typeof abs === 'object' && abs !== null && typeof (abs as Record<string, unknown>)['value'] === 'string') {
    const a = abs as Record<string, string>;
    return { absolute: { value: a['value'] as string, unit: a['unit'] as string } };
  }
  return undefined;
}

export const G07: BlockVersion = {
  type: 'G-07',
  version: '1',
  title: 'Weighing and dispensing',
  edition: 'generic',
  aliases: { tablets: 'K-07', injectables: 'KB-05' },
  level: 'PHASE',
  controls: ['PR-18', 'PR-19', 'PR-20', 'IN-23', 'IN-24', 'DI-30', 'INV-25'],
  configSchema: {
    type: 'object',
    description: 'Dispensing into containers labelled for this batch, within tolerance of the target',
    fields: {
      tolerance: {
        type: 'object',
        optional: true,
        description: 'Tolerance of the dispensed total around the target the phase reads (mandatory when it reads one)',
        fields: {
          percent: { type: 'decimal', optional: true, min: '0', description: 'Relative tolerance in percent of the target' },
          absolute: { ...QUANTITY_SCHEMA, optional: true, description: 'Absolute tolerance' },
        },
      },
      method: { type: 'string', enum: ['NET', 'BY_DIFFERENCE', 'WHOLE_CONTAINER'], optional: true, description: 'Weighing method (default NET)' },
    },
  },
  entrySummaries: { CONTAINER_WEIGHING: weighingSummary },
  dataSchema: {
    entries: {
      CONTAINER_WEIGHING: {
        type: 'object',
        description: 'One dispensed container: lot, gross, tare; the net is computed',
        fields: {
          item: { type: 'string', description: 'The dispensed-quantity parameter this container counts towards' },
          bomLine: { type: 'string', description: 'BOM line the material belongs to' },
          container: { type: 'string', description: 'Unique container id (printed on its label)' },
          lot: LOT_SCHEMA,
          ...WEIGHING_FIELDS,
        },
      },
    },
  },
  checkConfig: (phase, config, mbr) => {
    const out = [];
    if (phase.consumes.length === 0) out.push({ code: 'G07-NO-BOM', severity: 'ERROR' as const, message: `Dispensing step ${phase.id} consumes no BOM line`, controls: ['PR-19'] });
    const readsMass = phase.reads.some((r) => {
      const t = mbr.calculations.find((c) => c.id === r)?.output.unit ?? mbr.parameters.find((p) => p.id === r)?.unit ?? mbr.inputs.find((i) => i.id === r)?.unit;
      return isMassUnit(t);
    });
    if (readsMass && toleranceOf(config) === undefined) {
      out.push({ code: 'G07-TOLERANCE-MISSING', severity: 'WARNING' as const, message: `Dispensing step ${phase.id} reads a target but has no tolerance: the dispensed total is shown against the target but not checked`, controls: ['PR-19'] });
    }
    return out;
  },
  handler: {
    computedItems: (phase: PhaseNode, mbr: MbrContent) => massItems(phase, mbr),
    acceptEntry: (view, entry) => {
      const items = massItems(view.phase, view.mbr);
      const item = String(entry['item']);
      const problems: HandlerProblem[] = [];
      if (!items.includes(item)) problems.push(problem('G07-ITEM', `${item} is not a dispensed quantity of ${view.phase.id}`, ['PR-19']));
      const bomLine = String(entry['bomLine']);
      const bom = view.mbr.bom.find((b) => b.id === bomLine);
      if (!view.phase.consumes.includes(bomLine) || !bom) problems.push(problem('G07-BOM-LINE', `${bomLine} is not a BOM line this step dispenses`, ['PR-19', 'PR-13']));
      problems.push(...lotProblems(view, entry['lot'] as Record<string, unknown>, bom?.material));
      const unit = String(entry['unit']);
      if (!isMassUnit(unit)) problems.push(problem('G07-UNIT', `${unit} is not a mass unit`, ['DI-30']));
      else problems.push(...countingProblems('G07-UNIT', view, unit, items.includes(item) ? item : undefined));
      const net = netOf(String(entry['gross']), String(entry['tare']));
      if (!net.ok) problems.push(problem('G07-NET', net.message, ['PR-19', 'INV-25']));
      if (problems.length > 0 || !net.ok) return { ok: false, problems };
      const lot = entry['lot'] as Record<string, unknown>;
      const manual = entry['source'] === 'MANUAL';
      return {
        ok: true,
        data: {
          item,
          bomLine,
          container: entry['container'],
          lot: { ...lot },
          gross: entry['gross'],
          tare: entry['tare'],
          net: net.net,
          unit,
          balance: entry['balance'],
          source: entry['source'],
          label: { component: bom?.material ?? bomLine, lot: lot['id'], quantity: `${net.net} ${unit}`, batch: view.batch.batchNumber, product: view.batch.productCode, container: entry['container'] },
        },
        registerContainers: [{ id: String(entry['container']), holds: bomLine, holdsKind: 'BOM_LINE', net: { value: net.net, unit } }],
        ...(manual ? { exceptions: [manualWeighingDraft(item, view.stepKey)], verificationRequired: true } : {}),
      };
    },
    computeItems: (view) => containerTotals(view, 'CONTAINER_WEIGHING', (d) => d['item'] as string | undefined),
    beforePerform: (view) => {
      const missing = view.phase.consumes.filter((b) => !view.entries('CONTAINER_WEIGHING').some((e) => e.data['bomLine'] === b));
      return missing.length > 0 ? [problem('G07-BOM-INCOMPLETE', `Nothing has been dispensed yet for ${missing.join(', ')}`, ['PR-19', 'PR-21'])] : [];
    },
    onPerform: (view) => {
      const target = dispensingTarget(view);
      const tol = toleranceOf(view.config);
      if (!target || !tol) return {};
      const out: ExceptionDraft[] = [];
      for (const item of massItems(view.phase, view.mbr)) {
        const total = view.points(item).find((p) => p.status === 'VALID' && p.kind === 'VALUE')?.value;
        if (total?.kind !== 'DECIMAL') continue;
        const t = convert(view, target.value, target.unit, total.unit);
        if (t === undefined) continue;
        const limit = 'percent' in tol ? undefined : convert(view, tol.absolute.value, tol.absolute.unit, total.unit);
        const within = withinTolerance(total.value, t, 'percent' in tol ? { percent: tol.percent } : { absolute: limit ?? '0' });
        if (within) continue;
        out.push({
          type: 'DISPENSE_OUT_OF_TOLERANCE',
          title: `${item} = ${total.value} ${total.unit} is outside the tolerance of its target ${target.item} = ${t} ${total.unit}; it cannot be confirmed without this exception and a deviation`,
          controls: ['PR-19', 'PR-08'],
          severity: 'ACTION',
          category: 'OUT_OF_LIMIT',
          item,
          blocks: 'DOWNSTREAM',
          until: 'DEVIATION',
          deviationRequired: true,
        });
      }
      return { exceptions: out };
    },
    executedQuantityItem: (phase, mbr) => massItems(phase, mbr)[0],
    targetTolerance: (_phase, config) => toleranceOf(config),
    meanings: { check: ['CONTAINER_CHECKED'] },
  },
  exceptionRules: [
    { type: 'DISPENSE_OUT_OF_TOLERANCE', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'Dispensed total outside the tolerance of its target', controls: ['PR-19'] },
    { type: 'EXECUTED_TARGET_CHANGED', category: 'POST_ENTRY_CHANGE', severity: 'ACTION', summary: 'A corrected input moved the target of a quantity already dispensed', controls: ['DI-33', 'PR-19'] },
    ...CORE_VALUE_RULES,
  ],
  simulatorModel: {
    exceptionTypes: () => ['DISPENSE_OUT_OF_TOLERANCE', 'MANUAL_ENTRY_FALLBACK', 'EXECUTED_TARGET_CHANGED'],
    nominalEntries: ({ phase, mbr, target }) => {
      const items = massItems(phase, mbr);
      const t = phase.reads.map((r) => target(r)).find((v) => v?.kind === 'DECIMAL' && isMassUnit(v.unit));
      return phase.consumes.map((b, i) => {
        const bom = mbr.bom.find((x) => x.id === b);
        const ref = mbr.references.find((r) => r.id === bom?.material);
        const net = i === 0 && t?.kind === 'DECIMAL' && phase.consumes.length === 1 ? t.value : (bom?.quantity.value ?? '1');
        const unit = i === 0 && t?.kind === 'DECIMAL' && phase.consumes.length === 1 ? t.unit : (bom?.quantity.unit ?? 'kg');
        return { kind: 'CONTAINER_WEIGHING', item: items[0] ?? '', bomLine: b, container: `C-${phase.id}-${b}`, lot: { id: `LOT-${b}`, material: ref?.code ?? bom?.material ?? b, status: 'RELEASED', identityTested: true }, gross: net, tare: '0', unit, balance: 'BAL-1', source: 'DEVICE' };
      });
    },
  },
  goldenFixture: {
    description: 'API dispensed into one container: net computed from gross and tare, total within 0.5 % of the potency-adjusted target',
    controls: ['PR-19', 'INV-25'],
    phase: { block: { type: 'G-07', version: '1' }, config: { tolerance: { percent: '0.5' } }, records: ['disp'], reads: ['target'], consumes: ['BOM-API'] },
    inputs: [{ id: 'target', valueType: 'DECIMAL', unit: 'kg', value: '8.741486' }],
    bom: [{ id: 'BOM-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '8.0', unit: 'kg' } }],
    parameters: [{ id: 'disp', name: 'API dispensed', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' }],
    script: [
      {
        entry: { kind: 'CONTAINER_WEIGHING', item: 'disp', bomLine: 'BOM-API', container: 'C-001', lot: { id: 'AR-1', material: 'MAT-API', status: 'RELEASED', identityTested: true }, gross: '9.992', tare: '1.250', unit: 'kg', balance: 'BAL-07', source: 'DEVICE' },
      },
    ],
    expect: { exceptions: [], status: 'COMPLETED', values: { disp: '8.742' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/material.test.ts'],
};

/** |actual - target| within the tolerance (exact decimal arithmetic, no rounding). */
function withinTolerance(actual: string, target: string, tol: { percent: string } | { absolute: string }): boolean {
  const diff = Dec.parse(actual).minus(Dec.parse(target)).abs();
  const limit = 'percent' in tol ? Dec.parse(target).abs().times(Dec.parse(tol.percent)).div(Dec.HUNDRED) : Dec.parse(tol.absolute);
  return diff.lte(limit);
}

// ---------------------------------------------------------------------------------------------
// G-08 Identification and charge-in

export const G08: BlockVersion = {
  type: 'G-08',
  version: '1',
  title: 'Identification and charge-in',
  edition: 'generic',
  aliases: { tablets: 'K-08', injectables: 'KB-06' },
  level: 'PHASE',
  controls: ['PR-21', 'DI-30', 'IN-26'],
  configSchema: {
    type: 'object',
    description: 'Charge the dispensed containers or issued lots this step uses, once each, verified by scan',
    fields: {
      chargeAll: { type: 'boolean', optional: true, defaultText: 'yes outside a sub-lot section, no inside one', description: 'Every container of the used intermediates must be charged here (default: true outside sub-lot sections)' },
    },
  },
  entrySummaries: {
    CHARGE_CONTAINER: (d, c) => `Charged container ${S.val(d['container'])}${S.str(d['holds']) !== '' ? ` of ${S.nameOrText(c, d['holds'])}` : ''}`,
    CHARGE_LOT: (d, c) =>
      `Charged lot ${S.val(S.rec(d['lot'])['id'])} of ${c.name(d['bomLine'])}${d['quantity'] ? `: ${S.qty(d['quantity'])}` : ''}${S.str(d['container']) !== '' ? ` from container ${S.str(d['container'])}` : ''}`,
  },
  dataSchema: {
    entries: {
      CHARGE_CONTAINER: {
        type: 'object',
        description: 'A container of this batch, scanned at the process point',
        fields: { container: { type: 'string', description: 'Scanned container id' }, scannedBatch: { type: 'string', description: 'Batch number read from the container label' } },
      },
      CHARGE_LOT: {
        type: 'object',
        description: 'A lot issued from stores for a BOM line this step consumes, scanned at the process point',
        fields: { bomLine: { type: 'string', description: 'BOM line' }, container: { type: 'string', description: 'Scanned container id' }, lot: LOT_SCHEMA, quantity: { ...QUANTITY_SCHEMA, optional: true } },
      },
    },
  },
  handler: {
    acceptEntry: (view, entry) => {
      if (entry.kind === 'CHARGE_LOT') {
        const bomLine = String(entry['bomLine']);
        const bom = view.mbr.bom.find((b) => b.id === bomLine);
        const problems: HandlerProblem[] = [];
        if (!view.phase.consumes.includes(bomLine) || !bom) problems.push(problem('G08-UNPLANNED', `${bomLine} is not a BOM line charged at ${view.phase.id}: an unplanned material is rejected`, ['PR-21', 'PR-13']));
        problems.push(...lotProblems(view, entry['lot'] as Record<string, unknown>, bom?.material));
        if (problems.length > 0) return { ok: false, problems };
        return { ok: true, data: { bomLine, container: entry['container'], lot: { ...(entry['lot'] as Record<string, unknown>) }, ...(entry['quantity'] ? { quantity: entry['quantity'] } : {}) } };
      }
      const id = String(entry['container']);
      const c = view.containers().find((x) => x.id === id);
      if (!c) return { ok: false, problems: [problem('G08-WRONG-CONTAINER', `Container ${id} does not belong to this batch`, ['PR-21'])] };
      if (entry['scannedBatch'] !== view.batch.batchNumber) return { ok: false, problems: [problem('G08-LABEL', `The label of ${id} shows batch ${String(entry['scannedBatch'])}, not ${view.batch.batchNumber}`, ['PR-21', 'IN-26'])] };
      const planned = c.holdsKind === 'INTERMEDIATE' ? view.phase.uses.includes(c.holds) : view.phase.consumes.includes(c.holds);
      if (!planned) return { ok: false, problems: [problem('G08-UNPLANNED', `Container ${id} holds ${c.holds}, which ${view.phase.id} does not charge: an unplanned container is rejected`, ['PR-21', 'PR-13'])] };
      if (c.status === 'CONSUMED') return { ok: false, problems: [problem('G08-CONSUMED', `Container ${id} was already charged in ${c.consumedBy ?? '?'}`, ['PR-21'])] };
      const mine = new Map(view.frames.map((f) => [f.construct, f.index]));
      const other = c.producedIn.find((f) => mine.has(f.construct) && mine.get(f.construct) !== f.index);
      if (other) return { ok: false, problems: [problem('G08-OTHER-SUBLOT', `Container ${id} belongs to ${other.construct} instance ${other.index}, not to this one`, ['PR-21', 'PR-57'])] };
      return { ok: true, data: { container: id, holds: c.holds }, consumeContainers: [id] };
    },
    beforePerform: (view) => {
      const out: HandlerProblem[] = [];
      const charged = new Set(view.entries('CHARGE_CONTAINER').map((e) => String(e.data['container'])));
      const needs = [...view.phase.uses.map((u) => ({ id: u, kind: 'INTERMEDIATE' })), ...view.phase.consumes.map((b) => ({ id: b, kind: 'BOM_LINE' }))];
      const chargeAll = view.config['chargeAll'] !== undefined ? view.config['chargeAll'] === true : view.subLot === undefined;
      for (const n of needs) {
        const own = view.containers().filter((c) => c.holds === n.id && c.holdsKind === n.kind);
        const lots = view.entries('CHARGE_LOT').filter((e) => e.data['bomLine'] === n.id);
        const got = own.filter((c) => charged.has(c.id)).length + lots.length;
        if (got === 0) out.push(problem('G08-MISSING-CONTAINER', `Nothing has been charged for ${n.id}: a missing container blocks completion`, ['PR-21']));
        const left = own.filter((c) => c.status !== 'CONSUMED');
        if (chargeAll && left.length > 0) out.push(problem('G08-MISSING-CONTAINER', `Containers ${left.map((c) => c.id).join(', ')} of ${n.id} have not been charged`, ['PR-21']));
      }
      return out;
    },
    meanings: { check: ['CHARGE_IN_VERIFIED'] },
  },
  exceptionRules: [...CORE_VALUE_RULES],
  simulatorModel: {
    exceptionTypes: () => [],
    nominalEntries: ({ phase, mbr, frames, containers }) => {
      const out: (Record<string, unknown> & { kind: string })[] = [];
      const mine = new Map(frames.map((f) => [f.construct, f.index]));
      const usable = containers.filter((c) => c.status !== 'CONSUMED' && c.producedIn.every((f) => !mine.has(f.construct) || mine.get(f.construct) === f.index));
      // Inside a loop or sub-lot instance the nominal run charges one container per need (partial charges).
      const pick = <T>(list: T[]): T[] => (frames.length > 0 ? list.slice(0, 1) : list);
      for (const u of phase.uses) for (const c of pick(usable.filter((x) => x.holds === u))) out.push({ kind: 'CHARGE_CONTAINER', container: c.id, scannedBatch: '$BATCH' });
      for (const b of phase.consumes) {
        const own = usable.filter((x) => x.holds === b);
        if (own.length > 0) for (const c of pick(own)) out.push({ kind: 'CHARGE_CONTAINER', container: c.id, scannedBatch: '$BATCH' });
        else {
          const bom = mbr.bom.find((x) => x.id === b);
          const ref = mbr.references.find((r) => r.id === bom?.material);
          out.push({ kind: 'CHARGE_LOT', bomLine: b, container: `LOT-${b}-1`, lot: { id: `LOT-${b}`, material: ref?.code ?? bom?.material ?? b, status: 'RELEASED', identityTested: true } });
        }
      }
      return out;
    },
  },
  goldenFixture: {
    description: 'Both containers of the kit are scanned and charged; the step completes only when none is missing',
    phase: { block: { type: 'G-08', version: '1' }, config: {}, uses: ['I-KIT'] },
    intermediates: [{ id: 'I-KIT', name: 'Kit' }],
    containers: [
      { id: 'K-1', holds: 'I-KIT', holdsKind: 'INTERMEDIATE' },
      { id: 'K-2', holds: 'I-KIT', holdsKind: 'INTERMEDIATE' },
    ],
    script: [{ entry: { kind: 'CHARGE_CONTAINER', container: 'K-1', scannedBatch: '$BATCH' } }, { entry: { kind: 'CHARGE_CONTAINER', container: 'K-2', scannedBatch: '$BATCH' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/material.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-22 Output containers

export const G22: BlockVersion = {
  type: 'G-22',
  version: '1',
  title: 'Output containers, holds, split/merge',
  edition: 'generic',
  aliases: { tablets: 'K-22/K-25', injectables: 'KB-16' },
  level: 'PHASE',
  controls: ['PR-38', 'PR-45', 'PR-57', 'INV-25'],
  configSchema: {
    type: 'object',
    description: 'Uniquely identified output containers in quarantine with computed net weights',
    fields: { tare: { type: 'string', enum: ['WEIGHED', 'NOMINAL'], optional: true, description: 'Weighed tare (default) or nominal for validated container types' } },
  },
  entrySummaries: {
    OUTPUT_CONTAINER: (d, c) =>
      `Container ${S.val(d['container'])} of ${c.name(d['intermediate'])}: net ${S.amount(d['net'], d['unit'])} (gross ${S.amount(d['gross'], d['unit'])}, tare ${S.amount(d['tare'], d['unit'])}) on ${S.val(d['balance'])}${d['source'] === 'MANUAL' ? ', keyed by hand' : ''}`,
  },
  dataSchema: {
    entries: {
      OUTPUT_CONTAINER: {
        type: 'object',
        description: 'One output container of an intermediate this step produces',
        fields: {
          intermediate: { type: 'string', description: 'Intermediate produced' },
          container: { type: 'string', optional: true, description: 'Container id (system-generated when absent)' },
          ...WEIGHING_FIELDS,
        },
      },
    },
  },
  handler: {
    computedItems: (phase, mbr) => massItems(phase, mbr),
    acceptEntry: (view, entry) => {
      const intermediate = String(entry['intermediate']);
      const problems: HandlerProblem[] = [];
      if (!view.phase.produces.includes(intermediate)) problems.push(problem('G22-NOT-PRODUCED', `${view.phase.id} does not produce ${intermediate}`, ['PR-57', 'PR-13']));
      const unit = String(entry['unit']);
      const items = massItems(view.phase, view.mbr);
      if (!isMassUnit(unit)) problems.push(problem('G22-UNIT', `${unit} is not a mass unit`, ['DI-30']));
      else problems.push(...countingProblems('G22-UNIT', view, unit, items[0]));
      const net = netOf(String(entry['gross']), String(entry['tare']));
      if (!net.ok) problems.push(problem('G22-NET', net.message, ['INV-25']));
      if (problems.length > 0 || !net.ok) return { ok: false, problems };
      const n = view.entries('OUTPUT_CONTAINER').length + 1;
      const id = typeof entry['container'] === 'string' ? entry['container'] : `${view.batch.batchNumber}/${intermediate}/${view.stepKey.split('@')[1] || '0'}/${n}`;
      const manual = entry['source'] === 'MANUAL';
      return {
        ok: true,
        data: { intermediate, container: id, gross: entry['gross'], tare: entry['tare'], net: net.net, unit, balance: entry['balance'], source: entry['source'], status: 'QUARANTINE', item: items[0] ?? null },
        registerContainers: [{ id, holds: intermediate, holdsKind: 'INTERMEDIATE', net: { value: net.net, unit } }],
        ...(manual ? { exceptions: [manualWeighingDraft(items[0] ?? intermediate, view.stepKey)], verificationRequired: true } : {}),
      };
    },
    computeItems: (view) => containerTotals(view, 'OUTPUT_CONTAINER', (d) => (typeof d['item'] === 'string' ? d['item'] : undefined)),
    beforePerform: (view) => {
      const missing = view.phase.produces.filter((i) => !view.entries('OUTPUT_CONTAINER').some((e) => e.data['intermediate'] === i));
      return missing.length > 0 ? [problem('G22-NO-CONTAINER', `No output container has been registered for ${missing.join(', ')}`, ['PR-38', 'PR-57'])] : [];
    },
  },
  exceptionRules: [...CORE_VALUE_RULES],
  simulatorModel: {
    exceptionTypes: () => ['MANUAL_ENTRY_FALLBACK'],
    nominalEntries: ({ phase }) => phase.produces.map((i) => ({ kind: 'OUTPUT_CONTAINER', intermediate: i, gross: '26.10', tare: '1.00', unit: 'kg', balance: 'BAL-2', source: 'DEVICE' })),
  },
  goldenFixture: {
    description: 'Two containers of dried granules registered in quarantine; the net total is computed into the recorded quantity',
    controls: ['INV-25'],
    phase: { block: { type: 'G-22', version: '1' }, config: {}, records: ['net'], produces: ['I-DRY'] },
    intermediates: [{ id: 'I-DRY', name: 'Dried granules' }],
    parameters: [{ id: 'net', name: 'Dried granules (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 2 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' }],
    script: [
      { entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-DRY', gross: '13.60', tare: '1.05', unit: 'kg', balance: 'BAL-2', source: 'DEVICE' } },
      { entry: { kind: 'OUTPUT_CONTAINER', intermediate: 'I-DRY', gross: '13.55', tare: '1.00', unit: 'kg', balance: 'BAL-2', source: 'DEVICE' } },
    ],
    expect: { exceptions: [], status: 'COMPLETED', values: { net: '25.10' } },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/material.test.ts'],
};

// ---------------------------------------------------------------------------------------------
// G-23 Returns, rejects, destruction

export const G23: BlockVersion = {
  type: 'G-23',
  version: '1',
  title: 'Returns, rejects, destruction',
  edition: 'generic',
  aliases: { tablets: 'K-23', injectables: 'KB-18' },
  level: 'PHASE',
  controls: ['PR-40', 'PR-46', 'PR-48', 'IN-35'],
  configSchema: {
    type: 'object',
    description: 'Returns to stores, reject containers, waste and witnessed destruction',
    fields: { witness: { type: 'boolean', optional: true, default: true, description: 'Destruction is witnessed (default true)' } },
  },
  entrySummaries: {
    DISPOSAL: (d, c) =>
      `${S.cap(S.words(d['category']))}: ${S.qty(d['quantity'])} of ${S.nameOrText(c, d['material'])}${d['batchCoded'] === true ? ', printed with the batch code' : ''}${S.str(d['container']) !== '' ? `, container ${S.str(d['container'])}` : ''}${S.str(d['method']) !== '' ? `, by ${S.str(d['method'])}` : ''}`,
  },
  dataSchema: {
    entries: {
      DISPOSAL: {
        type: 'object',
        description: 'One return, reject container, waste or destruction record',
        fields: {
          category: { type: 'string', enum: ['RETURN_TO_STORES', 'REJECT_CONTAINER', 'WASTE', 'DESTRUCTION'], description: 'What happens to the material' },
          material: { type: 'string', description: 'Material or component' },
          batchCoded: { type: 'boolean', optional: true, description: 'Printed with the batch code (can only be destroyed)' },
          quantity: QUANTITY_SCHEMA,
          container: { type: 'string', optional: true, description: 'Identified container (rejects are held in identified containers)' },
          method: { type: 'string', optional: true, description: 'Destruction method' },
        },
      },
    },
  },
  handler: {
    acceptEntry: (view, entry) => {
      const cat = String(entry['category']);
      if (entry['batchCoded'] === true && cat === 'RETURN_TO_STORES') {
        return { ok: false, problems: [problem('G23-BATCH-CODED', `${String(entry['material'])} carries the batch code: batch-coded leftovers can only be destroyed, never returned to stock`, ['PR-40'])] };
      }
      if (cat === 'DESTRUCTION' && typeof entry['method'] !== 'string') return { ok: false, problems: [problem('G23-METHOD', 'A destruction records its method', ['PR-40', 'PR-46'])] };
      if (cat === 'REJECT_CONTAINER' && typeof entry['container'] !== 'string') return { ok: false, problems: [problem('G23-CONTAINER', 'Rejects are held in an identified container', ['PR-46', 'IN-35'])] };
      if (cat === 'DESTRUCTION' && view.config['witness'] !== false && view.phase.signatures.check?.meaning !== 'WITNESSED') {
        return { ok: false, problems: [problem('G23-WITNESS', `Destruction is witnessed, but ${view.phase.id} is only verified afterwards`, ['PR-40', 'PR-46'])] };
      }
      return { ok: true, data: { ...entry } };
    },
  },
  exceptionRules: [...CORE_VALUE_RULES],
  simulatorModel: { exceptionTypes: () => [], nominalEntries: () => [] },
  goldenFixture: {
    description: 'Batch-coded cartons destroyed and witnessed; a return of batch-coded cartons to stock is refused',
    phase: { block: { type: 'G-23', version: '1' }, config: {}, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'WITNESSED', role: 'VERIFIER' } } },
    script: [{ entry: { kind: 'DISPOSAL', category: 'DESTRUCTION', material: 'Printed carton', batchCoded: true, quantity: { value: '3', unit: '1' }, method: 'Shredding' } }],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['packages/recipe-core/test/blocks/golden.test.ts', 'packages/recipe-core/test/blocks/material.test.ts'],
};

export const MATERIAL_BLOCKS: readonly BlockVersion[] = [G07, G08, G22, G23];

/**
 * The items phase `phase` records that its block computes from its entries and that are never typed (Phase 2 exit
 * follow-up T12.DOC round 2): what the engine's definition reads from the block's handler (computedItems; a dispensing or
 * output step's mass totals), for the block versions of this release that compute any, the material blocks (a parity
 * test holds every generic version with computed items to this list). Empty for any other block. The validator and the
 * designer read it so as not to call such an item typed by hand.
 */
export function computedItemsOf(phase: PhaseNode, mbr: MbrContent): string[] {
  const block = MATERIAL_BLOCKS.find((b) => b.type === phase.block.type && b.version === phase.block.version);
  return block?.handler?.computedItems?.(phase, mbr) ?? [];
}

/** The sentence of a container weighing (G-07, TB-01): what it counts towards, by the master's names. */
export function weighingSummary(d: Readonly<Record<string, unknown>>, c: S.EntrySummaryContext): string {
  const u = d['unit'];
  const of = S.str(d['item']) !== '' && c.name(d['item']) !== S.UNNAMED_ITEM ? c.name(d['item']) : c.name(d['bomLine']);
  return `${S.cap(of)}: container ${S.val(d['container'])}, lot ${S.val(S.rec(d['lot'])['id'])}, net ${S.amount(d['net'], u)} (gross ${S.amount(d['gross'], u)}, tare ${S.amount(d['tare'], u)}) on ${S.val(d['balance'])}${d['source'] === 'MANUAL' ? ', keyed by hand' : ''}`;
}
