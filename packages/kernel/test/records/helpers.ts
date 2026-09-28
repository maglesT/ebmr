/**
 * Test helpers for the records module. Every actor context comes from testActor (coordination rule:
 * the lead switches it to seeded identities once the identity module lands).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../src/db/command.ts';
import { withCommand } from '../../src/db/command.ts';
import { contentForSigning, createChallenge, sign } from '../../src/esig/signing.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { approveRecordType, defineRecordType, type RecordTypeDefinition } from '../../src/records/register.ts';
import { approvePurge } from '../../src/records/retention-store.ts';
import { ensureSealKey, testSealKey } from '../esig/helpers.ts';
import { seedActor, seedAdministration, seedAuthn, withReason as withAdminReason, type SeededActor } from '../identity/seed.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import type { TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return seededTestActor(db, overrides);
}

/**
 * A person holding `roleCode` who can sign: the actor keeps the credentials the signer re-enters at
 * every signing (DI-38). Use it for approvers whose approval carries an electronic signature.
 */
export function signerActor(db: TestDatabase, roleCode: string, legalName?: string): Promise<SeededActor> {
  return seedActor(db, { roleCode, ...(legalName ? { legalName } : {}) });
}

/**
 * The signing flow as production runs it (esig README): the server's canonical content, a challenge
 * in the signer's own command, the signer's authentication for that challenge through the
 * authentication service, then sign and seal. Returns the signature id. For a restored copy whose
 * seal key was registered before the backup, pass registerKey: false.
 */
export async function signFor(
  db: TestDatabase,
  signer: SeededActor,
  aggregate: { type: string; id: string },
  meaning: string,
  expectedState: string | null,
  opts: { registerKey?: boolean } = {},
): Promise<string> {
  if (opts.registerKey ?? true) await ensureSealKey(db);
  const content = await contentForSigning(db.app, aggregate.type, aggregate.id);
  const challenge = await withCommand(db.app, again(signer), (c) =>
    createChallenge(c, { aggregateType: aggregate.type, aggregateId: aggregate.id, contentVersion: content.contentVersion ?? '1', meaning, clientContentHash: content.contentHash ?? '' }),
  );
  const ev = await authenticate(seedAuthn(db), {
    method: 'PASSWORD',
    identifier: signer.seed.loginName,
    secret: signer.seed.password,
    deviceFingerprint: signer.seed.deviceFingerprint,
    purpose: 'SIGNATURE',
    challengeId: challenge.challengeId,
  });
  const result = await withCommand(db.app, again(signer), (c) => sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState }, testSealKey));
  return result.signatureId;
}

/** The signed aggregate of a disposal approval: the record at its current retain-until, with the cited true copy (0720). */
export async function disposalAggregate(db: TestDatabase, recordKey: string, trueCopyId?: string): Promise<{ type: string; id: string; retainUntil: string | null }> {
  const { rows } = await db.app.query<{ d: string | null }>(
    "select records.compute_effective_retention(s.id) ->> 'retainUntil' as d from records.retention_schedule s where s.record_key = $1",
    [recordKey],
  );
  const retainUntil = rows[0]?.d ?? null;
  return { type: 'record_disposal', id: `${recordKey}@${retainUntil ?? 'open'}${trueCopyId ? `@${trueCopyId}` : ''}`, retainUntil };
}

/**
 * A disposal approval as QA gives it: a RECORD_DISPOSAL_APPROVED signature of the record at its current
 * retain-until (and cited true copy), then records.approve_purge with it. A record that may not be
 * disposed of cannot be signed for; it gets a random id, because approve_purge refuses it (EBMR-REC-03x)
 * before it reads the signature.
 */
export async function approveDisposal(db: TestDatabase, approver: SeededActor, recordKey: string, reason: string, trueCopyId?: string): Promise<string> {
  const aggregate = await disposalAggregate(db, recordKey, trueCopyId);
  const content = aggregate.retainUntil ? await contentForSigning(db.app, aggregate.type, aggregate.id) : undefined;
  const signature = content?.state === 'DISPOSABLE' ? await signFor(db, approver, aggregate, 'RECORD_DISPOSAL_APPROVED', 'DISPOSABLE') : randomUUID();
  return withCommand(db.app, again(approver), (c) => approvePurge(c, recordKey, signature, reason, trueCopyId));
}

/**
 * The same person, granted a second role (requested by the seeded administrator, approved by the
 * seeded process owner) and acting in it. For tests of per-person rules (for example: the
 * investigator cannot approve the closure) that must reach the rule with a role holding the permission.
 */
export async function inSecondRole(db: TestDatabase, ctx: ActorContext, roleCode: string): Promise<ActorContext> {
  const { admin, owner } = await seedAdministration(db);
  const grant = await withCommand(db.app, withAdminReason(admin), (c) => requestRoleGrant(c, { accountId: ctx.accountId, roleCode, reason: `test: also ${roleCode}` }));
  await withCommand(db.app, withAdminReason(owner), (c) => decideRoleGrant(c, grant, true, 'approved for test'));
  return { ...ctx, roleCode, correlationId: randomUUID() };
}

/** The same person acting in a later command with a reason for change (DI-24). */
export function withReason(ctx: ActorContext, reasonCode: string, reasonText?: string): ActorContext {
  return { ...ctx, correlationId: randomUUID(), reasonCode, ...(reasonText ? { reasonText } : {}) };
}

/** A fresh command context for the same person (new correlation id, no reason). */
export function again(ctx: ActorContext): ActorContext {
  const { reasonCode: _r, reasonText: _t, ...rest } = ctx;
  void _r;
  void _t;
  return { ...rest, correlationId: randomUUID() };
}

/**
 * Declares, in this test database only, that records of a stub aggregate type are disposed of at the
 * end of their retention (records.declare_retention_aggregate, 0420), as the owning module's migration
 * does in production: owner-level, under the software-release identity. The kernel declares 'batch';
 * every other aggregate type is refused by records.create_retention_schedule (EBMR-REC-024).
 */
export async function allowRetention(db: TestDatabase, aggregateType: string, retentionKeys: string[]): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query(`select kernel.set_actor_context(jsonb_build_object(
      'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
      'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Software release (test fixture)',
      'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test aggregate declared for retention'))`);
    await client.query("select records.declare_retention_aggregate($1, $2::text[], 'test fixture', 'stub records of this test database')", [
      aggregateType,
      retentionKeys,
    ]);
    await client.query('select kernel.set_actor_context(null)');
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stub GMP tables standing in for other modules' records (created by the superuser in this test
 * database only). Registered for audit like any product table; the application role gets no DELETE.
 * Batch records ('batch', declared by the kernel) and component lots (supporting records, declared
 * here) can have a retention schedule.
 */
export async function createStubTables(db: TestDatabase): Promise<void> {
  await db.admin.query(`
    create schema if not exists stub_b4 authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_b4 to ebmr_app;
    create table stub_b4.batch_entry (
      id uuid primary key default gen_random_uuid(),
      batch_id uuid not null,
      step_ref text not null,
      value numeric not null,
      status text not null default 'RECORDED'
    );
    create table stub_b4.batch_reading (
      id uuid primary key default gen_random_uuid(),
      batch_id uuid not null,
      value numeric not null
    );
    create table stub_b4.lot_record (
      id uuid primary key default gen_random_uuid(),
      lot_id uuid not null,
      note text not null
    );
    grant select, insert, update on stub_b4.batch_entry, stub_b4.lot_record to ebmr_app;
    grant select, insert on stub_b4.batch_reading to ebmr_app;
    select kernel.register_audited_table('stub_b4.batch_entry', 'batch', 'batch_id', false);
    select kernel.register_audited_table('stub_b4.batch_reading', 'batch', 'batch_id', true);
    select kernel.register_audited_table('stub_b4.lot_record', 'component_lot', 'lot_id', false);
    reset role;
  `);
  await allowRetention(db, 'component_lot', ['SUPPORTING_RECORD']);
}

export async function insertEntry(db: TestDatabase, ctx: ActorContext, batchId: string, value: string, stepRef = 'S1'): Promise<string> {
  return withCommand(db.app, again(ctx), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into stub_b4.batch_entry (batch_id, step_ref, value) values ($1, $2, $3) returning id', [
      batchId,
      stepRef,
      value,
    ]);
    return rows[0]?.id ?? '';
  });
}

export async function insertReading(db: TestDatabase, ctx: ActorContext, batchId: string, value: string): Promise<void> {
  await withCommand(db.app, again(ctx), (c) => c.query('insert into stub_b4.batch_reading (batch_id, value) values ($1, $2)', [batchId, value]));
}

export async function correctEntry(db: TestDatabase, ctx: ActorContext, id: string, value: string): Promise<void> {
  await withCommand(db.app, withReason(ctx, 'TRANSCRIPTION_ERROR', 'wrong digit'), (c) =>
    c.query('update stub_b4.batch_entry set value = $2 where id = $1', [id, value]),
  );
}

export const recordType = (code: string, over: Partial<RecordTypeDefinition> = {}): RecordTypeDefinition => ({
  code,
  title: code.toLowerCase().replaceAll('_', ' '),
  description: `test record type ${code}`,
  officialRecord: true,
  dataClass: 'RAW',
  gmpCriticality: 'HIGH',
  officialMedium: 'ELECTRONIC',
  originalAndCopies: 'the electronic record is the original',
  storageLocation: 'eBMR edition database',
  owningModule: 'test',
  ownerRole: 'QA',
  retentionKey: 'BATCH_RECORD',
  reviewRule: 'QA review',
  feedsAcceptanceLimit: true,
  ...over,
});

/**
 * Defines a record type as one person and approves it, with a RECORD_TYPE_APPROVED signature of that
 * version, as another. RECORD.TYPE_DEFINE and RECORD.TYPE_APPROVE are held by QA_MBR_APPROVER
 * (0700_authorization_catalogue.sql).
 */
export async function registerType(db: TestDatabase, def: RecordTypeDefinition): Promise<void> {
  const author = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
  const approver = await signerActor(db, 'QA_MBR_APPROVER');
  const version = await withCommand(db.app, author, (c) => defineRecordType(c, def));
  const signature = await signFor(db, approver, { type: 'record_type_version', id: `${def.code}:${version}` }, 'RECORD_TYPE_APPROVED', 'DEFINED');
  await withCommand(db.app, again(approver), (c) => approveRecordType(c, def.code, version, signature));
}

export async function scalar<T>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query<{ v: T }>(sql, params);
  return rows[0]?.v as T;
}
