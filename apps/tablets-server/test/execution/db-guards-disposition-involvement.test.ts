/**
 * Phase 2 exit review F11 (controls vs tests; INV-03, PR-13, PR-49, DI-17, DI-35; ADR 0012 item 8): the person who
 * dispositions an exception is outside the involvement set of the step that raised it, in the database as in the
 * engine (engine batch.ts dispositionException, ENG-SEGREGATION).
 *
 * Before recipe-core 0306 the database excluded only the exception's raiser and the person who linked its deviation:
 * the batch_exception content provider named only those two as having entered the record, so the kernel's INV-03 rule
 * (EBMR-ESIG-044) let a person who started, entered data in, corrected or signed performed the raising step sign the
 * disposition, and no recipe guard asked. A writer holding the application role (ebmr_sandbox here) then stored that
 * disposition with an engine result computed as if the person were not involved; the invariant query reported nothing.
 * Now the provider names the raising step's performers, data enterers, correctors and PERFORMED signers too (the kernel
 * refuses the signature), `check_disposition_state` refuses the row (EBMR-EXE-087), and `execution_violations()`
 * reports a disposition by a person involved in the step before it.
 *
 * Round 2 (recipe-core 0310): those lists, and the INVOLVEMENT events, are written by the same writer. operator1's own
 * START_STEP and entry stored without operator1 in the lists or events left operator1 free to disposition. Now the
 * involvement is also read from the accepted command rows on the step (append-only, hash-chained, attributed from the
 * session): the provider names them, a trigger refuses the row, and the invariant query reports it.
 *
 * Round 3 (recipe-core 0315): the step an exception was raised at was read from the stored exception's source, which
 * the writer controls for an exception a block or the engine raises. operator2's CLEARANCE_CHECK with an item not
 * confirmed, stored with the engine's real result except that its CLEARANCE_FAILED kept no step, left operator1, who
 * started the clearance, free to disposition it. Now the raising step is also the step the command of the row that
 * raised the exception acts on (that row's EXCEPTION_RAISED event names it, 0299): the provider, the trigger and the
 * invariant query all read it.
 *
 * Round 4 (recipe-core 0327): an exception the engine raises at another step than the one its row acts on was still
 * the writer's to place. A correction of the blend time (step A, p-early-time) makes the blend ratio computed in step B
 * (p-early-calc) fail, and the engine raises CALCULATION_FAILED at B; stored without its step (or at a step nobody
 * worked in), the raising steps were only A, so operator1, who worked only in B, was free to disposition it. Now every
 * exception a row adds names, as the engine raises it, the step instance it was raised at (its key, step and frames),
 * and that step is the one the row acts on, apart from what a correction or an invalidation raises in a step whose
 * computed values or targets the changed value feeds (EBMR-EXE-044); the invariant query reports an exception that
 * names no step instance.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { esig, identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, prepareSignature } from './db-guards-support.ts';
import { asPersonaInRole, dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, refusalOf, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const CLEAR = 'p-disp-clear@';

/** `key` also holds `roleCode` (requested by the administrator, approved by the owner; no rule forbids the pair). */
async function grantRole(key: string, roleCode: string): Promise<void> {
  const who = personaIn(sbx, key);
  const reason = { reasonCode: 'TEST_SETUP', reasonText: `F11: ${key} also holds ${roleCode}` };
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: reason.reasonText }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'F11 set-up'));
}

/** A dc-mini run in which operator1 started the line clearance and entered data in it, and supervisor1 raised an exception on it. */
async function runWithStepException(): Promise<{ d: RunDriver; exception: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
  await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
  const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
  if (!exception) throw new Error('SETUP: no exception');
  return { d, exception };
}

let operatorIsQa = false;

const LISTS = ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const;

/**
 * operator1's own `command` on the line clearance (START_STEP or an entry), recorded through the application role on
 * client `c` (in the command context the caller installed) with the engine's real result, except that operator1 is
 * taken out of the step's four lists and its INVOLVEMENT events are dropped (the round-2 verification's bypass of F11).
 */
async function scrubbedAct(c: pg.PoolClient, runId: string, command: (actor: engine.Actor) => engine.Command): Promise<unknown> {
  const run = await runContext(sbx.db.admin, runId);
  const who = personaIn(sbx, 'operator1').personId;
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const cmd = command(engineActor(who, roles));
  const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused ${cmd.type}: ${JSON.stringify(r.refusal)}`);
  const state = structuredClone(r.state);
  const s = state.steps[CLEAR];
  if (!s) throw new Error('SETUP: no clearance');
  for (const list of LISTS) s[list] = s[list].filter((p) => p !== who);
  return appendAs(tx, cmd, { state, events: r.events.filter((e) => e.type !== 'INVOLVEMENT') }, roles);
}

const scrubbedStart = (actor: engine.Actor): engine.Command => ({ type: 'START_STEP', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [] });
const scrubbedEntry = (actor: engine.Actor): engine.Command => ({
  type: 'RECORD_ENTRY', commandId: randomUUID(), actor, step: 'p-disp-clear', context: [], entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0002' },
});

/** operator1's DISPOSITION_EXCEPTION as QA with signature `signatureId`, appended with the engine's own result on the stored state. */
async function dispositionAs(c: pg.PoolClient, runId: string, exception: string, signatureId: string): Promise<unknown> {
  const run = await runContext(sbx.db.admin, runId);
  const who = personaIn(sbx, 'operator1').personId;
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const command: engine.Command = {
    type: 'DISPOSITION_EXCEPTION',
    commandId: randomUUID(),
    actor: engineActor(who, roles),
    exception,
    outcome: 'NO_IMPACT',
    justification: 'Door closed, booth re-checked; no impact.',
    signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who },
  };
  const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the disposition on the stored state: ${JSON.stringify(r.refusal)}`);
  return appendAs(tx, command, r, roles);
}

async function operatorAsQa(): Promise<void> {
  if (!operatorIsQa) {
    await grantRole('operator1', 'QA_SHOP_FLOOR');
    operatorIsQa = true;
  }
}

/**
 * operator1, holding QA_SHOP_FLOOR, proposes NO_IMPACT for `exception` and prepares the EXCEPTION_DISPOSITIONED
 * signature (content, challenge, badge and PIN on the kiosk); `sign` signs in the caller's command, `qa` is that command's actor.
 */
async function qaDisposition(d: RunDriver, exception: string): Promise<{ qa: ActorContext; sign: (c: pg.PoolClient) => Promise<string> }> {
  await operatorAsQa();
  const agg = `${d.runId}:${exception}`;
  const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(sbx, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
  await withCommand(sbx.db.app, await asQa(), (c) => execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.', deviationRef: null }));
  const content = await esig.contentForSigning(sbx.db.admin, 'batch_exception', agg);
  const challenge = await withCommand(sbx.db.app, await asQa(), (c) =>
    esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
  );
  const persona = personaIn(sbx, 'operator1');
  const ev = await identity.authenticate(sbx.db.authn, {
    method: 'BADGE_PIN', identifier: persona.badgeUid ?? '', secret: persona.pin ?? '', deviceFingerprint: terminalOf(sbx.seed, d.browser('operator1').terminal).fingerprint,
    purpose: 'SIGNATURE', challengeId: challenge.challengeId,
  });
  const sealKey = sbx.built.ctx.sealKey;
  if (!sealKey) throw new Error('SETUP: no seal key');
  return {
    qa: await asQa({ authEventId: ev.authEventId }),
    sign: async (c) => (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId,
  };
}

const NOT_CONFIRMED_CHECK = {
  kind: 'CLEARANCE_CHECK',
  answers: [{ id: 'NO_PREVIOUS_MATERIAL', answer: 'NOT_CONFIRMED' }, { id: 'NO_PREVIOUS_DOCUMENTS', answer: 'CONFIRMED' }, { id: 'EQUIPMENT_CLEAN_LABEL', answer: 'CONFIRMED' }],
};

/**
 * `persona`'s CLEARANCE_CHECK on the line clearance with one item not confirmed, recorded through the application role
 * on client `c` (in the command context the caller installed) with the engine's real result, except that the
 * CLEARANCE_FAILED it raises is stored without the step it was raised at (source.stepKey and source.step deleted): the
 * round-3 verification's bypass of F11. Returns the exception's id.
 */
async function unsourcedClearanceFailure(c: pg.PoolClient, runId: string, persona: string): Promise<string> {
  const run = await runContext(sbx.db.admin, runId);
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const cmd: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(personaIn(sbx, persona).personId, roles), step: 'p-disp-clear', context: [], entry: NOT_CONFIRMED_CHECK };
  const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused the clearance check: ${JSON.stringify(r.refusal)}`);
  const state = structuredClone(r.state);
  const raised = Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined);
  const failure = raised[0];
  if (raised.length !== 1 || failure?.type !== 'CLEARANCE_FAILED' || failure.source.stepKey !== CLEAR) throw new Error(`SETUP: ${JSON.stringify(raised)}`);
  delete failure.source.stepKey;
  delete failure.source.step;
  await appendAs(tx, cmd, { state, events: r.events }, roles);
  return failure.id;
}

/**
 * The round-3 bypass as it can still exist: operator2's unsourced CLEARANCE_FAILED landed behind the triggers' back (a
 * restore, or a row stored before recipe-core 0327, which now refuses it from the application role, EBMR-EXE-044), so
 * the rules read at the disposition are what decides.
 */
async function landedUnsourcedClearanceFailure(d: RunDriver): Promise<string> {
  return withCommand(sbx.db.admin, await actorOf(sbx, d.browser('operator2'), 'operator2'), async (c) => {
    await c.query('set local session_replication_role = replica');
    return unsourcedClearanceFailure(c, d.runId, 'operator2');
  });
}

/** A dc-mini run driven by operator1 and operator2 (both on the DISP-1 kiosk), supervisor1 and qa1. */
async function twoOperatorRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, {
    issuer, operator1: await sbx.asPersona('operator1'), operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}


type Json = Record<string, unknown>;
type StoredException = engine.BatchState['exceptions'][string];

const EARLY_TIME = 'p-early-time@';
const EARLY_CALC = 'p-early-calc@';

/**
 * dc-mini with the blend time keyed first (p-early-time; NON_CRITICAL here, so its correction needs no approval and its
 * check stays a later review) and a G-14 step (p-early-calc) computing blendRatio = blendTime * 15 min / (blendTime -
 * 15 min), which a blend time of 15 min cannot give (the verifier's probe of round 3).
 */
const withEarlyCalculation = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    const calc = prep.find((x) => x['id'] === 'p-disp-calc') as Json;
    for (const x of content['parameters'] as Json[]) if (x['id'] === 'blendTime') x['criticality'] = 'NON_CRITICAL';
    (content['calculations'] as Json[]).push({ id: 'blendRatio', name: 'Blend ratio', expression: 'blendTime * 15 [min] / (blendTime - 15 [min])', output: { valueType: 'DECIMAL', unit: 'min' }, criticality: 'CRITICAL', riskClass: 'HIGH' });
    return [{ ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [] }, { ...calc, id: 'p-early-calc', name: 'Blend ratio', computes: ['blendRatio'] }, ...prep];
  });

/** operator2 keys the blend time (16 min) and signs it performed, verifier1 verifies it, operator1 starts the ratio step (blendRatio computed) and signs it performed. */
async function calculationRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyCalculation()));
  const d = new RunDriver(sbx, runId, {
    issuer, operator1: await sbx.asPersona('operator1'), operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator2', { type: 'START_STEP', stepKey: EARLY_TIME });
  await d.ok('operator2', { type: 'RECORD_DATA', stepKey: EARLY_TIME, item: 'blendTime', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, source: { mode: 'MANUAL' } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: EARLY_TIME });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY_TIME, meaning: 'VERIFIED' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY_CALC });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY_CALC });
  const st = await execution.loadState(sbx.db.admin, runId);
  if (!Object.values(st?.state.derived ?? {}).some((x) => x.calculation === 'blendRatio' && x.stepKey === EARLY_CALC && x.status === 'CURRENT')) throw new Error('SETUP: no blend ratio computed');
  return d;
}

/**
 * operator2 corrects the blend time to 15 min through the store (the application role), signing CORRECTED in the
 * recording command, with the engine's own result except as `forge` changes the exceptions the correction raises
 * (`raised`, in the result's state). `client` is the pool the command runs on (the application role, or the
 * administrator for a row landed behind the triggers' back with `replica`). 'ok' or the refusal.
 */
async function correctBlendTime(d: RunDriver, forge: (raised: StoredException[], state: engine.BatchState) => void, opts: { replica?: boolean } = {}): Promise<string> {
  const before = await execution.loadState(sbx.db.admin, d.runId);
  const point = Object.values(before?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.id;
  if (!point) throw new Error('SETUP: no blend time');
  const p = await prepareSignature(sbx, d.browser('operator2'), 'operator2', 'batch_point', `${d.runId}:${point}`, 'CORRECTED');
  const who = personaIn(sbx, 'operator2').personId;
  const run = await runContext(sbx.db.admin, d.runId);
  return messageOf(
    withCommand(opts.replica ? sbx.db.admin : sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      if (opts.replica) await c.query('set local session_replication_role = replica');
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(who, roles), point,
        value: { kind: 'DECIMAL', value: '15', unit: 'min' }, reason: 'Transcription error: the timer read 15 min', signature: { id, meaning: 'CORRECTED', signer: who },
      };
      const r = engineResult(tx, command);
      const state = structuredClone(r.state);
      forge(Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined), state);
      return appendAs(tx, command, { state, events: r.events }, roles);
    }),
  );
}

/** The CALCULATION_FAILED exceptions a correction raised at the ratio step, as the engine raises them (checked). */
function calculationFailures(raised: StoredException[]): StoredException[] {
  const failed = raised.filter((x) => x.type === 'CALCULATION_FAILED');
  if (failed.length === 0 || failed.some((x) => x.source.stepKey !== EARLY_CALC || x.source.item !== 'blendRatio')) throw new Error(`SETUP: ${JSON.stringify(raised)}`);
  return failed;
}


/**
 * A dc-mini run in which operator2 (DISP-1 kiosk) did the dispensing preparation and starts the paracetamol dispensing
 * with one container weighed by hand at 55 kg for a target of 50 kg (outside the 0.5 % tolerance), so the PERFORMED
 * finalisation of that step raises DISPENSE_OUT_OF_TOLERANCE (blocks generic/material.ts onPerform).
 */
async function overweightDispensing(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, {
    issuer, operator1: await sbx.asPersona('operator1'), operator2: await sbx.asPersona('operator2', 'TEST-KIOSK-DISP-1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: 'p-disp-calc@' });
  await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-calc@' });
  await d.ok('operator2', { type: 'START_STEP', stepKey: PCM });
  await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '56.250', tare: '1.250', unit: 'kg' } } });
  return d;
}

const PCM = 'p-disp-pcm@';

/**
 * operator1's preparation of the PERFORMED signature of the paracetamol dispensing (a PREPARE row, as the server
 * stores before the challenge), recorded on client `c` with the engine's own finalisation except that the
 * DISPENSE_OUT_OF_TOLERANCE it raises is stored without its step. Returns the exception's id.
 */
async function unsourcedPreparation(c: pg.PoolClient, runId: string): Promise<string> {
  const run = await runContext(sbx.db.admin, runId);
  const tx = await execution.ExecutionTx.open(c, run.def, runId);
  const roles = await engineRoles(c);
  const actor = engineActor(personaIn(sbx, 'operator1').personId, roles);
  const target = { type: 'SIGN_PERFORMED' as const, step: 'p-disp-pcm', context: [] };
  const p = engine.prepareForSignature(tx.def, tx.state, target, actor, { nowUs: tx.nowUs });
  const state = structuredClone(p.state);
  const raised = Object.values(state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined && x.type === 'DISPENSE_OUT_OF_TOLERANCE');
  const failure = raised[0];
  if (raised.length !== 1 || failure?.source.stepKey !== PCM) throw new Error(`SETUP: ${JSON.stringify(Object.values(state.exceptions))}`);
  delete failure.source.stepKey;
  delete failure.source.step;
  await execution.appendExecution(c, {
    batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'PREPARE', command: engine.encode({ type: 'PREPARE', target, actor, meaning: 'PERFORMED' }), commandId: `PREPARE:${randomUUID()}`,
    nowUs: tx.nowUs, accepted: true, state, events: p.events, roles, contents: engine.changedContents(tx.def, tx.state, state),
  });
  return failure.id;
}

describe('F11: a person involved in the step that raised an exception never dispositions it (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49][DI-35] the signed content of an exception raised at a step names the step\'s performers and data enterers as having entered it, so the kernel knows who is excluded', async () => {
    const { d, exception } = await runWithStepException();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const supervisor1 = personaIn(sbx, 'supervisor1').personId;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${exception}`]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, supervisor1].sort());
    // An exception raised at no step names only its raiser.
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const other = (await d.runView('qa1')).exceptions.find((x) => x.exceptionId !== exception)?.exceptionId ?? '';
    const { rows: plain } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${other}`]);
    expect(plain[0]?.c.entered_by).toEqual([operator1]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a person who entered data in the raising step, also holding QA_SHOP_FLOOR, cannot disposition the exception through the store directly: the kernel refuses the signature, nothing is recorded', async () => {
    const { d, exception } = await runWithStepException();
    await operatorAsQa();
    const who = personaIn(sbx, 'operator1');
    const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(sbx, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
    const run = await runContext(sbx.db.admin, d.runId);
    const before = await execution.loadState(sbx.db.admin, d.runId);
    expect(before?.state.steps[CLEAR]?.dataEnterers ?? [], 'operator1 entered data in the step').toContain(who.personId);
    expect(before?.state.exceptions[exception]?.source.stepKey).toBe(CLEAR);

    const justification = 'Door closed, booth re-checked; no impact.';
    await withCommand(sbx.db.app, await asQa(), (c) => execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification, deviationRef: null }));
    const agg = `${d.runId}:${exception}`;
    const content = await esig.contentForSigning(sbx.db.admin, 'batch_exception', agg);
    const challenge = await withCommand(sbx.db.app, await asQa(), (c) =>
      esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
    );
    const terminal = terminalOf(sbx.seed, d.browser('operator1').terminal);
    const ev = await identity.authenticate(sbx.db.authn, { method: 'BADGE_PIN', identifier: who.badgeUid ?? '', secret: who.pin ?? '', deviceFingerprint: terminal.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const sealKey = sbx.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: no seal key');

    // The engine's own verdict on the stored state, in operator1's QA command: ENG-SEGREGATION.
    const honest = await withCommand(sbx.db.app, await asQa(), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(who.personId, roles),
        exception,
        outcome: 'NO_IMPACT',
        justification,
        signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
      };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      return r.accepted ? 'accepted' : r.refusal?.code;
    });
    expect(honest).toBe('ENG-SEGREGATION');

    const outcome = await messageOf(
      withCommand(sbx.db.app, await asQa({ authEventId: ev.authEventId }), async (c) => {
        const signatureId = (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId;
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'DISPOSITION_EXCEPTION',
          commandId: randomUUID(),
          actor: engineActor(who.personId, roles),
          exception,
          outcome: 'NO_IMPACT',
          justification,
          signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
        };
        // The application role bypasses the engine's rule: the result is computed as if operator1 were not involved in
        // the step, and the step's involvement lists are put back unchanged.
        const doctored = structuredClone(tx.state);
        const s = doctored.steps[CLEAR];
        if (!s) throw new Error('SETUP: no step');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) s[list] = s[list].filter((p) => p !== who.personId);
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored state: ${JSON.stringify(r.refusal)}`);
        const real = tx.state.steps[CLEAR];
        const out = r.state.steps[CLEAR];
        if (!real || !out) throw new Error('SETUP');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) out[list] = [...real[list]];
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(outcome).toMatch(/EBMR-ESIG-044|EBMR-EXE-087/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(rows[0]?.n).toBe('0');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] the server\'s own signing path refuses the same disposition, and an uninvolved QA reviewer records it', async () => {
    const { d, exception } = await runWithStepException();
    // Review F13 (same defect as its INV-03 tag on esig/disposition.test): this test used to show only the uninvolved
    // reviewer's disposition. operator1, who entered data in the raising step, now asks for it through the server's
    // ceremony routes, in a session acting as QA_SHOP_FLOOR: the sign request's dry run is refused by the engine
    // (ENG-SEGREGATION), the refusal is recorded as a refused row, and nothing is signed.
    await operatorAsQa();
    const involved = new RunDriver(sbx, d.runId, { operator1: await asPersonaInRole(sbx, 'operator1', 'QA_SHOP_FLOOR') });
    involved.beforeTap = d.beforeTap;
    const rows0 = await rowsOf(sbx, d.runId);
    const refused = await involved.sign('operator1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect({ stage: refused.stage, outcome: outcomeOf(refused.result) }).toEqual({ stage: 'sign', outcome: '422:ENG-SEGREGATION' });
    expect(refusalOf(refused.result)).toMatchObject({ kind: 'INDEPENDENCE', controls: ['PR-13', 'PR-49', 'INV-03'] });
    expect(refusalOf(refused.result).whatHappened).toMatch(/Nothing was signed\./);
    expect((await rowsOf(sbx, d.runId)).slice(rows0.length)).toMatchObject([{ kind: 'COMMAND', command_type: 'DISPOSITION_EXCEPTION', accepted: false, refusal: { code: 'ENG-SEGREGATION' }, signature_ids: [] }]);
    const signed = async () => (await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${d.runId}:${exception}`])).rows[0]?.n;
    expect(await signed()).toBe('0');
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception]?.status).toBe('OPEN');
    // supervisor1 raised it: the kernel's rule on the raiser holds as before.
    const own = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(own.result), own.result.ok ? '' : JSON.stringify(own.result.error)).toBe('ok');
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.disposition?.by).toBe(personaIn(sbx, 'qa1').personId);
    expect(await signed()).toBe('1');
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] a disposition by a person who was involved in the raising step before it, landed in the store behind the writers\' back, is reported by the invariant query', async () => {
    const { d, exception } = await runWithStepException();
    const qa1 = personaIn(sbx, 'qa1').personId;
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: 'Door closed, booth re-checked; no impact.' });
    expect(outcomeOf(r.result)).toBe('ok');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    // A restore or a hand edit puts an involvement of qa1 in the step into the row that recorded the PREVIOUS_BATCH entry.
    const { rows } = await sbx.db.admin.query<{ seq: string }>("select seq::text as seq from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_ENTRY' and accepted order by seq limit 1", [d.runId]);
    const seq = rows[0]?.seq;
    if (!seq) throw new Error('SETUP: no entry row');
    const admin = await sbx.db.admin.connect();
    try {
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      await admin.query(
        `insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
         select $1, $2::bigint, coalesce(max(idx), -1) + 1, 'INVOLVEMENT', jsonb_build_object('type', 'INVOLVEMENT', 'stepKey', $3::text, 'person', $4::text, 'involvement', 'ENTERED_DATA')
           from recipe.execution_event where batch_id = $1 and row_seq = $2::bigint`,
        [d.runId, seq, CLEAR, qa1],
      );
      await admin.query('commit');
    } finally {
      admin.release();
    }
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} .*${qa1}.*involved in step ${CLEAR.replace('@', '@')}`))]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a person whose own rows on the raising step left them out of its lists and dropped their INVOLVEMENT events is still excluded: the accepted rows name them, so the kernel refuses the signature and nothing is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const who = personaIn(sbx, 'operator1').personId;
    // The round-2 bypass: operator1's own START_STEP and PREVIOUS_BATCH entry, each stored without operator1 in the step's
    // lists and without its INVOLVEMENT event.
    for (const command of [scrubbedStart, scrubbedEntry]) {
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => scrubbedAct(c, runId, command)))).toBe('ok');
    }
    const stored = await execution.loadState(sbx.db.admin, runId);
    for (const list of LISTS) expect(stored?.state.steps[CLEAR]?.[list] ?? [], `SETUP: ${list} without operator1`).not.toContain(who);
    const { rows: acts } = await sbx.db.admin.query<{ command_type: string; actor_person: string }>(
      "select command_type, actor_person::text as actor_person from recipe.execution_command where batch_id = $1 and command_type in ('START_STEP', 'RECORD_ENTRY') order by seq",
      [runId],
    );
    expect(acts).toEqual([{ command_type: 'START_STEP', actor_person: who }, { command_type: 'RECORD_ENTRY', actor_person: who }]);
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    // The signed content names operator1 from the rows themselves.
    const agg = `${runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [agg]);
    expect(rows[0]?.c.entered_by ?? []).toContain(who);
    // The disposition with the engine's own, unmodified result: the engine sees no involvement in the scrubbed lists.
    const signing = await qaDisposition(d, exception);
    const outcome = await messageOf(withCommand(sbx.db.app, signing.qa, async (c) => dispositionAs(c, runId, exception, await signing.sign(c))));
    expect(outcome).toMatch(/EBMR-ESIG-044/);
    const after = await execution.loadState(sbx.db.admin, runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows: sigs } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
    expect((await violations(sbx)).filter((v) => v.batchId === runId)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] a disposition signed before its signer acted in the raising step, then stored after that act in the same transaction, is refused by the store (EBMR-EXE-087): the accepted rows before it name the signer', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    // The exception is raised at the clearance while nobody has worked in it.
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const outcome = await messageOf(
      withCommand(sbx.db.app, qa, async (c) => {
        // Signed while operator1 is not involved: the kernel lets it through.
        const signatureId = await sign(c);
        // operator1 then starts the step as an operator, the start stored without operator1 in the lists or events.
        await install(c, operator);
        await scrubbedAct(c, runId, scrubbedStart);
        // Back as QA: the signed disposition, with the engine's result on the scrubbed state.
        await install(c, qa);
        return dispositionAs(c, runId, exception, signatureId);
      }),
    );
    expect(outcome).toMatch(/started, entered data in, corrected or signed performed step p-disp-clear@.*\(INV-03, PR-13, PR-49\)\. \[EBMR-EXE-087\]/);
    const after = await execution.loadState(sbx.db.admin, runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    expect(after?.state.steps[CLEAR]?.status, 'the whole transaction was rolled back').toBe('ENABLED');
  }, 300_000);

  it('[INV-03][PR-13][PR-49] a disposition by a person whose accepted command acted in the raising step before it, landed in the store with the triggers off (a restore), is reported by the invariant query although the step lists and events leave the person out', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), supervisor1: await sbx.asPersona('supervisor1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('SETUP: no exception');
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    // The same transaction as above, written with the row triggers off (as a restore or a hand edit would land it).
    expect(
      await messageOf(
        withCommand(sbx.db.admin, qa, async (c) => {
          const signatureId = await sign(c);
          await c.query('set local session_replication_role = replica');
          await install(c, operator);
          await scrubbedAct(c, runId, scrubbedStart);
          await install(c, qa);
          return dispositionAs(c, runId, exception, signatureId);
        }),
      ),
    ).toBe('ok');
    const who = personaIn(sbx, 'operator1').personId;
    const stored = await execution.loadState(sbx.db.admin, runId);
    expect(stored?.state.exceptions[exception]?.disposition?.by, 'SETUP: stored').toBe(who);
    const problems = (await violations(sbx)).filter((v) => v.batchId === runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([expect.stringMatching(new RegExp(`exception ${exception} was dispositioned by ${who}, who was involved in step p-disp-clear@`))]);
  }, 300_000);
  it('[INV-03][PR-13][PR-49][DI-17] round 3: an exception a block raised, stored without the step it was raised at, is still that step\'s: the row that raised it names the step, so the person who started it cannot sign the disposition and nothing is recorded', async () => {
    const d = await twoOperatorRun();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const operator2 = personaIn(sbx, 'operator2').personId;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await landedUnsourcedClearanceFailure(d);
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.source, 'SETUP: stored without its step').toEqual({ frames: [] });
    expect(stored?.state.exceptions[exception]?.raisedBy).toBe(operator2);
    // The signed content names operator1, who started the step the CLEARANCE_CHECK row acted on.
    const agg = `${d.runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [agg]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, operator2].sort());
    // operator1, also holding QA_SHOP_FLOOR, signs and stores the disposition with the engine's own, unmodified result
    // (the engine, reading the stored source, sees no raising step).
    const signing = await qaDisposition(d, exception);
    const outcome = await messageOf(withCommand(sbx.db.app, signing.qa, async (c) => dispositionAs(c, d.runId, exception, await signing.sign(c))));
    expect(outcome).toMatch(/EBMR-ESIG-044/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows: sigs } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] round 3: a disposition signed before its signer acted in the step whose row raised the exception (stored without its step), then stored after that act in the same transaction, is refused by the store (EBMR-EXE-087)', async () => {
    const d = await twoOperatorRun();
    await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await landedUnsourcedClearanceFailure(d);
    // operator1 is not involved yet: the kernel lets the signature through.
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const outcome = await messageOf(
      withCommand(sbx.db.app, qa, async (c) => {
        const signatureId = await sign(c);
        // operator1 then enters data in the step as an operator, stored without operator1 in the lists or events.
        await install(c, operator);
        await scrubbedAct(c, d.runId, scrubbedEntry);
        await install(c, qa);
        return dispositionAs(c, d.runId, exception, signatureId);
      }),
    );
    expect(outcome).toMatch(/started, entered data in, corrected or signed performed step p-disp-clear@.*\(INV-03, PR-13, PR-49\)\. \[EBMR-EXE-087\]/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    expect(after?.state.steps[CLEAR]?.dataEnterers ?? [], 'the whole transaction was rolled back').toEqual([personaIn(sbx, 'operator2').personId]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] round 3: the same disposition landed with the triggers off is reported by the invariant query, although the exception names no step and the lists and events leave the person out', async () => {
    const d = await twoOperatorRun();
    await d.ok('operator2', { type: 'START_STEP', stepKey: CLEAR });
    const exception = await landedUnsourcedClearanceFailure(d);
    const { qa, sign } = await qaDisposition(d, exception);
    const operator = await actorOf(sbx, d.browser('operator1'), 'operator1');
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    expect(
      await messageOf(
        withCommand(sbx.db.admin, qa, async (c) => {
          const signatureId = await sign(c);
          await c.query('set local session_replication_role = replica');
          await install(c, operator);
          await scrubbedAct(c, d.runId, scrubbedEntry);
          await install(c, qa);
          return dispositionAs(c, d.runId, exception, signatureId);
        }),
      ),
    ).toBe('ok');
    const who = personaIn(sbx, 'operator1').personId;
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.disposition?.by, 'SETUP: stored').toBe(who);
    expect(stored?.state.exceptions[exception]?.source, 'SETUP: no step').toEqual({ frames: [] });
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    // Round 4 (recipe-core 0327): the exception that names no step is reported too.
    expect(problems.filter((p) => p.includes('INV-03'))).toEqual([
      expect.stringMatching(new RegExp(`exception ${exception} was dispositioned by ${who}, who was involved in step p-disp-clear@`)),
      `exception ${exception} (CLEARANCE_FAILED) names no step instance it was raised at, although the engine raises it at a step (INV-03, PR-13, PR-49)`,
    ]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] round 4: a correction in one step that makes a calculation of a later step fail raises CALCULATION_FAILED at the later step; stored without that step, the row is refused (EBMR-EXE-044), and stored as raised, the person who worked only in the later step cannot sign its disposition', async () => {
    const d = await calculationRun();
    const operator1 = personaIn(sbx, 'operator1').personId;
    // The verifier's probe: both CALCULATION_FAILED stored without their step (source.stepKey and source.step deleted).
    const stripped = await correctBlendTime(d, (raised) => {
      for (const x of calculationFailures(raised)) {
        delete x.source.stepKey;
        delete x.source.step;
      }
    });
    expect(stripped).toMatch(/exception EX-\d+ \(CALCULATION_FAILED\) without the step instance it was raised at.*\(INV-03, PR-13, PR-49, DI-26\)\. \[EBMR-EXE-044\]/);
    const kept = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.values(kept?.state.exceptions ?? {}).filter((x) => x.type === 'CALCULATION_FAILED'), 'nothing was recorded').toEqual([]);
    // As the engine raises them, the correction is recorded; the exceptions name the ratio step.
    expect(await correctBlendTime(d, (raised) => void calculationFailures(raised))).toBe('ok');
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    const failures = Object.values(stored?.state.exceptions ?? {}).filter((x) => x.type === 'CALCULATION_FAILED');
    expect(failures.map((x) => x.source.stepKey)).toEqual(failures.map(() => EARLY_CALC));
    const exception = failures[0]?.id ?? '';
    const agg = `${d.runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [agg]);
    expect(rows[0]?.c.entered_by ?? []).toContain(operator1);
    // operator1, who started the ratio step and signed it performed, also holding QA_SHOP_FLOOR: the kernel refuses.
    const signing = await qaDisposition(d, exception);
    const outcome = await messageOf(withCommand(sbx.db.app, signing.qa, async (c) => dispositionAs(c, d.runId, exception, await signing.sign(c))));
    expect(outcome).toMatch(/EBMR-ESIG-044/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    const { rows: sigs } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] round 4: the same CALCULATION_FAILED placed at another step instance, one the correction does not reach (the line clearance, which nobody worked in), is refused (EBMR-EXE-044)', async () => {
    const d = await calculationRun();
    const before = await execution.loadState(sbx.db.admin, d.runId);
    const clear = before?.state.steps[CLEAR];
    if (!clear) throw new Error('SETUP: the clearance is not enabled');
    const outcome = await correctBlendTime(d, (raised) => {
      for (const x of calculationFailures(raised)) x.source = { ...x.source, stepKey: CLEAR, step: clear.step, frames: [...clear.frames] };
    });
    expect(outcome).toMatch(/exception EX-\d+ \(CALCULATION_FAILED\) at step p-disp-clear@, .*\(INV-03, PR-13, PR-49, DI-26\)\. \[EBMR-EXE-044\]/);
    const kept = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.values(kept?.state.exceptions ?? {}).filter((x) => x.type === 'CALCULATION_FAILED')).toEqual([]);
  }, 300_000);

  it('[INV-03][PR-13][PR-49] round 4: a CALCULATION_FAILED stored without its step behind the triggers\' back (a restore) is reported by the invariant query', async () => {
    const d = await calculationRun();
    expect(await correctBlendTime(d, (raised) => {
      for (const x of calculationFailures(raised)) {
        delete x.source.stepKey;
        delete x.source.step;
      }
    }, { replica: true })).toBe('ok');
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    const failures = Object.values(stored?.state.exceptions ?? {}).filter((x) => x.type === 'CALCULATION_FAILED').map((x) => x.id).sort();
    expect(failures.length, 'SETUP: stored').toBeGreaterThan(0);
    const problems = (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(problems.filter((p) => p.includes('names no step instance'))).toEqual(failures.map((x) => `exception ${x} (CALCULATION_FAILED) names no step instance it was raised at, although the engine raises it at a step (INV-03, PR-13, PR-49)`));
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] round 4: the round-3 bypass through the application role (a CLEARANCE_FAILED stored without the step it was raised at) is refused when it is written (EBMR-EXE-044); nothing is recorded', async () => {
    const d = await twoOperatorRun();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const outcome = await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator2'), 'operator2'), (c) => unsourcedClearanceFailure(c, d.runId, 'operator2')));
    expect(outcome).toMatch(/exception EX-\d+ \(CLEARANCE_FAILED\) without the step instance it was raised at.*\(INV-03, PR-13, PR-49, DI-26\)\. \[EBMR-EXE-044\]/);
    const after = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.values(after?.state.exceptions ?? {})).toEqual([]);
    expect(after?.state.entries ?? {}, 'the clearance check was not recorded').toEqual({});
  }, 300_000);

  it('[INV-03][PR-13][PR-49][DI-17] round 4: an exception a preparation row raises (the PERFORMED finalisation of a dispensing out of tolerance) is refused from the application role without its step (EBMR-EXE-044), and landed without it behind the triggers\' back it is still that step\'s: the preparation row names the step, so the signed content names the person who weighed', async () => {
    const d = await overweightDispensing();
    const operator1 = personaIn(sbx, 'operator1').personId;
    const operator2 = personaIn(sbx, 'operator2').personId;
    const refused = await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => unsourcedPreparation(c, d.runId)));
    expect(refused).toMatch(/This preparation PREPARE:SIGN_PERFORMED row raises exception EX-\d+ \(DISPENSE_OUT_OF_TOLERANCE\) without the step instance it was raised at.*\[EBMR-EXE-044\]/);
    expect(Object.values((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions ?? {}).filter((x) => x.type === 'DISPENSE_OUT_OF_TOLERANCE')).toEqual([]);
    // The same row landed behind the triggers' back (a restore, or a row stored before recipe-core 0327).
    const exception = await withCommand(sbx.db.admin, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      await c.query('set local session_replication_role = replica');
      return unsourcedPreparation(c, d.runId);
    });
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.source, 'SETUP: stored without its step').toEqual({ frames: [], item: 'pcmDispensed' });
    expect(stored?.state.exceptions[exception]?.raisedBy).toBe(operator1);
    const { rows: steps } = await sbx.db.admin.query<{ s: string[] }>('select recipe.exception_raising_steps($1::uuid, s.state, $2) as s from recipe.execution_state s where s.batch_id = $1::uuid', [d.runId, exception]);
    expect(steps[0]?.s).toEqual([PCM]);
    const { rows } = await sbx.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${d.runId}:${exception}`]);
    expect([...(rows[0]?.c.entered_by ?? [])].sort()).toEqual([operator1, operator2].sort());
  }, 300_000);
});
