/**
 * DEMO-ONLY: the real server built in-process on a seeded demo or E2E installation, driven the way browsers drive it
 * (Phase 4 slice 7b; the set-up CLI's --gmp-release seed, release-path.ts). Each persona works in its own session at its
 * terminal: session cookie, CSRF token, device proofs signed with the terminal's DEMO-ONLY key, badge taps at the kiosks,
 * the e-signature ceremony with the persona's password or PIN. Everything runs on the installation's real clock, so the
 * driver paces itself to the server's rate limits (badge taps per terminal and badge, device nonces per terminal,
 * signatures per session) by waiting on the host's clock, as a person at the terminal would. Never run on production
 * (the set-up CLI refuses EBMR_ENV=production).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { engine } from '@ebmr/recipe-core';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import {
  createApiClient, routes, type ApiClient, type ClientIntent, type DeviceProof, type FetchLike, type Result, type RouteDef, type SignableAction, type SignedIntent,
} from '@ebmr/api-contract';
import { freshTap, openPersonaSession, personaOf, signDeviceProof, terminalOf, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { buildApp, type BuiltApp } from '../app.ts';
import { parseConfig } from '../config.ts';
import { recordContentForSigning } from '../features/esig/content.ts';
import { newSessionToken, tokenHash } from '../platform/auth/session.ts';

const ORIGIN = 'http://localhost:3001';
type Json = Record<string, unknown>;

export interface DemoBrowser {
  key: string;
  terminal: string;
  kiosk: boolean;
  actor: ActorContext & { deviceId: string };
  api: ApiClient;
  proof(method: string, path: string, body: Record<string, unknown>): Promise<DeviceProof>;
  signs: number[];
}

export function value<T>(r: Result<T>, what: string): T {
  if (r.ok) return r.value;
  const e = r.error;
  throw new Error(`${what} was refused: ${e.kind === 'REFUSAL' ? `${String(e.status)} ${e.envelope.refusal.code}: ${e.envelope.refusal.whatHappened} ${e.envelope.refusal.why}` : JSON.stringify(e)}`);
}

function parseSetCookie(header: string | string[] | undefined, jar: Map<string, string>): void {
  for (const line of header === undefined ? [] : Array.isArray(header) ? header : [header]) {
    const [pair = ''] = line.split(';');
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const v = pair.slice(i + 1).trim();
    if (v === '' || /max-age=0/i.test(line)) jar.delete(pair.slice(0, i).trim());
    else jar.set(pair.slice(0, i).trim(), v);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A sliding one-minute window of the host's clock: waits until one more event fits under `max`. */
class Pace {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number) {}
  async take(key: string): Promise<void> {
    for (;;) {
      const now = performance.now(); // monotonic host time for pacing only (never a GMP value)
      const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 61_000);
      if (recent.length < this.max) {
        recent.push(now);
        this.hits.set(key, recent);
        return;
      }
      await sleep(61_000 - (now - (recent[0] ?? now)) + 50);
    }
  }
}

export class DemoApp {
  private readonly taps = new Pace(25);
  private readonly nonces = new Pace(100);
  private readonly signatures = new Pace(15);
  private readonly browsers = new Map<string, DemoBrowser>();

  private constructor(
    readonly built: BuiltApp,
    readonly db: DatabaseHandle,
    readonly seed: SiteSeed,
    readonly installation: 'GMP' | 'SANDBOX' = 'GMP',
  ) {}

  /** `installation` (default GMP): slice 7o opens the sandbox too, for its DEMO-ONLY plant (sandbox-plant.ts). */
  static async open(opts: { database: string; keysDir: string; exchangeDir: string; seed: SiteSeed; db: DatabaseHandle; installation?: 'GMP' | 'SANDBOX' }): Promise<DemoApp> {
    const kind = opts.installation ?? 'GMP';
    const prefix = kind === 'GMP' ? 'gmp' : 'sandbox';
    const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
    const env = parseConfig(
      {
        EBMR_INSTALLATION: kind,
        EBMR_DATABASE: opts.database,
        EBMR_PG_HOST: admin.hostname,
        EBMR_PG_PORT: admin.port === '' ? '5432' : admin.port,
        EBMR_PUBLIC_ORIGIN: ORIGIN,
        EBMR_ENV: 'development',
        EBMR_LOG_LEVEL: 'silent',
        EBMR_SEAL_KEY_FILE: join(opts.keysDir, `${prefix}-seal-key.json`),
        EBMR_SECRETS_FILE: join(opts.keysDir, `${prefix}-secrets.json`),
        EBMR_EXCHANGE_DIR: opts.exchangeDir,
        EBMR_NUMBER_LEDGER_FILE: join(opts.keysDir, `${prefix}-numbers.ledger.jsonl`),
      },
      () => randomBytes(32).toString('hex'),
    );
    const built = await buildApp(env, { pools: { app: opts.db.app, authn: opts.db.authn, close: () => Promise.resolve() } });
    return new DemoApp(built, opts.db, opts.seed, kind);
  }

  async close(): Promise<void> {
    await this.built.close();
  }

  /** A browser of persona `key` at `terminal` (default its home terminal), signed in; a fresh one when `fresh`. */
  async browser(key: string, terminal?: string, fresh = false, role?: string): Promise<DemoBrowser> {
    const p = personaOf(this.seed, key);
    const code = terminal ?? p.homeTerminal;
    const id = `${key}@${code}${role ? `:${role}` : ''}`;
    const known = this.browsers.get(id);
    if (known && !fresh) return known;
    const t = terminalOf(this.seed, code);
    const actor = await openPersonaSession(this.db, this.seed, key, code);
    const token = newSessionToken();
    await this.db.app.query('select tab.bind_session($1, $2, $3)', [actor.sessionId, tokenHash(token), role ?? p.roleCode]);
    const cookie = this.built.ctx.config.cookies.session;
    const jar = new Map<string, string>([[cookie, token]]);
    const held: { csrf?: string } = {};
    let lastNonce: string | undefined;
    const app = this.built.app;
    const fetchLike: FetchLike = async (url, init) => {
      const res = await app.inject({
        method: init.method as 'GET',
        url,
        headers: { ...init.headers, cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
        ...(init.body !== undefined ? { payload: init.body } : {}),
      });
      parseSetCookie(res.headers['set-cookie'], jar);
      return { status: res.statusCode, headers: { get: (n: string) => (res.headers[n.toLowerCase()] as string | undefined) ?? null }, text: () => Promise.resolve(res.body) };
    };
    const api = createApiClient({ fetch: fetchLike, installation: () => this.installation, csrfToken: () => held.csrf, headers: () => ({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }) });
    held.csrf = value(await api.call(routes.session.get), `the session of ${key}`).csrfToken;
    const nonces = this.nonces;
    const b: DemoBrowser = {
      key,
      terminal: code,
      kiosk: t.deviceClass === 'SHARED' || t.deviceClass === 'GRADE_A_B',
      actor,
      api,
      signs: [],
      async proof(method, path, body) {
        const k = t.key;
        if (!k) throw new Error(`terminal ${code} has no browser key`);
        await nonces.take(code);
        const n = value(await api.call(routes.session.deviceNonce, { body: { spki: k.publicKeySpki, ...(lastNonce !== undefined ? { lastNonce } : {}) } }), 'a device nonce');
        lastNonce = n.nonce;
        return { spki: k.publicKeySpki, nonce: n.nonce, sig: signDeviceProof(k, `${n.nonce}|${method.toUpperCase()}|${path}|${sha256Hex(canonicalJson(body))}`) };
      },
    };
    this.browsers.set(id, b);
    return b;
  }

  /** A new session of the browser's persona at its terminal, in the same role (the old one is replaced in place). */
  async renew(b: DemoBrowser): Promise<DemoBrowser> {
    const role = [...this.browsers.entries()].find(([, x]) => x === b)?.[0].split(':')[1];
    const n = await this.browser(b.key, b.terminal, true, role);
    Object.assign(b, n, { signs: [] });
    return b;
  }

  async call<R extends RouteDef>(b: DemoBrowser, route: R, input: Parameters<ApiClient['call']>[1], what: string): Promise<unknown> {
    return value(await b.api.call(route as never, input as never), what);
  }

  /** A badge tap of the browser's persona for a request (paced to the server's 30 a minute per terminal and badge). */
  async tap(b: DemoBrowser, path: string, body: Record<string, unknown>) {
    const p = personaOf(this.seed, b.key);
    if (!p.badgeUid) throw new Error(`${b.key} has no badge`);
    await this.taps.take(`${b.terminal}|${b.key}`);
    return { method: 'BADGE_TAP' as const, badgeUid: p.badgeUid, proof: await b.proof('POST', path, body) };
  }

  credentials(b: DemoBrowser) {
    const p = personaOf(this.seed, b.key);
    return b.kiosk && p.pin ? { kind: 'PIN' as const, pin: p.pin } : { kind: 'PASSWORD' as const, loginName: p.loginName, password: p.password };
  }

  /** The ceremony of a signable action (describe, preview, challenge, sign); a kiosk challenge is tapped. */
  async sign(b0: DemoBrowser, action: SignableAction, what: string, subject?: { aggregateType: string; aggregateId: string; meaning: string; intent?: string }): Promise<unknown> {
    await this.signatures.take(`${b0.key}@${b0.terminal}`);
    // The signing route allows 20 signatures a minute per session: a new session after 15.
    const b = b0.signs.length >= 15 ? await this.renew(b0) : b0;
    b.signs.push(performance.now());
    const d = subject ?? (value(await b.api.call(routes.esig.describe, { body: { action } }), `the description of ${what}`) as { aggregateType: string; aggregateId: string; meaning: string | null });
    const meaning = d.meaning ?? '';
    const preview = value(await b.api.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: subject?.intent ?? meaning } }), `the content of ${what}`);
    const body = { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning, clientContentHash: sha256Hex(preview.canonicalText), action };
    const challenge = value(await b.api.call(routes.esig.createChallenge, { body, ...(b.kiosk ? { attribution: await this.tap(b, '/api/esig/challenges', body) } : {}) }), `the challenge of ${what}`);
    const signBody = { challengeId: challenge.challengeId, credentials: this.credentials(b), action };
    return value(await b.api.call(routes.esig.sign, { body: { ...signBody, proof: await b.proof('POST', '/api/esig/sign', signBody) } }), what);
  }

  /** A database command of the browser's persona in its own session (a fresh tap at a kiosk). */
  async dbAs<T>(b: DemoBrowser, sql: string, params: unknown[], reason?: { reasonCode: string; reasonText: string }): Promise<T> {
    if (b.kiosk) await this.taps.take(`${b.terminal}|${b.key}`);
    const actor: ActorContext = { ...b.actor, correlationId: randomUUID(), ...(b.kiosk ? { authEventId: await freshTap(this.db, this.seed, b.key, b.terminal) } : {}), ...(reason ?? {}) };
    return withCommand(this.db.app, actor, async (c: pg.PoolClient) => (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);
  }

  /** The persona's own command through a library function (the actor and reason as dbAs). */
  async as<T>(b: DemoBrowser, work: (c: pg.PoolClient) => Promise<T>, reason?: { reasonCode: string; reasonText: string }): Promise<T> {
    const actor: ActorContext = { ...b.actor, correlationId: randomUUID(), ...(reason ?? {}) };
    return withCommand(this.db.app, actor, work);
  }

  /** A signature on an aggregate no signable action covers (the market authorisation), in the persona's session. */
  async signDirect(b: DemoBrowser, aggregateType: string, aggregateId: string, meaning: string, expectedState: string): Promise<string> {
    const sealKey = this.built.ctx.sealKey;
    if (!sealKey) throw new Error('the GMP server has no seal key');
    const p = personaOf(this.seed, b.key);
    // A GOVERNANCE-class record (an EU importer) is not readable through the record path (EBMR-TAB-020): its content
    // is read the way the set-up reads governance content (setup.ts), then signed by the person as usual.
    const governance = (await this.db.admin.query<{ c: string }>('select tab.aggregate_read_class($1) as c', [aggregateType])).rows[0]?.c !== 'RECORD';
    const content = governance ? await esig.contentForSigning(this.db.admin, aggregateType, aggregateId) : await recordContentForSigning(this.db.app, aggregateType, aggregateId);
    const challenge = await withCommand(this.db.app, { ...b.actor, correlationId: randomUUID() }, (c) =>
      esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
    );
    const ev = await identity.authenticate(this.db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: terminalOf(this.seed, b.terminal).fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    return (await withCommand(this.db.app, { ...b.actor, correlationId: randomUUID() }, (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, sealKey))).signatureId;
  }
}

/** One GMP batch driven over its routes (the commands and signed intents of the shop floor and the office). */
export class DemoBatch {
  constructor(
    readonly app: DemoApp,
    readonly batchId: string,
    readonly batchNumber: string,
  ) {}

  async view(b: DemoBrowser) {
    return value(await b.api.call(routes.batches.batch, { params: { batchId: this.batchId } }), 'the batch');
  }

  async command(b: DemoBrowser, intent: ClientIntent): Promise<void> {
    const body = { expectedVersion: (await this.view(b)).header.version, intent };
    const path = `/api/batches/${this.batchId}/commands`;
    value(await b.api.call(routes.batches.command, { params: { batchId: this.batchId }, body, ...(b.kiosk ? { attribution: await this.app.tap(b, path, body) } : {}) }), `${b.key} ${intent.type}`);
  }

  entry(stepKey: string, entryKind: string, data: Json): ClientIntent {
    return { type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind, data } } as ClientIntent;
  }

  /** A signed intent through the ceremony, with the aggregate and meaning the screens offer. */
  async signed(b: DemoBrowser, intent: SignedIntent): Promise<void> {
    const subject = await this.subject(b, intent);
    const action = { kind: 'ENGINE_COMMAND' as const, runId: this.batchId, expectedVersion: (await this.view(b)).header.version, intent };
    await this.app.sign(b, action, `${b.key} ${intent.type}`, subject);
  }

  private async subject(b: DemoBrowser, intent: SignedIntent): Promise<{ aggregateType: string; aggregateId: string; meaning: string; intent?: string }> {
    if (intent.type === 'SIGN_OFF_STAGE') {
      const a = (await this.view(b)).actions.find((x) => x.action === 'SIGN_OFF_STAGE' && x.target === intent.stageKey);
      return { aggregateType: 'batch_stage', aggregateId: `${this.batchId}:${intent.stageKey}`, meaning: a?.meaning ?? 'STAGE_SIGNED_OFF' };
    }
    if (intent.type === 'DISPOSITION_EXCEPTION') {
      const meaning = 'EXCEPTION_DISPOSITIONED';
      return {
        aggregateType: 'batch_exception', aggregateId: `${this.batchId}:${intent.exception}`, meaning,
        intent: `${meaning}|${Buffer.from(JSON.stringify({ outcome: intent.outcome, justification: intent.justification }), 'utf8').toString('base64url')}`,
      };
    }
    if (intent.type === 'DISPOSITION_HOLD_POINT') {
      const meaning = engine.holdPointMeaning(intent.disposition);
      return {
        aggregateType: 'batch_step', aggregateId: `${this.batchId}:${intent.stepKey}`, meaning,
        intent: `${meaning}|${Buffer.from(JSON.stringify({ disposition: intent.disposition, comment: intent.comment ?? null }), 'utf8').toString('base64url')}`,
      };
    }
    if (intent.type === 'CORRECT_ENTRY') return { aggregateType: 'batch_point', aggregateId: `${this.batchId}:${intent.point}`, meaning: 'CORRECTED' };
    const view = value(await b.api.call(routes.batches.step, { params: { batchId: this.batchId, stepKey: intent.stepKey } }), 'the step');
    const kind = intent.type === 'VERIFY' ? (intent.meaning === 'WITNESSED' ? 'WITNESS' : 'VERIFY') : intent.type;
    const a = view.actions.find((x) => x.action === kind || (kind === 'VERIFY' && x.action === 'WITNESS') || (kind === 'WITNESS' && x.action === 'VERIFY'));
    const meaning = intent.type === 'VERIFY' && intent.meaning === 'WITNESSED' ? 'WITNESSED' : (a?.meaning ?? '');
    return { aggregateType: 'batch_step', aggregateId: `${this.batchId}:${intent.stepKey}`, meaning };
  }

  /** Start, entries, PERFORMED and the check (VERIFIED or WITNESSED; none for `checker: null`). */
  async step(stepKey: string, performer: DemoBrowser, checker: DemoBrowser | null, entries: (ClientIntent | { wait: number })[] = [], meaning: 'VERIFIED' | 'WITNESSED' = 'VERIFIED'): Promise<void> {
    await this.command(performer, { type: 'START_STEP', stepKey });
    for (const e of entries) {
      if ('wait' in e) await sleep(e.wait);
      else await this.command(performer, e);
    }
    await this.signed(performer, { type: 'SIGN_PERFORMED', stepKey });
    if (checker) await this.signed(checker, { type: 'VERIFY', stepKey, meaning });
  }

  /** QA dispositions the stage's open alerts NO_IMPACT, the supervisor signs the stage off. */
  async closeStage(stageKey: string, qa: DemoBrowser, supervisor: DemoBrowser, why = 'Second person checked each value keyed by hand at the time; no impact on the batch.'): Promise<void> {
    for (const e of (await this.view(supervisor)).exceptions.filter((x) => x.status === 'OPEN' && x.severity === 'ALERT')) {
      await this.signed(qa, { type: 'DISPOSITION_EXCEPTION', exception: e.exceptionId, outcome: 'NO_IMPACT', justification: why });
    }
    await this.signed(supervisor, { type: 'SIGN_OFF_STAGE', stageKey });
  }
}

export { sleep };
