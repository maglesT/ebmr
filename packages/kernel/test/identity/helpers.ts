/**
 * Test helpers for the identity module. `testActor` is the one place tests in this folder get an
 * actor context from (coordination rule); for the identity module it is always a real, seeded
 * identity, because kernel.validate_actor_context refuses anything else.
 */
import pg from 'pg';
import { expect } from 'vitest';
import { toDbContext, type ActorContext } from '../../src/db/command.ts';
import { ebmrCode } from '../../src/identity/errors.ts';
import { type TestDatabase, urlFor } from '../support/db.ts';
import { seedActor, type SeedActorOptions, type SeededActor } from './seed.ts';

export async function testActor(db: TestDatabase, overrides?: Partial<ActorContext> & SeedActorOptions): Promise<SeededActor> {
  const seeded = await seedActor(db, overrides ?? {});
  const { roleCode: _r, scope: _s, deviceClass: _d, roomCode: _m, acknowledgeEsig: _a, withBadge: _b, withPin: _p, ...ctx } = overrides ?? {};
  return { ...seeded, ...ctx };
}

/** A real login pool for the authentication-service role (to prove its privileges end-to-end). */
export function authnLoginPool(db: TestDatabase): pg.Pool {
  const pool = new pg.Pool({ connectionString: urlFor(db.name, { name: 'ebmr_authn', password: 'ebmr_authn' }), max: 2 });
  pool.on('error', () => undefined);
  return pool;
}

/** Assert that a promise is refused with a given EBMR code (and optionally a message fragment). */
export async function expectRefused(p: Promise<unknown>, code: string, fragment?: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected refusal ${code}`).toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  expect(ebmrCode(caught) ?? message).toBe(code);
  if (fragment) expect(message).toMatch(fragment);
}

/** Assert that the application role has no privilege for a raw SQL statement. */
export async function expectPermissionDenied(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toThrow(/permission denied/);
}

/**
 * Superuser-only test setup that simulates the passage of time on protected rows (for example an
 * old authentication event or an idle session). Runs with triggers disabled for this transaction
 * only; never used to prove a control, only to arrange the state the control is tested against.
 */
export async function asTimeTraveller(db: TestDatabase, sql: string, params: unknown[] = []): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/**
 * A command run by SECURITY DEFINER-level code (as the signing module B2 will): the superuser pool
 * declares the actor with kernel.begin_command, then calls owner-only functions such as
 * iam.consume_auth_event.
 */
export async function asDefinerCommand<T>(db: TestDatabase, ctx: ActorContext, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
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

/** A superuser transaction that is always rolled back (for attacks that need owner rights). */
export async function asSuperuserTransaction(db: TestDatabase, work: (c: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

export async function dbNow(db: TestDatabase): Promise<string> {
  const { rows } = await db.app.query<{ t: string }>("select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t");
  return rows[0]?.t ?? '';
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
