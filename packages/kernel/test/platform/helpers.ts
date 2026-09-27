/**
 * Test helpers for the platform module (B5).
 *
 * Every actor context in these tests comes from `testActor`. The lead switches its body to seed a
 * real identity once the identity module refuses unknown persons.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ActorContext } from '../../src/db/command.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import type { TestDatabase } from '../support/db.ts';

export function testActor(db: TestDatabase, overrides: Partial<ActorContext> = {}): Promise<ActorContext> {
  return seededTestActor(db, overrides);
}

/**
 * Stand-ins for the identity module's authority evaluation and the e-signature module's
 * signature check, registered as the platform's AUTHORITY and SIGNATURE hooks. Permissions are
 * granted per role code in platform_test.role_permission; signatures are rows in
 * platform_test.signature.
 */
export async function installStubHooks(db: TestDatabase): Promise<void> {
  await db.admin.query('create schema if not exists platform_test authorization ebmr_owner');
  await asOwner(db, `
    create table platform_test.role_permission (role_code text not null, permission text not null, primary key (role_code, permission));
    create table platform_test.signature (
      id uuid primary key, meaning text not null, aggregate_type text not null, aggregate_id text not null, person_id text not null);
    create function platform_test.authority(p_permission text, p_actor jsonb, p_aggregate_type text, p_aggregate_id text) returns text
    language sql stable as $$
      select case when exists (select 1 from platform_test.role_permission
                               where role_code = p_actor ->> 'role_code' and permission = p_permission)
                  then null else format('role %s does not hold %s', p_actor ->> 'role_code', p_permission) end
    $$;
    create function platform_test.signature_ok(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text, p_actor jsonb)
    returns text language sql stable as $$
      select case when exists (select 1 from platform_test.signature
                               where id = p_signature_id and meaning = p_meaning and aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id)
                  then null else 'no such signature for this record and meaning' end
    $$;
    select platform.register_hook('AUTHORITY', 'platform_test.authority(text, jsonb, text, text)');
    select platform.register_hook('SIGNATURE', 'platform_test.signature_ok(uuid, text, text, text, jsonb)');
  `);
}

export async function grantPermission(db: TestDatabase, roleCode: string, ...permissions: string[]): Promise<void> {
  for (const p of permissions) {
    await db.admin.query('insert into platform_test.role_permission (role_code, permission) values ($1, $2) on conflict do nothing', [roleCode, p]);
  }
}

/** Records a stub signature and returns its id. */
export async function stubSignature(db: TestDatabase, meaning: string, aggregateType: string, aggregateId: string, personId = randomUUID()): Promise<string> {
  const id = randomUUID();
  await db.admin.query('insert into platform_test.signature (id, meaning, aggregate_type, aggregate_id, person_id) values ($1, $2, $3, $4, $5)', [
    id,
    meaning,
    aggregateType,
    aggregateId,
    personId,
  ]);
  return id;
}

/** Runs SQL as the owner role (superuser connection, SET LOCAL ROLE), in one transaction. */
export async function asOwner(db: TestDatabase, sql: string): Promise<void> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query('set local role ebmr_owner');
    await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Superuser test set-up that must bypass triggers (e.g. to put a step's start in the past).
 * session_replication_role = replica disables ordinary triggers for this transaction only.
 */
export async function withTriggersDisabled<T>(db: TestDatabase, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.admin.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** The database clock as text with microseconds (UTC). */
export async function dbNow(db: TestDatabase): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t");
  return rows[0]?.t ?? '';
}
