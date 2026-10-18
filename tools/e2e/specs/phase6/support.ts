/**
 * Support of the Phase 6 exit browser flows (slice 6j-b): the arrangements no screen makes, done in the E2E databases
 * the way the server tests do them, through the kernel's own commands under real identities:
 *  - `withDb(e2e, installation, work)`: the installation's database (superuser, application and authentication pools);
 *  - `administration(db, seed)`: sessions of the bootstrap administrator and process owner;
 *  - `ensureChangeRecord(db)`: an approved configuration change record for the E2E set-up (CR-E2E-FIXTURE), written by
 *    the database owner as the kernel's test fixture writes CR-TEST-FIXTURE: it stands in for the change-control path
 *    (raise, quality-unit signature, approve), which the kernel's change-control tests prove;
 *  - `grantedPerson(...)`: a person holding a role no persona holds (a training coordinator), through the access
 *    workflow (the administrator requests, the owner approves, the person sets a password);
 *  - `registerAdapter(...)`, `envelope(...)`, `receive(...)`: an integration adapter registered like a device (DI-20),
 *    its INTEGRATION identity's session, and its receiving commands with the SDK's envelope (DI-31);
 *  - `setMirrorMode`, `syncMirror`, `ageMirror`: the site's mode of a mirrored data class (a change-controlled setting),
 *    the adapter's synchronisation, and the heartbeat stopping while the data stays (the kernel tests' ageMirror).
 * DEMO-ONLY credentials and data; every name is unique per run.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Page } from '@playwright/test';
import { identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { openDatabase, openPersonaSession, passwordActor, terminalOf, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { expect, type E2eWorld } from '../../fixtures/index.ts';

export type Installation = 'GMP' | 'SANDBOX';
type Json = Record<string, unknown>;

/** Runs `work` on the installation's database, closing its pools after. */
export async function withDb<T>(e2e: E2eWorld, installation: Installation, work: (db: DatabaseHandle, seed: SiteSeed) => Promise<T>): Promise<T> {
  const db = openDatabase(e2e.state.databases[installation], installation);
  try {
    return await work(db, e2e.seeds[installation]);
  } finally {
    await db.close();
  }
}

/** A context with the E2E set-up's reason (an audited change names why). */
export const because = <T extends ActorContext>(ctx: T, text: string, code = 'E2E_SETUP'): T => ({ ...ctx, reasonCode: code, reasonText: text, correlationId: randomUUID() });

export interface Administration {
  admin: ActorContext;
  owner: ActorContext;
}

export async function administration(db: DatabaseHandle, seed: SiteSeed): Promise<Administration> {
  const b = seed.bootstrap;
  return { admin: await passwordActor(db, b.admin, b.admin.fingerprint), owner: await passwordActor(db, b.owner, b.owner.fingerprint) };
}

export const E2E_CHANGE_RECORD = 'CR-E2E-FIXTURE';

/** Writes the approved E2E change record once per database (both workers may ask at the same time: an advisory lock). */
export async function ensureChangeRecord(db: DatabaseHandle): Promise<string> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("select pg_advisory_xact_lock(hashtext('e2e change record'))");
    await c.query(`select kernel.set_actor_context(jsonb_build_object(
      'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
      'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'E2E fixture (change record)',
      'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'E2E fixture: an approved configuration change record'))`);
    await c.query(
      `insert into platform.change_record (number, title, description, areas, raised_by_person, raised_by_account)
       select $1, 'E2E fixture', 'Configuration set up by the browser flows', (select array_agg(code order by code) from platform.config_area),
              '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
       where not exists (select 1 from platform.change_record where number = $1)`,
      [E2E_CHANGE_RECORD],
    );
    await c.query(
      `insert into platform.change_record_event (change_record_id, event, signature_id, person_id, account_id)
       select r.id, 'APPROVED', gen_random_uuid(), '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'
         from platform.change_record r
        where r.number = $1 and not exists (select 1 from platform.change_record_event e where e.change_record_id = r.id and e.event = 'APPROVED')`,
      [E2E_CHANGE_RECORD],
    );
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return E2E_CHANGE_RECORD;
}

/** Letters only (a to z): a sandbox text never holds a word shaped like a batch or lot number (EBMR-SBX-024, DI-05). */
export function letters(n: number): string {
  return [...randomBytes(n)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
}

export interface GrantedPerson {
  personId: string;
  accountId: string;
  loginName: string;
  legalName: string;
  roleCode: string;
  password: string;
}

/** The office terminal a created person signs in on: the QA office PC on GMP, the sandbox's office PC there. */
export const officeTerminal = (seed: SiteSeed): string => (seed.installation === 'GMP' ? 'PC-QA-01' : 'TEST-PC-01');

/** A person holding `roleCode`, through the access workflow (in the sandbox the names are test labels, DI-05). */
export async function grantedPerson(db: DatabaseHandle, seed: SiteSeed, adm: Administration, roleCode: string, name: string): Promise<GrantedPerson> {
  const sandbox = seed.installation === 'SANDBOX';
  const legalName = sandbox ? `TEST-${name}` : name;
  const loginName = `${sandbox ? 'test-' : ''}${roleCode.toLowerCase().replace(/_/g, '.')}.${letters(8)}`;
  const created = await withCommand(db.app, because(adm.admin, `E2E set-up: a ${roleCode}`), async (c) => {
    const personId = await identity.createPerson(c, 'NATURAL', legalName);
    await identity.recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card', evidenceRef: `HR-${loginName}`,
      occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'HUMAN' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode, reason: `E2E set-up: ${roleCode}` });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, because(adm.owner, `E2E set-up: a ${roleCode}`), (c) => identity.decideRoleGrant(c, created.grantId, true, `E2E set-up: ${roleCode}`));
  const fp = terminalOf(seed, officeTerminal(seed)).fingerprint;
  const password = `E2e-${randomUUID()}`;
  const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: loginName, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  await identity.changeSecret(db.authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: password, loginName });
  return { personId: created.personId, accountId: created.accountId, loginName, legalName, roleCode, password };
}

/** A session of a created person on the office terminal. */
export function sessionOf(db: DatabaseHandle, seed: SiteSeed, p: GrantedPerson): Promise<ActorContext> {
  return passwordActor(db, p, terminalOf(seed, officeTerminal(seed)).fingerprint);
}

export type SourceSystem = 'LMS' | 'CMMS' | 'EMS' | 'OPCUA';

export interface Adapter {
  system: SourceSystem;
  code: string;
  id: string;
  actor: ActorContext;
  /** The last sequence number this adapter's feed sent. */
  seq: number;
  /** Phase 7 slice 7g-4: what the server's adapter worker signs in with (its entry in the service-keys file). */
  credentials: { loginName: string; serviceKey: string; fingerprint: string };
}

/**
 * An adapter instance registered like a device (DI-20): an INTEGRATION account (service key, role SERVICE_ACCOUNT) on its
 * own SERVER device, bound to `system` by the device administrator; its session as the adapter worker opens it.
 */
export async function registerAdapter(db: DatabaseHandle, seed: SiteSeed, adm: Administration, system: SourceSystem): Promise<Adapter> {
  const sandbox = seed.installation === 'SANDBOX';
  const tag = letters(6).toUpperCase();
  const legalName = `${sandbox ? 'TEST-' : ''}${system} adapter ${tag}`;
  const loginName = `${sandbox ? 'test-' : ''}svc-${system.toLowerCase()}-${tag.toLowerCase()}`;
  const fingerprint = randomBytes(32).toString('hex');
  const created = await withCommand(db.app, because(adm.admin, `E2E set-up: the ${system} adapter's identity`), async (c) => {
    const personId = await identity.createPerson(c, 'SYSTEM', legalName);
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'INTEGRATION' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode: 'SERVICE_ACCOUNT', reason: `E2E ${system} adapter identity` });
    await identity.registerDevice(c, { code: `${sandbox ? 'TEST-' : ''}SRV-${system}-${tag}`, deviceClass: 'SERVER', site: seed.siteCode, fingerprint, description: `${system} adapter host (E2E)` });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, because(adm.owner, `E2E set-up: the ${system} adapter's identity`), (c) => identity.decideRoleGrant(c, created.grantId, true, 'approved for the E2E set-up'));
  const ev = await identity.authenticate(db.authn, { method: 'SERVICE_KEY', identifier: loginName, secret: created.secret, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(db.app, ev.authEventId, fingerprint);
  const actor: ActorContext = {
    personId: created.personId, accountId: created.accountId, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION',
    siteZone: adm.admin.siteZone, legalName,
  };
  const code = `${system}-E2E-${tag}`;
  const id = await withCommand(db.app, because(adm.admin, `E2E set-up: register the ${system} adapter`), async (c) =>
    (await c.query<{ id: string }>('select iam.register_integration_adapter($1, $2, $3, $4, $5) as id', [code, system, created.accountId, s.deviceId, `${system} adapter (E2E)`])).rows[0]?.id ?? '',
  );
  return { system, code, id, actor, seq: 0, credentials: { loginName, serviceKey: created.secret, fingerprint } };
}

let lastUs = 0n;
/** A strictly increasing source time (epoch microseconds as text). */
export function nowUs(): string {
  const t = BigInt(Date.now()) * 1000n;
  lastUs = t > lastUs ? t : lastUs + 1n;
  return lastUs.toString();
}

/** The envelope the adapter worker sends (the payload hash is of the payload's JSON text, as the simulators send it). */
export function envelope(a: Adapter, messageType: string, payload: unknown): Json {
  a.seq += 1;
  return {
    sourceSystem: a.system,
    messageType,
    sourceRecordId: `R-${randomBytes(4).toString('hex')}`,
    sourceTimestamp: nowUs(),
    sequenceNo: a.seq.toString(),
    idempotencyKey: `k-${randomUUID()}`,
    schemaVersion: '1',
    payloadHash: createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'),
    payload,
  };
}

/** The adapter's receiving command `fn` on one envelope, with the source's reason naming the message (as the worker sends it). */
export async function receive(db: DatabaseHandle, a: Adapter, fn: string, env: Json): Promise<Json> {
  const ctx = because(a.actor, `${String(env['messageType'])} ${String(env['sourceRecordId'])} from the ${a.system}`, 'INBOUND_MESSAGE');
  return withCommand(db.app, ctx, async (c) => (await c.query<{ r: Json }>(`select ${fn}($1::jsonb) as r`, [JSON.stringify(env)])).rows[0]?.r ?? {});
}

/** The site's mode of a mirrored data class: a configuration change of the process owner under the change record. */
export async function setMirrorMode(db: DatabaseHandle, adm: Administration, dataClass: string, mode: 'STAND_IN' | 'MIRROR'): Promise<void> {
  const changeRecord = await ensureChangeRecord(db);
  await withCommand(db.app, { ...because(adm.owner, `E2E set-up: ${dataClass} ${mode}`), changeRecord }, (c) =>
    c.query('select platform.set_setting($1, $2)', [`integration.mode.${dataClass.toLowerCase()}`, mode]));
}

/** The adapter, caught up with its source (the last number it sent), records a synchronisation of `dataClass`. */
export async function syncMirror(db: DatabaseHandle, a: Adapter, dataClass: string): Promise<void> {
  await withCommand(db.app, { ...a.actor, correlationId: randomUUID() }, (c) => c.query('select platform.record_mirror_sync($1, $2)', [dataClass, a.seq.toString()]));
}

/** The heartbeat stops while the data stays: the last synchronisation moved `seconds` into the past (superuser, as the kernel tests do). */
export async function ageMirror(db: DatabaseHandle, dataClass: string, seconds: number): Promise<void> {
  await db.admin.query('update platform.mirror_sync set last_synced_at = last_synced_at - make_interval(secs => $2) where data_class = $1', [dataClass, seconds]);
}

/** Ends the sessions an arrangement opened. */
export async function endSessions(db: DatabaseHandle, ...actors: ActorContext[]): Promise<void> {
  for (const a of actors) await identity.endSession(db.app, a.sessionId);
}

/**
 * When `batchId` occupied room `room` (its first occupancy there), as epoch microseconds: the window in which the eBMR binds
 * a room's alarms and series to the batch. An occupancy still open ends now.
 */
export async function occupancyWindow(db: DatabaseHandle, batchId: string, room: string): Promise<{ fromUs: bigint; toUs: bigint }> {
  const { rows } = await db.admin.query<{ from_us: string; to_us: string }>(
    `select (extract(epoch from o.started_at) * 1000000)::bigint::text as from_us,
            (extract(epoch from coalesce(e.ended_at, clock_timestamp())) * 1000000)::bigint::text as to_us
       from plant.area_occupancy o join plant.area a on a.id = o.area_id left join plant.area_occupancy_end e on e.occupancy_id = o.id
      where o.batch_id = $1 and a.code = $2 order by o.started_at limit 1`,
    [batchId, room],
  );
  const r = rows[0];
  if (!r) throw new Error(`batch ${batchId} never occupied ${room}`);
  return { fromUs: BigInt(r.from_us), toUs: BigInt(r.to_us) };
}

/**
 * Rows only the receipt or ERP paths write, arranged as the server tests arrange them (the superuser with triggers off),
 * inside a command of the demo set's stores person (persona set 0, which no E2E worker signs in as), so the audit trail
 * and the state engine see a validated actor. Every foreign key is kept, so the database still restores from its backup;
 * a lot gets its state as a receipt gives it (`lotState`).
 */
export async function fixture<T>(db: DatabaseHandle, seed: SiteSeed, label: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const actor = await openPersonaSession(db, seed, 'stores');
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(because(actor, `E2E fixture: ${label}`)))]);
    await c.query('set local session_replication_role = replica');
    const out = await work(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
    await identity.endSession(db.app, actor.sessionId);
  }
}

/** A lot's state row and its history, as a received lot starts (the material-lot machine's first state). */
export async function lotState(c: pg.PoolClient, lotId: string): Promise<void> {
  await c.query("select platform.create_aggregate_state('material_lot', 'material_lot', $1)", [lotId]);
}

/**
 * Opens a function from the home screen's tiles, as a person does (client-side navigation). A page load boots the SPA
 * again and identifies the terminal, which counts toward the address's identification allowance (60 a minute, shared by
 * every browser of the E2E stack): the flows load a page once per terminal and navigate inside the app after.
 */
export async function openTile(page: Page, title: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('link', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('What do you want to do?');
}
