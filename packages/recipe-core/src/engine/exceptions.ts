/**
 * Exceptions the engine itself raises, and how exceptions block steps (outline 5.2.4, 6.2
 * "exceptions are not arrows"; PR-08 tier behaviour; DI-26 mandatory review-by-exception types).
 *
 * Limit tiers (from the limits module):
 *   ALERT            -> register item, nothing blocked;
 *   INTERNAL_ACTION  -> the measuring step and the steps after it stop until a deviation is linked;
 *                       with the MBR's "continue current step" the step may finish, the steps after it
 *                       still wait for the deviation;
 *   REGISTERED/VALIDATED (registered limit, CPP, CQA)
 *                    -> a registration-relevant deviation is mandatory, only QA dispositions it, the
 *                       stage cannot be signed off until QA has, and it shows on every release screen.
 * An exception is never deleted and never closed by a later change of the value; only a disposition
 * by a person outside the involvement set of the step that raised it closes it.
 */
import type { ExceptionDraft, ExceptionRule } from '../blocks/contract.ts';
import type { Frame } from '../flow/tokens.ts';
import type { LimitEvaluation } from '../limits/evaluate.ts';
import { reachFrom, type BatchDefinition } from './definition.ts';
import type { BatchState, ExceptionRecord, StepInstance } from './types.ts';

/** Exception types raised by the engine core (blocks declare their own in their exception rules). */
export const ENGINE_EXCEPTION_RULES: readonly ExceptionRule[] = [
  { type: 'LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A value is outside a limit tier; behaviour follows the tier', controls: ['PR-08'] },
  { type: 'YIELD_OUT_OF_LIMITS', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A yield or reconciliation is outside its limits: investigation required, release blocked', controls: ['PR-31', 'PR-39', 'IN-17'] },
  { type: 'ACCEPTANCE_CRITERION_FAILED', category: 'OUT_OF_LIMIT', severity: 'CRITICAL', summary: 'A criterion of an ALL_APPLY acceptance scheme failed', controls: ['PR-08', 'IN-34'] },
  { type: 'CALCULATION_FAILED', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A calculation raised an explicit error (missing input, division by zero, domain)', controls: ['DI-33'] },
  { type: 'TIME_MAX_BREACH', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'A maximum duration between two events was exceeded', controls: ['INV-20', 'PR-30', 'IN-13'] },
  { type: 'TIME_MIN_BREACH', category: 'TIME_LIMIT', severity: 'ACTION', summary: 'An automatic event happened before its minimum duration', controls: ['INV-20', 'PR-30'] },
  { type: 'LOOP_EXHAUSTED', category: 'FLOW', severity: 'ACTION', summary: 'A repeat-until loop reached its maximum without meeting its exit condition', controls: ['INV-19', 'DI-34'] },
  { type: 'REPLICATE_COUNT_INVALID', category: 'FLOW', severity: 'ACTION', summary: 'The sub-lot count expression gave no whole number within the MBR minimum and maximum', controls: ['INV-19'] },
  { type: 'DECISION_NOT_EVALUABLE', category: 'FLOW', severity: 'ACTION', summary: 'A data-decided branch could not be decided (missing value or no single branch true)', controls: ['DI-34'] },
  { type: 'DECISION_AFFECTING_CORRECTION', category: 'POST_ENTRY_CHANGE', severity: 'CRITICAL', summary: 'A correction would have changed a decision already taken; only QA dispositions it', controls: ['DI-34', 'INV-41'] },
  { type: 'EXECUTED_TARGET_CHANGED', category: 'POST_ENTRY_CHANGE', severity: 'ACTION', summary: 'A recomputed target is outside tolerance of what was already executed', controls: ['DI-33', 'PR-19'] },
  { type: 'POST_ENTRY_CORRECTION', category: 'POST_ENTRY_CHANGE', severity: 'ALERT', summary: 'A value was corrected after entry (path a)', controls: ['DI-24'] },
  { type: 'RESULT_INVALIDATED', category: 'POST_ENTRY_CHANGE', severity: 'ALERT', summary: 'A result was invalidated with an investigation (path c)', controls: ['DI-29', 'INV-41'] },
  { type: 'ABORTED_ATTEMPT', category: 'REPEAT_OR_ABORTED', severity: 'ALERT', summary: 'An attempt was voided before a result existed (path b)', controls: ['DI-29'] },
  { type: 'REPEAT_ATTEMPT', category: 'REPEAT_OR_ABORTED', severity: 'ALERT', summary: 'A value was captured again in the same step instance', controls: ['DI-29'] },
  { type: 'REPEAT_AFTER_FAIL', category: 'REPEAT_OR_ABORTED', severity: 'ACTION', summary: 'A new attempt after a failing result; the failing result still governs', controls: ['DI-29', 'INV-41', 'IN-20'] },
  { type: 'LATE_ENTRY', category: 'LATE_ENTRY', severity: 'ALERT', summary: 'An entry with a person-claimed event time', controls: ['DI-28', 'PR-11'] },
  { type: 'MANUAL_ENTRY_FALLBACK', category: 'MANUAL_ENTRY', severity: 'ALERT', summary: 'A value was keyed by hand where device capture is configured; two-person mode', controls: ['DI-30', 'PR-14', 'DI-26'] },
  { type: 'STEP_SKIPPED', category: 'FORCED_SKIPPED_NA', severity: 'ALERT', summary: 'A skippable step was skipped with an approver', controls: ['PR-13', 'DI-26'] },
  { type: 'WITNESS_LATE', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'A WITNESSED signature came after its window', controls: ['DI-35', 'DI-30'] },
  { type: 'HOLD_POINT_NOT_APPROVED', category: 'DEVIATION_OR_OVERRIDE', severity: 'CRITICAL', summary: 'A QA hold point was not approved: the intermediate is rejected', controls: ['PR-45', 'IN-37'] },
  { type: 'OPERATOR_RAISED', category: 'DEVIATION_OR_OVERRIDE', severity: 'ALERT', summary: 'An exception raised by a person at a step', controls: ['PR-13', 'PR-49'] },
  { type: 'CLOCK_REGRESSION', category: 'TIME_SYNC', severity: 'ALERT', summary: 'The trusted clock went backwards; maximum checks use the latest time seen', controls: ['DI-27'] },
];

export const ENGINE_EXCEPTION_TYPES = new Set(ENGINE_EXCEPTION_RULES.map((r) => r.type));

function ruleOf(type: string): ExceptionRule {
  const r = ENGINE_EXCEPTION_RULES.find((x) => x.type === type);
  if (!r) throw new Error(`unknown engine exception type ${type}`);
  return r;
}

/** An engine exception draft with its declared category and severity. */
export function engineDraft(type: string, title: string, overrides: Partial<ExceptionDraft> = {}): ExceptionDraft {
  const r = ruleOf(type);
  return { type, title, controls: [...r.controls], severity: r.severity, category: r.category, blocks: 'NONE', ...overrides };
}

/**
 * The exception a limit evaluation requires (outline 5.2.4), or undefined when it passed. `kind`
 * names what was evaluated (parameter, calculation, yield checkpoint).
 */
export function tierDraft(ev: LimitEvaluation, subject: string, kind: 'PARAMETER' | 'CALCULATION' | 'YIELD', item: string, continueAllowed: boolean): ExceptionDraft | undefined {
  if (ev.breached === undefined) return undefined;
  const yieldLike = kind === 'YIELD';
  const type = yieldLike ? 'YIELD_OUT_OF_LIMITS' : 'LIMIT_BREACH';
  const failing = ev.tiers.filter((t) => !t.pass);
  const rounded = failing.map((t) => (t.low && !t.low.pass ? t.low.rounded : t.high && !t.high.pass ? t.high.rounded : undefined)).find((r) => r !== undefined);
  const where = failing.map((t) => `${t.tier.toLowerCase().replace('_', ' ')}${t.low && !t.low.pass ? ' low limit' : ''}${t.high && !t.high.pass ? ' high limit' : ''}`).join('; ');
  const base = `${subject} ${ev.value ?? ''} ${ev.unit}${rounded !== undefined && rounded !== ev.value ? ` (compared as ${rounded})` : ''} is outside its ${ev.breached.toLowerCase().replace('_', ' ')} limit (${where})`;
  const controls = yieldLike ? ['PR-08', 'PR-31', 'PR-39', 'IN-17'] : ['PR-08'];
  switch (ev.requirement) {
    case 'REGISTER_ITEM':
      return { type, title: `${base}: registered for review`, controls, severity: 'ALERT', category: 'OUT_OF_LIMIT', item, blocks: 'NONE', releaseBlocking: yieldLike, deviationRequired: yieldLike };
    case 'STOP_UNTIL_DEVIATION':
      return {
        type,
        title: `${base}: ${continueAllowed ? 'the steps after it wait' : 'this step and the steps after it wait'} until a deviation is linked`,
        controls,
        severity: 'ACTION',
        category: 'OUT_OF_LIMIT',
        item,
        blocks: continueAllowed ? 'DOWNSTREAM' : 'STEP_AND_DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        releaseBlocking: yieldLike,
      };
    case 'REGISTRATION_RELEVANT_DEVIATION':
      return {
        type,
        title: `${base}: a registration-relevant deviation is mandatory and only QA dispositions it`,
        controls,
        severity: 'CRITICAL',
        category: 'OUT_OF_LIMIT',
        item,
        blocks: 'STEP_AND_DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        qaOnly: true,
        registrationRelevant: true,
        releaseBlocking: true,
      };
    default:
      return undefined;
  }
}

/** True when an exception still blocks (open, and its lifting condition is not met). */
export function blockActive(e: ExceptionRecord): boolean {
  if (!e.block || e.status !== 'OPEN') return false;
  return e.block.until === 'DISPOSITION' || e.deviation === undefined;
}

/** Replicate frames agree: siblings of another sub-lot instance are never "downstream" (ADR 0004 L-26). */
export function replicateCompatible(def: BatchDefinition, a: readonly Frame[], b: readonly Frame[]): boolean {
  const idx = new Map(b.map((f) => [f.construct, f.index]));
  for (const f of a) {
    if (!def.replicates.has(f.construct)) continue;
    const other = idx.get(f.construct);
    if (other !== undefined && other !== f.index) return false;
  }
  return true;
}

/** Open exceptions that block this step instance from starting (downstream blocks) or completing (step and downstream blocks). */
export function blockingExceptions(def: BatchDefinition, s: BatchState, inst: StepInstance, phase: 'START' | 'COMPLETE'): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  const step = def.steps.get(inst.step);
  if (!step) return out;
  for (const e of Object.values(s.exceptions)) {
    if (!blockActive(e) || !e.block) continue;
    if (phase === 'COMPLETE' && e.block.steps.includes(inst.key)) {
      out.push(e);
      continue;
    }
    const d = e.block.downstream;
    if (!d || inst.key === e.source.stepKey) continue;
    if (reachFrom(def, d.node).has(step.graphNode) && replicateCompatible(def, d.frames, inst.frames)) out.push(e);
  }
  return out.sort((a, b) => a.raisedSeq - b.raisedSeq);
}

export function describeBlocking(list: readonly ExceptionRecord[]): string {
  return list.map((e) => `${e.id} ${e.title}${e.deviationRequired && !e.deviation ? ' (needs a linked deviation)' : ''}`).join('; ');
}
