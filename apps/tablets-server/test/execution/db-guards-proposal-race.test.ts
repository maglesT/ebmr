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
 *
 * F37.R (the completeness critic's F37 defect; recipe-core 0329): 0309 serialised the proposals only on the batch's row
 * lock, which a signing takes only on the server's path. esig.sign takes the record's own signing lock
 * (esig.aggregate_lock), which the proposals never took, and the content providers lock nothing. So a signer holding
 * the application role, signing without the batch's lock and keeping its transaction open, let another QA user's
 * proposal commit on the signed content version (the uncommitted signature was invisible to 0309's check): the
 * signature then read CONTENT_MISMATCH, which only esig.verify_signatures noticed. Now both proposal functions take that
 * lock too, after the batch's: on two connections, a proposal made while such a signing is open waits for it and is
 * refused, and a signing asked for while such a proposal is open waits for it and is refused because the record
 * changed (EBMR-ESIG-012).
 *
 * F37.R round 2 (recipe-core 0331, kernel 1020; the round-4 verification): those waits serialise only in READ COMMITTED.
 * Under REPEATABLE READ or SERIALIZABLE a transaction reads the snapshot of its first statement, taken before the wait:
 * the steward's proposal in REPEATABLE READ waited for the outside signer, then committed on the signed content version,
 * and QA1's signing in REPEATABLE READ waited for the open proposal, then signed the content its snapshot showed; both
 * signatures read CONTENT_MISMATCH. Now the proposals refuse any isolation level but READ COMMITTED (EBMR-EXE-084), and
 * the kernel's signing lock, which esig.sign and every change of signed content take, does the same (EBMR-ESIG-015):
 * in both orders, at both levels, for an exception and a hold point, no signature covers content its record no longer
 * has; nor does a change of an exception's signed content made under REPEATABLE READ after a signing committed leave
 * that signature unsuperseded.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes } from '@ebmr/api-contract';
import { esig, identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, type engine } from '@ebmr/recipe-core';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { tapFor } from '../esig/support.ts';
import { actorOf, appendAs, engineResult, messageOf, prepareSignature } from './db-guards-support.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
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


/**
 * Runs `p` (a command on its own connection) and returns once it has settled or a backend of the test database waits
 * for a lock (the other connection's transaction is still open): whether it waited, and its outcome once settled.
 */
async function waitingOrDone(p: Promise<unknown>): Promise<{ waited: boolean; state: () => string; done: Promise<void> }> {
  let state = 'running';
  const done = p.then(
    () => void (state = 'committed'),
    (e: unknown) => void (state = `refused: ${e instanceof Error ? e.message : String(e)}`),
  );
  for (let i = 0; i < 200 && state === 'running' && (await lockWaits()) === 0; i += 1) await new Promise((res) => setTimeout(res, 25));
  return { waited: state === 'running', state: () => state, done };
}

/** A dc-mini run with a QA hold point after the clearance, the clearance done: the hold point waits for its decision. */
async function atHoldPoint(): Promise<{ d: RunDriver; runId: string }> {
  const CLEAR = 'p-disp-clear@';
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, withEarlyHoldPoint()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9997' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  return { d, runId };
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

  it('[INV-09][DI-37][PR-49] F37.R: on two connections, a disposition proposed while a signer outside the server\'s path (no batch lock) keeps its signed transaction open waits for it and is refused; the signature, committed after, stays VALID', async () => {
    const { d, exception } = await withException();
    const aggregateId = `${d.runId}:${exception}`;
    const proposeOn = (c: Parameters<typeof execution.proposeDisposition>[0], proposal: typeof A) => execution.proposeDisposition(c, d.runId, exception, { ...proposal, deviationRef: null });
    expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(c, A)))).toBe('ok');
    const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
    const qa2 = await qa2Actor();
    let second: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
    // Connection 1: QA1 signs and keeps the transaction open, never taking the batch's lock. Connection 2: QA2 proposes.
    await withCommand(sbx.db.app, await signing.actor(), async (c) => {
      await signing.sign(c);
      second = await waitingOrDone(withCommand(sbx.db.app, qa2, (c2) => proposeOn(c2, B)));
    });
    await second?.done;
    expect({ waited: second?.waited, state: second?.state() }).toEqual({
      waited: true,
      state: expect.stringMatching(new RegExp(`^refused: A disposition of exception ${exception} is already signed on content version 1; no other is proposed on it \\(INV-09, DI-37\\)\\. \\[EBMR-EXE-084\\]`)) as unknown,
    });
    expect(await signatureStates(aggregateId)).toEqual(['EXCEPTION_DISPOSITIONED@1:VALID']);
    const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.verify_signatures()');
    expect(rows[0]?.n).toBe('0');
  }, 300_000);

  it('[INV-09][DI-37][PR-49] F37.R: on two connections, a signing asked for while another QA user\'s proposal is open waits for it, then is refused because the record changed (EBMR-ESIG-012); no signature covers content it does not have', async () => {
    const { d, exception } = await withException();
    const aggregateId = `${d.runId}:${exception}`;
    const proposeOn = (c: Parameters<typeof execution.proposeDisposition>[0], proposal: typeof A) => execution.proposeDisposition(c, d.runId, exception, { ...proposal, deviationRef: null });
    expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(c, A)))).toBe('ok');
    const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
    const signer = await signing.actor();
    let first: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
    // Connection 2: QA2's proposal, transaction open. Connection 1: QA1 signs (outside the server's path).
    await withCommand(sbx.db.app, await qa2Actor(), async (c2) => {
      await proposeOn(c2, B);
      first = await waitingOrDone(withCommand(sbx.db.app, signer, (c) => signing.sign(c)));
    });
    await first?.done;
    expect({ waited: first?.waited, state: first?.state() }).toEqual({
      waited: true,
      state: expect.stringMatching(/^refused: EBMR-ESIG-012 the record changed after the challenge was issued/) as unknown,
    });
    expect(await signatureStates(aggregateId)).toEqual([]);
    const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.verify_signatures()');
    expect(rows[0]?.n).toBe('0');
  }, 300_000);

  it('[INV-09][DI-37][PR-45] F37.R: on two connections, a hold-point decision proposed while a release signed outside the server\'s path is open waits for it and is refused; the release, committed after, stays VALID over APPROVED', async () => {
    const { d, runId } = await atHoldPoint();
    const HOLD = 'H-TEST@';
    const aggregateId = `${runId}:${HOLD}`;
    const proposeOn = (c: { query: (q: string, v: unknown[]) => Promise<unknown> }, disposition: string, comment: string | null) =>
      c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [runId, HOLD, JSON.stringify({ disposition, comment })]);
    expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(c, 'APPROVED', null)))).toBe('ok');
    const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_step', aggregateId, 'HOLD_POINT_RELEASED');
    const qa2 = await qa2Actor();
    let second: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
    await withCommand(sbx.db.app, await signing.actor(), async (c) => {
      await signing.sign(c);
      second = await waitingOrDone(withCommand(sbx.db.app, qa2, (c2) => proposeOn(c2, 'NOT_APPROVED', 'QA2: booth not released')));
    });
    await second?.done;
    expect({ waited: second?.waited, state: second?.state() }).toEqual({
      waited: true,
      state: expect.stringMatching(/^refused: A decision on hold point H-TEST@ is already signed on content version 1; no other is proposed on it \(INV-09, DI-37, PR-45\)\. \[EBMR-EXE-084\]/) as unknown,
    });
    expect((await signatureStates(aggregateId)).filter((x) => x.startsWith('HOLD_POINT_'))).toEqual(['HOLD_POINT_RELEASED@1:VALID']);
    const now = await esig.contentForSigning(sbx.db.admin, 'batch_step', aggregateId);
    expect((JSON.parse(now.canonical ?? '{}') as { content?: { proposedDecision?: unknown } }).content?.proposedDecision).toEqual({ disposition: 'APPROVED', comment: null });
  }, 300_000);

  const SNAPSHOT_LEVELS = ['repeatable read', 'serializable'] as const;
  type Level = (typeof SNAPSHOT_LEVELS)[number];

  /** `work` in one command of `actor` in a transaction at `level` (its snapshot taken by kernel.begin_command); rolled back on any error. */
  async function withCommandAt<T>(actor: ActorContext, level: Level, work: (c: Parameters<Parameters<typeof withCommand>[2]>[0]) => Promise<T>): Promise<T> {
    const c = await sbx.db.app.connect();
    try {
      await c.query(`begin isolation level ${level}`);
      await c.query("set local statement_timeout = '60s'");
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
      const result = await work(c);
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  async function signatureProblems(): Promise<string> {
    const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.verify_signatures()');
    return rows[0]?.n ?? '?';
  }

  const proposalRefused = (what: string, level: Level): RegExp =>
    new RegExp(`^refused: A ${what} is proposed only in a READ COMMITTED transaction: under ${level} the proposal would read .*\\. \\[EBMR-EXE-084\\]$`);
  const signingRefused = (level: Level): RegExp => new RegExp(`^refused: EBMR-ESIG-015 a signature, and a change of signed content, are made only in a READ COMMITTED transaction: under ${level} `);

  it('[INV-09][DI-37][PR-49] F37.R round 2: on two connections, a disposition proposed in REPEATABLE READ or SERIALIZABLE while a signer outside the server\'s path keeps its signed transaction open is refused (EBMR-EXE-084); the signature, committed after, stays VALID', async () => {
    const out: Record<string, unknown> = {};
    for (const level of SNAPSHOT_LEVELS) {
      const { d, exception } = await withException();
      const aggregateId = `${d.runId}:${exception}`;
      const proposeOn = (c: Parameters<typeof execution.proposeDisposition>[0], proposal: typeof A) => execution.proposeDisposition(c, d.runId, exception, { ...proposal, deviationRef: null });
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(c, A)))).toBe('ok');
      const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
      const qa2 = await qa2Actor();
      let second: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
      // Connection 1: QA1 signs outside the server's path (no batch lock), transaction open. Connection 2: QA2 proposes at `level`.
      await withCommand(sbx.db.app, await signing.actor(), async (c) => {
        await signing.sign(c);
        second = await waitingOrDone(withCommandAt(qa2, level, (c2) => proposeOn(c2, B)));
      });
      await second?.done;
      out[level] = { proposal: second?.state(), signatures: await signatureStates(aggregateId), problems: await signatureProblems() };
    }
    expect(out).toEqual(Object.fromEntries(SNAPSHOT_LEVELS.map((level) => [level, {
      proposal: expect.stringMatching(proposalRefused('disposition of exception EX-\\d+', level)) as unknown,
      signatures: ['EXCEPTION_DISPOSITIONED@1:VALID'],
      problems: '0',
    }])));
  }, 300_000);

  it('[INV-09][DI-37][PR-49] F37.R round 2: on two connections, a signing in REPEATABLE READ or SERIALIZABLE asked for while another QA user\'s proposal is open is refused (EBMR-ESIG-015) instead of signing the content its snapshot shows; no signature covers content the record does not have', async () => {
    const out: Record<string, unknown> = {};
    for (const level of SNAPSHOT_LEVELS) {
      const { d, exception } = await withException();
      const aggregateId = `${d.runId}:${exception}`;
      const proposeOn = (c: Parameters<typeof execution.proposeDisposition>[0], proposal: typeof A) => execution.proposeDisposition(c, d.runId, exception, { ...proposal, deviationRef: null });
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(c, A)))).toBe('ok');
      const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
      const signer = await signing.actor();
      let first: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
      // Connection 2: QA2's proposal (READ COMMITTED), transaction open. Connection 1: QA1 signs at `level`, outside the server's path.
      await withCommand(sbx.db.app, await qa2Actor(), async (c2) => {
        await proposeOn(c2, B);
        first = await waitingOrDone(withCommandAt(signer, level, (c) => signing.sign(c)));
      });
      await first?.done;
      out[level] = { signing: first?.state(), signatures: await signatureStates(aggregateId), problems: await signatureProblems() };
    }
    expect(out).toEqual(Object.fromEntries(SNAPSHOT_LEVELS.map((level) => [level, { signing: expect.stringMatching(signingRefused(level)) as unknown, signatures: [], problems: '0' }])));
  }, 300_000);

  it('[INV-09][DI-37][PR-45] F37.R round 2: on two connections, for a hold point, a decision proposed in REPEATABLE READ or SERIALIZABLE while a release signed outside the server\'s path is open is refused (EBMR-EXE-084), and a release signed in REPEATABLE READ or SERIALIZABLE while a proposal is open is refused (EBMR-ESIG-015); the committed release stays VALID over APPROVED', async () => {
    const HOLD = 'H-TEST@';
    const out: Record<string, unknown> = {};
    for (const level of SNAPSHOT_LEVELS) {
      const proposeOn = (runId: string, c: { query: (q: string, v: unknown[]) => Promise<unknown> }, disposition: string, comment: string | null) =>
        c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [runId, HOLD, JSON.stringify({ disposition, comment })]);
      // Signing first: the release is open, the steward proposes at `level`.
      const first = await atHoldPoint();
      const agg1 = `${first.runId}:${HOLD}`;
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, first.d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(first.runId, c, 'APPROVED', null)))).toBe('ok');
      const release = await prepareSignature(sbx, first.d.browser('qa1'), 'qa1', 'batch_step', agg1, 'HOLD_POINT_RELEASED');
      const qa2 = await qa2Actor();
      let proposal: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
      await withCommand(sbx.db.app, await release.actor(), async (c) => {
        await release.sign(c);
        proposal = await waitingOrDone(withCommandAt(qa2, level, (c2) => proposeOn(first.runId, c2, 'NOT_APPROVED', 'QA2: booth not released')));
      });
      await proposal?.done;
      const content = await esig.contentForSigning(sbx.db.admin, 'batch_step', agg1);
      // Proposal first: the steward's proposal is open, QA1 signs the release at `level`.
      const second = await atHoldPoint();
      const agg2 = `${second.runId}:${HOLD}`;
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, second.d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => proposeOn(second.runId, c, 'APPROVED', null)))).toBe('ok');
      const release2 = await prepareSignature(sbx, second.d.browser('qa1'), 'qa1', 'batch_step', agg2, 'HOLD_POINT_RELEASED');
      const signer = await release2.actor();
      let signing: Awaited<ReturnType<typeof waitingOrDone>> | undefined;
      await withCommand(sbx.db.app, await qa2Actor(), async (c2) => {
        await proposeOn(second.runId, c2, 'NOT_APPROVED', 'QA2: booth not released');
        signing = await waitingOrDone(withCommandAt(signer, level, (c) => release2.sign(c)));
      });
      await signing?.done;
      out[level] = {
        proposal: proposal?.state(),
        released: (await signatureStates(agg1)).filter((x) => x.startsWith('HOLD_POINT_')),
        decision: (JSON.parse(content.canonical ?? '{}') as { content?: { proposedDecision?: unknown } }).content?.proposedDecision,
        signing: signing?.state(),
        unreleased: (await signatureStates(agg2)).filter((x) => x.startsWith('HOLD_POINT_')),
        problems: await signatureProblems(),
      };
    }
    expect(out).toEqual(Object.fromEntries(SNAPSHOT_LEVELS.map((level) => [level, {
      proposal: expect.stringMatching(proposalRefused('decision on hold point H-TEST@', level)) as unknown,
      released: ['HOLD_POINT_RELEASED@1:VALID'],
      decision: { disposition: 'APPROVED', comment: null },
      signing: expect.stringMatching(signingRefused(level)) as unknown,
      unreleased: [],
      problems: '0',
    }])));
  }, 300_000);

  it('[INV-09][DI-37][PR-49] F37.R round 2: on two connections, a change of an exception\'s signed content made in REPEATABLE READ or SERIALIZABLE after a disposition was signed and committed is refused (EBMR-ESIG-015) instead of leaving that signature unsuperseded', async () => {
    const out: Record<string, unknown> = {};
    for (const level of SNAPSHOT_LEVELS) {
      const issuer = await sbx.asPersona('issuer');
      const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
      const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), qa1: await sbx.asPersona('qa1'), supervisor1: await sbx.asPersona('supervisor1') });
      d.beforeTap = () => vi.advanceTimersByTime(7_000);
      await d.ok('operator1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
      const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId ?? '';
      const aggregateId = `${runId}:${exception}`;
      expect(await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1', { roleCode: 'QA_SHOP_FLOOR' }), (c) => execution.proposeDisposition(c, runId, exception, { ...A, deviationRef: null })))).toBe('ok');
      const signing = await prepareSignature(sbx, d.browser('qa1'), 'qa1', 'batch_exception', aggregateId, 'EXCEPTION_DISPOSITIONED');
      const run = await runContext(sbx.db.admin, runId);
      const sup = personaIn(sbx, 'supervisor1');
      const supervisor = await actorOf(sbx, d.browser('supervisor1'), 'supervisor1');
      // Connection 1: the supervisor's transaction at `level`, its snapshot taken. Connection 2: QA1's disposition is
      // signed outside the server's path and committed (not applied: the exception stays open). Connection 1 then links
      // a deviation through the store, which stores a new content version of the exception.
      let snapshotTaken!: () => void;
      const taken = new Promise<void>((res) => (snapshotTaken = res));
      let signed!: () => void;
      const signedNow = new Promise<void>((res) => (signed = res));
      const change = messageOf(
        withCommandAt(supervisor, level, async (c) => {
          snapshotTaken();
          await signedNow;
          const tx = await execution.ExecutionTx.open(c, run.def, runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'ATTACH_DEVIATION', commandId: randomUUID(), actor: engineActor(sup.personId, roles), exception, deviationRef: 'TEST-DEV-0037' };
          return appendAs(tx, command, engineResult(tx, command), roles);
        }),
      );
      await taken;
      await withCommand(sbx.db.app, await signing.actor(), (c) => signing.sign(c));
      signed();
      out[level] = {
        change: await change,
        signatures: await signatureStates(aggregateId),
        deviation: (await execution.loadState(sbx.db.admin, runId))?.state.exceptions[exception]?.deviation ?? null,
        problems: await signatureProblems(),
      };
    }
    expect(out).toEqual(Object.fromEntries(SNAPSHOT_LEVELS.map((level) => [level, {
      change: expect.stringMatching(new RegExp(`^EBMR-ESIG-015 a signature, and a change of signed content, are made only in a READ COMMITTED transaction: under ${level} `)) as unknown,
      signatures: ['EXCEPTION_DISPOSITIONED@1:VALID'],
      deviation: null,
      problems: '0',
    }])));
  }, 300_000);
});
