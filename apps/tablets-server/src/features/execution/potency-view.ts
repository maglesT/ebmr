/**
 * R10 #1, #2 and R13 (owner's rabeprazole demo, 25–28 October 2026): what the operator sees of a TB-01 step's potency
 * calculation. The governing POTENCY_CALCULATION entry already stores every lot with its approved result, each lot's
 * as-is potency and target, the compensating excipient's target and the total (DI-33); the step screen showed none of
 * it. These read the stored entry (never recompute it) and say, per lot, whether the lot's approved result has changed
 * since (tab.lot_assay_of, tablets 1001): then the step needs a new calculation (R13).
 */
import { Dec } from '@ebmr/expr';
import { blocks, type engine, type flow } from '@ebmr/recipe-core';
import type { FieldView, StepScreenView } from '@ebmr/api-contract';
import type pg from 'pg';

type Json = Record<string, unknown>;
type PotencyView = NonNullable<StepScreenView['potency']>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The material of a BOM line as the MBR names it: "Title (CODE)", or the line's material. */
export function bomMaterialName(mbr: flow.MbrContent, bomLine: string): string {
  const line = mbr.bom.find((b) => b.id === bomLine);
  const ref = line ? mbr.references.find((r) => r.id === line.material) : undefined;
  if (ref) return ref.title && ref.title !== ref.code ? `${ref.title} (${ref.code})` : ref.code;
  return line?.material ?? bomLine;
}

/** The step's governing (latest) potency calculation, as stored. */
export function governingCalculation(state: engine.BatchState, stepKey: string): Json | undefined {
  const all = Object.values(state.entries)
    .filter((e) => e.stepKey === stepKey && e.kind === 'POTENCY_CALCULATION')
    .sort((a, b) => a.recordedSeq - b.recordedSeq);
  return all[all.length - 1]?.data;
}

/** The targets of each BOM line of a stored calculation (the active's is the sum of its lots' targets). */
export function calculationTargets(calc: Json): Map<string, string> {
  const out = new Map<string, string>();
  const active = isRecord(calc['active']) ? calc['active'] : {};
  const results = (Array.isArray(calc['results']) ? calc['results'] : []).filter(isRecord);
  if (results.length > 0 && typeof active['bomLine'] === 'string') {
    const sum = results.reduce((acc, r) => acc.plus(Dec.parse(str(r['target']) || '0')), Dec.ZERO);
    const places = results.reduce((most, r) => Math.max(most, Dec.parse(str(r['target']) || '0').decimalPlaces()), 0);
    out.set(active['bomLine'], sum.toFixed(places, 'HALF_EVEN'));
  }
  const exc = calc['excipient'];
  if (isRecord(exc) && typeof exc['bomLine'] === 'string' && typeof exc['target'] === 'string') out.set(exc['bomLine'], exc['target']);
  return out;
}

/** The sentence an operator reads (also the entry's summary). */
export function potencySentence(p: Omit<PotencyView, 'summary'>): string {
  const lots = p.lots.map((l) => {
    const parts = [`assay ${l.assay} %`, ...(l.water !== null ? [`water ${l.water} %`] : []), ...(l.lod !== null ? [`LOD ${l.lod} %`] : [])];
    return `Lot ${l.lotCode}: ${parts.join(', ')} → ${l.asIs} % as is`;
  });
  const targets = [`${p.active.material} ${p.active.target} ${p.active.unit}`, ...(p.excipient ? [`${p.excipient.material} ${p.excipient.target} ${p.excipient.unit}`] : [])];
  return `${lots.join('; ')}; ${targets.join('; ')}`;
}

/** The potency view of a stored calculation (no lot marked changed). */
export function potencyFromCalculation(mbr: flow.MbrContent, calc: Json): PotencyView {
  const active = isRecord(calc['active']) ? calc['active'] : {};
  const unit = str(active['unit']);
  const results = (Array.isArray(calc['results']) ? calc['results'] : []).filter(isRecord);
  const lots: PotencyView['lots'] = (Array.isArray(calc['lots']) ? calc['lots'] : []).filter(isRecord).map((l, i) => {
    const lot = isRecord(l['lot']) ? l['lot'] : {};
    const assay = isRecord(l['assay']) ? l['assay'] : {};
    const r = results[i] ?? {};
    return {
      lotCode: str(lot['id']),
      basis: str(assay['basis']),
      assay: str(assay['assay']),
      water: text(assay['water']),
      lod: text(assay['lod']),
      asIs: str(r['asIsAssay']),
      baseEquivalent: str(r['baseEquivalent']),
      target: str(r['target']),
      changed: false,
    };
  });
  const targets = calculationTargets(calc);
  const activeLine = str(active['bomLine']);
  const exc = isRecord(calc['excipient']) ? calc['excipient'] : null;
  const view: Omit<PotencyView, 'summary'> = {
    lots,
    active: { bomLine: activeLine, material: bomMaterialName(mbr, activeLine), unit, standard: str(active['standard']), target: targets.get(activeLine) ?? '' },
    excipient: exc
      ? { bomLine: String(exc['bomLine']), material: bomMaterialName(mbr, String(exc['bomLine'])), unit, standard: str(exc['standard']), target: str(exc['target']) }
      : null,
    total: isRecord(calc['total']) ? str(calc['total']['target']) : '',
  };
  return { ...view, summary: potencySentence(view) };
}

/**
 * The step's potency view, or null when no calculation has been recorded. Each lot is marked changed when its current
 * approved result (tab.lot_assay_of) is no longer the one the calculation took (R13).
 */
export async function potencyOf(db: pg.Pool | pg.PoolClient, mbr: flow.MbrContent, state: engine.BatchState, batchId: string, stepKey: string): Promise<PotencyView | null> {
  const calc = governingCalculation(state, stepKey);
  if (!calc) return null;
  const view = potencyFromCalculation(mbr, calc);
  const taken = (Array.isArray(calc['lots']) ? calc['lots'] : []).filter(isRecord).map((l) => (isRecord(l['assay']) ? text(l['assay']['resultId']) : null));
  for (const [i, l] of view.lots.entries()) {
    const { rows } = await db.query<{ a: Json | null }>('select tab.lot_assay_of($1, $2::uuid) as a', [l.lotCode, batchId]);
    const was = taken[i] ?? null;
    l.changed = was !== null && (rows[0]?.a?.['resultId'] ?? null) !== was;
  }
  return view;
}

/**
 * R10 #1: each dispensed (computed) box of a TB-01 step shows its line's target from the calculation before anything is
 * weighed. The box of a line is the one its weighings name; before any weighing, the block's own order (the active's
 * box first, the excipient's second, as the block's nominal path takes them).
 */
export function withPotencyTargets(fields: FieldView[], potency: PotencyView | null, phase: flow.PhaseNode, mbr: flow.MbrContent, state: engine.BatchState, stepKey: string): FieldView[] {
  if (!potency) return fields;
  const lines = [potency.active, ...(potency.excipient ? [potency.excipient] : [])];
  const items = blocks.massItems(phase, mbr);
  const itemOf = (bomLine: string, i: number): string | undefined =>
    Object.values(state.entries).find((e) => e.stepKey === stepKey && e.kind === 'CONTAINER_WEIGHING' && e.data['bomLine'] === bomLine)?.data['item']?.toString() ?? items[i];
  const byItem = new Map<string, (typeof lines)[number]>();
  lines.forEach((l, i) => {
    const item = itemOf(l.bomLine, i);
    if (item !== undefined) byItem.set(item, l);
  });
  return fields.map((f) => {
    const l = byItem.get(f.item);
    if (!l || !f.computed || l.target === '') return f;
    return { ...f, target: { value: { kind: 'DECIMAL', value: l.target, unit: l.unit }, source: 'the potency calculation' } };
  });
}
