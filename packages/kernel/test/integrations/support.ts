/**
 * Shared support for the slice 6a builder-B adapter tests (QMS, LIMS, LMS, CMMS) in the kernel, site-services and
 * recipe-core packages: a registered adapter identity per system, envelopes as the SDK builds them, the mirror mode
 * and freshness switches, and the refusal recording the worker does after a refused command (D-P6a-0-5).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { activateAccount, createAccount, createPerson, decideRoleGrant, issueInitialSecret, registerDevice, requestRoleGrant } from '../../src/identity/admin.ts';
import { authenticate, type AuthnDb } from '../../src/identity/authentication.ts';
import { openSession } from '../../src/identity/sessions.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import type { TestDatabase } from '../support/db.ts';
import { testActor } from '../identity/helpers.ts';
import { SEED_SITE, SEED_ZONE, seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';

export type SourceSystem = 'QMS' | 'LIMS' | 'LMS' | 'CMMS' | 'L3';

export interface TestAdapter {
  system: SourceSystem;
  code: string;
  id: string;
  actor: SeededActor;
  /** The next sequence number of this adapter's feed. */
  seq: number;
}

export const ctxOf = (a: SeededActor, extra: Partial<ActorContext> = {}): ActorContext => {
  const { seed: _seed, ...c } = a;
  void _seed;
  return { ...c, correlationId: randomUUID(), ...extra };
};

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The administrator (IAM.DEVICE_MANAGE, account creation) and the process owner (grant decisions, platform settings)
 * the helpers act as: the kernel tests' seeded pair by default; a server test passes its installation's bootstrap pair.
 */
export interface Administration {
  admin: ActorContext;
  owner: ActorContext;
  /** The authentication pool (default: the superuser pool in the ebmr_authn role, as the kernel seeds use). */
  authn?: AuthnDb;
}

const administration = async (db: TestDatabase, given?: Administration): Promise<Administration> => given ?? (await seedAdministration(db));

/** An INTEGRATION account (SERVICE_KEY, role SERVICE_ACCOUNT) with a session on its own SERVER device. */
export async function integrationActor(db: TestDatabase, name: string, given?: Administration): Promise<SeededActor> {
  const { admin, owner, authn } = await administration(db, given);
  const lg = `svc-${randomBytes(5).toString('hex')}`;
  const fp = randomBytes(32).toString('hex');
  const created = await withCommand(db.app, withReason(admin), async (c) => {
    const personId = await createPerson(c, 'SYSTEM', name);
    const accountId = await createAccount(c, { personId, loginName: lg, kind: 'INTEGRATION' });
    const { secret } = await issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await activateAccount(c, accountId);
    const grantId = await requestRoleGrant(c, { accountId, roleCode: 'SERVICE_ACCOUNT', reason: 'test integration identity' });
    await registerDevice(c, { code: `SRV-${randomBytes(5).toString('hex')}`, deviceClass: 'SERVER', site: SEED_SITE, fingerprint: fp, description: `test ${name} host` });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, created.grantId, true, 'approved for test'));
  const ev = await authenticate(authn ?? { pool: db.admin, setRole: 'ebmr_authn' }, { method: 'SERVICE_KEY', identifier: lg, secret: created.secret, deviceFingerprint: fp, purpose: 'LOGIN' });
  const s = await openSession(db.app, ev.authEventId, fp);
  return {
    personId: created.personId, accountId: created.accountId, roleCode: 'SERVICE_ACCOUNT', sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION',
    siteZone: SEED_ZONE, legalName: name,
    seed: { loginName: lg, password: created.secret, deviceFingerprint: fp, deviceClass: 'SERVER', grantId: created.grantId },
  };
}

/** An INTEGRATION account on its own SERVER device, registered for `system` by the device administrator. */
export async function registerAdapter(db: TestDatabase, system: SourceSystem, given?: Administration): Promise<TestAdapter> {
  const { admin } = await administration(db, given);
  const actor = await integrationActor(db, `${system} adapter ${randomBytes(2).toString('hex')}`, given);
  const code = `${system}-${randomBytes(3).toString('hex').toUpperCase()}`;
  const id = await withCommand(db.app, withReason(admin), async (c) =>
    (await c.query<{ id: string }>('select iam.register_integration_adapter($1, $2, $3, $4, $5) as id', [code, system, actor.accountId, actor.deviceId, `test ${system} adapter`])).rows[0]!.id,
  );
  return { system, code, id, actor, seq: 0 };
}

export interface EnvelopeOptions {
  sourceRecordId?: string;
  sourceTimestamp?: string;
  sequenceNo?: string;
  idempotencyKey?: string;
}

/** The envelope the adapter worker sends (the payload hash is of the payload's JSON text, as the simulators send it). */
export function envelopeFor(a: TestAdapter, messageType: string, payload: unknown, o: EnvelopeOptions = {}): Record<string, unknown> {
  a.seq += 1;
  return {
    sourceSystem: a.system,
    messageType,
    sourceRecordId: o.sourceRecordId ?? `R-${randomBytes(4).toString('hex')}`,
    sourceTimestamp: o.sourceTimestamp ?? nowUs(),
    sequenceNo: o.sequenceNo ?? a.seq.toString(),
    idempotencyKey: o.idempotencyKey ?? `k-${randomUUID()}`,
    schemaVersion: '1',
    payloadHash: sha256(JSON.stringify(payload)),
    payload,
  };
}

let lastUs = 0n;
/** A strictly increasing source timestamp (epoch microseconds as text) for test messages. */
export function nowUs(): string {
  const t = BigInt(Date.now()) * 1000n;
  lastUs = t > lastUs ? t : lastUs + 1n;
  return lastUs.toString();
}

/**
 * The reason an adapter's receiving command carries (D-P6a-B-7): the source's, naming the message, so a withdrawal or
 * a correction the message causes is audited with it (EBMR-AUDIT-002); the adapter worker sends the same.
 */
export function inboundReason(envelope: unknown): { reasonCode: string; reasonText: string } {
  const e = (envelope ?? {}) as Record<string, unknown>;
  return { reasonCode: 'INBOUND_MESSAGE', reasonText: `${String(e['messageType'])} ${String(e['sourceRecordId'])} from the ${String(e['sourceSystem'])}` };
}

/** Runs the adapter's receiving command; on a refusal the worker records it in its own command (kernel 1180). */
export async function receive(db: TestDatabase, a: TestAdapter, fn: string, envelope: unknown): Promise<Record<string, unknown>> {
  return withCommand(db.app, ctxOf(a.actor, inboundReason(envelope)), async (c) => (await c.query<{ r: Record<string, unknown> }>(`select ${fn}($1::jsonb) as r`, [JSON.stringify(envelope)])).rows[0]!.r);
}

export async function recordRefusal(db: TestDatabase, a: TestAdapter, envelope: unknown, errorClass: string, detail: string): Promise<string> {
  return withCommand(db.app, ctxOf(a.actor), async (c) =>
    (await c.query<{ id: string }>('select platform.record_inbound_refusal($1::jsonb, $2, $3) as id', [JSON.stringify(envelope), errorClass, detail])).rows[0]!.id,
  );
}

export async function setMirrorMode(db: TestDatabase, dataClass: string, mode: 'STAND_IN' | 'MIRROR', given?: Administration): Promise<void> {
  const { owner } = await administration(db, given);
  await ensureFixtureChangeRecord(db);
  await withCommand(db.app, underChange(withReason(owner)), (c) => c.query('select platform.set_setting($1, $2)', [`integration.mode.${dataClass.toLowerCase()}`, mode]));
}

/**
 * The highest sequence number the database holds for adapter `code` (accepted, or received and refused): the source
 * head that an adapter which is caught up names when it synchronises (kernel 1182).
 */
export async function heldHead(db: Pick<TestDatabase, 'admin'>, code: string): Promise<string> {
  const { rows } = await db.admin.query<{ n: string }>(
    `select coalesce(greatest((select max(m.sequence_no) from platform.inbound_message m where m.adapter_code = $1),
                              (select max(e.sequence_no) from platform.inbound_exception e where e.adapter_code = $1 and e.kind = 'REFUSED')), 0)::text as n`,
    [code],
  );
  return rows[0]?.n ?? '0';
}

/**
 * A person acknowledges every open SEQUENCE_GAP alarm of adapter `code`. The tests' adapters skip numbers on purpose
 * (a refused message whose refusal the test does not record); kernel 1182 refreshes a mirror over such a hole only once
 * its gap is acknowledged (the rule itself is proven in packages/kernel/test/inbound/inbound.test.ts).
 */
export async function acknowledgeGaps(db: TestDatabase, code: string): Promise<void> {
  const { rows } = await db.admin.query<{ id: string }>(
    `select a.id from platform.integration_alarm a
      where a.adapter_code = $1 and a.kind = 'SEQUENCE_GAP' and not exists (select 1 from platform.integration_alarm_ack k where k.alarm_id = a.id)`,
    [code],
  );
  if (rows.length === 0) return;
  const operator = await testActor(db);
  for (const r of rows) {
    await withCommand(db.app, { ...operator, correlationId: randomUUID() }, (c) =>
      c.query('select platform.acknowledge_integration_alarm($1, $2)', [r.id, 'test feed: the skipped numbers were refused messages']));
  }
}

/** A synchronisation of `dataClass` by an adapter caught up with its source, its test gaps acknowledged (or naming `sourceHead`). */
export async function syncMirror(db: TestDatabase, a: TestAdapter, dataClass: string, sourceHead?: string): Promise<void> {
  if (sourceHead === undefined) await acknowledgeGaps(db, a.code);
  const head = sourceHead ?? a.seq.toString(); // the test source's head: the last number it published
  await withCommand(db.app, ctxOf(a.actor), (c) => c.query('select platform.record_mirror_sync($1, $2)', [dataClass, head]));
}

/** The heartbeat stops while the data stays: the last synchronisation moved into the past (as the kernel tests do). */
export async function ageMirror(db: TestDatabase, dataClass: string, seconds: number): Promise<void> {
  await db.admin.query(`update platform.mirror_sync set last_synced_at = last_synced_at - make_interval(secs => $2) where data_class = $1`, [dataClass, seconds]);
}

export async function count(db: TestDatabase, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? -1);
}
