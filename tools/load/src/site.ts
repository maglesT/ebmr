/**
 * The reference site of the load driver (slice 7d; D-P7-4): a GMP database of its own (LOAD-ONLY: DEMO-ONLY keys and
 * personas, never a production database), the tablets server as its own process listening on loopback HTTP, and the
 * people and terminals the traffic needs:
 *  - the test-kit personas in as many sets as there are shop-floor sessions (each set's operators are other persons
 *    with their own badges), and one kiosk per shop-floor session in the dispensing booth (KIOSK-LOAD-nn) and one office
 *    PC per office session (PC-LOAD-nn), registered and attested as the seed registers its own;
 *  - a GMP master (dc-mini) through its signed life cycle and authorised for India, a batch-number rule, and ERP orders,
 *    as the server tests' GMP world makes them (apps/tablets-server/test/support/gmp-world.ts);
 *  - sessions bound to cookies as the tests bind them (a kernel login of the persona at its terminal), so the traffic
 *    starts signed in; badge taps, device proofs and e-signatures are made for every request as a browser makes them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { continuity, esig, identity, withCommand, type MigrationSource } from '@ebmr/kernel';
import {
  ADMIN_URL, bootstrapInstallation, onServer, createGmpDatabase, dropDatabase, editionMigrationSources, generateDeviceKey, openDatabase, openPersonaSession, openServiceSession, passwordActor,
  personaOf, seedDemoSite, uniqueSuffix, type DatabaseHandle, type SiteSeed,
} from '@ebmr/test-kit';
import { postOrder } from '../../../packages/recipe-core/test/lifecycle/gmp-support.ts';
import { cell } from '../../../packages/recipe-core/test/lifecycle/support.ts';
import { actorOf, BATCH_SIZE, gmpContent, gmpLifecycleWorld, INPUTS, LINE, SITE } from '../../../apps/tablets-server/test/support/gmp-world.ts';
import type { TestServer } from '../../../apps/tablets-server/test/support/harness.ts';
import { grantedPerson } from '../../../apps/tablets-server/test/support/granted-person.ts';
import { newSessionToken, tokenHash } from '../../../apps/tablets-server/src/platform/auth/session.ts';
import { netBrowser, type NetBrowser } from './net-browser.ts';
import type { Recorder } from './metrics.ts';

const SERVER_MAIN = fileURLToPath(new URL('../../../apps/tablets-server/src/main.ts', import.meta.url));
const TABLETS_SQL = fileURLToPath(new URL('../../../apps/tablets-server/sql', import.meta.url));
export const tabletsSources = (): MigrationSource[] => editionMigrationSources([{ namespace: 'tablets', directory: TABLETS_SQL }]);

export interface ServerProcess {
  child: ChildProcess;
  origin: string;
  port: number;
  pid: number;
  close(): Promise<void>;
}

export interface Site {
  database: string;
  db: DatabaseHandle;
  seed: SiteSeed;
  server: ChildProcess;
  pid: number;
  origin: string;
  port: number;
  dir: string;
  sealKeyFile: string;
  ledgerFile: string;
  familyId: string;
  versionId: string;
  kiosks: string[];
  offices: string[];
  serverErrors: string[];
  /** The persona keys of the shop-floor sessions, by kiosk. */
  operators: string[];
  /** Orders the ERP posts (one per batch to plan). */
  postOrders(n: number): Promise<void>;
  /** A browser of a person granted `roleCode` (no persona holds it), signed in with a password at office PC `terminal`. */
  signInGranted(roleCode: string, terminal: string, address: string, actor: string, recorder: Recorder): Promise<NetBrowser>;
  /** One more server process on the same database (the history's issuers spread over several CPUs). */
  extraServer(): Promise<ServerProcess>;
  /** A browser signed in as `personaKey` at `terminal`, from loopback address `address`, to the main server or `target`. */
  signIn(personaKey: string, terminal: string, address: string, actor: string, recorder: Recorder, target?: ServerProcess): Promise<NetBrowser>;
  close(): Promise<void>;
}

const why = <T extends object>(ctx: T, text: string) => ({ ...ctx, reasonCode: 'LOAD_SETUP', reasonText: text, correlationId: randomUUID() });

/** Extra terminals registered (and kiosks attested) as the seed registers its own; added to the seed's terminals. */
async function addTerminals(db: DatabaseHandle, seed: SiteSeed, codes: { code: string; cls: 'SHARED' | 'PERSONAL'; room?: string }[]): Promise<void> {
  const admin = await passwordActor(db, seed.bootstrap.admin, seed.bootstrap.admin.fingerprint);
  for (const t of codes) {
    const key = generateDeviceKey();
    const deviceId = await withCommand(db.app, why(admin, 'load terminals'), (c) =>
      identity.registerDevice(c, { code: t.code, deviceClass: t.cls, site: SITE, ...(t.room ? { room: t.room } : {}), fingerprint: key.fingerprint, description: `LOAD-ONLY ${t.cls === 'SHARED' ? 'kiosk' : 'office PC'} ${t.code}` }),
    );
    if (t.cls === 'SHARED') {
      await withCommand(db.app, why(admin, 'load kiosk attestation'), (c) =>
        continuity.recordHardeningAttestation(c, { deviceId, deviceClass: 'SHARED', usbMassStorageBlocked: true, kioskModeEnforced: true, malwareProtectionActive: true, osPatchWithinSla: true, method: 'MDM_COMPLIANCE_REPORT', evidenceRef: `MDM-LOAD-${t.code}` }),
      );
    }
    seed.terminals.push({ code: t.code, deviceClass: t.cls, room: t.room ?? null, description: `LOAD-ONLY ${t.code}`, deviceId, fingerprint: key.fingerprint, key });
  }
}

async function waitForServer(origin: string, child: ChildProcess, log: () => string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (child.exitCode !== null) throw new Error(`the server exited (${String(child.exitCode)}): ${log().slice(-2000)}`);
    try {
      const r = await fetch(`${origin}/api/meta`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not answer: ${log().slice(-2000)}`);
}

export async function buildSite(o: { sessions: number; offices: number; log: (m: string) => void }): Promise<Site> {
  const database = `ebmr_load_${uniqueSuffix()}`;
  o.log(`load site: database ${database}`);
  await createGmpDatabase(database, tabletsSources());
  // Diagnosis (EBMR_LOAD_TRACK_FUNCTIONS=1): the database counts the time of every SQL function, read afterwards from
  // pg_stat_user_functions of the kept database (EBMR_LOAD_KEEP=1).
  if (process.env['EBMR_LOAD_TRACK_FUNCTIONS'] === '1') await onServer((c) => c.query(`alter database "${database}" set track_functions = 'all'`));
  const boot = await bootstrapInstallation(database, 'GMP');
  const db = openDatabase(database, 'GMP', { max: 8 });
  // Each persona set holds two kiosk operators (operator1, operator2) of their own.
  const sets = Math.max(1, Math.ceil(o.sessions / 2));
  const seed = await seedDemoSite(db, 'GMP', boot, { personaSets: sets });
  const kiosks = Array.from({ length: o.sessions }, (_, i) => `KIOSK-LOAD-${String(i + 1).padStart(2, '0')}`);
  const offices = Array.from({ length: o.offices + 9 }, (_, i) => `PC-LOAD-${String(i + 1).padStart(2, '0')}`);
  await addTerminals(db, seed, [...kiosks.map((code) => ({ code, cls: 'SHARED' as const, room: 'DISP-1' })), ...offices.map((code) => ({ code, cls: 'PERSONAL' as const }))]);
  const operators = kiosks.map((_, i) => `${i % 2 === 0 ? 'operator1' : 'operator2'}${Math.floor(i / 2) === 0 ? '' : `-w${String(Math.floor(i / 2))}`}`);
  // DEMO-ONLY seal key and the external ledger of protected numbers, in the run's own directory.
  const dir = mkdtempSync(join(tmpdir(), 'ebmr-load-'));
  const secret = randomBytes(32);
  const sealKeyFile = join(dir, 'seal-key.json');
  writeFileSync(sealKeyFile, JSON.stringify({ keyId: 'load-hmac-1', algorithm: 'HMAC-SHA256', secret: secret.toString('base64'), label: 'DEMO-ONLY load seal key' }));
  const sealKey = esig.hmacSealKey('load-hmac-1', secret);
  const admin = await passwordActor(db, boot.admin, boot.admin.fingerprint);
  await withCommand(db.app, why(admin, 'register the DEMO-ONLY load seal key'), (c) => esig.registerSealKey(c, sealKey, 'DEMO-ONLY load seal key (HMAC-SHA256)'));
  const ledgerFile = join(dir, 'numbers.ledger.jsonl');
  // The GMP master, its market authorisation, licence and numbering rule, as the GMP world makes them.
  const fake = { database, db, seed, built: { ctx: { sealKey } } } as unknown as TestServer;
  const world = await gmpLifecycleWorld(fake);
  const content = gmpContent();
  const v = await world.approvedVersion(content);
  await world.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell(SITE, LINE, BATCH_SIZE)], regulatoryBasis: 'IN: registration on file' });
  const steward = await actorOf(fake, 'steward');
  await world.run(steward, (c) =>
    c.query('select site.define_batch_number_rule($1::jsonb)', [JSON.stringify({ rule_code: `L-${randomUUID().slice(0, 8).toUpperCase()}`, site_code: SITE, product_code: content.header.product.code, batch_kind: 'PROCESSING', format: 'L{YY}{SEQ:5}', site_zone: 'Asia/Kolkata', reason: 'Load numbering' })]),
    why({}, 'numbering rule for the load run'),
  );
  // The server, its own process on loopback; more processes of it on the same database for the history (spawn).
  const admin2 = new URL(ADMIN_URL);
  const serverErrors: string[] = [];
  const spawnServer = async (): Promise<ServerProcess> => {
    const port = 20000 + (randomBytes(2).readUInt16BE(0) % 20000);
    const origin = `http://127.0.0.1:${String(port)}`;
    const env = {
      ...process.env,
      EBMR_INSTALLATION: 'GMP', EBMR_ENV: 'test', EBMR_DATABASE: database, EBMR_PG_HOST: admin2.hostname, EBMR_PG_PORT: admin2.port || '5432',
      EBMR_PUBLIC_ORIGIN: origin, EBMR_HOST: '127.0.0.1', EBMR_PORT: String(port), EBMR_SEAL_KEY_FILE: sealKeyFile, EBMR_NUMBER_LEDGER_FILE: ledgerFile,
      EBMR_LOG_LEVEL: 'warn', EBMR_ANALYTICS: 'off', EBMR_EXCHANGE_DIR: join(dir, 'exchange'),
    };
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onLine = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-20_000);
      for (const line of text.split('\n')) if (/"level":(50|60)/.test(line) && serverErrors.length < 200) serverErrors.push(line.slice(0, 600));
    };
    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);
    await waitForServer(origin, child, () => tail);
    return {
      child, origin, port, pid: child.pid ?? 0,
      close: () => new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
    };
  };
  const main = await spawnServer();
  const { child: server, origin, port } = main;
  const extras: ServerProcess[] = [];
  o.log(`load site: server pid ${String(server.pid)} on ${origin}`);
  const erp = () => openServiceSession(db, seed, 'erpInterface');
  return {
    database, db, seed, server, pid: server.pid ?? 0, origin, port, dir, sealKeyFile, ledgerFile, familyId: v.familyId, versionId: v.versionId, kiosks, offices, serverErrors, operators,
    async postOrders(n) {
      const actor = await erp();
      for (let i = 0; i < n; i += 1) await postOrder(db.app, actor, content, BATCH_SIZE);
    },
    async extraServer() {
      const x = await spawnServer();
      extras.push(x);
      return x;
    },
    async signIn(personaKey, terminal, address, actorName, recorder, target) {
      const p = personaOf(seed, personaKey);
      const t = seed.terminals.find((x) => x.code === terminal);
      if (!t) throw new Error(`terminal ${terminal} is not in the seed`);
      const s = await openPersonaSession(db, seed, personaKey, terminal);
      const token = newSessionToken();
      await db.app.query('select tab.bind_session($1, $2, $3)', [s.sessionId, tokenHash(token), p.roleCode]);
      const at = target ?? main;
      const b = netBrowser({ origin: at.origin, host: '127.0.0.1', port: at.port, localAddress: address, terminal, key: t.key, installation: 'GMP', recorder, actor: actorName });
      b.cookies.set('ebmr_gmp_sid', token);
      const r = await b.call(routes.session.get);
      if (!r.ok) throw new Error(`session of ${personaKey} at ${terminal}: ${JSON.stringify(r.error)}`);
      return b;
    },
    async signInGranted(roleCode, terminal, address, actorName, recorder) {
      const fakeServer = { kind: 'GMP', database, db, seed } as unknown as TestServer;
      const p = await grantedPerson(fakeServer, roleCode, `Load ${roleCode.toLowerCase().replace(/_/g, ' ')}`);
      const t = seed.terminals.find((x) => x.code === terminal);
      if (!t) throw new Error(`terminal ${terminal} is not in the seed`);
      const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' });
      const session = await identity.openSession(db.app, ev.authEventId, t.fingerprint);
      const token = newSessionToken();
      await db.app.query('select tab.bind_session($1, $2, $3)', [session.sessionId, tokenHash(token), roleCode]);
      const b = netBrowser({ origin, host: '127.0.0.1', port, localAddress: address, terminal, key: t.key, installation: 'GMP', recorder, actor: actorName });
      b.cookies.set('ebmr_gmp_sid', token);
      const r = await b.call(routes.session.get);
      if (!r.ok) throw new Error(`session of the ${roleCode} at ${terminal}: ${JSON.stringify(r.error)}`);
      return b;
    },
    async close() {
      for (const x of [...extras, main]) await x.close();
      await db.close();
    },
  };
}

export async function dropSite(database: string): Promise<void> {
  await dropDatabase(database);
}

/** Signatures a session may sign a minute (the server's limit is 20, esig.sign by session): each issuer keeps under it. */
const SIGNS_PER_MINUTE = 18;
const lastSign = new WeakMap<NetBrowser, number>();
async function paceSign(b: NetBrowser): Promise<void> {
  const gap = 60_000 / SIGNS_PER_MINUTE;
  const wait = (lastSign.get(b) ?? 0) + gap - performance.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSign.set(b, performance.now());
}

/** Plans and issues a batch through the routes with the issuer's ISSUED signature; the attempts it took (SLO-3). */
let planning: Promise<unknown> = Promise.resolve();

/**
 * Plans and issues a batch. With `oneAtATime` the plans of every issuer of the driver go one after the other (the
 * history: planners at once take the same oldest open order, P7D-4); the signatures still run in parallel.
 */
export async function issueBatch(site: Site, issuer: NetBrowser, issuerKey: string, oneAtATime = false): Promise<{ batchId: string; attempts: number; ok: boolean; refusal: string | null }> {
  let attempts = 0;
  let last: string | null = null;
  for (; attempts < 3; ) {
    attempts += 1;
    const plan = () => issuer.call(routes.execution.planBatch, { body: { familyId: site.familyId, markets: ['IN'], site: SITE, line: LINE, batchSize: BATCH_SIZE } });
    let planned: Awaited<ReturnType<typeof plan>>;
    if (oneAtATime) {
      const mine = planning.then(plan);
      planning = mine.catch(() => undefined);
      planned = await mine;
    } else planned = await plan();
    if (!planned.ok) {
      last = planned.error.kind === 'REFUSAL' ? planned.error.envelope.refusal.code : planned.error.kind;
      // Two planners at once take the same oldest open ERP order: the later one is refused (EBMR-EXE-605, the order is
      // planned already) and plans again against the next one (finding P7D-4: the refusal is not marked retryable).
      if (planned.error.kind === 'REFUSAL' && (planned.error.envelope.retryable || last === 'EBMR-EXE-605')) continue;
      return { batchId: '', attempts, ok: false, refusal: last };
    }
    const batchId = planned.value.batchId;
    const preview = await issuer.call(routes.esig.content, { query: { aggregateType: 'batch_issue', aggregateId: batchId, intent: 'ISSUED' } });
    if (!preview.ok) return { batchId, attempts, ok: false, refusal: preview.error.kind };
    const action = { kind: 'GMP_BATCH_ISSUE' as const, batchId, reason: { code: 'PRODUCTION_PLAN', text: 'Issued for the plan (load run)' }, variants: {}, inputs: INPUTS };
    const challenge = await issuer.call(routes.esig.createChallenge, { body: { aggregateType: 'batch_issue', aggregateId: batchId, contentVersion: preview.value.contentVersion, meaning: 'ISSUED', clientContentHash: sha256Hex(preview.value.canonicalText), action } });
    if (!challenge.ok) return { batchId, attempts, ok: false, refusal: challenge.error.kind === 'REFUSAL' ? challenge.error.envelope.refusal.code : challenge.error.kind };
    const p = personaOf(site.seed, issuerKey);
    const credentials: SignatureCredentials = { kind: 'PASSWORD', loginName: p.loginName, password: p.password };
    const body = { challengeId: challenge.value.challengeId, credentials, action };
    await paceSign(issuer);
    const signed = await issuer.call(routes.esig.sign, { body: { ...body, proof: await issuer.proof('POST', '/api/esig/sign', body) } });
    if (signed.ok) return { batchId, attempts, ok: true, refusal: null };
    last = signed.error.kind === 'REFUSAL' ? signed.error.envelope.refusal.code : signed.error.kind;
    if (!(signed.error.kind === 'REFUSAL' && signed.error.envelope.retryable)) return { batchId, attempts, ok: false, refusal: last };
  }
  return { batchId: '', attempts, ok: false, refusal: last };
}
