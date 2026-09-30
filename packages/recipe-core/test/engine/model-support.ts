/**
 * Model-based testing support: generated block-structured flows (every construct, with timers) and a
 * command generator that offers both legal and adversarial commands from the current state.
 */
import { Dec } from '@ebmr/expr';
import fc from 'fast-check';
import { checkMeaning, performMeaning } from '../../src/engine/actions.ts';
import type { Actor, BatchState, Command, DataValue } from '../../src/engine/types.ts';
import { RELEASING_DISPOSITIONS, type BatchDefinition } from '../../src/engine/definition.ts';
import { ctxKey } from '../../src/engine/tx.ts';
import type { FlowNode, MbrContent, Parameter, TimeConstraint } from '../../src/flow/model.ts';
import { endpoint, mbrWith, phase } from '../flow/support.ts';
import { nominalValue, OP1, OP2, param, PEOPLE, QA1, sig, substituteBatch, SUP1, SYS, VER1, VER2, type Run, type Scenario } from './support.ts';

export type Shape =
  | { t: 'phase'; timer: 0 | 1 | 2 }
  | { t: 'hold' }
  | { t: 'seq'; c: Shape[] }
  | { t: 'par'; c: Shape[] }
  | { t: 'alt'; c: Shape[]; empty: boolean }
  | { t: 'loop'; b: Shape; max: number; maxMinutes: number }
  | { t: 'rep'; b: Shape; min: number; extra: number; concurrent: boolean };

export const shapes = fc.letrec<{ node: Shape; phase: Shape; hold: Shape; seq: Shape; par: Shape; alt: Shape; loop: Shape; rep: Shape }>((tie) => ({
  node: fc.oneof({ maxDepth: 3, depthIdentifier: 'flow' }, tie('phase'), tie('phase'), tie('hold'), tie('seq'), tie('par'), tie('alt'), tie('loop'), tie('rep')),
  phase: fc.record({ timer: fc.constantFrom<0 | 1 | 2>(0, 0, 1, 2) }).map((r) => ({ t: 'phase' as const, timer: r.timer })),
  hold: fc.constant({ t: 'hold' as const }),
  seq: fc.array(tie('node'), { minLength: 1, maxLength: 3 }).map((c) => ({ t: 'seq' as const, c })),
  par: fc.array(tie('node'), { minLength: 2, maxLength: 3 }).map((c) => ({ t: 'par' as const, c })),
  alt: fc.record({ c: fc.array(tie('node'), { minLength: 1, maxLength: 3 }), empty: fc.boolean() }).map(({ c, empty }) => ({ t: 'alt' as const, c: c.length === 1 && !empty ? [...c, { t: 'phase' as const, timer: 0 as const }] : c, empty })),
  loop: fc.record({ b: tie('node'), max: fc.integer({ min: 1, max: 3 }), maxMinutes: fc.constantFrom(0, 90) }).map(({ b, max, maxMinutes }) => ({ t: 'loop' as const, b, max, maxMinutes })),
  rep: fc.record({ b: tie('node'), min: fc.integer({ min: 1, max: 2 }), extra: fc.integer({ min: 0, max: 1 }), concurrent: fc.boolean() }).map((r) => ({ t: 'rep' as const, ...r })),
}));

/**
 * A procedure: p0 records q (kg); the generated shape; pz computes dq = q + q. Phases with timer 1
 * carry a 2-10 min timer, timer 2 a 0-5 min maximum; loops may carry a maximum duration.
 */
export function buildFlow(shape: Shape): MbrContent {
  let n = 0;
  const next = (p: string): string => `${p}${++n}`;
  const parameters: MbrContent['parameters'] = [param('q', { capture: 'MANUAL', evidence: 'NONE', accuracyCheck: 'SECOND_PERSON' })];
  const timeConstraints: TimeConstraint[] = [];
  const make = (s: Shape): FlowNode => {
    switch (s.t) {
      case 'phase': {
        const id = next('p');
        if (s.timer > 0) {
          timeConstraints.push({
            id: `TC-${id}`,
            name: `Timer of ${id}`,
            kind: 'TIMER',
            from: { node: id, event: 'START' },
            to: { node: id, event: 'END' },
            ...(s.timer === 1 ? { min: { value: '2', unit: 'min' } } : {}),
            max: { value: s.timer === 1 ? '10' : '5', unit: 'min' },
            source: { kind: 'VALIDATION_REPORT', ref: 'VR' },
            breach: s.timer === 1 ? 'EXCEPTION' : 'EXCEPTION_AND_BLOCK',
            pauses: 'INCLUDED',
          });
        }
        return phase(id);
      }
      case 'hold':
        return { kind: 'holdPoint', id: next('h'), name: 'QA hold', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] };
      case 'seq':
        return { kind: 'sequence', id: next('s'), children: s.c.map(make) };
      case 'par':
        return { kind: 'parallel', id: next('par'), branches: s.c.map((c) => ({ id: next('b'), name: 'Branch', body: make(c) })) };
      case 'alt':
        return {
          kind: 'alternative',
          id: next('alt'),
          decision: { mode: 'OPERATOR_CHOICE', roles: ['PRODUCTION_SUPERVISOR'], reasonRequired: true },
          branches: [...s.c.map((c) => ({ id: next('b'), name: 'Branch', body: make(c) })), ...(s.empty ? [{ id: next('b'), name: 'No action' }] : [])],
        };
      case 'loop': {
        const id = next('loop');
        const ep = `ep_${id}`;
        parameters.push(endpoint(ep));
        return {
          kind: 'loop',
          id,
          name: 'Loop',
          maxIterations: s.max,
          ...(s.maxMinutes > 0 ? { maxDuration: { value: String(s.maxMinutes), unit: 'min' } } : {}),
          exit: { condition: `${ep} <= 1 [%]`, endpoint: ep },
          body: { kind: 'sequence', id: next('s'), children: [make(s.b), phase(next('p'), { records: [ep] })] },
        };
      }
      case 'rep':
        return { kind: 'replicate', id: next('rep'), name: 'Sub-lots', count: { mode: 'RUNTIME', min: s.min, max: s.min + s.extra, reasonRequired: true }, instances: s.concurrent ? 'CONCURRENT' : 'SEQUENTIAL', subLotPrefix: 'SL', body: make(s.b) };
    }
  };
  const body = make(shape);
  const root: FlowNode = { kind: 'sequence', id: 'wrap', children: [phase('p0', { records: ['q'] }), body, phase('pz', { block: { type: 'G-14', version: '1' }, computes: ['dq'] })] };
  return mbrWith(root, {
    parameters,
    timeConstraints,
    calculations: [{ id: 'dq', name: 'Double q', expression: 'q + q', output: { valueType: 'DECIMAL', unit: 'kg' }, criticality: 'CRITICAL', riskClass: 'HIGH' }],
  });
}

export type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'commandId'> : never) : never;

function pickPerson(roles: readonly string[], k: number): Actor {
  const holders = PEOPLE.filter((p) => p.roles.some((r) => roles.includes(r)));
  return holders.length > 0 ? (holders[k % holders.length] as Actor) : OP1;
}

/**
 * Commands offered in a state: every legal next action (one variant each), plus adversarial ones:
 * out-of-order starts, typed derived values, verification by an involved person, holds, exceptions.
 * `endpointValue` decides loop endpoints (true: exit value).
 */
export interface ModelData {
  /** Value that ends (true) or continues (false) the loop whose endpoint this is. */
  endpoint(item: string, exit: boolean): DataValue;
  /** A calculation id to try typing (INV-25). */
  derived: string;
  /** Realistic data and entries (the golden scenario of a fixture). */
  scenario?: Scenario;
}

export const GENERATED_DATA: ModelData = {
  endpoint: (_item, exit) => ({ kind: 'DECIMAL', value: exit ? '0.5' : '3.0', unit: '%' }),
  derived: 'dq',
};

/** A value just beyond the outermost limit of a parameter (to provoke limit exceptions), else the nominal value. */
export function breachValue(p: Parameter): DataValue {
  const outer = p.limits?.ranges[0];
  const nominal = nominalValue(p);
  if (!outer?.high || nominal.kind !== 'DECIMAL') return nominal;
  const digits = p.precision?.kind === 'DECIMALS' ? p.precision.digits : 3;
  return { kind: 'DECIMAL', value: Dec.parse(outer.high.value).plus(Dec.ONE).toFixed(digits, 'HALF_UP'), unit: nominal.unit };
}

export interface Candidates {
  /** Legal next actions that move the batch on. */
  progress: CommandInput[];
  /** Every candidate: progress plus adversarial and rare legal commands. */
  all: CommandInput[];
}

/**
 * Commands offered in a state: legal next actions (`progress`) and adversarial ones: out-of-order
 * starts, typed derived values, verification by an involved person, repeats, out-of-limit values,
 * holds, corrections, negative hold-point dispositions and invalid counts.
 */
export function candidateCommands(def: BatchDefinition, run: Run, k: number, exitLoops: boolean, data: ModelData = GENERATED_DATA): Candidates {
  const s: BatchState = run.state;
  const progress: CommandInput[] = [];
  const other: CommandInput[] = [];
  const person = (roles: readonly string[]): Actor => pickPerson(roles.length > 0 ? roles : ['PRODUCTION_OPERATOR'], k);
  for (const inst of Object.values(s.steps)) {
    const step = def.steps.get(inst.step);
    if (!step) continue;
    const f = inst.frames;
    if (step.node.kind === 'holdPoint') {
      if (inst.status === 'ENABLED' && !inst.disposition) {
        progress.push({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: inst.step, context: f, disposition: 'APPROVED', signature: sig('HOLD_POINT_RELEASED', QA1) });
        const neg = step.node.dispositions.find((x) => !RELEASING_DISPOSITIONS.includes(x));
        if (neg && k % 5 === 0) other.push({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: inst.step, context: f, disposition: neg, signature: sig('HOLD_POINT_NOT_RELEASED', QA1) });
      }
      continue;
    }
    const phase = step.node;
    if (inst.status === 'ENABLED') progress.push({ type: 'START_STEP', actor: step.systemPerforms ? SYS : person(step.performRoles), step: inst.step, context: f });
    if (inst.status === 'IN_PROGRESS') {
      let complete = true;
      for (const item of phase.records) {
        const p = def.analysis.parameters.get(item);
        if (!p || step.computedItems.has(item)) continue;
        const has = Object.values(s.points).some((x) => x.stepKey === inst.key && x.item === item && x.kind === 'VALUE' && x.status === 'VALID');
        const value: DataValue = def.loopEndpoints.has(item) ? data.endpoint(item, exitLoops) : k % 9 === 0 ? breachValue(p) : (data.scenario?.value?.(item, inst.step, f, run) ?? nominalValue(p));
        const auto = p.capture === 'AUTOMATION' && !phase.signatures.perform;
        const cmd: CommandInput = { type: 'RECORD_DATA', actor: auto ? SYS : person(step.performRoles), step: inst.step, context: f, item, value, source: auto ? { mode: 'AUTOMATION', system: 'PLC' } : p.capture === 'MANUAL' ? { mode: 'MANUAL' } : { mode: 'DEVICE', device: 'D' } };
        if (has) other.push(cmd);
        else {
          progress.push(cmd);
          complete = false;
        }
      }
      const recorded = new Set(Object.values(s.entries).filter((e) => e.stepKey === inst.key).map((e) => JSON.stringify({ ...e.data, kind: e.kind })));
      const nominal = data.scenario?.entries?.(inst.step, f, run) ?? step.block?.simulatorModel?.nominalEntries({ phase, config: step.config, mbr: def.mbr, frames: f, containers: Object.values(s.containers), target: (item) => inst.targets[item]?.value }) ?? [];
      const entryKinds = new Set(Object.values(s.entries).filter((e) => e.stepKey === inst.key).map((e) => e.kind));
      for (const e of nominal) {
        if (recorded.has(JSON.stringify(e))) continue;
        const cmd: CommandInput = { type: 'RECORD_ENTRY', actor: person(step.performRoles), step: inst.step, context: f, entry: substituteBatch(e, s.header.batchNumber) };
        if (entryKinds.has(e.kind) && nominal.length === 1) other.push(cmd);
        else {
          progress.push(cmd);
          complete = false;
        }
      }
      const signer = inst.dataEnterers.find((x) => !inst.performedSigners.includes(x)) ?? inst.performers[0] ?? person(step.performRoles).id;
      const who = PEOPLE.find((p) => p.id === signer) ?? OP1;
      (complete ? progress : other).push({ type: 'SIGN_PERFORMED', actor: who, step: inst.step, context: f, signature: sig(performMeaning(def, inst.step), who) });
      other.push({ type: 'RECORD_DATA', actor: who, step: inst.step, context: f, item: data.derived, value: { kind: 'DECIMAL', value: '2.00', unit: 'kg' }, source: { mode: 'MANUAL' } });
    }
    if (inst.status === 'AWAITING_VERIFICATION') {
      const involved = [...inst.performers, ...inst.dataEnterers, ...inst.correctors];
      const verifier = [VER1, VER2].find((v) => !involved.includes(v.id)) ?? VER1;
      const checker = PEOPLE.find((p) => !involved.includes(p.id) && p.roles.includes(step.checkRole ?? 'VERIFIER')) ?? verifier;
      const meaning = checkMeaning(def, inst, inst.step);
      progress.push({ type: 'VERIFY', actor: checker, step: inst.step, context: f, signature: sig(meaning, checker) });
      // Adversarial: an involved person verifies (with the checker role when one of them holds it: INV-03).
      const cheater = PEOPLE.find((p) => involved.includes(p.id) && p.roles.includes(step.checkRole ?? 'VERIFIER'));
      const self = PEOPLE.find((p) => p.id === inst.performers[0]) ?? OP1;
      other.push({ type: 'VERIFY', actor: cheater ?? self, step: inst.step, context: f, signature: sig(meaning, cheater ?? self) });
      if (cheater) progress.push({ type: 'VERIFY', actor: cheater, step: inst.step, context: f, signature: sig(meaning, cheater) });
    }
  }
  for (const e of def.game.enabled(s.marking)) {
    const node = def.gi.node.get(e.node);
    if (!node) continue;
    if (node.kind === 'XOR_SPLIT' && !s.decisions[`${node.source}@${ctxKey(e.frames)}`]) {
      const alt = def.alternatives.get(node.source);
      const branch = alt?.branches[k % (alt.branches.length || 1)]?.id ?? '';
      progress.push({ type: 'CHOOSE_ALTERNATIVE', actor: SUP1, construct: node.source, context: e.frames, branch, reason: 'model choice' });
    }
    if (node.kind === 'REP_SPLIT' && !s.decisions[`${node.source}@${ctxKey(e.frames)}`]) {
      const rep = def.replicates.get(node.source);
      if (rep) {
        progress.push({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: rep.id, context: e.frames, count: rep.count.min + (k % (rep.count.max - rep.count.min + 1)), reason: 'model count' });
        other.push({ type: 'CHOOSE_REPLICATE_COUNT', actor: SUP1, construct: rep.id, context: e.frames, count: rep.count.max + 1, reason: 'too many' });
      }
    }
    if (node.kind === 'LOOP_TEST' && !s.decisions[`${node.source}@${ctxKey(e.frames)}`]) progress.push({ type: 'COMPLETE_LOOP_ITERATION', actor: OP2, construct: node.source, context: e.frames });
  }
  for (const f of Object.values(s.stages)) {
    if (!f.awaitingSignOff) continue;
    const who = pickPerson([def.stages.get(f.stage)?.responsibleRole ?? 'HEAD_OF_PRODUCTION'], k);
    progress.push({ type: 'SIGN_OFF_STAGE', actor: who, stage: f.stage, context: f.frames, signature: sig('STAGE_SIGNED_OFF', who) });
  }
  for (const e of Object.values(s.exceptions)) {
    if (e.status !== 'OPEN') continue;
    if (e.deviationRequired && !e.deviation) progress.push({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: e.id, deviationRef: `DEV-${e.id}` });
    const who = e.qaOnly ? QA1 : k % 2 === 0 ? SUP1 : QA1;
    progress.push({ type: 'DISPOSITION_EXCEPTION', actor: who, exception: e.id, outcome: e.deviationRequired ? 'DEVIATION_RAISED' : 'NO_IMPACT', justification: 'model disposition', signature: sig('EXCEPTION_DISPOSITIONED', who) });
  }
  for (const h of Object.values(s.holds)) if (!h.released) progress.push({ type: 'RELEASE_HOLD', actor: QA1, hold: h.id, reason: 'model release' });
  const last = [...def.steps.values()].filter((x) => x.kind === 'PHASE').pop();
  if (last) other.push({ type: 'START_STEP', actor: OP1, step: last.id });
  other.push({ type: 'HOLD_BATCH', actor: SUP1, holdType: 'SUPERVISOR', reason: 'model hold' });
  other.push({ type: 'RAISE_EXCEPTION', actor: OP2, description: 'model observation', severity: k % 2 === 0 ? 'ALERT' : 'ACTION' });
  const manual = Object.values(s.points).find((p) => p.kind === 'VALUE' && p.status === 'VALID' && p.source.mode === 'MANUAL');
  if (manual) other.push({ type: 'CORRECT_ENTRY', actor: OP2, point: manual.id, value: { kind: 'DECIMAL', value: '1.25', unit: 'kg' }, reason: 'model correction', signature: sig('CORRECTED', OP2), approval: { approver: SUP1, signature: sig('CORRECTION_APPROVED', SUP1) } });
  return { progress, all: [...progress, ...other] };
}
