/**
 * Data capture, limit evaluation and derived values (outline 5.2.3, 5.2.4, 6.4; PR-08, DI-29, DI-30,
 * DI-33, INV-25, INV-41).
 *
 * - A value is committed with its source before its limit evaluation exists (DI-28): the evaluation is
 *   a fact of the stored point, computed by the limits module through the expression language, which
 *   is the only place rounding happens.
 * - Derived values (calculations, and quantities a block computes from its entries) are computed by
 *   the engine with an evaluation record; typing one is refused (INV-25).
 * - Every attempt is kept; a repeat after a failing result is flagged and never replaces it (INV-41).
 * - The exit value of a repeat-until loop's endpoint is evaluated against its limits when the loop
 *   exits; readings of earlier iterations are recorded as "endpoint not yet reached".
 */
import { recalculate, tryEvaluate, type EvaluationRecord, type InputValue } from '@ebmr/expr';
import { isDecimalLiteral, decimalsOf } from '../flow/decimal.ts';
import type { Parameter, PhaseNode } from '../flow/model.ts';
import { contextKey, type Frame } from '../flow/tokens.ts';
import { evaluateAllApply } from '../limits/all-apply.ts';
import { evaluateLimits, LimitEvaluationError, type LimitEvaluation } from '../limits/evaluate.ts';
import type { LimitSpec } from '../limits/model.ts';
import type { ExceptionDraft, HandlerView, Notification } from '../blocks/contract.ts';
import type { StepDef } from './definition.ts';
import { ENGINE_EXCEPTION_TYPES, engineDraft, tierDraft } from './exceptions.ts';
import { refuse, type Tx } from './tx.ts';
import type { DataPoint, DataSource, DataValue, DerivedValue, OccurredAt, StepInstance, StoredEvaluation } from './types.ts';
import { currentDerived, effectivePoint, pointsOf, resolveAt, showValue, toInputValue, type Resolved } from './values.ts';

// ---------------------------------------------------------------------------------------------
// Value validation (DI-30 plausibility: type, format, unit, list, readings)

function unitOk(tx: Tx, from: string, to: string): boolean {
  if (from === to) return true;
  const a = tx.def.expr.unit(from);
  const b = tx.def.expr.unit(to);
  return a.ok && b.ok && a.dimension === b.dimension && tx.def.expr.convert('1', from, to) !== undefined;
}

function checkDecimalText(value: string, p: Parameter, item: string): void {
  const shown = JSON.stringify(value);
  if (!isDecimalLiteral(value)) refuse('ENG-VALUE-FORMAT', `${item}: ${shown} is not a decimal number written as text`, ['DI-30']);
  if (p.precision?.kind === 'DECIMALS' && decimalsOf(value) > p.precision.digits) {
    refuse('ENG-VALUE-PRECISION', `${item}: ${value} has more decimals than the ${p.precision.digits} the MBR captures`, ['DI-30', 'PR-08']);
  }
}

/** Refuses a value that does not fit its parameter (type, unit, format, category list, number of readings). */
export function validateValue(tx: Tx, p: Parameter, value: DataValue): void {
  const readings = p.readings ?? 1;
  const item = p.id;
  if (readings > 1) {
    if (value.kind !== 'SERIES') refuse('ENG-VALUE-TYPE', `${item} is captured as ${readings} readings`, ['DI-30', 'DI-29']);
    if (value.values.length !== readings) refuse('ENG-VALUE-READINGS', `${item} needs exactly ${readings} readings; ${value.values.length} were given`, ['DI-29', 'IN-35']);
    if (!unitOk(tx, value.unit, p.unit ?? '1')) refuse('ENG-VALUE-UNIT', `${item}: unit ${value.unit} does not measure the same thing as ${p.unit ?? '1'}`, ['DI-30']);
    for (const v of value.values) checkDecimalText(v, p, item);
    return;
  }
  switch (p.valueType) {
    case 'DECIMAL':
      if (value.kind !== 'DECIMAL') refuse('ENG-VALUE-TYPE', `${item} takes a decimal value with a unit`, ['DI-30']);
      checkDecimalText(value.value, p, item);
      if (!unitOk(tx, value.unit, p.unit ?? '1')) refuse('ENG-VALUE-UNIT', `${item}: unit ${value.unit} does not measure the same thing as ${p.unit ?? '1'}`, ['DI-30']);
      return;
    case 'COUNT':
      if (value.kind !== 'COUNT' || !/^(0|[1-9][0-9]*)$/.test(value.value)) refuse('ENG-VALUE-TYPE', `${item} takes a whole count (0 or more)`, ['DI-30']);
      return;
    case 'BOOLEAN':
      if (value.kind !== 'BOOLEAN') refuse('ENG-VALUE-TYPE', `${item} takes yes or no`, ['DI-30']);
      return;
    case 'CATEGORY':
      if (value.kind !== 'CATEGORY' || !(p.categories ?? []).includes(value.value)) refuse('ENG-VALUE-TYPE', `${item} takes one of ${(p.categories ?? []).join(', ')}`, ['DI-30']);
      return;
    case 'TEXT':
      if (value.kind !== 'TEXT' || value.value.trim().length === 0) refuse('ENG-VALUE-TYPE', `${item} takes a non-empty text`, ['DI-30']);
      return;
    case 'INSTANT':
      if (value.kind !== 'INSTANT') refuse('ENG-VALUE-TYPE', `${item} takes a date and time`, ['DI-30']);
      return;
  }
}

/** Objective evidence (device, automation, scan, LIMS) or not (a manual entry without a photo or printout). */
export function isObjective(source: DataSource): boolean {
  return source.mode !== 'MANUAL' || source.evidence !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Limit evaluation of a stored value

function summarise(ev: LimitEvaluation): StoredEvaluation {
  const detail = ev.tiers.map((t) => `${t.tier}: ${t.pass ? 'pass' : 'FAIL'}${t.low ? ` low ${t.low.rounded}${t.low.pass ? '' : ' (outside)'}` : ''}${t.high ? ` high ${t.high.rounded}${t.high.pass ? '' : ' (outside)'}` : ''}`);
  const out: StoredEvaluation = { requirement: ev.requirement, detail, languageVersion: ev.languageVersion };
  if (ev.breached !== undefined) out.breached = ev.breached;
  return out;
}

const SEVERITY_ORDER: Record<string, number> = { REGISTERED: 3, VALIDATED: 3, INTERNAL_ACTION: 2, ALERT: 1 };

/** Evaluates a (possibly multi-reading) value against a limit spec: every reading is compared; the worst governs. */
export function evaluateValue(tx: Tx, spec: LimitSpec, value: DataValue): LimitEvaluation | undefined {
  const singles: { value: string; unit: string }[] =
    value.kind === 'DECIMAL' ? [{ value: value.value, unit: value.unit }] : value.kind === 'COUNT' ? [{ value: value.value, unit: '1' }] : value.kind === 'SERIES' ? value.values.map((v) => ({ value: v, unit: value.unit })) : [];
  if (singles.length === 0) return undefined;
  let worst: LimitEvaluation | undefined;
  for (const s of singles) {
    let ev: LimitEvaluation;
    try {
      ev = evaluateLimits(spec, s, tx.def.expr);
    } catch (e) {
      if (e instanceof LimitEvaluationError) refuse('ENG-VALUE-UNIT', e.message, ['PR-08']);
      throw e;
    }
    const rank = ev.breached === undefined ? 0 : (SEVERITY_ORDER[ev.breached] ?? 0);
    const worstRank = worst?.breached === undefined ? 0 : (SEVERITY_ORDER[worst.breached] ?? 0);
    if (!worst || rank > worstRank) worst = ev;
  }
  return worst;
}

/** Raises a limit exception for an evaluated point; returns the exception id. */
export function raiseForEvaluation(tx: Tx, step: StepDef, inst: StepInstance, ev: LimitEvaluation, subject: string, kind: 'PARAMETER' | 'CALCULATION' | 'YIELD', item: string, source: { point?: string; derived?: string }): string | undefined {
  const draft = tierDraft(ev, subject, kind, item, ev.currentStepMayContinueWithDeviation);
  if (!draft) return undefined;
  return tx.raise(draft, { stepKey: inst.key, step: inst.step, frames: inst.frames, item, ...source }, { node: step.graphNode, frames: inst.frames }, ev.breached !== undefined ? { tier: ev.breached } : {});
}

/** Applies a handler's exception drafts (only types the block declares, or engine types). */
export function raiseDrafts(tx: Tx, step: StepDef, inst: StepInstance, drafts: readonly ExceptionDraft[] | undefined, source: { point?: string; entry?: string } = {}): string[] {
  const out: string[] = [];
  for (const d of drafts ?? []) {
    const declared = step.block?.exceptionRules?.some((r) => r.type === d.type) ?? false;
    if (!declared && !ENGINE_EXCEPTION_TYPES.has(d.type)) throw new Error(`block ${step.block?.type ?? '?'} raised undeclared exception type ${d.type}`);
    const src: { stepKey: string; step: string; frames: Frame[]; point?: string } = { stepKey: inst.key, step: inst.step, frames: inst.frames };
    if (source.point !== undefined) src.point = source.point;
    out.push(tx.raise(d, src, { node: step.graphNode, frames: inst.frames }));
  }
  return out;
}

export function notify(tx: Tx, subject: string, notes: readonly Notification[] | undefined): void {
  for (const n of notes ?? []) tx.emit({ type: 'NOTIFICATION', roles: [...n.roles], subject, message: n.message });
}

/**
 * True when `item` is the endpoint of a loop enclosing this step instance whose iteration has not been
 * decided yet (its limits apply at the loop exit; a correction after the exit is evaluated at once).
 */
export function isLoopEndpointInProgress(tx: Tx, step: StepDef, item: string, frames: readonly Frame[]): boolean {
  return (tx.def.loopEndpoints.get(item) ?? []).some((l) => {
    if (!step.constructs.includes(l)) return false;
    const upTo = frames.slice(0, frames.findIndex((f) => f.construct === l) + 1);
    return tx.s.decisions[`${l}@${contextKey(upTo)}`] === undefined;
  });
}

/**
 * Stores a new attempt (or a correction version) of a value and evaluates it. Returns the point.
 * Flags: REPEAT and REPEAT_AFTER_FAIL (DI-29, INV-41), MANUAL_FALLBACK (DI-30, PR-14), LATE_ENTRY.
 */
export function storePoint(
  tx: Tx,
  step: StepDef,
  inst: StepInstance,
  view: HandlerView | undefined,
  item: string,
  value: DataValue,
  source: DataSource,
  options: { occurredAt?: OccurredAt; correctionOf?: DataPoint; lateEntry?: boolean } = {},
): DataPoint {
  const param = tx.def.analysis.parameters.get(item);
  const previous = pointsOf(tx.s, inst.key, item);
  const attempt = options.correctionOf ? options.correctionOf.attempt : previous.reduce((m, p) => Math.max(m, p.attempt), 0) + 1;
  const version = options.correctionOf ? options.correctionOf.version + 1 : 1;
  const id = tx.nextId('DP');
  const point: DataPoint = {
    id,
    item,
    stepKey: inst.key,
    step: inst.step,
    frames: [...inst.frames],
    attempt,
    version,
    kind: 'VALUE',
    value,
    source,
    enteredBy: tx.by,
    recordedAt: tx.now,
    recordedSeq: tx.s.seq + 1,
    timeBasis: options.occurredAt?.trust === 'DEVICE_SYNCED' ? 'OCCURRED_AT' : 'RECORDED_AT',
    status: 'VALID',
    failed: false,
    flags: [],
    exceptions: [],
  };
  if (options.occurredAt) point.occurredAt = { us: options.occurredAt.us, trust: options.occurredAt.trust };
  if (options.correctionOf) {
    point.supersedes = options.correctionOf.id;
    point.flags.push('CORRECTED');
  }
  const earlier = previous.filter((p) => p.kind === 'VALUE' && p.attempt < attempt);
  if (!options.correctionOf && earlier.length > 0) {
    point.flags.push('REPEAT');
    if (earlier.some((p) => p.failed && p.status !== 'SUPERSEDED')) point.flags.push('REPEAT_AFTER_FAIL');
  }
  const capture = param?.capture;
  if (source.mode === 'MANUAL' && capture !== undefined && capture !== 'MANUAL') point.flags.push('MANUAL_FALLBACK');
  if (options.lateEntry === true) point.flags.push('LATE_ENTRY');
  tx.s.points[id] = point;

  // Evaluation after the commit of the value (DI-28): limits, then block rules.
  if (param?.limits) {
    if (isLoopEndpointInProgress(tx, step, item, inst.frames)) {
      point.evaluation = { requirement: 'ENDPOINT_IN_PROGRESS', detail: ['evaluated against its limits when the loop exits'], languageVersion: tx.def.expr.languageVersion };
    } else {
      const ev = evaluateValue(tx, param.limits, value);
      if (ev) {
        point.evaluation = summarise(ev);
        point.failed = ev.breached !== undefined;
        const ex = raiseForEvaluation(tx, step, inst, ev, `${param.name} (${item})`, 'PARAMETER', item, { point: id });
        if (ex) point.exceptions.push(ex);
      }
    }
  }
  if (view && step.block?.handler?.onValue) {
    const eff = step.block.handler.onValue(view, item, value, point);
    if (eff.failed === true) point.failed = true;
    if (eff.verificationRequired === true) inst.verificationRequired = true;
    point.exceptions.push(...raiseDrafts(tx, step, inst, eff.exceptions, { point: id }));
    notify(tx, `${inst.key} ${item}`, eff.notifications);
  }
  if (point.flags.includes('REPEAT_AFTER_FAIL')) {
    point.exceptions.push(
      tx.raise(
        engineDraft('REPEAT_AFTER_FAIL', `${item} was captured again after a failing result in ${inst.key}; the failing result still governs until it is invalidated with an investigation`, { item, blocks: 'NONE', deviationRequired: true }),
        { stepKey: inst.key, step: inst.step, frames: inst.frames, point: id },
      ),
    );
  } else if (point.flags.includes('REPEAT')) {
    point.exceptions.push(tx.raise(engineDraft('REPEAT_ATTEMPT', `${item} was captured again in ${inst.key} (attempt ${attempt}); the first result governs`, { item }), { stepKey: inst.key, step: inst.step, frames: inst.frames, point: id }));
  }
  if (point.flags.includes('MANUAL_FALLBACK')) {
    inst.verificationRequired = true;
    point.exceptions.push(
      tx.raise(engineDraft('MANUAL_ENTRY_FALLBACK', `${item} was keyed by hand although it is configured for ${String(capture).toLowerCase()} capture; the step now needs a second person`, { item }), {
        stepKey: inst.key,
        step: inst.step,
        frames: inst.frames,
        point: id,
      }),
    );
  }
  // DI-30: a critical value keyed by hand needs an independent accuracy check before the step completes.
  if (source.mode === 'MANUAL' && param?.criticality === 'CRITICAL') inst.verificationRequired = true;
  tx.emit({ type: 'DATA_RECORDED', point: id, stepKey: inst.key, item, attempt, version, by: tx.by, failed: point.failed, flags: [...point.flags] });
  return point;
}

// ---------------------------------------------------------------------------------------------
// Derived values (calculations)

interface Gathered {
  inputs: Record<string, InputValue>;
  provenance: DerivedValue['inputs'];
  fingerprint: string;
}

function gatherInputs(tx: Tx, calc: string, stepId: string, frames: readonly Frame[]): Gathered | { missing: string } {
  const entry = tx.def.programs.get(`${calc}@${stepId}`);
  if (!entry) return { missing: `${calc} has no compiled program at ${stepId}` };
  const inputs: Record<string, InputValue> = {};
  const provenance: DerivedValue['inputs'] = [];
  for (const read of entry.program.reads) {
    const r = resolveAt(tx.def, tx.s, read, frames);
    if (!r.ok) return { missing: r.reason };
    const iv = toInputValue(r.resolved, entry.derivedInputs.has(read));
    if (!iv) return { missing: `${read} cannot be read by the calculation` };
    inputs[read] = iv;
    provenance.push({ item: read, points: r.resolved.points, derived: r.resolved.derived });
  }
  const fingerprint = provenance.map((p) => `${p.item}:${p.points.join(',')}:${p.derived.join(',')}`).join('|');
  return { inputs, provenance, fingerprint };
}

function valueOfRecord(record: EvaluationRecord, calcOutputKind: 'DECIMAL' | 'COUNT' | 'BOOLEAN'): DataValue {
  const o = record.output;
  if (o.kind === 'boolean') return { kind: 'BOOLEAN', value: o.value === 'true' };
  if (calcOutputKind === 'COUNT' || (o.tag === 'count' && o.unit === '1')) return { kind: 'COUNT', value: o.value };
  return { kind: 'DECIMAL', value: o.value, unit: o.unit ?? '1' };
}

function fingerprintOf(d: DerivedValue): string {
  return d.inputs.map((p) => `${p.item}:${p.points.join(',')}:${p.derived.join(',')}`).join('|');
}

/**
 * Computes (or recomputes after a change of an input) every calculation a phase computes whose
 * inputs are available. Returns the ids of new derived values.
 */
export function computeCalculations(tx: Tx, step: StepDef, inst: StepInstance, reason: string | undefined): string[] {
  if (step.node.kind !== 'phase') return [];
  const created: string[] = [];
  for (const calcId of step.node.computes) {
    const calc = tx.def.analysis.calculations.get(calcId);
    const entry = tx.def.programs.get(`${calcId}@${step.id}`);
    if (!calc || !entry) continue;
    const g = gatherInputs(tx, calcId, step.id, inst.frames);
    const previous = currentDerived(tx.s, inst.key, calcId);
    if ('missing' in g) continue;
    if (previous && fingerprintOf(previous) === g.fingerprint) continue;
    let record: EvaluationRecord;
    if (previous) {
      try {
        record = recalculate(entry.program, previous.record, g.inputs, reason ?? 'an input of this calculation changed');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        raiseCalcFailure(tx, step, inst, calcId, message);
        continue;
      }
    } else {
      const r = tryEvaluate(entry.program, g.inputs);
      if (!r.ok) {
        raiseCalcFailure(tx, step, inst, calcId, `${r.error.code}: ${r.error.message}`);
        continue;
      }
      record = r.record;
    }
    const id = tx.nextId('DV');
    const d: DerivedValue = {
      id,
      calculation: calcId,
      stepKey: inst.key,
      frames: [...inst.frames],
      version: (previous?.version ?? 0) + 1,
      status: 'CURRENT',
      value: valueOfRecord(record, calc.output.valueType),
      record,
      inputs: g.provenance,
      computedAt: tx.now,
      computedSeq: tx.s.seq + 1,
      failed: false,
      exceptions: [],
    };
    if (previous) {
      previous.status = 'SUPERSEDED';
      d.supersedes = previous.id;
      d.reason = reason ?? 'an input of this calculation changed';
    }
    tx.s.derived[id] = d;
    const ev: Parameters<Tx['emit']>[0] = { type: 'DERIVED_VALUE_COMPUTED', derived: id, calculation: calcId, stepKey: inst.key, value: d.value, contentHash: record.contentHash };
    if (d.supersedes !== undefined) Object.assign(ev, { supersedes: d.supersedes, reason: d.reason });
    tx.emit(ev);
    evaluateDerived(tx, step, inst, d);
    created.push(id);
  }
  return created;
}

function raiseCalcFailure(tx: Tx, step: StepDef, inst: StepInstance, calcId: string, message: string): void {
  const already = Object.values(tx.s.exceptions).some((e) => e.type === 'CALCULATION_FAILED' && e.source.stepKey === inst.key && e.source.item === calcId && e.status === 'OPEN');
  if (already) return;
  tx.raise(engineDraft('CALCULATION_FAILED', `${calcId} could not be computed in ${inst.key}: ${message}`, { item: calcId, blocks: 'STEP_AND_DOWNSTREAM', until: 'DISPOSITION' }), { stepKey: inst.key, step: inst.step, frames: inst.frames, item: calcId }, { node: step.graphNode, frames: inst.frames });
}

/** Limits of a calculation and of any yield checkpoint whose result it is (PR-31, PR-39, IN-17). */
function evaluateDerived(tx: Tx, step: StepDef, inst: StepInstance, d: DerivedValue): void {
  const calc = tx.def.analysis.calculations.get(d.calculation);
  if (calc?.limits) {
    const ev = evaluateValue(tx, calc.limits, d.value);
    if (ev) {
      d.evaluation = summarise(ev);
      d.failed = ev.breached !== undefined;
      const ex = raiseForEvaluation(tx, step, inst, ev, `${calc.name} (${calc.id})`, 'CALCULATION', calc.id, { derived: d.id });
      if (ex) d.exceptions.push(ex);
    }
  }
  for (const y of tx.def.mbr.yieldCheckpoints) {
    if (y.result !== d.calculation || !y.limits) continue;
    const ev = evaluateValue(tx, y.limits, d.value);
    if (!ev) continue;
    d.evaluation = summarise(ev);
    d.failed ||= ev.breached !== undefined;
    const ex = raiseForEvaluation(tx, step, inst, ev, `${y.name} (${y.id})`, 'YIELD', d.calculation, { derived: d.id });
    if (ex) d.exceptions.push(ex);
  }
}

/**
 * The endpoint of a repeat-until loop is evaluated against its limits when the loop exits (EXIT or
 * EXHAUSTED); readings of earlier iterations are "endpoint not yet reached" (ADR 0004, TB-05).
 */
export function raiseForEvaluationAtExit(tx: Tx, loopId: string, iterationFrames: readonly Frame[]): void {
  const loop = tx.def.loops.get(loopId);
  if (!loop) return;
  const param = tx.def.analysis.parameters.get(loop.exit.endpoint);
  if (!param?.limits) return;
  const r = resolveAt(tx.def, tx.s, loop.exit.endpoint, iterationFrames);
  if (!r.ok) return;
  const point = r.resolved.points[0] === undefined ? undefined : tx.s.points[r.resolved.points[0]];
  const inst = point ? tx.s.steps[point.stepKey] : undefined;
  const step = point ? tx.def.steps.get(point.step) : undefined;
  if (!point || !inst || !step) return;
  const ev = evaluateValue(tx, param.limits, r.resolved.value);
  if (!ev) return;
  point.evaluation = { ...summarise(ev), detail: [...summarise(ev).detail, `evaluated at the exit of ${loopId}`] };
  point.failed = ev.breached !== undefined;
  const ex = raiseForEvaluation(tx, step, inst, ev, `${param.name} (${param.id}) at the exit of ${loop.name}`, 'PARAMETER', param.id, { point: point.id });
  if (ex) point.exceptions.push(ex);
}

/** ALL_APPLY acceptance scheme of an IPC phase, evaluated when the step is performed (each criterion on its own). */
export function evaluateAcceptanceScheme(tx: Tx, step: StepDef, inst: StepInstance): void {
  const phase = step.node as PhaseNode;
  if (phase.acceptanceScheme === undefined) return;
  const scheme = tx.def.analysis.schemes.get(phase.acceptanceScheme);
  if (!scheme) return;
  const already = Object.values(tx.s.exceptions).some((e) => e.type === 'ACCEPTANCE_CRITERION_FAILED' && e.source.stepKey === inst.key);
  if (already) return;
  const stats = new Map<string, { value: string; unit: string } | undefined>();
  for (const c of scheme.criteria) {
    const r = resolveAt(tx.def, tx.s, c.statistic, inst.frames);
    const v = r.ok ? r.resolved.value : undefined;
    stats.set(c.statistic, v?.kind === 'DECIMAL' ? { value: v.value, unit: v.unit } : v?.kind === 'COUNT' ? { value: v.value, unit: '1' } : undefined);
  }
  const result = evaluateAllApply(scheme, stats, tx.def.expr);
  for (const cr of result.criteria) {
    if (cr.pass) continue;
    const base = tierDraft(cr.evaluation, `Criterion ${cr.criterion} of ${scheme.title} (markets ${cr.governingMarkets.join(', ')})`, 'PARAMETER', cr.criterion, false);
    const draft: ExceptionDraft = base
      ? { ...base, type: 'ACCEPTANCE_CRITERION_FAILED', controls: [...base.controls, 'IN-34'] }
      : engineDraft('ACCEPTANCE_CRITERION_FAILED', `Criterion ${cr.criterion} of ${scheme.title} has no value to evaluate`, { blocks: 'STEP_AND_DOWNSTREAM', until: 'DEVIATION', deviationRequired: true });
    tx.raise(draft, { stepKey: inst.key, step: inst.step, frames: inst.frames, item: cr.criterion }, { node: step.graphNode, frames: inst.frames }, cr.evaluation.breached !== undefined ? { tier: cr.evaluation.breached } : {});
  }
}

/** Snapshot of the values a phase reads (targets shown to the operator), taken when it starts. */
export function snapshotTargets(tx: Tx, step: StepDef, inst: StepInstance): void {
  if (step.node.kind !== 'phase') return;
  for (const read of step.node.reads) {
    const r = resolveAt(tx.def, tx.s, read, inst.frames);
    if (r.ok) inst.targets[read] = { value: r.resolved.value, points: r.resolved.points, derived: r.resolved.derived };
  }
}

/** Mandatory data and calculations of a phase instance that are still missing (for the PERFORMED guard). */
export function missingData(tx: Tx, step: StepDef, inst: StepInstance): string[] {
  if (step.node.kind !== 'phase') return [];
  const out: string[] = [];
  for (const item of step.node.records) if (!effectivePoint(tx.s, inst.key, item)) out.push(item);
  for (const calc of step.node.computes) if (!currentDerived(tx.s, inst.key, calc)) out.push(calc);
  return out;
}

export type { Resolved };
export { showValue };
