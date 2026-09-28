/**
 * Token advance (ADR 0004 decision 5; DI-34): after every command the engine fires every enabled
 * control node of the token game (splits, joins, scopes, loop entries, sub-lot releases) and makes a
 * step ENABLED when a token reaches it. A step's token moves on only when the step is COMPLETED or
 * SKIPPED, so no step can start before its predecessors have completed. Decisions are taken by the
 * engine from recorded data (data-decided branches, count expressions), from the issue-time variant,
 * or from an authorised person's recorded choice with a reason; loop outcomes come from the exit
 * condition, never from a person. Untaken branches are set NOT_APPLICABLE by the system. While the
 * batch is on hold nothing advances (outline 5.2.2).
 */
import type { ExprValue } from '../flow/expression-port.ts';
import type { Enabled, Frame } from '../flow/tokens.ts';
import type { GraphNode } from '../flow/graph.ts';
import { CONDITION } from '../validator/analysis.ts';
import type { StepDef } from './definition.ts';
import { raiseForEvaluationAtExit } from './data.ts';
import { engineDraft } from './exceptions.ts';
import { flagEarlyAutomaticEvent, recordNodeEvent } from './timing.ts';
import { ctxKey, stepKey, type Tx } from './tx.ts';
import type { DecisionRecord, StageFrameState, StepInstance } from './types.ts';
import { resolveAt, toExprValue } from './values.ts';

export interface ConditionResult {
  ok: boolean;
  value?: boolean;
  reason?: string;
  inputs: { points: string[]; derived: string[] };
}

/**
 * Evaluates a condition (branch guard, loop exit) written at tree node `treeId`, read at graph node
 * `reader`, with the values visible in `frames`. Missing values are explicit failures.
 */
export function evaluateCondition(tx: Tx, source: string, treeId: string, reader: GraphNode | undefined, frames: readonly Frame[]): ConditionResult {
  const a = tx.def.analysis;
  const env = a.envAt(treeId, reader);
  const check = tx.def.expr.check(source, env, CONDITION);
  const inputs = { points: [] as string[], derived: [] as string[] };
  if (!check.ok) return { ok: false, reason: `the condition "${source}" does not check`, inputs };
  const scope = a.expanded.scopes.get(treeId);
  const values = new Map<string, ExprValue>();
  for (const local of check.reads) {
    const id = scope?.env.get(local) ?? local;
    const r = resolveAt(tx.def, tx.s, id, frames);
    if (!r.ok) return { ok: false, reason: r.reason, inputs };
    const v = toExprValue(r.resolved.value);
    if (!v) return { ok: false, reason: `${id} cannot be read by a condition`, inputs };
    values.set(local, v);
    inputs.points.push(...r.resolved.points);
    inputs.derived.push(...r.resolved.derived);
  }
  const out = tx.def.expr.evaluate(source, env, values, CONDITION);
  if (!out.ok) return { ok: false, reason: `${out.code}: ${out.message}`, inputs };
  if (out.value.kind !== 'BOOLEAN') return { ok: false, reason: 'the condition did not give true or false', inputs };
  return { ok: true, value: out.value.value, inputs };
}

export function recordDecision(tx: Tx, d: Omit<DecisionRecord, 'at' | 'seq'>): DecisionRecord {
  const rec: DecisionRecord = { ...d, at: tx.now, seq: tx.s.seq + 1 };
  tx.s.decisions[d.key] = rec;
  const ev: Parameters<Tx['emit']>[0] = { type: 'DECISION_MADE', decision: d.key, kind: d.kind, construct: d.construct, outcome: d.outcome, by: d.decidedBy };
  if (d.reason !== undefined) Object.assign(ev, { reason: d.reason });
  tx.emit(ev);
  return rec;
}

/** Data-decided branch (outline 6.2): exactly one guard true, else the `otherwise` branch; otherwise not decidable. */
export function decideDataBranch(tx: Tx, altId: string, frames: readonly Frame[]): { branch: string; inputs: DecisionRecord['inputs'] } | { problem: string; inputs: DecisionRecord['inputs'] } {
  const alt = tx.def.alternatives.get(altId);
  const split = tx.def.analysis.graphNodeOf(altId, 'XOR_SPLIT');
  if (!alt) return { problem: `unknown alternative ${altId}`, inputs: { points: [], derived: [] } };
  const truthy: string[] = [];
  const inputs = { points: [] as string[], derived: [] as string[] };
  for (const b of alt.branches) {
    if (b.guard === undefined) continue;
    const r = evaluateCondition(tx, b.guard, altId, split, frames);
    inputs.points.push(...r.inputs.points);
    inputs.derived.push(...r.inputs.derived);
    if (!r.ok) return { problem: `branch ${b.id}: ${r.reason ?? 'not evaluable'}`, inputs };
    if (r.value === true) truthy.push(b.id);
  }
  const uniq = { points: [...new Set(inputs.points)], derived: [...new Set(inputs.derived)] };
  if (truthy.length === 1) return { branch: truthy[0] as string, inputs: uniq };
  if (truthy.length > 1) return { problem: `more than one branch applies (${truthy.join(', ')})`, inputs: uniq };
  const otherwise = alt.branches.find((b) => b.otherwise === true);
  return otherwise ? { branch: otherwise.id, inputs: uniq } : { problem: 'no branch applies', inputs: uniq };
}

function raiseDecisionProblem(tx: Tx, key: string, construct: string, frames: readonly Frame[], problem: string, node: string): void {
  if (tx.s.pendingDecisionProblems[key] !== undefined) return;
  const id = tx.raise(
    engineDraft('DECISION_NOT_EVALUABLE', `${construct} cannot be decided from the recorded data: ${problem}`, { blocks: 'DOWNSTREAM', until: 'DISPOSITION', deviationRequired: true }),
    { frames: [...frames], construct },
    { node, frames },
  );
  tx.s.pendingDecisionProblems[key] = id;
}

function markNotApplicable(tx: Tx, altId: string, taken: string, frames: readonly Frame[]): void {
  for (const step of tx.def.steps.values()) {
    const b = step.branches.find((x) => x.construct === altId);
    if (!b || b.branch === taken) continue;
    const key = stepKey(step.id, frames);
    if (tx.s.steps[key]) continue;
    const inst = newInstance(step, key, frames, 'NOT_APPLICABLE');
    inst.notApplicable = { reason: 'BRANCH_NOT_TAKEN', construct: altId };
    inst.firstCompletedSeq = tx.s.seq + 1;
    tx.s.steps[key] = inst;
    tx.emit({ type: 'STEP_STATUS_CHANGED', stepKey: key, step: step.id, from: 'PENDING', to: 'NOT_APPLICABLE', by: 'SYSTEM', reason: `branch ${b.branch} of ${altId} was not taken` });
  }
}

export function newInstance(step: StepDef, key: string, frames: readonly Frame[], status: StepInstance['status']): StepInstance {
  return {
    key,
    step: step.id,
    kind: step.kind,
    frames: [...frames],
    status,
    performers: [],
    dataEnterers: [],
    correctors: [],
    performedSigners: [],
    signatures: [],
    verificationRequired: false,
    reverification: false,
    targets: {},
    blockComputed: {},
  };
}

function subLotId(tx: Tx, repId: string, parent: readonly Frame[], index: number): string {
  const rep = tx.def.replicates.get(repId);
  const prefix = rep?.subLotPrefix ?? 'SL';
  const path = parent.map((f) => f.index).join('.');
  return `${tx.s.header.batchNumber}-${prefix}${path ? `${path}.` : ''}${index}`;
}

function createSubLot(tx: Tx, repId: string, parent: readonly Frame[], index: number): void {
  const key = `${repId}@${ctxKey([...parent, { construct: repId, index }])}`;
  if (tx.s.subLots[key]) return;
  const id = subLotId(tx, repId, parent, index);
  tx.s.subLots[key] = { key, id, construct: repId, frames: [...parent, { construct: repId, index }], index, createdAt: tx.now };
  tx.emit({ type: 'SUBLOT_CREATED', subLot: id, construct: repId, index, context: ctxKey(parent) });
}

function stageFrameKey(stage: string, frames: readonly Frame[]): string {
  return `${stage}@${ctxKey(frames)}`;
}

/** Fires one enabled node when it can fire; returns true when the marking changed. */
function tryFire(tx: Tx, e: Enabled): boolean {
  const def = tx.def;
  const node = def.gi.node.get(e.node) as GraphNode;
  const ctx = ctxKey(e.frames);
  let option: string | number | undefined;

  switch (node.kind) {
    case 'TASK':
    case 'HOLD': {
      const stepId = def.stepByGraphNode.get(node.id) as string;
      const step = def.steps.get(stepId) as StepDef;
      const key = stepKey(stepId, e.frames);
      const inst = tx.s.steps[key];
      if (!inst) {
        const created = newInstance(step, key, e.frames, 'ENABLED');
        created.enabledAt = tx.now;
        created.enabledSeq = tx.s.seq + 1;
        tx.s.steps[key] = created;
        tx.emit({ type: 'STEP_STATUS_CHANGED', stepKey: key, step: stepId, from: 'PENDING', to: 'ENABLED', by: 'SYSTEM', reason: 'token arrived' });
        if (step.kind === 'HOLD') recordNodeEvent(tx, stepId, 'START', e.frames, tx.clockUs);
        return false;
      }
      if (inst.status !== 'COMPLETED' && inst.status !== 'SKIPPED') return false;
      break;
    }
    case 'XOR_SPLIT': {
      const altId = node.source;
      const alt = def.alternatives.get(altId);
      const dkey = `${altId}@${ctx}`;
      const existing = tx.s.decisions[dkey];
      if (existing) option = existing.outcome;
      else if (alt?.decision.mode === 'ISSUE_VARIANT') {
        const value = tx.s.header.variants[alt.decision.variant];
        const branch = alt.branches.find((b) => value !== undefined && (b.variantValues ?? []).includes(value));
        if (!branch) {
          raiseDecisionProblem(tx, dkey, altId, e.frames, `no branch covers variant ${alt.decision.variant} = ${String(value)}`, node.id);
          return false;
        }
        recordDecision(tx, { key: dkey, kind: 'BRANCH', construct: altId, frames: [...e.frames], outcome: branch.id, decidedBy: 'SYSTEM', reason: `issue variant ${alt.decision.variant} = ${String(value)}`, inputs: { points: [], derived: [] } });
        option = branch.id;
      } else if (alt?.decision.mode === 'DATA') {
        const d = decideDataBranch(tx, altId, e.frames);
        if ('problem' in d) {
          raiseDecisionProblem(tx, dkey, altId, e.frames, d.problem, node.id);
          return false;
        }
        recordDecision(tx, { key: dkey, kind: 'BRANCH', construct: altId, frames: [...e.frames], outcome: d.branch, decidedBy: 'SYSTEM', inputs: d.inputs });
        option = d.branch;
      } else return false; // OPERATOR_CHOICE waits for CHOOSE_ALTERNATIVE.
      markNotApplicable(tx, altId, String(option), e.frames);
      recordNodeEvent(tx, altId, 'START', e.frames, tx.clockUs);
      break;
    }
    case 'LOOP_TEST': {
      const existing = tx.s.decisions[`${node.source}@${ctx}`];
      if (!existing) return false; // waits for COMPLETE_LOOP_ITERATION
      option = existing.outcome;
      break;
    }
    case 'REP_SPLIT': {
      const repId = node.source;
      const rep = def.replicates.get(repId);
      const dkey = `${repId}@${ctx}`;
      const existing = tx.s.decisions[dkey];
      if (existing) option = Number(existing.outcome);
      else if (rep?.count.mode === 'EXPRESSION') {
        const env = def.analysis.envAt(repId, node);
        const check = def.expr.check(rep.count.expression, env, { role: 'CALCULATION' });
        const values = new Map<string, ExprValue>();
        const inputs = { points: [] as string[], derived: [] as string[] };
        let problem: string | undefined;
        for (const local of check.reads) {
          const id = def.analysis.expanded.scopes.get(repId)?.env.get(local) ?? local;
          const r = resolveAt(def, tx.s, id, e.frames);
          const v = r.ok ? toExprValue(r.resolved.value) : undefined;
          if (!r.ok || !v) {
            problem = r.ok ? `${id} cannot be read` : r.reason;
            break;
          }
          values.set(local, v);
          inputs.points.push(...r.resolved.points);
          inputs.derived.push(...r.resolved.derived);
        }
        const out = problem === undefined ? def.expr.evaluate(rep.count.expression, env, values, { role: 'CALCULATION' }) : undefined;
        const text = out?.ok === true && (out.value.kind === 'COUNT' || out.value.kind === 'DECIMAL') ? out.value.value : undefined;
        const n = text !== undefined && /^[0-9]+(\.0*)?$/.test(text) ? Number.parseInt(text, 10) : undefined;
        if (n === undefined || n < rep.count.min || n > rep.count.max) {
          const reason = problem ?? (out && !out.ok ? out.message : `the count expression gave ${text ?? 'no value'}, not a whole number within ${rep.count.min}..${rep.count.max}`);
          if (tx.s.pendingDecisionProblems[dkey] === undefined) {
            tx.s.pendingDecisionProblems[dkey] = tx.raise(engineDraft('REPLICATE_COUNT_INVALID', `${rep.name} (${repId}): ${reason}`, { blocks: 'DOWNSTREAM', until: 'DISPOSITION', deviationRequired: true }), { frames: [...e.frames], construct: repId }, { node: node.id, frames: e.frames });
          }
          return false;
        }
        recordDecision(tx, { key: dkey, kind: 'COUNT', construct: repId, frames: [...e.frames], outcome: String(n), decidedBy: 'SYSTEM', reason: `count expression ${rep.count.expression}`, inputs });
        option = n;
      } else return false; // RUNTIME waits for CHOOSE_REPLICATE_COUNT.
      break;
    }
    case 'SCOPE_END': {
      const stage = def.stages.get(node.source);
      if (stage) {
        const frame = tx.s.stages[stageFrameKey(stage.id, e.frames)];
        if (!frame?.signOff?.valid) {
          if (frame && !frame.awaitingSignOff) frame.awaitingSignOff = true;
          return false; // waits for SIGN_OFF_STAGE by the person responsible (IN-15)
        }
      }
      break;
    }
    default:
      break;
  }

  const result = def.game.fire(tx.s.marking, e, option);
  tx.s.marking = result.marking;
  afterFire(tx, node, e, option, result.exception !== undefined);
  return true;
}

function afterFire(tx: Tx, node: GraphNode, e: Enabled, option: string | number | undefined, exhausted: boolean): void {
  const def = tx.def;
  const at = tx.clockUs;
  switch (node.kind) {
    case 'SCOPE_START': {
      recordNodeEvent(tx, node.source, 'START', e.frames, at);
      if (def.stages.has(node.source)) {
        const key = stageFrameKey(node.source, e.frames);
        if (!tx.s.stages[key]) {
          const frame: StageFrameState = { key, stage: node.source, frames: [...e.frames], startedAt: tx.now, awaitingSignOff: false, invalidations: [] };
          tx.s.stages[key] = frame;
        }
      }
      break;
    }
    case 'SCOPE_END': {
      recordNodeEvent(tx, node.source, 'END', e.frames, at);
      flagEarlyAutomaticEvent(tx, node.source, 'END', e.frames, at);
      const frame = tx.s.stages[stageFrameKey(node.source, e.frames)];
      if (frame) {
        frame.awaitingSignOff = false;
        frame.endedAt ??= tx.now;
      }
      break;
    }
    case 'AND_SPLIT':
      recordNodeEvent(tx, node.source, 'START', e.frames, at);
      break;
    case 'AND_JOIN':
    case 'XOR_JOIN':
      recordNodeEvent(tx, node.source, 'END', e.frames, at);
      flagEarlyAutomaticEvent(tx, node.source, 'END', e.frames, at);
      break;
    case 'LOOP_ENTRY': {
      const consumed = e.consumes[0];
      const back = consumed ? def.gi.edge.get(consumed.edge)?.kind === 'LOOP_BACK' : false;
      if (!back) recordNodeEvent(tx, node.source, 'START', e.frames, at);
      break;
    }
    case 'LOOP_TEST': {
      if (option === 'EXIT' || option === 'EXHAUSTED') {
        const outer = e.frames.slice(0, -1);
        recordNodeEvent(tx, node.source, 'END', outer, at);
        raiseForEvaluationAtExit(tx, node.source, e.frames);
        if (exhausted) {
          const loop = def.loops.get(node.source);
          tx.raise(
            engineDraft('LOOP_EXHAUSTED', `${loop?.name ?? node.source} reached its maximum of ${loop?.maxIterations ?? '?'} iterations without meeting its exit condition (${loop?.exit.condition ?? ''}); QA must disposition it before the steps after it run`, {
              blocks: 'DOWNSTREAM',
              until: 'DISPOSITION',
              qaOnly: true,
              deviationRequired: true,
              releaseBlocking: true,
            }),
            { frames: [...e.frames], construct: node.source },
            { node: node.id, frames: outer },
          );
        }
      }
      break;
    }
    case 'REP_SPLIT': {
      recordNodeEvent(tx, node.source, 'START', e.frames, at);
      const rep = def.replicates.get(node.source);
      const n = typeof option === 'number' ? option : 1;
      const first = rep?.instances === 'SEQUENTIAL' ? 1 : n;
      for (let k = 1; k <= first; k++) createSubLot(tx, node.source, e.frames, k);
      break;
    }
    case 'REP_JOIN': {
      if (e.release) {
        const released = tx.s.marking.counts.get(`${ctxKey(e.frames)}|${node.source}|released`) ?? 1;
        createSubLot(tx, node.source, e.frames, released);
      } else {
        recordNodeEvent(tx, node.source, 'END', e.frames, at);
        flagEarlyAutomaticEvent(tx, node.source, 'END', e.frames, at);
      }
      break;
    }
    case 'XOR_SPLIT':
    case 'TASK':
    case 'HOLD':
    case 'START':
    case 'END':
      break;
  }
}

/** Fires every node that can fire, until nothing changes; then checks for execution completion. */
export function advance(tx: Tx): void {
  const st = tx.s.status;
  if (st === 'ON_HOLD' || st === 'ABORTED' || st === 'CANCELLED') return;
  for (let guard = 0; guard < 1_000_000; guard++) {
    let fired = false;
    for (const e of tx.def.game.enabled(tx.s.marking)) {
      if (tryFire(tx, e)) {
        fired = true;
        break;
      }
    }
    if (!fired) break;
  }
  checkCompletion(tx);
}

/** EXECUTION_COMPLETE (system): no token left, every step terminal and verified, every stage signed off (outline 5.2.2). */
export function checkCompletion(tx: Tx): void {
  if (tx.s.status !== 'IN_PROGRESS') return;
  if (tx.s.marking.tokens.size > 0) return;
  const steps = Object.values(tx.s.steps);
  if (steps.some((i) => i.status !== 'COMPLETED' && i.status !== 'NOT_APPLICABLE' && i.status !== 'SKIPPED')) return;
  if (steps.some((i) => i.reverification)) return;
  if (Object.values(tx.s.stages).some((f) => !f.signOff?.valid)) return;
  tx.s.status = 'EXECUTION_COMPLETE';
  tx.emit({ type: 'BATCH_STATUS_CHANGED', from: 'IN_PROGRESS', to: 'EXECUTION_COMPLETE', reason: 'every step is terminal and verified and every stage is signed off' });
}
