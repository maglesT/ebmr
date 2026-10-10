/**
 * Test support for module B1 (execution engine and generic blocks): persons and roles, TEST STAND-INS
 * for the block versions that arrive in Phase 3 (G-06, G-21; never part of src), fixture definitions,
 * and a driver that issues commands, keeps the clock and can run a batch on autopilot.
 *
 * G-09@1 and G-10@1 are real SANDBOX_ONLY block versions (module C3), so every definition here is made
 * for the sandbox installation (`installation: 'SANDBOX'`); a GMP definition refuses them.
 */
import { Dec } from '@ebmr/expr';
import type { BlockVersion } from '../../src/blocks/contract.ts';
import { genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import type { BlockRegistry } from '../../src/blocks/registry.ts';
import { checkMeaning, performMeaning } from '../../src/engine/actions.ts';
import { defineBatch, type BatchDefinition, type DefineOptions } from '../../src/engine/definition.ts';
import { issue, step } from '../../src/engine/engine.ts';
import { checkInvariants } from '../../src/engine/invariants.ts';
import { ctxKey, stepKey } from '../../src/engine/tx.ts';
import type { Actor, BatchState, Command, DataSource, DataValue, EngineEvent, EnginePolicy, ExceptionRecord, IssueRequest, Refusal, SignatureRef, StepInstance, StepResult } from '../../src/engine/types.ts';
import { effectivePoint } from '../../src/engine/values.ts';
import { RELEASING_DISPOSITIONS } from '../../src/engine/definition.ts';
import { compareDecimal, midpointDecimal } from '../../src/flow/decimal.ts';
import type { MbrContent, Parameter } from '../../src/flow/model.ts';
import type { Frame } from '../../src/flow/tokens.ts';
import { expr, loadFixture, type FixtureName } from '../flow/support.ts';

export { expr };

// ---------------------------------------------------------------------------------------------
// Persons

const person = (id: string, roles: string[]): Actor => ({ id, kind: 'PERSON', roles });
export const OP1 = person('OP1', ['PRODUCTION_OPERATOR', 'OPERATOR']);
export const OP2 = person('OP2', ['PRODUCTION_OPERATOR', 'OPERATOR']);
export const VER1 = person('VER1', ['PRODUCTION_VERIFIER', 'VERIFIER']);
export const VER2 = person('VER2', ['PRODUCTION_VERIFIER', 'VERIFIER']);
export const VER3 = person('VER3', ['PRODUCTION_VERIFIER', 'VERIFIER']);
export const SUP1 = person('SUP1', ['PRODUCTION_SUPERVISOR', 'PACKAGING_SUPERVISOR']);
export const HEAD1 = person('HEAD1', ['HEAD_OF_PRODUCTION']);
export const QA1 = person('QA1', ['QA']);
export const QA2 = person('QA2', ['QA']);
export const SYS: Actor = { id: 'SYS-MES', kind: 'SYSTEM', roles: [] };
/** Holds performer and checker roles: may do either on a step, never both (INV-03). */
export const DUAL1 = person('DUAL1', ['PRODUCTION_OPERATOR', 'OPERATOR', 'PRODUCTION_VERIFIER', 'VERIFIER']);
export const PEOPLE: readonly Actor[] = [OP1, OP2, VER1, VER2, VER3, SUP1, HEAD1, QA1, QA2, DUAL1];

// ---------------------------------------------------------------------------------------------
// TEST STAND-INS for block versions that arrive with Phase 3 persistence: none any more. G-06 (slice 3a) and G-21
// (slice 4a) are real versions now, as are G-09 and G-10.

/** G-06 has its real version since Phase 3 slice 3a (blocks/generic/automated.ts), G-21 since slice 4a (printed.ts). */
export const PHASE3_STAND_INS: readonly BlockVersion[] = [];

export function testRegistry(): BlockRegistry {
  return genericBlockRegistry().extend(...PHASE3_STAND_INS);
}

export const FIXTURE_JUSTIFICATIONS = [
  { key: 'G07-TOLERANCE-MISSING@p-disp-api', text: 'Fixture predates the G-07 tolerance option; TB-01 (Phase 3) carries the potency-adjusted dispensing tolerance', by: 'TEST' },
];

export function fixtureDefinition(name: FixtureName, policy: Partial<EnginePolicy> = {}): BatchDefinition {
  return defineBatch(loadFixture(name), { registry: testRegistry(), expressions: expr, policy, justifications: FIXTURE_JUSTIFICATIONS, installation: 'SANDBOX' });
}

export function define(mbr: MbrContent, options: Partial<DefineOptions> = {}): BatchDefinition {
  return defineBatch(mbr, { registry: testRegistry(), expressions: expr, installation: 'SANDBOX', ...options });
}

/** 2026-09-28T08:00:00Z in epoch microseconds. */
export const T0 = BigInt(Date.UTC(2026, 8, 28, 8, 0, 0)) * 1000n;
export const MIN = 60_000_000n;

export const FIXTURE_INPUTS: Record<FixtureName, IssueRequest['inputs']> = {
  'tablet-granulation-compression': {
    labelClaim: { value: { kind: 'DECIMAL', value: '40', unit: 'mg' }, source: 'registration REG-ATV v3' },
    batchSizeTablets: { value: { kind: 'COUNT', value: '200000' }, source: 'batch header' },
    mwSalt: { value: { kind: 'DECIMAL', value: '1155.36', unit: 'g/mol' }, source: 'material master MAT-ATV' },
    mwBase: { value: { kind: 'DECIMAL', value: '558.64', unit: 'g/mol' }, source: 'material master MAT-ATV' },
    excipientStd: { value: { kind: 'DECIMAL', value: '43.260', unit: 'kg' }, source: 'registration REG-ATV v3' },
    targetWeight: { value: { kind: 'DECIMAL', value: '250.0', unit: 'mg' }, source: 'registration REG-ATV v3' },
  },
  'tablet-blister-packaging': {
    avgTabletWeight: { value: { kind: 'DECIMAL', value: '257.5', unit: 'mg' }, source: 'bulk lot B-1001 IPC' },
    tabletsPerBlister: { value: { kind: 'COUNT', value: '10' }, source: 'material master MAT-BULK' },
  },
};

// ---------------------------------------------------------------------------------------------
// Driver

let signatureSeq = 0;
export function sig(meaning: string, signer: Actor | string): SignatureRef {
  signatureSeq += 1;
  return { id: `SIG-${signatureSeq}`, meaning, signer: typeof signer === 'string' ? signer : signer.id };
}

type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'commandId'> & { commandId?: string } : never) : never;

export interface RunOptions {
  /** Check every invariant after every command (default true). */
  checkInvariants?: boolean;
}

export class Run {
  events: EngineEvent[] = [];
  nowUs: bigint;
  private seq = 0;
  readonly log: { command: Command; result: StepResult; nowUs: bigint }[] = [];

  constructor(
    readonly def: BatchDefinition,
    public state: BatchState,
    nowUs: bigint,
    readonly options: RunOptions = {},
  ) {
    this.nowUs = nowUs;
  }

  static issue(def: BatchDefinition, overrides: Partial<IssueRequest> = {}, at: bigint = T0, options: RunOptions = {}): Run {
    const mbr = def.mbr;
    const req: IssueRequest = {
      batchId: 'BATCH-1',
      batchNumber: 'B0001',
      batchSize: mbr.header.batchSizes[0]?.id ?? '',
      marketSet: [...mbr.header.marketSet],
      inputs: {},
      issuedBy: SUP1,
      ...overrides,
    };
    const r = issue(def, req, { nowUs: at });
    const run = new Run(def, r.state, at, options);
    run.events.push(...r.events);
    return run;
  }

  advance(us: bigint): this {
    this.nowUs += us;
    return this;
  }

  minutes(n: number): this {
    return this.advance(BigInt(n) * MIN);
  }

  exec(input: CommandInput): StepResult {
    this.seq += 1;
    const command = { ...input, commandId: input.commandId ?? `CMD-${this.seq}` } as Command;
    const result = step(this.def, this.state, command, { nowUs: this.nowUs });
    this.log.push({ command, result, nowUs: this.nowUs });
    this.state = result.state;
    this.events.push(...result.events);
    if (this.options.checkInvariants !== false) {
      const v = checkInvariants(this.def, this.state);
      if (v.length > 0) throw new Error(`invariant violated after ${command.type}: ${v.map((x) => `[${x.invariant}] ${x.message}`).join('; ')}`);
    }
    return result;
  }

  ok(input: CommandInput): StepResult {
    const r = this.exec(input);
    if (!r.accepted) throw new Error(`${input.type} was refused: ${r.refusal?.message ?? (r.duplicate ? 'duplicate' : '?')}`);
    return r;
  }

  refused(input: CommandInput, code?: string): Refusal {
    const r = this.exec(input);
    if (r.accepted || !r.refusal) throw new Error(`${input.type} was accepted but should have been refused${code ? ` with ${code}` : ''}`);
    if (code !== undefined && r.refusal.code !== code) throw new Error(`${input.type} was refused with ${r.refusal.code} (${r.refusal.message}), expected ${code}`);
    return r.refusal;
  }

  inst(stepId: string, frames: readonly Frame[] = []): StepInstance | undefined {
    return this.state.steps[stepKey(stepId, frames)];
  }

  status(stepId: string, frames: readonly Frame[] = []): string | undefined {
    return this.inst(stepId, frames)?.status;
  }

  start(stepId: string, frames: readonly Frame[] = [], who: Actor = OP1, blockData?: Record<string, unknown>): StepResult {
    return this.ok({ type: 'START_STEP', actor: who, step: stepId, context: frames, ...(blockData ? { blockData } : {}) });
  }

  record(stepId: string, item: string, value: DataValue, opts: { frames?: readonly Frame[]; who?: Actor; source?: DataSource } = {}): StepResult {
    return this.ok({ type: 'RECORD_DATA', actor: opts.who ?? OP1, step: stepId, context: opts.frames ?? [], item, value, source: opts.source ?? { mode: 'DEVICE', device: 'DEV-1' } });
  }

  entry(stepId: string, entry: Record<string, unknown> & { kind: string }, frames: readonly Frame[] = [], who: Actor = OP1): StepResult {
    return this.ok({ type: 'RECORD_ENTRY', actor: who, step: stepId, context: frames, entry: substituteBatch(entry, this.state.header.batchNumber) });
  }

  /** PERFORMED by `who`, signed with the step's own meaning (the block's, else PERFORMED) unless `meaning` is given. */
  perform(stepId: string, frames: readonly Frame[] = [], who: Actor = OP1, meaning = performMeaning(this.def, stepId)): StepResult {
    return this.ok({ type: 'SIGN_PERFORMED', actor: who, step: stepId, context: frames, ...(who.kind === 'PERSON' ? { signature: sig(meaning, who) } : {}) });
  }

  /** The check by `who`, signed with the meaning the step requires now (actions.ts checkMeaning) unless `meaning` is given. */
  verify(stepId: string, frames: readonly Frame[] = [], who: Actor = VER1, meaning = checkMeaning(this.def, this.inst(stepId, frames), stepId, this.state, this.nowUs)): StepResult {
    return this.ok({ type: 'VERIFY', actor: who, step: stepId, context: frames, signature: sig(meaning, who) });
  }

  exceptions(type?: string): BatchState['exceptions'][string][] {
    return Object.values(this.state.exceptions).filter((e) => type === undefined || e.type === type);
  }

  value(item: string, stepId: string, frames: readonly Frame[] = []): string | undefined {
    const key = stepKey(stepId, frames);
    const d = Object.values(this.state.derived).find((x) => x.stepKey === key && x.calculation === item && x.status === 'CURRENT');
    const v = d?.value ?? effectivePoint(this.state, key, item)?.value;
    if (!v) return undefined;
    return v.kind === 'DECIMAL' || v.kind === 'COUNT' || v.kind === 'CATEGORY' || v.kind === 'TEXT' ? v.value : v.kind === 'SERIES' ? v.values.join(',') : String(v.kind === 'BOOLEAN' ? v.value : '');
  }
}

export function substituteBatch<T extends Record<string, unknown>>(entry: T, batch: string): T {
  return JSON.parse(JSON.stringify(entry).replaceAll('"$BATCH"', JSON.stringify(batch))) as T;
}

// ---------------------------------------------------------------------------------------------
// Autopilot: runs a batch with nominal data, choosing actors by role and honouring a scenario.

export interface Scenario {
  /** Values to record, by item (and step instance): return undefined for the nominal value. */
  value?: (item: string, stepId: string, frames: readonly Frame[], run: Run) => DataValue | undefined;
  /** Block entries of a step instance: return undefined for the block's nominal entries. */
  entries?: (stepId: string, frames: readonly Frame[], run: Run) => (Record<string, unknown> & { kind: string })[] | undefined;
  /** Branch for an operator choice. */
  branch?: (construct: string, frames: readonly Frame[]) => string | undefined;
  /** Sub-lot count for a run-time replicate section. */
  count?: (construct: string, frames: readonly Frame[]) => number | undefined;
  /** Minutes a step takes between start and PERFORMED (default 1). */
  minutes?: (stepId: string, frames: readonly Frame[]) => number;
  /** Hold point disposition (default the first releasing one). */
  disposition?: (stepId: string, frames: readonly Frame[]) => string | undefined;
  /** Called before each step instance is executed (to inject extra commands). */
  before?: (inst: StepInstance, run: Run) => void;
  /**
   * Open exceptions QA decides so the run goes on (true): a deviation is linked where one is required,
   * then QA dispositions it. By default none: a blocking exception stops the run (STUCK).
   */
  qaDecides?: (e: ExceptionRecord) => boolean;
}

export function actorWith(roles: readonly string[], exclude: ReadonlySet<string> = new Set()): Actor {
  const a = PEOPLE.find((p) => !exclude.has(p.id) && p.roles.some((r) => roles.includes(r)));
  if (!a) throw new Error(`no test person holds one of ${roles.join(', ')} outside ${[...exclude].join(', ')}`);
  return a;
}

/** A value inside the innermost limit range (or the target), at the parameter's precision. */
export function nominalValue(p: Parameter): DataValue {
  const single = (): string => {
    const ranges = p.limits?.ranges ?? [];
    const inner = ranges.find((r) => r.tier === 'ALERT') ?? ranges.find((r) => r.tier === 'INTERNAL_ACTION') ?? ranges[0];
    let v = p.target ?? '1';
    if (inner?.low && inner.high) v = midpointDecimal(inner.low.value, inner.high.value);
    else if (inner?.low) v = inner.low.value;
    else if (inner?.high) v = inner.high.value;
    const digits = p.precision?.kind === 'DECIMALS' ? p.precision.digits : 3;
    return Dec.parse(v).toFixed(digits, 'HALF_UP');
  };
  const readings = p.readings ?? 1;
  if (readings > 1) return { kind: 'SERIES', values: Array.from({ length: readings }, () => single()), unit: p.unit ?? '1' };
  switch (p.valueType) {
    case 'DECIMAL':
      return { kind: 'DECIMAL', value: single(), unit: p.unit ?? '1' };
    case 'COUNT':
      return { kind: 'COUNT', value: '1' };
    case 'BOOLEAN':
      return { kind: 'BOOLEAN', value: true };
    case 'CATEGORY': {
      const c = p.categories ?? [];
      return { kind: 'CATEGORY', value: ['PASS', 'CONFIRMED', 'YES'].find((x) => c.includes(x)) ?? c[0] ?? '' };
    }
    case 'TEXT':
      return { kind: 'TEXT', value: 'observed' };
    case 'INSTANT':
      return { kind: 'INSTANT', us: T0 };
  }
}

function sourceFor(p: Parameter): { actorSystem: boolean; source: DataSource } {
  switch (p.capture) {
    case 'AUTOMATION':
      return { actorSystem: true, source: { mode: 'AUTOMATION', system: 'PLC-1' } };
    case 'DEVICE':
      return { actorSystem: false, source: { mode: 'DEVICE', device: 'DEV-1' } };
    case 'SCAN':
      return { actorSystem: false, source: { mode: 'SCAN', code: 'SCAN-1' } };
    case 'LIMS':
      return { actorSystem: false, source: { mode: 'LIMS', resultRef: 'LIMS-1' } };
    default:
      return { actorSystem: false, source: p.evidence === 'PHOTO' || p.evidence === 'PRINTOUT' ? { mode: 'MANUAL', evidence: { kind: p.evidence, sha256: 'a'.repeat(64) } } : { mode: 'MANUAL' } };
  }
}

/** The autopilot cannot go on without a person's decision (a blocking exception, a hold). */
export class Stuck extends Error {}

function stuckOr(refusal: Refusal | undefined): never {
  if (refusal && (refusal.code === 'ENG-BLOCKED' || refusal.code === 'ENG-BATCH-ON-HOLD' || refusal.code === 'ENG-HOLD-OPEN-EXCEPTIONS')) throw new Stuck(refusal.message);
  throw new Error(`refused: ${refusal?.message ?? '?'}`);
}

/** Executes one enabled phase instance nominally: start, data, entries, PERFORMED, check. */
export function executePhase(run: Run, inst: StepInstance, scenario: Scenario = {}): void {
  const def = run.def;
  const step = def.steps.get(inst.step);
  if (!step || step.node.kind !== 'phase') throw new Error(`${inst.step} is not a phase`);
  const phase = step.node;
  scenario.before?.(inst, run);
  const performer = step.systemPerforms ? SYS : actorWith(step.performRoles);
  const starter = performer.kind === 'SYSTEM' && !phase.signatures.perform ? SYS : performer;
  const started = run.exec({ type: 'START_STEP', actor: starter, step: inst.step, context: inst.frames });
  if (!started.accepted) stuckOr(started.refusal);
  run.minutes(scenario.minutes?.(inst.step, inst.frames) ?? 1);
  for (const item of phase.records) {
    if (step.computedItems.has(item)) continue;
    const p = def.analysis.parameters.get(item);
    if (!p) continue;
    const { actorSystem, source } = sourceFor(p);
    const value = scenario.value?.(item, inst.step, inst.frames, run) ?? nominalValue(p);
    const who = actorSystem && !phase.signatures.perform ? SYS : performer.kind === 'SYSTEM' ? actorWith(step.performRoles.length > 0 ? step.performRoles : ['PRODUCTION_OPERATOR']) : performer;
    run.record(inst.step, item, value, { frames: inst.frames, who, source: who.kind === 'SYSTEM' ? source : source.mode === 'AUTOMATION' ? { mode: 'DEVICE', device: 'PLC-HMI' } : source });
  }
  const current = run.inst(inst.step, inst.frames) as StepInstance;
  const entries =
    scenario.entries?.(inst.step, inst.frames, run) ??
    step.block?.simulatorModel?.nominalEntries({ phase, config: step.config, mbr: def.mbr, frames: inst.frames, containers: Object.values(run.state.containers), target: (item) => current.targets[item]?.value }) ??
    [];
  for (const e of entries) run.entry(inst.step, e, inst.frames, performer.kind === 'SYSTEM' ? actorWith(['PRODUCTION_OPERATOR']) : performer);
  const after = run.inst(inst.step, inst.frames) as StepInstance;
  const signers = after.dataEnterers.length > 0 ? after.dataEnterers.map((id) => PEOPLE.find((p) => p.id === id) as Actor) : [performer.kind === 'SYSTEM' && !step.systemPerforms ? actorWith(step.performRoles) : performer];
  for (const who of signers) {
    const meaning = performMeaning(def, inst.step);
    const r = run.exec({ type: 'SIGN_PERFORMED', actor: who, step: inst.step, context: inst.frames, ...(who.kind === 'PERSON' ? { signature: sig(meaning, who) } : {}) });
    if (!r.accepted) stuckOr(r.refusal);
  }
  const done = run.inst(inst.step, inst.frames) as StepInstance;
  if (done.status === 'AWAITING_VERIFICATION') {
    const exclude = new Set([...done.performers, ...done.dataEnterers, ...done.correctors, ...done.performedSigners]);
    const verifier = actorWith(step.checkRole !== undefined ? [step.checkRole] : def.policy.fallbackVerifierRoles, exclude);
    const r = run.exec({ type: 'VERIFY', actor: verifier, step: inst.step, context: inst.frames, signature: sig(checkMeaning(def, done, inst.step, run.state, run.nowUs), verifier) });
    if (!r.accepted) stuckOr(r.refusal);
  }
}

/** Runs the batch until it completes or nothing more can be done; returns the reason it stopped. */
export function autopilot(run: Run, scenario: Scenario = {}, maxActions = 5_000): 'COMPLETE' | 'STUCK' {
  const def = run.def;
  for (let n = 0; n < maxActions; n++) {
    if (run.state.status === 'EXECUTION_COMPLETE') return 'COMPLETE';
    // Exceptions the scenario has QA decide, as soon as they are raised.
    const decided = scenario.qaDecides ? Object.values(run.state.exceptions).find((e) => e.status === 'OPEN' && scenario.qaDecides?.(e)) : undefined;
    if (decided) {
      const qa = actorWith(def.policy.qaRoles);
      if (decided.deviationRequired && !decided.deviation) run.ok({ type: 'ATTACH_DEVIATION', actor: qa, exception: decided.id, deviationRef: `DEV-${decided.id}` });
      run.ok({ type: 'DISPOSITION_EXCEPTION', actor: qa, exception: decided.id, outcome: decided.deviationRequired ? 'DEVIATION_RAISED' : 'NO_IMPACT', justification: 'scenario decision', signature: sig('EXCEPTION_DISPOSITIONED', qa) });
      continue;
    }
    // Stage sign-offs.
    const frame = Object.values(run.state.stages).find((f) => f.awaitingSignOff);
    if (frame) {
      const stage = def.stages.get(frame.stage);
      const who = actorWith([stage?.responsibleRole ?? 'HEAD_OF_PRODUCTION']);
      run.ok({ type: 'SIGN_OFF_STAGE', actor: who, stage: frame.stage, context: frame.frames, signature: sig('STAGE_SIGNED_OFF', who) });
      continue;
    }
    // Decisions waiting for a person or a loop iteration end.
    let acted = false;
    for (const e of def.game.enabled(run.state.marking)) {
      const node = def.gi.node.get(e.node);
      if (!node) continue;
      if (node.kind === 'XOR_SPLIT') {
        const alt = def.alternatives.get(node.source);
        if (alt?.decision.mode !== 'OPERATOR_CHOICE' || run.state.decisions[`${alt.id}@${ctxKey(e.frames)}`]) continue;
        const branch = scenario.branch?.(alt.id, e.frames) ?? alt.branches[0]?.id ?? '';
        const who = actorWith(alt.decision.roles);
        run.ok({ type: 'CHOOSE_ALTERNATIVE', actor: who, construct: alt.id, context: e.frames, branch, reason: 'scenario choice' });
        acted = true;
        break;
      }
      if (node.kind === 'REP_SPLIT') {
        const rep = def.replicates.get(node.source);
        if (rep?.count.mode !== 'RUNTIME' || run.state.decisions[`${rep.id}@${ctxKey(e.frames)}`]) continue;
        const count = scenario.count?.(rep.id, e.frames) ?? rep.count.min;
        run.ok({ type: 'CHOOSE_REPLICATE_COUNT', actor: actorWith(def.policy.replicateCountRoles), construct: rep.id, context: e.frames, count, reason: 'scenario count' });
        acted = true;
        break;
      }
      if (node.kind === 'LOOP_TEST' && !run.state.decisions[`${node.source}@${ctxKey(e.frames)}`]) {
        run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: node.source, context: e.frames });
        acted = true;
        break;
      }
    }
    if (acted) continue;
    const enabled = Object.values(run.state.steps)
      .filter((i) => i.status === 'ENABLED' && !i.disposition)
      .sort((a, b) => (a.enabledSeq ?? 0) - (b.enabledSeq ?? 0));
    const next = enabled[0];
    if (!next) {
      const awaiting = Object.values(run.state.steps).find((i) => i.status === 'AWAITING_VERIFICATION');
      if (awaiting) {
        const stepDef = def.steps.get(awaiting.step);
        const exclude = new Set([...awaiting.performers, ...awaiting.dataEnterers, ...awaiting.correctors, ...awaiting.performedSigners]);
        const who = actorWith(stepDef?.checkRole !== undefined ? [stepDef.checkRole] : def.policy.fallbackVerifierRoles, exclude);
        run.verify(awaiting.step, awaiting.frames, who, checkMeaning(def, awaiting, awaiting.step, run.state, run.nowUs));
        continue;
      }
      return 'STUCK';
    }
    if (next.kind === 'HOLD') {
      const hold = def.steps.get(next.step)?.node;
      if (hold?.kind !== 'holdPoint') return 'STUCK';
      const disposition = scenario.disposition?.(next.step, next.frames) ?? hold.dispositions.find((d) => RELEASING_DISPOSITIONS.includes(d)) ?? '';
      const who = actorWith([hold.role]);
      const positive = RELEASING_DISPOSITIONS.includes(disposition);
      const r = run.exec({ type: 'DISPOSITION_HOLD_POINT', actor: who, step: next.step, context: next.frames, disposition, signature: sig(positive ? 'HOLD_POINT_RELEASED' : 'HOLD_POINT_NOT_RELEASED', who) });
      if (!r.accepted) {
        if (r.refusal?.code === 'ENG-HOLD-OPEN-EXCEPTIONS' || r.refusal?.code === 'ENG-BATCH-ON-HOLD') return 'STUCK';
        stuckOr(r.refusal);
      }
      if (!positive) return 'STUCK';
      continue;
    }
    try {
      executePhase(run, next, scenario);
    } catch (e) {
      if (e instanceof Stuck) return 'STUCK';
      throw e;
    }
  }
  return 'STUCK';
}

/** Order-independent text of the exceptions of a run: "TYPE@stepKey" sorted. */
export function exceptionList(run: Run): string[] {
  return run.exceptions().map((e) => `${e.type}@${e.source.stepKey ?? e.source.construct ?? e.source.constraint ?? '-'}`).sort();
}

export function decimalEq(a: string | undefined, b: string): boolean {
  return a !== undefined && compareDecimal(a, b) === 0;
}

// ---------------------------------------------------------------------------------------------
// Fixture scenarios: the golden data of the fixtures' golden cases, recorded through the engine.

const dec = (value: string, unit: string): DataValue => ({ kind: 'DECIMAL', value, unit });
const lot = (id: string, material: string): Record<string, unknown> => ({ id, material, status: 'RELEASED', identityTested: true });
const sub = (frames: readonly Frame[]): number => frames.find((f) => f.construct === 'R-SUBLOT')?.index ?? 0;
const iteration = (frames: readonly Frame[]): number => frames.find((f) => f.construct === 'L-DRY')?.index ?? 0;

export const TABLET_WEIGHTS = ['249.8', '251.2', '250.4', '248.9', '252.0', '250.1', '249.5', '251.7', '250.9', '248.6', '250.3', '251.1', '249.2', '250.8', '249.9', '251.5', '250.6', '249.4', '250.2', '250.7'];

/** LOD per sub-lot and drying iteration: sub-lot 1 needs two iterations; sub-lot 2 exits at once, at an alert value. */
export const LOD_READINGS: Record<number, Record<number, string>> = { 1: { 1: '5.20', 2: '3.10' }, 2: { 1: '3.45' } };

export const GRANULATION_SCENARIO: Scenario = {
  count: () => 2,
  branch: (construct, frames) => (construct === 'ALT-IPA' ? (sub(frames) === 2 ? 'b-extra-ipa' : 'b-no-ipa') : undefined),
  minutes: (stepId) => ({ 'p-drymix': 12, 'p-wetmass': 3, 'p-drycycle': 30, 'p-lube': 4, 'p-binder-add': 3 })[stepId] ?? 2,
  value: (item, _step, frames) => {
    switch (item) {
      case 'apiAssay':
        return dec('99.2', '%');
      case 'apiWater':
        return dec('4.6', '%');
      case 'kitCharged':
        return dec(sub(frames) === 1 ? '25.60' : '25.45', 'kg');
      case 'extraIpa':
        return dec('0.50', 'kg');
      case 'lod':
        return dec(LOD_READINGS[sub(frames)]?.[iteration(frames)] ?? '3.00', '%');
      case 'egCharged':
        return dec('1.550', 'kg');
      case 'blendCharged':
        return dec('51.00', 'kg');
      case 'tabletWeight':
        return { kind: 'SERIES', values: TABLET_WEIGHTS, unit: 'mg' };
      case 'hardness':
        return dec('90', 'N');
      case 'rejectsNet':
        return dec('0.350', 'kg');
      default:
        return undefined;
    }
  },
  entries: (stepId, frames) => {
    const weigh = (container: string, bomLine: string, material: string, gross: string, tare: string, item: string): Record<string, unknown> & { kind: string } => ({
      kind: 'CONTAINER_WEIGHING',
      item,
      bomLine,
      container,
      lot: lot(`AR-${bomLine}`, material),
      gross,
      tare,
      unit: 'kg',
      balance: 'BAL-07',
      source: 'DEVICE',
    });
    const out = (intermediate: string, gross: string, tare: string, container?: string): Record<string, unknown> & { kind: string } => ({
      kind: 'OUTPUT_CONTAINER',
      intermediate,
      ...(container ? { container } : {}),
      gross,
      tare,
      unit: 'kg',
      balance: 'BAL-02',
      source: 'DEVICE',
    });
    switch (stepId) {
      case 'p-disp-api':
        return [weigh('C-API-1', 'BOM-ATV', 'MAT-ATV', '9.992', '1.250', 'apiDispensed')];
      case 'p-disp-exc':
        return [
          weigh('C-MCC-1', 'BOM-MCC', 'MAT-MCC', '21.000', '1.000', 'excipientsDispensed'),
          weigh('C-LAC-1', 'BOM-LAC', 'MAT-LAC', '19.960', '1.000', 'excipientsDispensed'),
          weigh('C-PVP-1', 'BOM-PVP', 'MAT-PVP', '2.000', '0.500', 'excipientsDispensed'),
          weigh('C-IPA-1', 'BOM-IPA', 'MAT-IPA', '1.750', '0.500', 'excipientsDispensed'),
          weigh('C-CCS-1', 'BOM-CCS', 'MAT-CCS', '1.780', '0.500', 'excipientsDispensed'),
          weigh('C-MGS-1', 'BOM-MGS', 'MAT-MGS', '0.770', '0.500', 'excipientsDispensed'),
        ];
      case 'p-disp-kits':
        return [out('I-KIT', '26.60', '1.00', 'KIT-1'), out('I-KIT', '26.45', '1.00', 'KIT-2'), out('I-KIT-EG', '2.550', '1.000', 'KIT-EG')];
      case 'p-charge':
        return [{ kind: 'CHARGE_CONTAINER', container: `KIT-${sub(frames)}`, scannedBatch: '$BATCH' }];
      case 'p-wet-out':
        return [out('I-WET', '28.00', '1.00')];
      case 'p-gran-out':
        return [out('I-DRIED', sub(frames) === 1 ? '26.10' : '25.95', '1.00')];
      case 'p-blend-out':
        return [out('I-BLEND', '52.20', '1.00')];
      case 'p-comp-out':
        return [out('I-CORES', '51.35', '1.00')];
      default:
        return undefined;
    }
  },
};

export const PACKAGING_SCENARIO: Scenario = {
  value: (item) => {
    switch (item) {
      case 'bulkIssued':
        return dec('5.150', 'kg');
      case 'sealTemp':
        return dec('190', 'Cel');
      case 'blistersGood':
        return { kind: 'COUNT', value: '1990' };
      case 'rejectBlisters':
        return { kind: 'COUNT', value: '6' };
      case 'bulkRemaining':
        return dec('0.000', 'kg');
      case 'cartonsIssued':
        return { kind: 'COUNT', value: '200' };
      case 'cartonsPacked':
        return { kind: 'COUNT', value: '199' };
      case 'serialsCommissioned':
        return { kind: 'COUNT', value: '199' };
      case 'cartonsDamaged':
        return { kind: 'COUNT', value: '1' };
      case 'cartonsReturned':
        return { kind: 'COUNT', value: '0' };
      default:
        return undefined;
    }
  },
  entries: (stepId) =>
    stepId === 'p-blister-out'
      ? [{ kind: 'OUTPUT_CONTAINER', intermediate: 'I-BLISTERS', container: 'BLS-1', gross: '5.60', tare: '0.40', unit: 'kg', balance: 'BAL-5', source: 'DEVICE' }]
      : stepId === 'p-carton-destroy'
        ? [{ kind: 'DISPOSAL', category: 'DESTRUCTION', material: 'Printed carton', batchCoded: true, quantity: { value: '1', unit: '1' }, method: 'Shredding' }]
        : undefined,
};

// ---------------------------------------------------------------------------------------------
// Small-MBR helpers

export function param(id: string, extra: Partial<Parameter> = {}): Parameter {
  return { id, name: id, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 2 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE', ...extra };
}

/** Completes a started-or-enabled phase with one DEVICE value (kg) per recorded item. */
export function done(run: Run, stepId: string, values: Record<string, string> = {}, frames: Frame[] = []): void {
  if (run.status(stepId, frames) === 'ENABLED') run.start(stepId, frames);
  for (const [item, v] of Object.entries(values)) run.record(stepId, item, { kind: 'DECIMAL', value: v, unit: 'kg' }, { frames });
  run.perform(stepId, frames);
  if (run.status(stepId, frames) === 'AWAITING_VERIFICATION') run.verify(stepId, frames);
}

/** A copy of an object without one key (for "what if this part were missing" tests). */
export function omit<T extends object, K extends keyof T>(o: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as Omit<T, K>;
}
