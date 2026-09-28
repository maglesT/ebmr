/**
 * Which value a step sees (outline 5.2.3; validator README "reading repeated data"; INV-41).
 *
 * - Within one step instance, the effective value of an item is the FIRST attempt that still holds a
 *   valid result (corrections replace a version inside the same attempt). A later attempt never
 *   replaces an earlier result: a passing re-test does not hide a failing original (INV-41, DI-29);
 *   only an approved invalidation of the earlier result lets the next attempt govern.
 * - A value written inside a loop and read after it is the last iteration's value; a value written
 *   inside a replicate section and read outside it is the series of its per-instance values, in
 *   instance order (every instance must have one); inside the same iteration or instance the reader
 *   sees that iteration's or instance's own value.
 */
import type { InputValue } from '@ebmr/expr';
import type { ExprType, ExprValue } from '../flow/expression-port.ts';
import { contextKey, type Frame } from '../flow/tokens.ts';
import type { BatchDefinition } from './definition.ts';
import type { BatchState, DataPoint, DataValue, DerivedValue } from './types.ts';

export interface Resolved {
  value: DataValue;
  points: string[];
  derived: string[];
  /** The single derived record (non-series), for DERIVED inputs of calculations (INV-25). */
  record?: DerivedValue;
  /** Plain-text provenance for evaluation records. */
  source: string;
}

export type Resolution = { ok: true; resolved: Resolved } | { ok: false; reason: string };

/** Points of one item in one step instance, attempt order then version order. */
export function pointsOf(s: BatchState, stepKey: string, item: string): DataPoint[] {
  return Object.values(s.points)
    .filter((p) => p.stepKey === stepKey && p.item === item)
    .sort((a, b) => a.attempt - b.attempt || a.version - b.version);
}

/** The effective data point of an item in a step instance (first attempt still holding a valid result). */
export function effectivePoint(s: BatchState, stepKey: string, item: string): DataPoint | undefined {
  return pointsOf(s, stepKey, item).find((p) => p.kind === 'VALUE' && p.status === 'VALID' && p.value !== undefined);
}

export function currentDerived(s: BatchState, stepKey: string, calculation: string): DerivedValue | undefined {
  return Object.values(s.derived).find((d) => d.stepKey === stepKey && d.calculation === calculation && d.status === 'CURRENT');
}

interface Candidate {
  frames: Frame[];
  value: DataValue;
  point?: DataPoint;
  derived?: DerivedValue;
  source: string;
}

function describeSource(p: DataPoint): string {
  const s = p.source;
  const how = s.mode === 'DEVICE' ? `device ${s.device}` : s.mode === 'SCAN' ? `scan ${s.code}` : s.mode === 'AUTOMATION' ? `system ${s.system}` : s.mode === 'LIMS' ? `LIMS ${s.resultRef}` : s.mode === 'BLOCK' ? `computed from ${s.entries.join(', ')}` : 'manual entry';
  return `${p.stepKey} ${p.item} attempt ${p.attempt}${p.version > 1 ? ` version ${p.version}` : ''} (${how})`;
}

function candidates(def: BatchDefinition, s: BatchState, item: string): Candidate[] {
  if (def.analysis.calculations.has(item)) {
    return Object.values(s.derived)
      .filter((d) => d.calculation === item && d.status === 'CURRENT')
      .map((d) => ({ frames: d.frames, value: d.value, derived: d, source: `${d.stepKey} ${item} (computed, record ${d.record.contentHash.slice(0, 12)})` }));
  }
  const byStep = new Map<string, DataPoint>();
  for (const p of Object.values(s.points)) {
    if (p.item !== item || p.kind !== 'VALUE' || p.status !== 'VALID' || p.value === undefined) continue;
    const prev = byStep.get(p.stepKey);
    if (!prev || p.attempt < prev.attempt) byStep.set(p.stepKey, p);
  }
  return [...byStep.values()].map((p) => ({ frames: p.frames, value: p.value as DataValue, point: p, source: describeSource(p) }));
}

function toSeriesValues(def: BatchDefinition, v: DataValue, unit: string): string[] | undefined {
  if (v.kind === 'COUNT') return [v.value];
  if (v.kind === 'DECIMAL') {
    const c = v.unit === unit ? v.value : def.expr.convert(v.value, v.unit, unit);
    return c === undefined ? undefined : [c];
  }
  if (v.kind === 'SERIES') {
    const out: string[] = [];
    for (const x of v.values) {
      const c = v.unit === unit ? x : def.expr.convert(x, v.unit, unit);
      if (c === undefined) return undefined;
      out.push(c);
    }
    return out;
  }
  return undefined;
}

function elementUnit(t: ExprType | undefined): string {
  if (!t) return '1';
  if (t.kind === 'SERIES') return elementUnit(t.of);
  if (t.kind === 'DECIMAL') return t.unit;
  return '1';
}

/**
 * The value of `item` as seen by a reader in `frames` (a step instance or a decision point).
 * Missing values are explicit (never a silent zero).
 */
export function resolveAt(def: BatchDefinition, s: BatchState, item: string, frames: readonly Frame[]): Resolution {
  const input = s.header.inputs[item];
  if (input) return { ok: true, resolved: { value: input.value, points: [], derived: [], source: input.source } };
  const readerIndex = new Map(frames.map((f) => [f.construct, f.index]));
  const matching: { c: Candidate; extra: Frame[] }[] = [];
  for (const c of candidates(def, s, item)) {
    let ok = true;
    const extra: Frame[] = [];
    for (const f of c.frames) {
      const idx = readerIndex.get(f.construct);
      if (idx === undefined) extra.push(f);
      else if (extra.length > 0 || idx !== f.index) {
        ok = false;
        break;
      }
    }
    if (ok) matching.push({ c, extra });
  }
  if (matching.length === 0) return { ok: false, reason: `${item} has no recorded value yet` };
  const unit = elementUnit(def.analysis.declaredType(item));

  const aggregate = (list: { c: Candidate; extra: Frame[] }[], level: number, parent: Frame[]): Resolution => {
    const deeper = list.filter((x) => x.extra.length > level);
    if (deeper.length === 0) {
      if (list.length !== 1) return { ok: false, reason: `${item} has ${list.length} values where one is expected` };
      const only = list[0] as { c: Candidate };
      const r: Resolved = { value: only.c.value, points: only.c.point ? [only.c.point.id] : [], derived: only.c.derived ? [only.c.derived.id] : [], source: only.c.source };
      if (only.c.derived) r.record = only.c.derived;
      return { ok: true, resolved: r };
    }
    const construct = (deeper[0] as { extra: Frame[] }).extra[level]?.construct as string;
    if (def.loops.has(construct)) {
      const last = Math.max(...deeper.map((x) => (x.extra[level] as Frame).index));
      return aggregate(
        deeper.filter((x) => (x.extra[level] as Frame).index === last),
        level + 1,
        [...parent, { construct, index: last }],
      );
    }
    // Replicate section: one value per instance, in instance order (every instance must have one).
    const sample = (deeper[0] as { c: Candidate }).c.frames;
    const parentFrames = sample.slice(0, sample.findIndex((f) => f.construct === construct));
    const countDecision = s.decisions[`${construct}@${contextKey(parentFrames)}`];
    const indices = [...new Set(deeper.map((x) => (x.extra[level] as Frame).index))].sort((a, b) => a - b);
    const count = countDecision ? Number(countDecision.outcome) : indices.length;
    const values: string[] = [];
    const points: string[] = [];
    const derived: string[] = [];
    const sources: string[] = [];
    for (let k = 1; k <= count; k++) {
      const sub = deeper.filter((x) => (x.extra[level] as Frame).index === k);
      if (sub.length === 0) return { ok: false, reason: `${item} has no value for sub-lot instance ${k} of ${construct}` };
      const r = aggregate(sub, level + 1, [...parent, { construct, index: k }]);
      if (!r.ok) return r;
      const vs = toSeriesValues(def, r.resolved.value, unit);
      if (vs === undefined) return { ok: false, reason: `${item} of instance ${k} cannot be expressed in ${unit}` };
      values.push(...vs);
      points.push(...r.resolved.points);
      derived.push(...r.resolved.derived);
      sources.push(r.resolved.source);
    }
    return { ok: true, resolved: { value: { kind: 'SERIES', values, unit }, points, derived, source: `series of ${values.length}: ${sources.join('; ')}` } };
  };
  return aggregate(matching, 0, []);
}

/** A value for the condition evaluator (branch guards, loop exits, replicate counts). */
export function toExprValue(v: DataValue): ExprValue | undefined {
  switch (v.kind) {
    case 'DECIMAL':
      return { kind: 'DECIMAL', value: v.value, unit: v.unit };
    case 'COUNT':
      return { kind: 'COUNT', value: v.value };
    case 'BOOLEAN':
      return { kind: 'BOOLEAN', value: v.value };
    case 'CATEGORY':
      return { kind: 'CATEGORY', value: v.value };
    case 'TEXT':
      return { kind: 'TEXT', value: v.value };
    case 'SERIES':
      return { kind: 'SERIES', values: [...v.values], unit: v.unit };
    case 'INSTANT':
      return undefined;
  }
}

/** ISO 8601 UTC text with microseconds for an instant (for evaluation records). */
export function microsToIso(us: bigint): string {
  const ms = us / 1000n - (us % 1000n < 0n ? 1n : 0n);
  const micros = us - ms * 1000n;
  const base = new Date(Number(ms)).toISOString();
  return `${base.slice(0, 23)}${micros.toString().padStart(3, '0')}Z`;
}

/** A value for a calculation input (the expression language records the source with it). */
export function toInputValue(r: Resolved, derivedInput: boolean): InputValue | undefined {
  if (derivedInput) return r.record ? { derived: r.record.record } : undefined;
  const v = r.value;
  switch (v.kind) {
    case 'DECIMAL':
      return { value: v.value, unit: v.unit, source: r.source };
    case 'COUNT':
      return { value: v.value, unit: '1', tag: 'count', source: r.source };
    case 'BOOLEAN':
      return { boolean: v.value, source: r.source };
    case 'CATEGORY':
      return { category: v.value, source: r.source };
    case 'TEXT':
      return { text: v.value, source: r.source };
    case 'INSTANT':
      return { instant: microsToIso(v.us), source: r.source };
    case 'SERIES':
      return { values: [...v.values], unit: v.unit, source: r.source };
  }
}

/** Plain text of a value for messages and records. */
export function showValue(v: DataValue): string {
  switch (v.kind) {
    case 'DECIMAL':
      return `${v.value} ${v.unit}`;
    case 'SERIES':
      return `[${v.values.join(', ')}] ${v.unit}`;
    case 'INSTANT':
      return microsToIso(v.us);
    default:
      return String(v.value);
  }
}
