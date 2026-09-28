/**
 * Time constraints at run time (INV-20; outline 5.2 general rules, 5.6, 6.2; ADR 0004 decision 3).
 *
 * - Every step and construct start and end is recorded with its time basis (occurred_at only when
 *   DEVICE_SYNCED, otherwise the trusted recorded time).
 * - A constraint applies per iteration and per sub-lot instance of the constructs both its events lie
 *   in; it is void when its end lies in an alternative branch that was not taken.
 * - The `to` event of a step (start, performed) is refused before the minimum has elapsed; an automatic
 *   construct event before its minimum raises an exception instead (it cannot be refused).
 * - Beyond the maximum exactly one exception is raised per constraint instance, whether or not the end
 *   event has happened. `sweep` computes this at every command and on demand, so a breach never
 *   depends on a timer job firing.
 * - The start of an interval inside a repeated construct is its earliest START or its latest END.
 * - Pauses (equipment stops) arrive with the automated equipment phase (G-06) in Phase 3; until then
 *   no pause time is subtracted, which can only make a maximum stricter.
 */
import { durationToMicros, formatMicros } from '../flow/decimal.ts';
import type { Frame } from '../flow/tokens.ts';
import type { RuntimeConstraint } from './definition.ts';
import { engineDraft } from './exceptions.ts';
import { ctxKey, refuse, stepKey, type Tx } from './tx.ts';
import type { NodeEventRecord, OccurredAt, TimeInstanceState } from './types.ts';

/** The instant an event is recorded at: occurred_at only when the source clock is synchronised. */
export function eventInstant(tx: Tx, occurredAt: OccurredAt | undefined): bigint {
  return occurredAt && occurredAt.trust === 'DEVICE_SYNCED' ? occurredAt.us : tx.clockUs;
}

export function nodeEventKey(node: string, event: 'START' | 'END', frames: readonly Frame[]): string {
  return `${node}|${event}|${ctxKey(frames)}`;
}

export function recordNodeEvent(tx: Tx, node: string, event: 'START' | 'END', frames: readonly Frame[], at: bigint): void {
  const key = nodeEventKey(node, event, frames);
  if (tx.s.nodeEvents[key]) return;
  tx.s.nodeEvents[key] = { node, event, frames: [...frames], at };
}

function occurrences(tx: Tx, node: string, event: 'START' | 'END'): NodeEventRecord[] {
  return Object.values(tx.s.nodeEvents).filter((e) => e.node === node && e.event === event);
}

/** Frames of an occurrence restricted to the constraint's shared constructs (the instance context). */
function instanceFrames(rc: RuntimeConstraint, frames: readonly Frame[]): Frame[] {
  return frames.filter((f) => rc.shared.includes(f.construct));
}

function within(rc: RuntimeConstraint, frames: readonly Frame[], instance: readonly Frame[]): boolean {
  const inst = new Map(instance.map((f) => [f.construct, f.index]));
  return frames.every((f) => !rc.shared.includes(f.construct) || inst.get(f.construct) === f.index);
}

function fromInstant(rc: RuntimeConstraint, froms: readonly NodeEventRecord[]): bigint | undefined {
  if (froms.length === 0) return undefined;
  const ats = froms.map((f) => f.at);
  return rc.from.event === 'START' ? ats.reduce((a, b) => (b < a ? b : a)) : ats.reduce((a, b) => (b > a ? b : a));
}

function micros(q: { value: string; unit: string } | undefined): bigint | undefined {
  return q ? durationToMicros(q.value, q.unit) : undefined;
}

/**
 * Refuses a step event (START or END of a phase or hold point, loop exit, stage sign-off) that would
 * come before the minimum duration of any constraint ending in it (INV-20).
 */
export function checkMinimum(tx: Tx, node: string, event: 'START' | 'END', frames: readonly Frame[], at: bigint): void {
  for (const rc of tx.def.constraints) {
    if (rc.to.node !== node || rc.to.event !== event) continue;
    const min = micros(rc.tc.min);
    if (min === undefined) continue;
    const instance = instanceFrames(rc, frames);
    const froms = occurrences(tx, rc.from.node, rc.from.event).filter((f) => within(rc, f.frames, instance));
    const start = fromInstant(rc, froms);
    if (start === undefined) continue;
    const elapsed = at - start;
    if (elapsed < min) {
      refuse(
        'ENG-MIN-DURATION',
        `${rc.tc.name} has a minimum of ${formatMicros(min)}; only ${formatMicros(elapsed < 0n ? 0n : elapsed)} have passed, so ${node} cannot ${event === 'START' ? 'start' : 'end'} yet`,
        ['INV-20', 'PR-30'],
      );
    }
  }
}

function instanceState(tx: Tx, rc: RuntimeConstraint, instance: readonly Frame[]): TimeInstanceState {
  const key = `${rc.tc.id}@${ctxKey(instance)}`;
  const existing = tx.s.timeInstances[key];
  if (existing) return existing;
  const created: TimeInstanceState = { key, constraint: rc.tc.id, frames: [...instance], warned: false, voided: false };
  tx.s.timeInstances[key] = created;
  return created;
}

/** True when the `to` event can no longer happen in this instance (it lies in an untaken branch). */
function voided(tx: Tx, rc: RuntimeConstraint, instance: readonly Frame[]): boolean {
  for (const b of rc.toBranches) {
    const decisions = Object.values(tx.s.decisions).filter((d) => d.kind === 'BRANCH' && d.construct === b.construct && within(rc, d.frames, instance));
    if (decisions.length > 0 && decisions.every((d) => d.outcome !== b.branch)) return true;
  }
  return false;
}

function raiseTimeException(tx: Tx, rc: RuntimeConstraint, st: TimeInstanceState, kind: 'MAX' | 'MIN', elapsed: bigint, limit: bigint): void {
  const block = rc.tc.breach === 'EXCEPTION_AND_BLOCK';
  const what = kind === 'MAX' ? `exceeded its maximum of ${formatMicros(limit)} (${formatMicros(elapsed)} elapsed)` : `ended before its minimum of ${formatMicros(limit)} (${formatMicros(elapsed)} elapsed)`;
  const toStep = tx.def.steps.get(rc.to.node);
  const blockedSteps = toStep ? Object.values(tx.s.steps).filter((i) => i.step === toStep.id && within(rc, i.frames, st.frames) && i.status !== 'COMPLETED' && i.status !== 'NOT_APPLICABLE' && i.status !== 'SKIPPED').map((i) => i.key) : [];
  const draft = engineDraft(kind === 'MAX' ? 'TIME_MAX_BREACH' : 'TIME_MIN_BREACH', `${rc.tc.name} ${what}${block ? '; the step and the steps after it stop until QA dispositions the exception' : '; a deviation is required'}`, {
    blocks: block ? 'STEP_AND_DOWNSTREAM' : 'NONE',
    until: 'DISPOSITION',
    deviationRequired: true,
    qaOnly: block,
    releaseBlocking: true,
  });
  const id = tx.raise(draft, { frames: st.frames, constraint: rc.tc.id, ...(toStep ? { step: toStep.id } : {}) }, { node: rc.anchor, frames: st.frames });
  const rec = tx.s.exceptions[id];
  if (rec?.block) rec.block.steps = blockedSteps;
  if (kind === 'MAX') st.maxBreachException = id;
  else st.minBreachException = id;
}

/** After an automatic construct event: a minimum not reached is an exception (it cannot be refused). */
export function flagEarlyAutomaticEvent(tx: Tx, node: string, event: 'START' | 'END', frames: readonly Frame[], at: bigint): void {
  for (const rc of tx.def.constraints) {
    if (rc.to.node !== node || rc.to.event !== event) continue;
    const min = micros(rc.tc.min);
    if (min === undefined) continue;
    const instance = instanceFrames(rc, frames);
    const start = fromInstant(rc, occurrences(tx, rc.from.node, rc.from.event).filter((f) => within(rc, f.frames, instance)));
    if (start === undefined) continue;
    const st = instanceState(tx, rc, instance);
    if (at - start < min && st.minBreachException === undefined) raiseTimeException(tx, rc, st, 'MIN', at - start, min);
  }
}

/**
 * Evaluates every started constraint instance at the transaction time (INV-20): raises each maximum
 * breach exactly once, warns once before the maximum, and voids instances whose end cannot happen.
 */
export function sweepTime(tx: Tx): void {
  for (const rc of tx.def.constraints) {
    const max = micros(rc.tc.max);
    const warn = micros(rc.tc.warnBefore);
    const froms = occurrences(tx, rc.from.node, rc.from.event);
    const instances = new Map<string, Frame[]>();
    for (const f of froms) {
      const inst = instanceFrames(rc, f.frames);
      instances.set(ctxKey(inst), inst);
    }
    for (const instance of instances.values()) {
      const st = instanceState(tx, rc, instance);
      const start = fromInstant(rc, froms.filter((f) => within(rc, f.frames, instance)));
      if (start === undefined) continue;
      const tos = occurrences(tx, rc.to.node, rc.to.event)
        .filter((t) => within(rc, t.frames, instance) && t.at >= start)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      if (tos.length === 0 && !st.voided && voided(tx, rc, instance)) {
        st.voided = true;
        tx.emit({ type: 'TIME_CONSTRAINT_VOIDED', constraint: rc.tc.id, instance: st.key });
      }
      if (max === undefined || st.maxBreachException !== undefined) continue;
      for (const t of tos) {
        const elapsed = t.at - start;
        if (elapsed > max) {
          raiseTimeException(tx, rc, st, 'MAX', elapsed, max);
          break;
        }
      }
      if (st.maxBreachException !== undefined || tos.length > 0 || st.voided) continue;
      const elapsed = tx.now - start;
      if (elapsed > max) raiseTimeException(tx, rc, st, 'MAX', elapsed, max);
      else if (warn !== undefined && !st.warned && max - elapsed <= warn) {
        st.warned = true;
        tx.emit({ type: 'TIME_WARNING', constraint: rc.tc.id, instance: st.key, remainingUs: max - elapsed });
      }
    }
  }
}

/** Key of the step instance an event belongs to (for messages). */
export function eventStepKey(node: string, frames: readonly Frame[]): string {
  return stepKey(node, frames);
}
