/**
 * Client intents are resolved by the server into engine commands (Phase 2 apps plan section 4, "Client
 * commands are not engine commands"; section 7, "Command flow"). The browser says what the person did; the
 * server supplies every fact the browser must not:
 *  - the actor and the engine roles (stored authority evaluations, INV-26);
 *  - lot facts from tab.sandbox_lot (PR-18), by code;
 *  - weights from the scale readings claimed by id through the DeviceReadingPort (source DEVICE with the
 *    raw line and time trust set here, DI-32), or, when the room's scale is not online, the values keyed by
 *    hand (source MANUAL: the block flags the entry and forces a second person, PR-20);
 *  - container ids (TEST- lot-number pattern, prefixed by the batch number) and the batch read from a
 *    scanned container label;
 *  - the command id, and the signature of a signed intent (from the ceremony only).
 * A refusal here (unknown lot, a reading that cannot be claimed, both readings and manual values) is thrown,
 * so the command transaction rolls back with nothing written; a refusal by the engine is persisted.
 */
import type pg from 'pg';
import { sandbox } from '@ebmr/kernel';
import { engine, type flow } from '@ebmr/recipe-core';
import type { ClientEntry, ClientIntent, DataValueWire, SignedIntent } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { lotForEngine, resolveLot } from './lots.ts';

/** Maximum age of a scale reading at database time (plan section 10, default 120 s). */
export const READING_MAX_AGE_US = 120_000_000n;

export type JsonRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Step keys

/** `<step>@<construct>=<index>/<construct>=<index>`: the step id and its frames (construct ids never contain '='). */
export function parseStepKey(key: string): { step: string; context: flow.Frame[] } {
  const at = key.indexOf('@');
  if (at <= 0) throw badKey(key);
  const step = key.slice(0, at);
  let rest = key.slice(at + 1);
  const context: flow.Frame[] = [];
  while (rest.length > 0) {
    const m = /^([^=]+)=(0|[1-9][0-9]{0,8})(?:\/(.*))?$/s.exec(rest);
    if (!m) throw badKey(key);
    context.push({ construct: m[1] ?? '', index: Number(m[2]) });
    rest = m[3] ?? '';
  }
  return { step, context };
}

function badKey(key: string): Error {
  return refusal(400, {
    code: 'SCHEMA',
    kind: 'INVALID_INPUT',
    whatHappened: 'The step named in the request is not in the expected form.',
    why: `${key.slice(0, 80)} is not <step>@<context>.`,
    controls: ['DI-34'],
    whatYouCanDo: ['Reload the screen and try again.'],
  });
}

/** Step id and frames of a step instance: the stored instance, else the key as written. */
export function stepTarget(state: engine.BatchState, key: string): { step: string; context: flow.Frame[] } {
  const inst = state.steps[key];
  return inst ? { step: inst.step, context: [...inst.frames] } : parseStepKey(key);
}

// ---------------------------------------------------------------------------------------------
// Values

export function dataValueOf(v: DataValueWire): engine.DataValue {
  switch (v.kind) {
    case 'INSTANT':
      return { kind: 'INSTANT', us: BigInt(v.us) };
    case 'SERIES':
      return { kind: 'SERIES', values: [...v.values], unit: v.unit };
    default:
      return { ...v };
  }
}

export function wireOf(v: engine.DataValue): DataValueWire {
  switch (v.kind) {
    case 'INSTANT':
      return { kind: 'INSTANT', us: v.us.toString() };
    case 'SERIES':
      return { kind: 'SERIES', values: [...v.values], unit: v.unit };
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
  }
}

// ---------------------------------------------------------------------------------------------
// Refusals of the resolution (nothing is written)

function refuse(code: string, whatHappened: string, why: string, controls: string[], whatYouCanDo: string[], status = 422): Error {
  return refusal(status, { code, kind: 'INVALID_INPUT', whatHappened, why, controls, whatYouCanDo, whoCanHelp: ['The shift supervisor'] });
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface IntentContext {
  client: pg.PoolClient;
  app: AppContext;
  def: engine.BatchDefinition;
  state: engine.BatchState;
  /** The kiosk's room (DI-20): readings from another room are refused by the claim. */
  room: string | null;
  actor: engine.Actor;
  commandId: string;
  expectedVersion: number;
}

export interface ResolvedCommand {
  command: engine.Command;
  /** What the server resolved (reading ids and raw lines, lot facts, manual path): stored with the row. */
  evidence: JsonRecord;
}

interface Weights {
  gross: string;
  tare: string;
  unit: string;
  balance: string;
  source: 'DEVICE' | 'MANUAL';
  occurredAt?: engine.OccurredAt;
  evidence: JsonRecord;
}

async function weights(ctx: IntentContext, e: { tareReadingId?: string | undefined; grossReadingId?: string | undefined; manual?: { tare: string; gross: string; unit: string } | undefined }): Promise<Weights> {
  const readings = e.tareReadingId !== undefined || e.grossReadingId !== undefined;
  if (e.manual && readings) {
    throw refuse('EBMR-EXE-073', 'Send the weights either from the scale or keyed by hand, not both. Nothing was saved.', 'The request carries scale readings and hand-keyed values; a weight from the scale is never replaced by a typed one.', ['DI-30', 'DI-32'], ['Capture tare and gross again from the scale.']);
  }
  if (e.manual) {
    const scale = await ctx.app.deviceReadings.scaleStatus(ctx.room);
    if (scale?.status === 'ONLINE') {
      throw refuse('EBMR-EXE-074', 'The scale is online, so the weights are captured from it. Nothing was saved.', `${scale.deviceCode} is online; keying by hand is the fallback when the scale is offline (PR-20).`, ['DI-30', 'PR-20'], ['Capture tare and gross from the scale.']);
    }
    return { gross: e.manual.gross, tare: e.manual.tare, unit: e.manual.unit, balance: scale?.deviceCode ?? 'MANUAL', source: 'MANUAL', evidence: { manual: { scale: scale?.deviceCode ?? null, scaleStatus: scale?.status ?? null } } };
  }
  if (e.tareReadingId === undefined || e.grossReadingId === undefined) {
    throw refuse('EBMR-EXE-075', 'Capture both the tare and the gross weight. Nothing was saved.', 'A container weighing needs a tare and a gross reading from the scale (or both keyed by hand when the scale is offline).', ['DI-30', 'PR-19'], ['Capture the missing weight, then save.']);
  }
  const [tare] = await ctx.app.deviceReadings.claim(ctx.client, { readingIds: [e.tareReadingId], room: ctx.room, maxAgeUs: READING_MAX_AGE_US, purpose: 'TARE' });
  const [gross] = await ctx.app.deviceReadings.claim(ctx.client, { readingIds: [e.grossReadingId], room: ctx.room, maxAgeUs: READING_MAX_AGE_US, purpose: 'GROSS' });
  if (!tare || !gross) throw refuse('EBMR-EXE-075', 'A scale reading could not be used. Nothing was saved.', 'The scale reading was not returned by the claim.', ['DI-32'], ['Capture the weights again.']);
  if (tare.unit !== gross.unit || tare.deviceCode !== gross.deviceCode) {
    throw refuse('EBMR-EXE-076', 'Tare and gross must come from the same scale, in the same unit. Nothing was saved.', `Tare ${tare.value} ${tare.unit} on ${tare.deviceCode}; gross ${gross.value} ${gross.unit} on ${gross.deviceCode}.`, ['DI-30', 'PR-19'], ['Capture both weights on the same scale.']);
  }
  const reading = (purpose: string, r: typeof tare) => ({ purpose, readingId: r.readingId, deviceCode: r.deviceCode, value: r.value, unit: r.unit, raw: r.raw, sourceTimeUs: r.sourceTimeUs === null ? null : r.sourceTimeUs.toString(), trust: r.trust });
  return {
    gross: gross.value,
    tare: tare.value,
    unit: gross.unit,
    balance: gross.deviceCode,
    source: 'DEVICE',
    ...(gross.sourceTimeUs !== null ? { occurredAt: { us: gross.sourceTimeUs, trust: gross.trust } } : {}),
    evidence: { readings: [reading('TARE', tare), reading('GROSS', gross)] },
  };
}

/** A container id of this batch: `<batch number>/C<n>` (TEST- lot-number pattern), or a requested one of that form. */
export function containerId(state: engine.BatchState, requested: string | undefined): string {
  const batch = state.header.batchNumber;
  if (requested !== undefined) {
    const problem = sandbox.identifierProblem('SANDBOX', 'LOT_NUMBER', requested);
    if (!requested.startsWith(`${batch}/`) || problem !== null || state.containers[requested] !== undefined) {
      throw refuse(
        'EBMR-EXE-077',
        'This container id cannot be used. Nothing was saved.',
        `${requested.slice(0, 64)} ${state.containers[requested] !== undefined ? 'is already a container of this batch' : `is not a container id of batch ${batch} (<batch number>/<id>, TEST- lot-number rules)`}.`,
        ['DI-05', 'PR-21'],
        ['Leave the container id empty: the system gives the next one.'],
      );
    }
    return requested;
  }
  let n = Object.keys(state.containers).length + 1;
  while (state.containers[`${batch}/C${n}`] !== undefined) n += 1;
  return `${batch}/C${n}`;
}

/** The batch printed on a container label: the part of the code before its first '/'. */
export function labelBatch(code: string): string {
  const i = code.indexOf('/');
  return i > 0 ? code.slice(0, i) : code;
}

async function resolveEntry(ctx: IntentContext, e: ClientEntry): Promise<{ entry: JsonRecord & { kind: string }; occurredAt?: engine.OccurredAt; evidence: JsonRecord }> {
  switch (e.kind) {
    case 'CONTAINER_WEIGHING': {
      const lot = await resolveLot(ctx.client, e.lotCode);
      if (!lot) {
        throw refuse('EBMR-EXE-072', `Lot ${e.lotCode.slice(0, 64)} is not known on this installation. Nothing was saved.`, 'Only registered TEST- lots can be dispensed in a test run; the lot status comes from the lot register, never from the terminal (PR-18).', ['PR-18', 'DI-05'], ['Scan the lot label again, or ask for the lot to be registered.']);
      }
      const w = await weights(ctx, e);
      const container = containerId(ctx.state, e.container);
      return {
        entry: { kind: 'CONTAINER_WEIGHING', item: e.item, bomLine: e.bomLine, container, lot: lotForEngine(lot), gross: w.gross, tare: w.tare, unit: w.unit, balance: w.balance, source: w.source },
        ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}),
        evidence: { ...w.evidence, lot: { code: lot.lotCode, material: lot.materialCode, status: lot.status } },
      };
    }
    case 'OUTPUT_CONTAINER': {
      const w = await weights(ctx, e);
      const container = containerId(ctx.state, e.container);
      return {
        entry: { kind: 'OUTPUT_CONTAINER', intermediate: e.intermediate, container, gross: w.gross, tare: w.tare, unit: w.unit, balance: w.balance, source: w.source },
        ...(w.occurredAt ? { occurredAt: w.occurredAt } : {}),
        evidence: w.evidence,
      };
    }
    case 'CHARGE_CONTAINER':
      return { entry: { kind: 'CHARGE_CONTAINER', container: e.containerCode, scannedBatch: labelBatch(e.containerCode) }, evidence: { scanned: e.containerCode } };
    case 'CLEARANCE_CHECK':
      return { entry: { kind: 'CLEARANCE_CHECK', answers: e.answers.map((a) => ({ id: a.id, answer: a.answer })) }, evidence: {} };
    case 'PREVIOUS_BATCH':
      return { entry: { kind: 'PREVIOUS_BATCH', product: e.product, batchNumber: e.batchNumber }, evidence: {} };
    case 'EQUIPMENT_STATUS':
      return { entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: e.equipmentRef, labelId: e.labelId, answers: e.answers.map((a) => ({ id: a.id, answer: a.answer })) }, evidence: {} };
    case 'ACKNOWLEDGE':
      return { entry: { kind: 'ACKNOWLEDGE', mode: e.mode }, evidence: {} };
  }
}

/** The engine command of a plain client intent (claims readings and reads lots in the command's transaction). */
export async function resolveClientIntent(ctx: IntentContext, intent: ClientIntent): Promise<ResolvedCommand> {
  const base = { commandId: ctx.commandId, actor: ctx.actor, expectedVersion: ctx.expectedVersion };
  switch (intent.type) {
    case 'START_STEP': {
      const t = stepTarget(ctx.state, intent.stepKey);
      return { command: { ...base, type: 'START_STEP', step: t.step, context: t.context }, evidence: {} };
    }
    case 'RECORD_DATA': {
      const t = stepTarget(ctx.state, intent.stepKey);
      const source: engine.DataSource = intent.source.mode === 'SCAN' ? { mode: 'SCAN', code: intent.source.code } : intent.source.evidence ? { mode: 'MANUAL', evidence: { ...intent.source.evidence } } : { mode: 'MANUAL' };
      return {
        command: { ...base, type: 'RECORD_DATA', step: t.step, context: t.context, item: intent.item, value: dataValueOf(intent.value), source, ...(intent.reason !== undefined ? { reason: intent.reason } : {}) },
        evidence: {},
      };
    }
    case 'RECORD_ENTRY': {
      const t = stepTarget(ctx.state, intent.stepKey);
      const r = await resolveEntry(ctx, intent.entry);
      return { command: { ...base, type: 'RECORD_ENTRY', step: t.step, context: t.context, entry: r.entry, ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}) }, evidence: r.evidence };
    }
    case 'RAISE_EXCEPTION': {
      const t = intent.stepKey !== undefined ? stepTarget(ctx.state, intent.stepKey) : undefined;
      return { command: { ...base, type: 'RAISE_EXCEPTION', ...(t ? { step: t.step, context: t.context } : {}), description: intent.description, severity: intent.severity }, evidence: {} };
    }
    case 'ATTACH_DEVIATION':
      return { command: { ...base, type: 'ATTACH_DEVIATION', exception: intent.exception, deviationRef: intent.deviationRef }, evidence: {} };
    case 'HOLD_BATCH':
      return { command: { ...base, type: 'HOLD_BATCH', holdType: intent.holdType, reason: intent.reason }, evidence: {} };
    case 'RELEASE_HOLD':
      return { command: { ...base, type: 'RELEASE_HOLD', hold: intent.hold, reason: intent.reason }, evidence: {} };
  }
}

// ---------------------------------------------------------------------------------------------
// Signed intents (the ENGINE_COMMAND signable action)

export interface SignedSubject {
  aggregateType: engine.AggregateType;
  /** Key inside the run (step key, stage key, exception id). */
  key: string;
  /** The signature target for prepareForSignature. */
  target: engine.SignatureTarget;
  /** The state esig.sign expects the record in (the state the engine requires for the command). */
  expectedState: string;
}

/** What a signed intent signs, without the run's state. */
export function signedSubject(state: engine.BatchState | undefined, intent: SignedIntent): SignedSubject {
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      const t = state ? stepTarget(state, intent.stepKey) : parseStepKey(intent.stepKey);
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'SIGN_PERFORMED', step: t.step, context: t.context }, expectedState: 'IN_PROGRESS' };
    }
    case 'VERIFY':
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'VERIFY' }, expectedState: 'AWAITING_VERIFICATION' };
    case 'DISPOSITION_HOLD_POINT':
      return { aggregateType: 'batch_step', key: intent.stepKey, target: { type: 'DISPOSITION_HOLD_POINT' }, expectedState: 'ENABLED' };
    case 'SIGN_OFF_STAGE':
      return { aggregateType: 'batch_stage', key: intent.stageKey, target: { type: 'SIGN_OFF_STAGE' }, expectedState: 'AWAITING_SIGN_OFF' };
    case 'DISPOSITION_EXCEPTION':
      return { aggregateType: 'batch_exception', key: intent.exception, target: { type: 'DISPOSITION_EXCEPTION' }, expectedState: 'OPEN' };
  }
}

/**
 * The meaning the engine requires for a signed intent: the block's PERFORMED meaning, the check meaning of
 * the step (re-verification, witness, the block's own), the hold-point decision's meaning, a stage sign-off
 * or an exception disposition. Undefined when it depends on a state that is not known (describe() without
 * a cached run): the command's transaction checks it then.
 */
export function signedMeaning(def: engine.BatchDefinition | undefined, state: engine.BatchState | undefined, intent: SignedIntent): string | undefined {
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      if (!def) return undefined;
      return engine.performMeaning(def, parseStepKey(intent.stepKey).step);
    }
    case 'VERIFY': {
      if (!def || !state) return undefined;
      const inst = state.steps[intent.stepKey];
      return engine.checkMeaning(def, inst, inst?.step ?? parseStepKey(intent.stepKey).step, intent.meaning);
    }
    case 'DISPOSITION_HOLD_POINT':
      return engine.holdPointMeaning(intent.disposition);
    case 'SIGN_OFF_STAGE':
      return engine.MEANINGS.STAGE_SIGNED_OFF;
    case 'DISPOSITION_EXCEPTION':
      return engine.MEANINGS.EXCEPTION_DISPOSITIONED;
  }
}

/** The engine command of a signed intent with a signature (the placeholder for the dry run, the real one to apply). */
export function signedCommand(state: engine.BatchState, intent: SignedIntent, actor: engine.Actor, signature: engine.SignatureRef, commandId: string, expectedVersion: number): engine.Command {
  const base = { commandId, actor, expectedVersion };
  switch (intent.type) {
    case 'SIGN_PERFORMED': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'SIGN_PERFORMED', step: t.step, context: t.context, signature };
    }
    case 'VERIFY': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'VERIFY', step: t.step, context: t.context, signature };
    }
    case 'DISPOSITION_HOLD_POINT': {
      const t = stepTarget(state, intent.stepKey);
      return { ...base, type: 'DISPOSITION_HOLD_POINT', step: t.step, context: t.context, disposition: intent.disposition, ...(intent.comment !== undefined ? { comment: intent.comment } : {}), signature };
    }
    case 'SIGN_OFF_STAGE': {
      const frame = state.stages[intent.stageKey];
      const t = frame ? { step: frame.stage, context: [...frame.frames] } : parseStepKey(intent.stageKey);
      return { ...base, type: 'SIGN_OFF_STAGE', stage: t.step, context: t.context, signature };
    }
    case 'DISPOSITION_EXCEPTION':
      return { ...base, type: 'DISPOSITION_EXCEPTION', exception: intent.exception, outcome: intent.outcome, justification: intent.justification, signature };
  }
}
