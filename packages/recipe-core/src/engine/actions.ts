/**
 * What a person can do now (Phase 2 apps plan sections 7 and 9; module C3): every offered action is a
 * dry run of the real command through `engine.step` at the trusted time, with a placeholder signature
 * where the command carries one. The answer, including the refusal in the engine's own words, is
 * therefore exactly what `step` would decide; no guard is re-implemented here. Data entry is offered
 * while the step is in progress; the engine judges each value when it is committed.
 *
 * Also the signature meanings a step asks for (block meanings such as LINE_CLEARANCE_PERFORMED or
 * CONTAINER_CHECKED before the generic PERFORMED and VERIFIED), so the view, the challenge and the
 * command all name the same meaning.
 */
import { RELEASING_DISPOSITIONS, type BatchDefinition } from './definition.ts';
import { step as engineStep } from './engine.ts';
import { blockActive } from './exceptions.ts';
import { checkMeanings, handEntriesWithoutDeclaredEvidence, MEANINGS, performMeanings, witnessPossible } from './guards.ts';
import { cloneState, stepKey as keyOf, Tx } from './tx.ts';
import type { Actor, BatchState, Clock, Command, Refusal, SignatureRef, StepInstance } from './types.ts';
import { makeView } from './view.ts';

export type ActionKind =
  | 'START_STEP'
  | 'RECORD_DATA'
  | 'RECORD_ENTRY'
  | 'SIGN_PERFORMED'
  | 'VERIFY'
  | 'WITNESS'
  | 'DISPOSITION_HOLD_POINT'
  | 'SIGN_OFF_STAGE'
  | 'RAISE_EXCEPTION'
  | 'ATTACH_DEVIATION'
  | 'DISPOSITION_EXCEPTION'
  | 'HOLD_BATCH'
  | 'RELEASE_HOLD'
  | 'COMPLETE_LOOP_ITERATION';

export interface AvailableAction {
  action: ActionKind;
  available: boolean;
  /** The command carries an e-signature (sent through the signing ceremony). */
  signed: boolean;
  /** Signature meaning of a signed action. */
  meaning: string | null;
  /** What the action acts on when it is not the step itself: exception id, stage key, hold id; the disposition of a hold-point decision. */
  target: string | null;
  /** The engine's refusal when not available (plain language, rule code, controls). */
  refusal: Refusal | null;
}

export interface ActionScope {
  /** The step instance the screen shows; omitted for run-level actions (holds, stage sign-offs). */
  stepKey?: string;
}

/** Placeholder signature for a dry run: never stored, never shown as a signature. */
export const PLACEHOLDER_SIGNATURE_ID = '$dry-run';

function placeholder(meaning: string, actor: Actor): SignatureRef {
  return { id: PLACEHOLDER_SIGNATURE_ID, meaning, signer: actor.id };
}

type CommandInput = Command extends infer C ? (C extends Command ? Omit<C, 'commandId' | 'actor'> : never) : never;

/** Dry run of one command: accepted, or the engine's refusal. */
export function dryRun(def: BatchDefinition, state: BatchState, actor: Actor, clock: Clock, input: CommandInput): Refusal | null {
  const command = { ...input, commandId: '$dry-run', actor } as Command;
  const r = engineStep(def, state, command, clock);
  if (r.accepted) return null;
  return r.refusal ?? { code: 'ENG-DUPLICATE', message: 'This command was already applied (ENG-DUPLICATE; DI-34)', controls: ['DI-34'] };
}

/**
 * The block's advisory warnings by entry kind for step instance `stepKey` while it is in progress (block contract
 * entryWarnings, R10 #3): what recording that entry now would leave missing. Empty for other steps and blocks. Read on
 * a copy of the state; never a refusal.
 */
export function entryWarnings(def: BatchDefinition, state: BatchState, stepKey: string, clock: Clock, actor?: Actor): Readonly<Record<string, string>> {
  const inst = state.steps[stepKey];
  if (inst?.status !== 'IN_PROGRESS') return {};
  const step = def.steps.get(inst.step);
  const handler = step?.block?.handler;
  if (!step || step.node.kind !== 'phase' || !handler?.entryWarnings) return {};
  return handler.entryWarnings(makeView(new Tx(def, cloneState(state), clock.nowUs, clock.nowUs, actor), step, inst));
}

/**
 * The PERFORMED meaning a phase asks for (the block's own, else PERFORMED): the first of the exact set the engine
 * accepts (guards.ts performMeanings), so the screen, the challenge and the command name the same meaning.
 */
export function performMeaning(def: BatchDefinition, stepId: string): string {
  return performMeanings(def.steps.get(stepId))[0] ?? MEANINGS.PERFORMED;
}

/**
 * The check meaning of a step instance at `nowUs`: re-verification, the MBR's WITNESSED or a witness for a critical
 * hand entry without the photo or printout its MBR names (T12, engine 1.4.0) while a witness is still possible (engine
 * 1.5.0, T12.LATE: the witness window after the act has not passed and the run has not moved on), the block's own,
 * else VERIFIED: the first of the exact set the engine accepts (guards.ts checkMeanings). It depends on the step, what
 * the batch `state` holds of it and the time, never on the person: a person never chooses the meaning of the check
 * they sign, so a verifier cannot replace the check a step requires (for example CONTAINER_CHECKED on a dispensing
 * step) with a witness, nor a witness with a later review while the witness is possible (review finding P37; DI-35,
 * PR-14, PR-20, DI-30).
 */
export function checkMeaning(def: BatchDefinition, inst: StepInstance | undefined, stepId: string, state: BatchState | undefined, nowUs: bigint): string {
  const step = def.steps.get(stepId);
  const unevidenced = handEntriesWithoutDeclaredEvidence(def, state, inst);
  const due = step?.checkMeaning === 'WITNESSED' || unevidenced.length > 0;
  return checkMeanings(step, inst, unevidenced, !due || witnessPossible(def, state, inst, nowUs))[0] ?? MEANINGS.VERIFIED;
}

/** HOLD_POINT_RELEASED for a releasing disposition, else HOLD_POINT_NOT_RELEASED. */
export function holdPointMeaning(disposition: string): string {
  return RELEASING_DISPOSITIONS.includes(disposition) ? MEANINGS.HOLD_RELEASED : MEANINGS.HOLD_NOT_RELEASED;
}

function result(action: ActionKind, refusal: Refusal | null, extra: { signed?: boolean; meaning?: string | null; target?: string | null } = {}): AvailableAction {
  return { action, available: refusal === null, signed: extra.signed ?? false, meaning: extra.meaning ?? null, target: extra.target ?? null, refusal };
}

const plainRefusal = (code: string, message: string, controls: string[]): Refusal => ({ code, message: `${message} (${code}; ${controls.join(', ')})`, controls });

/**
 * Actions of one step instance (and the exceptions raised on it), or of the run (holds, stage
 * sign-offs, run-level exceptions) when `scope.stepKey` is omitted.
 */
export function availableActions(def: BatchDefinition, state: BatchState, actor: Actor, clock: Clock, scope: ActionScope = {}): AvailableAction[] {
  const out: AvailableAction[] = [];
  const run = (input: CommandInput): Refusal | null => dryRun(def, state, actor, clock, input);
  if (scope.stepKey !== undefined) {
    const inst = state.steps[scope.stepKey];
    if (!inst) return [result('START_STEP', plainRefusal('ENG-NOT-ENABLED', `Step ${scope.stepKey} has not been reached in this batch`, ['DI-34']))];
    const stepDef = def.steps.get(inst.step);
    const frames = inst.frames;
    if (inst.kind === 'HOLD') {
      // One decision per disposition the hold point offers, each signed with its own meaning (release:
      // HOLD_POINT_RELEASED; any other decision: HOLD_POINT_NOT_RELEASED); the target names the disposition.
      const hold = stepDef?.node.kind === 'holdPoint' ? stepDef.node : undefined;
      for (const disposition of hold?.dispositions ?? []) {
        const meaning = holdPointMeaning(disposition);
        out.push(result('DISPOSITION_HOLD_POINT', run({ type: 'DISPOSITION_HOLD_POINT', step: inst.step, context: frames, disposition, signature: placeholder(meaning, actor) }), { signed: true, meaning, target: disposition }));
      }
    } else {
      out.push(result('START_STEP', run({ type: 'START_STEP', step: inst.step, context: frames })));
      const phase = stepDef?.node.kind === 'phase' ? stepDef.node : undefined;
      const entryRefusal = dataEntryRefusal(state, inst);
      if (phase && phase.records.some((r) => !stepDef?.computedItems.has(r))) out.push(result('RECORD_DATA', entryRefusal));
      if (stepDef?.block?.dataSchema && Object.keys(stepDef.block.dataSchema.entries).length > 0) out.push(result('RECORD_ENTRY', entryRefusal));
      const pm = performMeaning(def, inst.step);
      out.push(result('SIGN_PERFORMED', run({ type: 'SIGN_PERFORMED', step: inst.step, context: frames, signature: placeholder(pm, actor) }), { signed: true, meaning: pm }));
      const cm = checkMeaning(def, inst, inst.step, state, clock.nowUs);
      out.push(result(cm === MEANINGS.WITNESSED ? 'WITNESS' : 'VERIFY', run({ type: 'VERIFY', step: inst.step, context: frames, signature: placeholder(cm, actor) }), { signed: true, meaning: cm }));
    }
    out.push(result('RAISE_EXCEPTION', run({ type: 'RAISE_EXCEPTION', step: inst.step, context: frames, description: 'dry run', severity: 'ALERT' })));
    for (const e of Object.values(state.exceptions).filter((x) => x.source.stepKey === inst.key || (x.source.stepKey === undefined && x.source.step === inst.step && keyOf(inst.step, x.source.frames) === inst.key))) {
      out.push(...exceptionActions(def, state, actor, clock, e.id));
    }
    return out;
  }
  // Run level.
  out.push(result('HOLD_BATCH', run({ type: 'HOLD_BATCH', holdType: actor.roles.some((r) => def.policy.qaRoles.includes(r)) ? 'QA' : 'SUPERVISOR', reason: 'dry run' })));
  for (const h of Object.values(state.holds).filter((x) => !x.released)) out.push(result('RELEASE_HOLD', run({ type: 'RELEASE_HOLD', hold: h.id, reason: 'dry run' }), { target: h.id }));
  out.push(result('RAISE_EXCEPTION', run({ type: 'RAISE_EXCEPTION', description: 'dry run', severity: 'ALERT' })));
  for (const frame of Object.values(state.stages).filter((f) => f.awaitingSignOff || (f.endedAt !== undefined && f.signOff?.valid !== true))) {
    out.push(result('SIGN_OFF_STAGE', run({ type: 'SIGN_OFF_STAGE', stage: frame.stage, context: frame.frames, signature: placeholder(MEANINGS.STAGE_SIGNED_OFF, actor) }), { signed: true, meaning: MEANINGS.STAGE_SIGNED_OFF, target: frame.key }));
  }
  for (const e of Object.values(state.exceptions).filter((x) => x.source.stepKey === undefined && x.status === 'OPEN')) out.push(...exceptionActions(def, state, actor, clock, e.id));
  return out;
}

/** Link a deviation (while one is needed and none is linked) and disposition (while open) an exception. */
export function exceptionActions(def: BatchDefinition, state: BatchState, actor: Actor, clock: Clock, exceptionId: string): AvailableAction[] {
  const e = state.exceptions[exceptionId];
  if (!e || e.status !== 'OPEN') return [];
  const out: AvailableAction[] = [];
  if (e.deviation === undefined && (e.deviationRequired || blockActive(e))) {
    out.push(result('ATTACH_DEVIATION', dryRun(def, state, actor, clock, { type: 'ATTACH_DEVIATION', exception: e.id, deviationRef: 'dry run' }), { target: e.id }));
  }
  const outcome = e.deviationRequired || e.deviation !== undefined ? 'DEVIATION_RAISED' : 'NO_IMPACT';
  out.push(
    result('DISPOSITION_EXCEPTION', dryRun(def, state, actor, clock, { type: 'DISPOSITION_EXCEPTION', exception: e.id, outcome, justification: 'dry run', signature: placeholder(MEANINGS.EXCEPTION_DISPOSITIONED, actor) }), {
      signed: true,
      meaning: MEANINGS.EXCEPTION_DISPOSITIONED,
      target: e.id,
    }),
  );
  return out;
}

function dataEntryRefusal(state: BatchState, inst: StepInstance): Refusal | null {
  if (state.status !== 'IN_PROGRESS' && state.status !== 'ON_HOLD') return plainRefusal('ENG-BATCH-STATUS', `The batch is ${state.status.toLowerCase().replace(/_/g, ' ')}: data cannot be recorded`, ['DI-34']);
  if (inst.status !== 'IN_PROGRESS') return plainRefusal('ENG-STEP-STATUS', `Step ${inst.key} is ${inst.status.toLowerCase().replace(/_/g, ' ')}: start it before recording data`, ['DI-34']);
  return null;
}
