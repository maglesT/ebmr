/**
 * Test support for module C1 (access, esig, audit): a server with a registered DEMO-ONLY seal key, badge-tap
 * attributions signed with the terminal's seeded key, kernel actor contexts of a browser's own session (so test
 * set-up never opens a second shop-floor session that would supersede it), stub signable entries, the ceremony's
 * two calls (challenge and sign) on a stub entry, what the kernel logged and alerted for a challenge (DI-19), and
 * short refusal descriptions.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { esig, withCommand, type ActorContext } from '@ebmr/kernel';
import { sha256Hex } from '@ebmr/expr';
import { routes, type Attribution, type CallError, type Result, type SignatureCredentials } from '@ebmr/api-contract';
import { freshTap, passwordActor, personaOf, terminalOf, type SeededPersona } from '@ebmr/test-kit';
import { resolveSession, tokenHash } from '../../src/platform/auth/session.ts';
import { esigStubHandler } from '../../src/features/esig/stub.ts';
import { startServer, type ServerOptions, type TestBrowser, type TestServer } from '../support/harness.ts';

export const SEAL_KEY_ID = 'test-c1-hmac-1';

/** A server whose installation has a registered HMAC seal key (DEMO-ONLY), optionally with the ESIG_STUB handler. */
export async function startSigningServer(kind: 'GMP' | 'SANDBOX', opts: ServerOptions & { stub?: boolean } = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-c1-'));
  const file = join(dir, 'seal-key.json');
  const secret = randomBytes(32);
  writeFileSync(file, JSON.stringify({ keyId: SEAL_KEY_ID, algorithm: 'HMAC-SHA256', secret: secret.toString('base64'), label: 'DEMO-ONLY test seal key' }));
  const server = await startServer(kind, { ...opts, env: { ...(opts.env ?? {}), EBMR_SEAL_KEY_FILE: file } });
  const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, {
    reasonCode: 'TEST_SETUP',
    reasonText: 'register the DEMO-ONLY test seal key',
    correlationId: randomUUID(),
  });
  await withCommand(server.db.app, admin, (c) => esig.registerSealKey(c, esig.hmacSealKey(SEAL_KEY_ID, secret), 'DEMO-ONLY test seal key (HMAC-SHA256)'));
  if (opts.stub !== false && !server.built.ctx.signables.forKind('ESIG_STUB')) server.built.ctx.signables.register(esigStubHandler(server.built.ctx));
  return server;
}

export const personaIn = (server: TestServer, key: string): SeededPersona => personaOf(server.seed, key);

/** A badge-tap attribution of `persona` for exactly this request (the proof covers method, path and body). */
export async function tapFor(browser: TestBrowser, persona: SeededPersona, method: string, path: string, body: Record<string, unknown>, pin?: string): Promise<Attribution> {
  if (!persona.badgeUid) throw new Error(`${persona.key} has no badge`);
  return { method: 'BADGE_TAP', badgeUid: persona.badgeUid, ...(pin ? { pin } : {}), proof: await browser.proof(method, path, body) };
}

/** The kernel session behind a browser's cookie. */
export async function sessionOfBrowser(server: TestServer, browser: TestBrowser) {
  const token = browser.cookies.get(server.config.cookies.session);
  if (!token) throw new Error('the browser has no session cookie');
  const s = await resolveSession(server.db.app, tokenHash(token));
  if (!s) throw new Error('the browser session is not bound');
  return s;
}

/** An ActorContext for one command in the browser's own session (a fresh badge tap on kiosks). */
export async function actorOfBrowser(server: TestServer, browser: TestBrowser, personaKey: string, extra: Partial<ActorContext> = {}): Promise<ActorContext> {
  const s = await sessionOfBrowser(server, browser);
  const p = personaIn(server, personaKey);
  const kiosk = s.deviceClass === 'SHARED' || s.deviceClass === 'GRADE_A_B';
  return {
    personId: p.personId,
    accountId: p.accountId,
    roleCode: s.roleCode ?? p.roleCode,
    sessionId: s.sessionId,
    deviceId: s.deviceId,
    source: 'UI',
    siteZone: server.seed.zone,
    legalName: p.legalName,
    correlationId: randomUUID(),
    ...(kiosk ? { authEventId: await freshTap(server.db, server.seed, personaKey, browser.terminal) } : {}),
    ...extra,
  };
}

export interface StubInput {
  kind?: 'STEP' | 'CLEANING_LOG' | 'MASTER_DOCUMENT';
  title?: string;
  value?: string;
  unit?: string;
}

/** A stub signable entry entered by the persona of `browser` (INV-03: that person entered its data). */
export async function createStub(server: TestServer, browser: TestBrowser, personaKey: string, input: StubInput = {}): Promise<string> {
  const actor = await actorOfBrowser(server, browser, personaKey);
  return withCommand(server.db.app, actor, async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into esig.stub_signable (kind, title, value, unit) values ($1, $2, $3, $4) returning id', [
      input.kind ?? 'STEP',
      input.title ?? 'Granulation: binder solution added',
      input.value ?? '12.503',
      input.unit ?? 'kg',
    ]);
    return rows[0]?.id ?? '';
  });
}

/** A correction of a stub entry's value with a reason (DI-24), through the application role. */
export async function correctStub(server: TestServer, browser: TestBrowser, personaKey: string, id: string, value: string): Promise<void> {
  const actor = await actorOfBrowser(server, browser, personaKey, { reasonCode: 'ENTRY_ERROR', reasonText: 'transcription error corrected' });
  await withCommand(server.db.app, actor, (c) => c.query('update esig.stub_signable set value = $2 where id = $1', [id, value]));
}

/** `status:code` of a refused call, or 'ok'. */
export function outcome(r: Result<unknown>): string {
  if (r.ok) return 'ok';
  return describe(r.error);
}

export function describe(e: CallError): string {
  return e.kind === 'REFUSAL' ? `${e.status}:${e.envelope.refusal.code}` : `${e.kind}`;
}

export function refusalOf(r: Result<unknown>) {
  if (r.ok || r.error.kind !== 'REFUSAL') throw new Error(`expected a refusal, got ${r.ok ? 'ok' : r.error.kind}: ${JSON.stringify(r.ok ? r.value : r.error)}`);
  return { status: r.error.status, ...r.error.envelope.refusal, retryable: r.error.envelope.retryable };
}

export function valueOf<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
}

export { terminalOf };

// ---------------------------------------------------------------------------------------------
// The ceremony on a stub entry (plan section 6)

export const CHALLENGE_PATH = '/api/esig/challenges';

/** Step 2: the content, then a challenge for it (on a kiosk attributed by the persona's own tap). */
export async function challengeFor(server: TestServer, b: TestBrowser, personaKey: string, stubId: string, meaning: string, opts: { clientContentHash?: string } = {}) {
  const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stubId, intent: meaning } }));
  const body = {
    aggregateType: 'esig_stub',
    aggregateId: stubId,
    contentVersion: content.contentVersion,
    meaning,
    clientContentHash: opts.clientContentHash ?? sha256Hex(content.canonicalText),
    action: { kind: 'ESIG_STUB' as const, stubId },
  };
  const kiosk = b.terminal.includes('KIOSK');
  const r = await b.call(routes.esig.createChallenge, { body, ...(kiosk ? { attribution: await tapFor(b, personaIn(server, personaKey), 'POST', CHALLENGE_PATH, body) } : {}) });
  return { content, r };
}

/** Step 3: sign the challenge (the proof from `proofFrom`, default the browser itself). */
export async function sign(b: TestBrowser, challengeId: string, stubId: string, credentials: SignatureCredentials, proofFrom?: TestBrowser, idempotencyKey?: string) {
  const body = { challengeId, credentials, action: { kind: 'ESIG_STUB' as const, stubId } };
  const proof = await (proofFrom ?? b).proof('POST', '/api/esig/sign', body);
  return b.call(routes.esig.sign, { body: { ...body, proof }, ...(idempotencyKey ? { idempotencyKey } : {}) });
}

export const pinOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PIN', pin: personaIn(server, key).pin ?? '' });
export const passwordOf = (server: TestServer, key: string): SignatureCredentials => ({
  kind: 'PASSWORD',
  loginName: personaIn(server, key).loginName,
  password: personaIn(server, key).password,
});

export async function signatureRows(server: TestServer, stubId: string): Promise<{ meaning_code: string; signer_person: string }[]> {
  return (
    await server.db.admin.query<{ meaning_code: string; signer_person: string }>(
      "select meaning_code, signer_person from esig.signature where aggregate_ref = 'esig_stub:' || $1 order by recorded_at",
      [stubId],
    )
  ).rows;
}

// ---------------------------------------------------------------------------------------------
// What the kernel logged and alerted for a challenge (DI-19)

export interface LoggedFailure {
  code: string;
  event: string | null;
  event_person: string | null;
  for_challenge: boolean | null;
  misuse: string | null;
  uses: string;
}

/**
 * The signing-failure log of a challenge with the authentication event each entry names (DI-19): whose it is,
 * whether it was made for this challenge, what the kernel's misuse check found and the event's committed uses. The
 * code is the kernel's, or UNKNOWN: and the first word of the message for other refusals.
 */
export async function loggedFailures(server: TestServer, challengeId: string): Promise<LoggedFailure[]> {
  const { rows } = await server.db.admin.query<LoggedFailure & { message: string }>(
    `select f.code, f.message, f.auth_event_id::text as event, e.person_id::text as event_person, (e.challenge_id = f.challenge_id) as for_challenge,
            f.misuse_code as misuse,
            coalesce((select string_agg(u.use_kind, ',' order by u.use_kind) from iam.auth_event_use u where u.auth_event_id = f.auth_event_id), '') as uses
       from esig.signing_failure f left join iam.auth_event e on e.id = f.auth_event_id
      where f.challenge_id = $1
      order by f.id`,
    [challengeId],
  );
  return rows.map(({ message, ...r }) => ({ ...r, code: r.code === 'UNKNOWN' ? `UNKNOWN:${message.split(' ')[0] ?? ''}` : r.code }));
}

/** The authentication events made for a challenge (the signing attempts' own), oldest first. */
export async function challengeEvents(server: TestServer, challengeId: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ id: string }>('select id::text as id from iam.auth_event where challenge_id = $1 order by recorded_at, id', [challengeId]);
  return rows.map((r) => r.id);
}

export interface SigningAlert {
  severity: string;
  person_id: string | null;
  account_id: string | null;
  code: string | null;
  reported: string | null;
  event_purpose: string | null;
  event_person: string | null;
  event_account: string | null;
}

/** The security alerts raised for misuse at a challenge (DI-19), with the authentication event each one names. */
export async function signingAlerts(server: TestServer, challengeId: string): Promise<SigningAlert[]> {
  const { rows } = await server.db.admin.query<SigningAlert>(
    `select a.severity, a.person_id::text, a.account_id::text, a.details ->> 'code' as code, a.details ->> 'reported_code' as reported,
            e.purpose as event_purpose, e.person_id::text as event_person, e.account_id::text as event_account
       from iam.security_alert a
       left join iam.auth_event e on e.id::text = a.details ->> 'auth_event_id' and e.challenge_id::text = a.details ->> 'challenge_id'
      where a.kind = 'SIGNING_FAILED' and a.details ->> 'challenge_id' = $1
      order by a.raised_at`,
    [challengeId],
  );
  return rows;
}
