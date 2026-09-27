/**
 * Test helpers for the records module. Every actor context comes from testActor (coordination rule:
 * the lead switches it to seeded identities once the identity module lands).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../src/db/command.ts';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { approveRecordType, defineRecordType, type RecordTypeDefinition } from '../../src/records/register.ts';
import { seedAdministration, withReason as withAdminReason } from '../identity/seed.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import type { TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return seededTestActor(db, overrides);
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
 * Stub GMP tables standing in for other modules' records (created by the superuser in this test
 * database only). Registered for audit like any product table; the application role gets no DELETE.
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
 * Defines a record type as one person and approves it as another. RECORD.TYPE_DEFINE and
 * RECORD.TYPE_APPROVE are held by QA_MBR_APPROVER (0700_authorization_catalogue.sql).
 */
export async function registerType(db: TestDatabase, def: RecordTypeDefinition): Promise<void> {
  const author = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
  const approver = await testActor(db, { roleCode: 'QA_MBR_APPROVER' });
  const version = await withCommand(db.app, author, (c) => defineRecordType(c, def));
  await withCommand(db.app, approver, (c) => approveRecordType(c, def.code, version, randomUUID()));
}

export async function scalar<T>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query<{ v: T }>(sql, params);
  return rows[0]?.v as T;
}
