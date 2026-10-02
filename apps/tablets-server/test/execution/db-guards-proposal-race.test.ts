/**
 * Phase 2 exit review F37 (executed attacks; INV-09, DI-37, PR-49, PR-45; ADR 0012): a decision proposed while a signed
 * decision commits never lands on the signed content version.
 *
 * Before recipe-core 0309, recipe.propose_disposition and recipe.propose_hold_point_decision took no lock that
 * serialises them with a signing of the same batch. A second QA user's correctly attributed proposal, run through the
 * store (the application role, here ebmr_sandbox) while the first QA user's signing transaction was open, read the
 * record as still undecided and inserted its proposal at the content version that signing had just signed. The
 * accepted signature then read CONTENT_MISMATCH and the signed content named the other user's decision. Now the
 * proposal waits for the batch's lock, then finds the record decided and is refused (EBMR-EXE-084); the signature stays
 * VALID. And a proposal on a content version a decision was already signed on is refused even without the race.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes } from '@ebmr/api-contract';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { tapFor } from '../esig/support.ts';
import { actorOf, messageOf, prepareSignature } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, pinOf, RunDriver, startExecServer, valueOf, withEarlyHoldPoint, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
  await grantRole('steward', 'QA_SHOP_FLOOR');
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const A = { outcome: 'NO_IMPACT' as const, justification: 'Reprint reconciled by QA1; no impact on the batch.' };
const B = { outcome: 'NO_IMPACT' as const, justification: 'QA2: a different justification proposed during the signing.' };

/** `key` also holds `roleCode` (requested by the administrator, approved by the owner). */
async function grantRole(key: string, roleCode: string): Promise<void> {
  const who = personaIn(sbx, key);
  const reason = { reasonCode: 'TEST_SETUP', reasonText: `F37: ${key} also holds ${roleCode}` };
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
  const grantId = await withCommand(sbx.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode, scope: {}, reason: reason.reasonText }));
  const owner = await passwordActor(sbx.db, sbx.seed.bootstrap.owner, sbx.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
  await withCommand(sbx.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'F37 set-up'));
}

/** The second QA user (the steward, also holding QA_SHOP_FLOOR) in an office session of their own. */
async function qa2Actor() {
  const office = await openPersonaSession(sbx.db, sbx.seed, 'steward');
  return { ...office, roleCode: 'QA_SHOP_FLOOR', correlationId: randomUUID() };
}

async function lockWaits(): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
  return Number(rows[0]?.n ?? '0');
}

/**
 * Wraps the server's signing dry run: once the first signer's dry run returns (its transaction holds the batch's lock,
 * before esig.sign), `second` starts, and the signing goes on only when `second` has finished or waits for a lock.
 */
function duringSigning(second: () => Promise<unknown>) {
  const handler = sbx.built.ctx.signables.forKind('ENGINE_COMMAND');
  if (!handler) throw new Error('SETUP: no ENGINE_COMMAND handler');
  const original = handler.dryRun.bind(handler);
  const out = { state: 'not started', waited: false, done: undefined as Promise<unknown> | undefined };
  handler.dryRun = async (client, ctx, action) => {
    const r = await original(client, ctx, action);
    if (out.state === 'not started') {
      out.state = 'running';
      out.done = second().then(
        () => (out.state = 'committed'),
        (e: unknown) => (out.state = `refused: ${e instanceof Error ? e.message : String(e)}`),
      );
      for (let i = 0; i < 200 && out.state === 'running' && (await lockWaits()) === 0; i += 1) await new Promise((res) => setTimeout(res, 25));
      out.waited = out.state === 'running';
    }
    return r;
  };
  return { out, restore: () => (handler.dryRun = original) };
}

async function signatureStates(aggregateId: string): Promise<string[]> {
  const { rows } = await sbx.db.admin.query<{ s: string }>(
    "select s.meaning_code || '@' || s.content_version || ':' || (esig.signature_state(s.id) ->> 'status') as s from esig.signature s where s.aggregate_id = $1 order by s.recorded_at",
    [aggregateId],
  );
  return rows.map((r) => r.s);
}

async function withException(): Promise<{ d: RunDriver; exception: string }> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
  const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
  if (!exception) throw new Error('SETUP: no exception');
  return { d, exception };
}

describe('F37: a proposed decision never lands on a signed content version (INV-09, DI-37)', () => {
  it('[INV-09][DI-37][PR-49] a disposition proposed through the store while QA1\'s signed disposition commits waits for it and is refused; QA1\'s signature stays VALID over its own disposition', async () => {
    const { d, exception } = await withException();
    const aggregateId = `${d.runId}:${exception}`;
    const b = d.browser('qa1');
    const intent = { type: 'DISPOSITION_EXCEPTION' as const, exception, ...A };
    const preview = `EXCEPTION_DISPOSITIONED|${Buffer.from(JSON.stringify(A), 'utf8').toString('base64url')}`;
    const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: 'batch_exception', aggregateId, intent: preview } }));
    const action = { kind: 'ENGINE_COMMAND' as const, runId: d.runId, expectedVersion: await d.version('qa1'), intent };
    const body = { aggregateType: 'batch_exception', aggregateId, contentVersion: content.contentVersion, meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: sha256Hex(content.canonicalText), action };
    vi.advanceTimersByTime(7_000);
    const ch = valueOf(await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, personaIn(sbx, 'qa1'), 'POST', '/api/esig/challenges', body) }));

    const actor = await qa2Actor();
    const race = duringSigning(() => withCommand(sbx.db.app, actor, (c) => execution.proposeDisposition(c, d.runId, exception, { ...B, deviationRef: null })));
    let signed;
    try {
      const signBody = { challengeId: ch.challengeId, credentials: pinOf(sbx, 'qa1'), action };
      const proof = await b.proof('POST', '/api/esig/sign', signBody);
      signed = await b.call(routes.esig.sign, { body: { ...signBody, proof } });
    } finally {
      race.restore();
    }
    await race.out.done;

    expect(signed.ok).toBe(true);
    expect(race.out.waited, 'the second proposal waited for the signing').toBe(true);
    expect(race.out.state).toMatch(new RegExp(`^refused: Exception ${exception} is already dispositioned \\(DI-26\\)\\. \\[EBMR-EXE-084\\]`));
    const st = await execution.loadState(sbx.db.admin, d.runId);
    expect(st?.state.exceptions[exception]?.disposition?.justification).toBe(A.justification);
    expect(await signatureStates(aggregateId)).toEqual(['EXCEPTION_DISPOSITIONED@1:VALID']);
    const now = await esig.contentForSigning(sbx.db.admin, 'batch_exception', aggregateId);
    expect((JSON.parse(now.canonical ?? '{}') as { content?: { proposedDisposition?: { justification?: string } } }).content?.proposedDisposition?.justification).toBe(A.justification);
    const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.verify_signatures()');
    expect(rows[0]?.n).toBe('0');
  }, 300_000);

  it('[INV-09][DI-37][PR-45] a hold-point decision proposed through the store while QA1\'s release commits waits for it and is refused; the release stays VALID over APPROVED', async () => {
    const CLEAR = 'p-disp-clear@';
    const HOLD = 'H-TEST@';
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyHoldPoint()));
    const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9998' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const aggregateId = `${runId}:${HOLD}`;

    const actor = await qa2Actor();
    const race = duringSigning(() =>
      withCommand(sbx.db.app, actor, (c) => c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [runId, HOLD, JSON.stringify({ disposition: 'NOT_APPROVED', comment: 'QA2: booth not released' })])),
    );
    let r;
    try {
      r = await d.sign('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: HOLD, disposition: 'APPROVED' });
    } finally {
      race.restore();
    }
    await race.out.done;

    expect(r.result.ok).toBe(true);
    expect(race.out.waited, 'the second proposal waited for the signing').toBe(true);
    expect(race.out.state).toMatch(/^refused: Hold point H-TEST@ is not waiting for a decision \(PR-45\)\. \[EBMR-EXE-084\]/);
    const st = await execution.loadState(sbx.db.admin, runId);
    expect(st?.state.steps[HOLD]?.disposition?.value).toBe('APPROVED');
    expect((await signatureStates(aggregateId)).filter((s) => s.startsWith('HOLD_POINT_'))).toEqual(['HOLD_POINT_RELEASED@1:VALID']);
    const now = await esig.contentForSigning(sbx.db.admin, 'batch_step', aggregateId);
    expect((JSON.parse(now.canonical ?? '{}') as { content?: { proposedDecision?: unknown } }).content?.proposedDecision).toEqual({ disposition: 'APPROVED', comment: null });
  }, 300_000);

  it('[INV-09][DI-37][PR-49] a disposition is never proposed on a content version a disposition was already signed on, even with the exception still open', async () => {
    const { d, exception } = await withException();
    const aggregateId = `${d.runId}:${exception}`;
    const propose = async (actor: Promise<ActorContext>, proposal: typeof A): Promise<string> =>
      messageOf(withCommand(sbx.db.app, await actor, (c) => execution.proposeDisposition(c, d.runId, exception, { ...proposal, deviationRef: null })));
    expect(await propose(actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), A)).toBe('ok');
    // QA1 signs the proposed disposition in a transaction that commits without recording it: the signature stands,
    // unused, and the exception is still open.
    const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
    await withCommand(sbx.db.app, await signing.actor(), (c) => signing.sign(c));
    expect(await signatureStates(aggregateId)).toEqual(['EXCEPTION_DISPOSITIONED@1:VALID']);
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception]?.status).toBe('OPEN');
    // Another proposal on that version would change what the signature covers: refused, and the signature stays VALID.
    expect(await propose(qa2Actor(), B)).toMatch(new RegExp(`A disposition of exception ${exception} is already signed on content version 1; no other is proposed on it \\(INV-09, DI-37\\)\\. \\[EBMR-EXE-084\\]`));
    expect(await signatureStates(aggregateId)).toEqual(['EXCEPTION_DISPOSITIONED@1:VALID']);
  }, 300_000);
});
