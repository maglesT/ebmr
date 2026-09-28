/**
 * Test support for module C1 (access, esig, audit): a server with a registered DEMO-ONLY seal key, badge-tap
 * attributions signed with the terminal's seeded key, kernel actor contexts of a browser's own session (so test
 * set-up never opens a second shop-floor session that would supersede it), stub signable entries, and short
 * refusal descriptions.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { esig, withCommand, type ActorContext } from '@ebmr/kernel';
import type { Attribution, CallError, Result } from '@ebmr/api-contract';
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
