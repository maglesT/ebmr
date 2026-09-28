/**
 * Invariant checks over a batch state (outline 5.3; used by the model-based tests after every step
 * and available to Phase 3 as the application-side invariant query). Each check is written
 * independently of the code that maintains the invariant, so a defect in one is caught by the other.
 *
 *   DI-34   tokens are safe (at most one token per sequential position and context) and match the
 *           enabled steps; no step starts before every predecessor on its path has completed.
 *   INV-19  loop iterations and sub-lot instances never exceed their maximum; exhaustion happens
 *           only at the maximum and always carries exactly one exception.
 *   INV-20  no step event before its minimum duration; every maximum breach (at the latest time
 *           seen) has exactly one exception, and no exception without a breach.
 *   INV-03  a verifier or witness never performed, entered data in or corrected the step.
 *   INV-31  every completed phase carries a valid human signature, and its check where one is required.
 *   INV-25  no typed value for a derived item; every derived value is its evaluation record's output
 *           and the record's content hash verifies.
 *   INV-41  the effective value of an item is the first attempt still holding a valid result.
 */
import { contentHashOf } from '@ebmr/expr';
import { durationToMicros } from '../flow/decimal.ts';
import type { GraphEdge } from '../flow/graph.ts';
import { contextKey, type Frame } from '../flow/tokens.ts';
import type { BatchDefinition, RuntimeConstraint } from './definition.ts';
import type { BatchState, NodeEventRecord, StepInstance } from './types.ts';

export interface InvariantViolation {
  invariant: 'DI-34' | 'INV-19' | 'INV-20' | 'INV-03' | 'INV-31' | 'INV-25' | 'INV-41';
  message: string;
}

const TERMINAL = new Set(['COMPLETED', 'NOT_APPLICABLE', 'SKIPPED']);

function regionsOfEdge(def: BatchDefinition, e: GraphEdge): Set<string> {
  return new Set([...(def.gi.node.get(e.from)?.regions ?? []), ...(def.gi.node.get(e.to)?.regions ?? [])]);
}

/** Two frame lists agree on every construct they share. */
function compatible(a: readonly Frame[], b: readonly Frame[]): boolean {
  const m = new Map(a.map((f) => [f.construct, f.index]));
  return b.every((f) => !m.has(f.construct) || m.get(f.construct) === f.index);
}

const forwardCache = new WeakMap<BatchDefinition, Map<string, Set<string>>>();

/** Graph nodes reachable from `from` over forward edges only (no loop-back). */
function forwardReach(def: BatchDefinition, from: string): Set<string> {
  let cache = forwardCache.get(def);
  if (!cache) {
    cache = new Map();
    forwardCache.set(def, cache);
  }
  const hit = cache.get(from);
  if (hit) return hit;
  const seen = new Set<string>();
  const queue = (def.gi.out.get(from) ?? []).filter((e) => e.kind !== 'LOOP_BACK').map((e) => e.to);
  while (queue.length > 0) {
    const n = queue.pop() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of def.gi.out.get(n) ?? []) if (e.kind !== 'LOOP_BACK') queue.push(e.to);
  }
  cache.set(from, seen);
  return seen;
}

function checkTokens(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  const tokens = [...s.marking.tokens.values()];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const a = tokens[i];
      const b = tokens[j];
      if (!a || !b || contextKey(a.frames) !== contextKey(b.frames)) continue;
      const ea = def.gi.edge.get(a.edge);
      const eb = def.gi.edge.get(b.edge);
      if (!ea || !eb) continue;
      const ra = regionsOfEdge(def, ea);
      const rb = regionsOfEdge(def, eb);
      const separated = [...ra].some((r) => {
        if (!r.startsWith('branch:')) return false;
        const construct = r.slice(0, r.indexOf('#'));
        return [...rb].some((x) => x.startsWith(`${construct}#`) && x !== r);
      });
      if (!separated) out.push({ invariant: 'DI-34', message: `two tokens in context "${contextKey(a.frames)}" on ${a.edge} and ${b.edge} are not in different parallel branches` });
    }
  }
  // Every open step instance (never completed before) holds the token on its incoming edge.
  const onEdge = new Set(tokens.map((t) => `${def.gi.edge.get(t.edge)?.to ?? ''}|${contextKey(t.frames)}`));
  for (const inst of Object.values(s.steps)) {
    if (inst.firstCompletedSeq !== undefined || TERMINAL.has(inst.status)) continue;
    const node = def.steps.get(inst.step)?.graphNode ?? '';
    if (!onEdge.has(`${node}|${contextKey(inst.frames)}`)) out.push({ invariant: 'DI-34', message: `step ${inst.key} is ${inst.status} without holding a token` });
  }
  if (s.status === 'IN_PROGRESS' || s.status === 'ISSUED' || s.status === 'EXECUTION_COMPLETE') {
    for (const t of tokens) {
      const to = def.gi.node.get(def.gi.edge.get(t.edge)?.to ?? '');
      if (!to || (to.kind !== 'TASK' && to.kind !== 'HOLD')) continue;
      const stepId = def.stepByGraphNode.get(to.id) ?? '';
      const inst = s.steps[`${stepId}@${contextKey(t.frames)}`];
      if (!inst) out.push({ invariant: 'DI-34', message: `a token reached ${stepId} in "${contextKey(t.frames)}" but the step is not enabled` });
      else if ((inst.status === 'COMPLETED' || inst.status === 'SKIPPED') && s.status !== 'ISSUED') out.push({ invariant: 'DI-34', message: `step ${inst.key} is finished but its token has not moved on` });
    }
  }
  if (s.status === 'EXECUTION_COMPLETE') {
    if (tokens.length > 0) out.push({ invariant: 'DI-34', message: 'the batch is complete but tokens remain' });
    for (const i of Object.values(s.steps)) if (!TERMINAL.has(i.status)) out.push({ invariant: 'DI-34', message: `the batch is complete but ${i.key} is ${i.status}` });
  }
}

function checkSequence(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  const insts = Object.values(s.steps);
  for (const later of insts) {
    const at = later.startedSeq ?? (later.status === 'SKIPPED' || (later.kind === 'HOLD' && later.status === 'COMPLETED') ? later.firstCompletedSeq : undefined);
    if (at === undefined) continue;
    const node = def.steps.get(later.step)?.graphNode;
    if (!node) continue;
    for (const earlier of insts) {
      if (earlier === later || earlier.status === 'NOT_APPLICABLE') continue;
      const en = def.steps.get(earlier.step)?.graphNode;
      if (!en || !forwardReach(def, en).has(node) || !compatible(earlier.frames, later.frames)) continue;
      if (earlier.firstCompletedSeq === undefined || earlier.firstCompletedSeq > at) {
        out.push({ invariant: 'DI-34', message: `${later.key} started (event ${at}) before its predecessor ${earlier.key} completed (${earlier.firstCompletedSeq ?? 'never'})` });
      }
    }
  }
}

function checkBounds(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  const frameLists: Frame[][] = [...Object.values(s.steps).map((i) => i.frames), ...Object.values(s.points).map((p) => p.frames), ...[...s.marking.tokens.values()].map((t) => [...t.frames])];
  for (const frames of frameLists) {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i] as Frame;
      const loop = def.loops.get(f.construct);
      if (loop && (f.index < 1 || f.index > loop.maxIterations)) out.push({ invariant: 'INV-19', message: `iteration ${f.index} of ${loop.id} exceeds its maximum of ${loop.maxIterations}` });
      const rep = def.replicates.get(f.construct);
      if (rep) {
        const count = Number(s.decisions[`${rep.id}@${contextKey(frames.slice(0, i))}`]?.outcome ?? Number.NaN);
        if (!(f.index >= 1 && f.index <= count && count <= rep.count.max && count >= rep.count.min)) out.push({ invariant: 'INV-19', message: `instance ${f.index} of ${rep.id} is outside the chosen count ${count} (${rep.count.min}..${rep.count.max})` });
      }
    }
  }
  for (const d of Object.values(s.decisions)) {
    if (d.kind === 'COUNT') {
      const rep = def.replicates.get(d.construct);
      const n = Number(d.outcome);
      if (!rep || !Number.isInteger(n) || n < rep.count.min || n > rep.count.max) out.push({ invariant: 'INV-19', message: `sub-lot count ${d.outcome} of ${d.construct} is outside its bounds` });
    }
    if (d.kind !== 'LOOP') continue;
    const loop = def.loops.get(d.construct);
    const it = d.frames[d.frames.length - 1]?.index ?? 0;
    if (!loop) continue;
    if (d.outcome === 'CONTINUE' && it >= loop.maxIterations) out.push({ invariant: 'INV-19', message: `${loop.id} continued after iteration ${it} although its maximum is ${loop.maxIterations}` });
    if (d.outcome === 'EXHAUSTED' && it !== loop.maxIterations) out.push({ invariant: 'INV-19', message: `${loop.id} was exhausted at iteration ${it}, not at its maximum` });
    const exh = Object.values(s.exceptions).filter((e) => e.type === 'LOOP_EXHAUSTED' && e.source.construct === loop.id && contextKey(e.source.frames) === contextKey(d.frames));
    const fired = d.outcome === 'EXHAUSTED' && ![...s.marking.tokens.values()].some((t) => def.gi.edge.get(t.edge)?.to === def.analysis.graphNodeOf(loop.id, 'LOOP_TEST')?.id && contextKey(t.frames) === contextKey(d.frames));
    if (fired && exh.length !== 1) out.push({ invariant: 'INV-19', message: `${loop.id} was exhausted in "${contextKey(d.frames)}" with ${exh.length} exceptions instead of exactly one` });
    if (d.outcome !== 'EXHAUSTED' && exh.length > 0) out.push({ invariant: 'INV-19', message: `${loop.id} has an exhaustion exception without being exhausted` });
  }
}

function occurrences(s: BatchState, node: string, event: 'START' | 'END'): NodeEventRecord[] {
  return Object.values(s.nodeEvents).filter((e) => e.node === node && e.event === event);
}

function checkTime(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  const now = s.lastRecordedUs;
  const inShared = (rc: RuntimeConstraint, frames: readonly Frame[]): Frame[] => frames.filter((f) => rc.shared.includes(f.construct));
  for (const rc of def.constraints) {
    const min = rc.tc.min ? durationToMicros(rc.tc.min.value, rc.tc.min.unit) : undefined;
    const max = rc.tc.max ? durationToMicros(rc.tc.max.value, rc.tc.max.unit) : undefined;
    const froms = occurrences(s, rc.from.node, rc.from.event);
    const keys = new Map<string, Frame[]>();
    for (const f of froms) keys.set(contextKey(inShared(rc, f.frames)), inShared(rc, f.frames));
    for (const [key, inst] of keys) {
      const mine = (fs: readonly Frame[]): boolean => compatible(fs, inst);
      const fr = froms.filter((f) => mine(f.frames)).map((f) => f.at);
      const start = rc.from.event === 'START' ? fr.reduce((a, b) => (b < a ? b : a)) : fr.reduce((a, b) => (b > a ? b : a));
      const tos = occurrences(s, rc.to.node, rc.to.event).filter((t) => mine(t.frames) && t.at >= start);
      const state = s.timeInstances[`${rc.tc.id}@${key}`];
      const isStep = def.steps.has(rc.to.node) || def.loops.has(rc.to.node) || def.stages.has(rc.to.node);
      if (min !== undefined) {
        for (const t of tos) {
          if (t.at - start >= min) continue;
          if (isStep) out.push({ invariant: 'INV-20', message: `${rc.tc.id}: ${rc.to.node} ${rc.to.event} came ${t.at - start} us after its start, before the minimum of ${min} us` });
          else if (!state?.minBreachException) out.push({ invariant: 'INV-20', message: `${rc.tc.id}: an automatic event before the minimum has no exception` });
        }
      }
      if (max === undefined) continue;
      const voided = state?.voided === true;
      const breached = tos.some((t) => t.at - start > max) || (tos.length === 0 && !voided && now - start > max);
      const exceptions = Object.values(s.exceptions).filter((e) => e.type === 'TIME_MAX_BREACH' && e.source.constraint === rc.tc.id && contextKey(e.source.frames) === key);
      if (breached && exceptions.length !== 1) out.push({ invariant: 'INV-20', message: `${rc.tc.id} in "${key}" is breached with ${exceptions.length} exceptions instead of exactly one` });
      if (!breached && exceptions.length > 0) out.push({ invariant: 'INV-20', message: `${rc.tc.id} in "${key}" has a breach exception without a breach` });
    }
  }
}

function involved(i: StepInstance): Set<string> {
  return new Set([...i.performers, ...i.dataEnterers, ...i.correctors, ...i.performedSigners]);
}

function checkSignatures(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  for (const i of Object.values(s.steps)) {
    const inv = involved(i);
    for (const sig of i.signatures) {
      if (sig.role === 'CHECKED' && inv.has(sig.signer)) out.push({ invariant: 'INV-03', message: `${sig.signer} verified ${i.key} although they performed, entered data in or corrected it` });
    }
    if (i.kind !== 'PHASE' || i.status !== 'COMPLETED') continue;
    const valid = i.signatures.filter((x) => x.valid);
    if (valid.length === 0) out.push({ invariant: 'INV-31', message: `${i.key} completed without any valid human signature` });
    const step = def.steps.get(i.step);
    if ((step?.checkRole !== undefined || i.verificationRequired) && !valid.some((x) => x.role === 'CHECKED')) out.push({ invariant: 'INV-31', message: `${i.key} completed without its required check signature` });
  }
}

function checkDerived(def: BatchDefinition, s: BatchState, out: InvariantViolation[]): void {
  for (const p of Object.values(s.points)) {
    if (def.analysis.calculations.has(p.item)) out.push({ invariant: 'INV-25', message: `a value was stored for the calculation ${p.item}` });
    const step = def.steps.get(p.step);
    if (step?.computedItems.has(p.item) && p.kind === 'VALUE' && p.source.mode !== 'BLOCK') out.push({ invariant: 'INV-25', message: `${p.item} is computed by its block but a value was typed` });
  }
  for (const d of Object.values(s.derived)) {
    const { contentHash, ...rest } = d.record;
    if (contentHashOf(rest) !== contentHash) out.push({ invariant: 'INV-25', message: `the evaluation record of ${d.id} does not match its content hash` });
    const v = d.value;
    const recorded = d.record.output.value;
    const shown = v.kind === 'DECIMAL' || v.kind === 'COUNT' ? v.value : v.kind === 'BOOLEAN' ? String(v.value) : undefined;
    if (shown !== recorded) out.push({ invariant: 'INV-25', message: `${d.id} holds ${String(shown)} but its record computed ${recorded}` });
  }
  // INV-41: the first attempt still holding a valid result governs.
  const byInstanceItem = new Map<string, typeof s.points[string][]>();
  for (const p of Object.values(s.points)) {
    const k = `${p.stepKey}|${p.item}`;
    byInstanceItem.set(k, [...(byInstanceItem.get(k) ?? []), p]);
  }
  for (const list of byInstanceItem.values()) {
    const valid = list.filter((p) => p.kind === 'VALUE' && p.status === 'VALID');
    const perAttempt = new Map<number, number>();
    for (const p of valid) perAttempt.set(p.attempt, (perAttempt.get(p.attempt) ?? 0) + 1);
    for (const [attempt, n] of perAttempt) if (n > 1) out.push({ invariant: 'INV-41', message: `attempt ${attempt} of ${list[0]?.item ?? '?'} has ${n} valid versions` });
    for (const p of list) for (const ex of p.exceptions) if (!s.exceptions[ex]) out.push({ invariant: 'INV-41', message: `exception ${ex} of ${p.id} has disappeared` });
  }
}

/** Every invariant violation in a state (empty when the state is sound). */
export function checkInvariants(def: BatchDefinition, s: BatchState): InvariantViolation[] {
  const out: InvariantViolation[] = [];
  checkTokens(def, s, out);
  checkSequence(def, s, out);
  checkBounds(def, s, out);
  checkTime(def, s, out);
  checkSignatures(def, s, out);
  checkDerived(def, s, out);
  return out;
}
