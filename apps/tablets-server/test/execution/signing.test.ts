/**
 * The ENGINE_COMMAND signable action through C1's ceremony (module C3; plan section 6; DI-35, DI-37, INV-03,
 * INV-09, INV-10, PR-45, PR-49): refusals sign nothing, a failed apply rolls everything back, the disposition
 * a QA reviewer signs is part of the signed content, hold-point decisions carry their own meanings, a
 * witness after the run moved on is refused, and a PERFORMED signature is superseded when the step's data
 * changes afterwards, in the kernel exactly as in the engine.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { esig } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { routes, StepScreenView, type SignedIntent } from '@ebmr/api-contract';
import { loggedFailures, personaIn, signingAlerts, tapFor } from '../esig/support.ts';
import { signDecision } from './signed-content-support.ts';
import {
  dcMini,
  importAndIssue,
  outcomeOf,
  passwordOf,
  pinOf,
  refusalOf,
  rowsOf,
  RunDriver,
  startExecServer,
  valueOf,
  violations,
  withEarlyHoldPoint,
  withWitnessedClearance,
  writePackage,
  type ExecServer,
} from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

async function driver(content = dcMini(), personas: string[] = ['operator1', 'verifier1', 'qa1', 'supervisor1']): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

const CLEAR = 'p-disp-clear@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

async function performClearance(d: RunDriver, persona = 'operator1'): Promise<void> {
  await d.ok(persona, { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok(persona, c);
  await d.signed(persona, { type: 'SIGN_PERFORMED', stepKey: CLEAR });
}

async function stateOf(d: RunDriver): Promise<engine.BatchState> {
  const st = await execution.loadState(server.db.admin, d.runId);
  if (!st) throw new Error('no state');
  return st.state;
}

async function signatureCount(d: RunDriver): Promise<number> {
  const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where aggregate_id like $1', [`${d.runId}:%`]);
  return Number(rows[0]?.n);
}

/**
 * The ceremony with something happening between the challenge and the signature: content preview and challenge at
 * the run's current version (so the challenge is accepted), then `between`, then POST /api/esig/sign.
 */
async function signAfter(d: RunDriver, persona: string, intent: SignedIntent, between: () => Promise<void>) {
  const b = d.browser(persona);
  const kiosk = b.terminal.includes('KIOSK');
  const s = await d.signing(persona, intent);
  const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: s.aggregateType, aggregateId: s.aggregateId, intent: s.meaning } }));
  const action = { kind: 'ENGINE_COMMAND' as const, runId: d.runId, expectedVersion: await d.version(persona), intent };
  const body = { aggregateType: s.aggregateType, aggregateId: s.aggregateId, contentVersion: content.contentVersion, meaning: s.meaning, clientContentHash: sha256Hex(content.canonicalText), action };
  d.beforeTap();
  const challenge = valueOf(await b.call(routes.esig.createChallenge, { body, ...(kiosk ? { attribution: await tapFor(b, personaIn(server, persona), 'POST', '/api/esig/challenges', body) } : {}) }));
  await between();
  const signBody = { challengeId: challenge.challengeId, credentials: kiosk ? pinOf(server, persona) : passwordOf(server, persona), action };
  const proof = await b.proof('POST', '/api/esig/sign', signBody);
  return { r: await b.call(routes.esig.sign, { body: { ...signBody, proof } }), challengeId: challenge.challengeId };
}

/** A clearance performed by operator1, then a VERIFY challenged by verifier1 while the run moves on (a run-level exception) before the signature. */
async function staleVerify(d: RunDriver) {
  await performClearance(d);
  const before = await signatureCount(d);
  const moved = { at: 0, to: 0 };
  const { r, challengeId } = await signAfter(d, 'verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' }, async () => {
    moved.at = await d.version('verifier1');
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    moved.to = await d.version('verifier1');
  });
  return { r, challengeId, before, moved };
}

describe('signing an engine command', () => {
  it('[DI-35][DI-37] PERFORMED binds the previewed content; the sign result is the step screen; the challenge names the block meaning', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    const r = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    expect(r.content.ok && r.content.value).toMatchObject({ meaning: 'LINE_CLEARANCE_PERFORMED', preview: true, rendering: { kind: 'batch_step', step: { stepKey: CLEAR, number: '1.1.1' } } });
    const signed = valueOf(r.result);
    expect(signed.manifestation).toMatchObject({ meaning: 'LINE_CLEARANCE_PERFORMED', aggregateType: 'batch_step', aggregateId: `${d.runId}:${CLEAR}`, valid: true });
    if (!r.content.ok) throw new Error('no content');
    expect(signed.manifestation.contentHash).toBe(r.content.value.contentHash);
    expect(sha256Hex(r.content.value.canonicalText)).toBe(signed.manifestation.contentHash);
    const view = StepScreenView.parse(signed.result);
    expect(view.step.status).toBe('AWAITING_VERIFICATION');
    expect(view.signatures.map((s) => s.meaning)).toEqual(['LINE_CLEARANCE_PERFORMED']);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[INV-03] the performer cannot verify their own step; a stale screen is refused at the challenge; nothing is signed', async () => {
    const d = await driver();
    await performClearance(d);
    const before = await signatureCount(d);
    // The performer's VERIFIED is refused (INV-03); nothing is signed.
    const own = await d.sign('operator1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    expect(own.result.ok).toBe(false);
    expect(await signatureCount(d)).toBe(before);
    // A stale screen is refused at the challenge already (prepareForChallenge), before any dry run.
    const version = await d.version('verifier1');
    const early = await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' }, { expectedVersion: version - 1 });
    expect({ stage: early.stage, outcome: outcomeOf(early.result) }).toEqual({ stage: 'challenge', outcome: '409:ENG-STALE' });
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[INV-10][DI-34][DI-19] P40: a refusal of the dry run at the signature signs nothing, is recorded as a refused COMMAND row without a signature, and is logged with the signer\'s own authentication without alerting anyone', async () => {
    const d = await driver();
    const { r, challengeId, before, moved } = await staleVerify(d);
    // The challenge was made at the current version; the run moved on before POST /api/esig/sign.
    expect(moved.to).toBeGreaterThan(moved.at);
    // The dry run (at the signature, not at the challenge) refuses ENG-STALE.
    expect(outcomeOf(r)).toBe('409:ENG-STALE');
    expect(refusalOf(r).whatHappened).toMatch(/Nothing was signed\.$/);
    expect(await signatureCount(d)).toBe(before);
    const { rows: sigs } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1 and meaning_code = $2', [`${d.runId}:${CLEAR}`, 'LINE_CLEARANCE_VERIFIED']);
    expect(sigs).toHaveLength(0);
    // The refusal is part of the record: the last row is the refused VERIFY, attributed by the signing's
    // authentication, with no signature (the placeholder never becomes one), and no PREPARE is left without it.
    const rows = await rowsOf(server, d.runId);
    expect(rows.at(-1)).toMatchObject({ kind: 'COMMAND', command_type: 'VERIFY', accepted: false, refusal: { code: 'ENG-STALE' }, signature_ids: [] });
    expect(rows.at(-1)?.auth_event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.at(-2)).toMatchObject({ kind: 'COMMAND', command_type: 'RAISE_EXCEPTION', accepted: true });
    expect((await stateOf(d)).steps[CLEAR]?.status).toBe('AWAITING_VERIFICATION');
    // The refusal is logged once, in that same command, with the signer's own authentication for this challenge, the
    // event that attributes the refused row (its one committed use). The kernel still checks the attempt for misuse
    // and sets aside only this command's own use of the event (kernel 0950, K2), which needs the command's validated
    // actor context to still hold when the handler's dry run returns: no misuse is found and nobody is alerted (DI-19).
    // A context the dry run switched and left behind would flag the rightful signer's refusal as re-use (EBMR-IAM-091)
    // and raise a HIGH alert against them.
    expect(await loggedFailures(server, challengeId)).toEqual([
      { code: 'UNKNOWN:ENG-STALE', event: rows.at(-1)?.auth_event_id, event_person: personaIn(server, 'verifier1').personId, for_challenge: true, misuse: null, uses: 'COMMAND' },
    ]);
    expect(await signingAlerts(server, challengeId)).toEqual([]);
    expect(await violations(server)).toEqual([]);
    // Signing again at the current version works.
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('LINE_CLEARANCE_VERIFIED');
  }, 180_000);

  it('[DI-36][DI-34] P41: the timeline never labels a dry run refused before signing as signed; signed rows name their meaning', async () => {
    const d = await driver();
    await staleVerify(d);
    const tl = valueOf(await d.browser('verifier1').call(routes.execution.timeline, { params: { runId: d.runId } })).entries;
    const refused = tl.at(-1);
    expect(refused).toMatchObject({ kind: 'COMMAND', accepted: false });
    expect(refused?.summary).not.toMatch(/\(signed /);
    // The timeline names the step by its number and name (lead TODO T4), not by its key.
    const clear = (await d.stepView('verifier1', CLEAR)).step;
    const named = `step ${clear.number} ${clear.title}`;
    expect(refused?.summary).toBe(`VERIFY ${named} (refused before signing: nothing was signed)`);
    expect(refused?.refusal).toBeTruthy();
    // An accepted signed row still names the meaning it was signed with.
    expect(tl.find((e) => e.kind === 'COMMAND' && e.accepted && e.summary.startsWith('SIGN_PERFORMED'))?.summary).toBe(`SIGN_PERFORMED ${named} (signed LINE_CLEARANCE_PERFORMED)`);
  }, 180_000);

  it('[INV-10] a failure after the seal rolls back the signature, the seal and the run row together', async () => {
    const d = await driver();
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
    if (!handler) throw new Error('ENGINE_COMMAND is not registered');
    const original = handler.apply.bind(handler);
    handler.apply = async (...args) => {
      await original(...args);
      throw new Error('simulated failure after apply (test)');
    };
    const commands = async () => (await rowsOf(server, d.runId)).filter((x) => x.kind === 'COMMAND').length;
    try {
      const before = await commands();
      const state = await stateOf(d);
      const r = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
      expect(r.stage).toBe('sign');
      expect(r.result.ok).toBe(false);
      expect(await signatureCount(d)).toBe(0);
      const after = await stateOf(d);
      expect(after.version).toBe(state.version);
      expect(after.steps[CLEAR]?.status).toBe('IN_PROGRESS');
      // Only the challenge's PREPARE row (committed with the challenge) may exist; no command row of the sign.
      expect(await commands()).toBe(before);
    } finally {
      handler.apply = original;
    }
    // Signing again works.
    valueOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR })).result);
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});

describe('exception dispositions (PR-49; Part 11 signature and record linking)', () => {
  async function withAlert(): Promise<{ d: RunDriver; exception: string }> {
    const d = await driver();
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const run = await d.runView('qa1');
    const e = run.exceptions[0];
    if (!e) throw new Error('no exception');
    return { d, exception: e.exceptionId };
  }

  it('[DI-37][PR-49][INV-03] the proposed outcome and justification are in the signed content; the same QA reviewer prepares and signs', async () => {
    const { d, exception } = await withAlert();
    const justification = 'Reprint reconciled; no impact on the batch.';
    const r = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification });
    if (!r.content.ok) throw new Error('no preview');
    expect(r.content.value.rendering).toMatchObject({ kind: 'batch_exception', disposition: { proposed: { outcome: 'NO_IMPACT', justification, deviationRef: null } } });
    const envelope = JSON.parse(r.content.value.canonicalText) as { content: { proposedDisposition: unknown } };
    expect(envelope.content.proposedDisposition).toEqual({ outcome: 'NO_IMPACT', justification, deviationRef: null });
    const signed = valueOf(r.result);
    expect(signed.manifestation).toMatchObject({ meaning: 'EXCEPTION_DISPOSITIONED', aggregateType: 'batch_exception', valid: true, contentHash: r.content.value.contentHash });
    // The kernel's content for the record includes the proposal exactly as signed.
    const k = await esig.contentForSigning(server.db.admin, 'batch_exception', `${d.runId}:${exception}`);
    expect(k.contentHash).toBe(signed.manifestation.contentHash);
    expect(sha256Hex(canonicalJson(JSON.parse(k.canonical ?? '{}')))).toBe(k.contentHash);
    expect((await stateOf(d)).exceptions[exception]).toMatchObject({ status: 'DISPOSITIONED', disposition: { outcome: 'NO_IMPACT', justification } });
    // Proposing is not a change of the exception's data: the reviewer is not an enterer (esig content_change).
    const { rows } = await server.db.admin.query('select 1 from esig.content_change where aggregate_ref = $1 and person_id = $2', [`batch_exception:${d.runId}:${exception}`, d.server.seed.personas.find((p) => p.key === 'qa1')?.personId]);
    expect(rows).toHaveLength(0);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-37][PR-49] a justification changed between the challenge and the signature is refused; nothing is signed', async () => {
    const { d, exception } = await withAlert();
    const intent = { type: 'DISPOSITION_EXCEPTION' as const, exception, outcome: 'NO_IMPACT' as const, justification: 'Reviewed: no impact.' };
    const r = await d.sign('qa1', intent, { signAction: { ...intent, justification: 'Reviewed again: no impact at all.' } });
    expect(outcomeOf(r.result)).toBe('409:EBMR-EXE-086');
    expect(refusalOf(r.result)).toMatchObject({ kind: 'CONTENT_CHANGED' });
    expect(await signatureCount(d)).toBe(0);
    expect((await stateOf(d)).exceptions[exception]?.status).toBe('OPEN');
    // A preview of another justification than the one challenged is refused as changed content (EBMR-ESIG-013).
    const other = await d.sign('qa1', intent, { proposal: { outcome: 'NO_IMPACT', justification: 'A different text' } });
    expect(outcomeOf(other.result)).toMatch(/^4\d\d:/);
  }, 180_000);
});

describe('hold-point decisions (PR-45)', () => {
  it('[PR-45][DI-35] release and reject are separate actions with their own meanings; the reject path is signed HOLD_POINT_NOT_RELEASED; a mismatched meaning is refused', async () => {
    const d = await driver(withEarlyHoldPoint());
    await performClearance(d);
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const view = await d.stepView('qa1', 'H-TEST@');
    expect(view.actions.filter((a) => a.action === 'DISPOSITION_HOLD_POINT').map((a) => [a.target, a.meaning, a.available]), JSON.stringify(view.actions)).toEqual([
      ['APPROVED', 'HOLD_POINT_RELEASED', true],
      ['NOT_APPROVED', 'HOLD_POINT_NOT_RELEASED', true],
    ]);
    const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
    const reject = { type: 'DISPOSITION_HOLD_POINT' as const, stepKey: 'H-TEST@', disposition: 'NOT_APPROVED' };
    expect(handler?.describe({ kind: 'ENGINE_COMMAND', runId: d.runId, expectedVersion: 0, intent: reject }).meaning).toBe('HOLD_POINT_NOT_RELEASED');
    // The decision is previewed as signed content (P26, P38); the challenge asks for the other class's meaning.
    const wrong = await signDecision(d, 'qa1', reject, { meaning: 'HOLD_POINT_RELEASED' });
    expect({ stage: wrong.stage, ok: wrong.result.ok }).toEqual({ stage: 'challenge', ok: false });
    expect(await signatureCount(d)).toBe(2);
    const signed = valueOf((await signDecision(d, 'qa1', reject)).result);
    expect(signed.manifestation.meaning).toBe('HOLD_POINT_NOT_RELEASED');
    const state = await stateOf(d);
    expect(state.steps['H-TEST@']?.disposition).toMatchObject({ value: 'NOT_APPROVED', positive: false });
    expect(state.steps['p-disp-bal@']).toBeUndefined();
    expect(Object.values(state.exceptions).map((e) => e.type)).toContain('HOLD_POINT_NOT_APPROVED');
    expect(await violations(server)).toEqual([]);
  }, 180_000);
});

describe('witnessing', () => {
  it('[DI-35][PR-14] a witness signs while the act can still be watched; once the run moved on the witness is refused (act.next_step_started)', async () => {
    const d = await driver(withWitnessedClearance());
    await performClearance(d);
    const provider = async () => (await server.db.admin.query<{ c: { act?: { next_step_started?: boolean } } }>('select recipe.batch_step_content($1) as c', [`${d.runId}:${CLEAR}`])).rows[0]?.c;
    expect((await provider())?.act?.next_step_started).toBe(false);
    // The balance check (a parallel branch) starts: the run moved on after the act.
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
    expect((await provider())?.act?.next_step_started).toBe(true);
    expect(engine.nextStepStarted(await stateOf(d), CLEAR)).toBe(true);
    const r = await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' });
    // Engine 1.5.0 (T12.LATE): no witness is possible any more, so the step's check is its later review and a witness is
    // a meaning mismatch at the challenge (it was EBMR-EXE-081 before); nothing is signed.
    expect({ stage: r.stage, outcome: outcomeOf(r.result) }).toEqual({ stage: 'challenge', outcome: '422:EBMR-EXE-080' });
    expect(await signatureCount(d)).toBe(1);
    // The later review (the block's own check) completes the step and records WITNESS_LATE, which only QA dispositions.
    const reviewed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result);
    expect(reviewed.manifestation.meaning).toBe('LINE_CLEARANCE_VERIFIED');
    const state = await stateOf(d);
    expect(state.steps[CLEAR]?.status).toBe('COMPLETED');
    expect(Object.values(state.exceptions).filter((e) => e.type === 'WITNESS_LATE').map((e) => ({ qaOnly: e.qaOnly, stepKey: e.source.stepKey, status: e.status }))).toEqual([{ qaOnly: true, stepKey: CLEAR, status: 'OPEN' }]);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-35] a timely witness on the terminal of the act is accepted', async () => {
    const d = await driver(withWitnessedClearance());
    await performClearance(d);
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' })).result);
    expect(signed.manifestation.meaning).toBe('WITNESSED');
    expect((await stateOf(d)).steps[CLEAR]?.status).toBe('COMPLETED');
  }, 180_000);
});

describe('superseded signatures (INV-09)', () => {
  it('[INV-09][DI-37] data recorded after a PERFORMED signature on a step still in progress supersedes it in the kernel and in the engine alike', async () => {
    const d = await driver(dcMini(), ['operator1', 'operator2']);
    const op2 = await server.asPersona('operator2', 'TEST-KIOSK-DISP-1');
    const d2 = new RunDriver(server, d.runId, { operator1: d.browser('operator1'), operator2: op2 });
    d2.beforeTap = d.beforeTap;
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', clearance[0] as Parameters<RunDriver['ok']>[1]);
    await d2.ok('operator2', clearance[1] as Parameters<RunDriver['ok']>[1]);
    const first = valueOf((await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR })).result);
    let state = await stateOf(d);
    expect(state.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    // operator2 records more data: the step's content changes, so operator1's PERFORMED no longer covers it.
    await d2.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-Y', batchNumber: 'TEST-B26-9998' } });
    const kernel = (await esig.getManifestation(server.db.admin, first.manifestation.signatureId)).valid;
    state = await stateOf(d);
    const engineValid = engine.engineSignatures(state).get(first.manifestation.signatureId)?.valid;
    expect(kernel).toBe(false);
    expect(engineValid).toBe(false);
    const view = await d.stepView('operator1', CLEAR);
    expect(view.signatures.find((s) => s.signatureId === first.manifestation.signatureId)?.valid).toBe(false);
    expect(await violations(server)).toEqual([]);
    expect(valueOf(await d.browser('operator1').call(routes.execution.verifyReplay, { params: { runId: d.runId }, body: {} })).identical).toBe(true);
  }, 180_000);
});
