/**
 * Support for the Phase 4 slice 7c kill tests (the "not twins" of the Phase 3 exit SQL mutation run): a database
 * function called in a persona's validated command on the superuser's connection, in a transaction that is always
 * rolled back; fixtures written with session_replication_role = replica (no triggers, no foreign keys) and switched back
 * to origin before the function under test runs; each call under its own savepoint, so a refusal is read as its message
 * and the transaction goes on.
 */
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { toDbContext, type ActorContext } from '@ebmr/kernel';
import { freshTap, openPersonaSession } from '@ebmr/test-kit';
import type { TestServer } from '../support/harness.ts';

export type Json = Record<string, unknown>;

/** `work` in persona `key`'s command on `server`, as the superuser; always rolled back. */
export async function inCommand<T>(server: TestServer, key: string, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await actAs(server, c, key);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** Begins persona `key`'s command in the open transaction (a kiosk persona with its fresh badge tap). */
export async function actAs(server: TestServer, c: PoolClient, key: string): Promise<void> {
  const session = await openPersonaSession(server.db, server.seed, key);
  const badge = server.seed.personas.find((p) => p.key === key)?.badgeUid;
  const actor = {
    ...session,
    ...(badge ? { authEventId: await freshTap(server.db, server.seed, key) } : {}),
    reasonCode: 'TEST',
    reasonText: 'slice 7c kill test',
    correlationId: randomUUID(),
  };
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
}

/** Fixture writes with triggers and foreign keys off. */
export async function replica<T>(c: PoolClient, work: () => Promise<T>): Promise<T> {
  await c.query("set local session_replication_role = 'replica'");
  const r = await work();
  await c.query("set local session_replication_role = 'origin'");
  return r;
}

export type Outcome<T> = { ok: true; r: T } | { ok: false; message: string };

/** One statement under a savepoint: its column r, or the refusal's message. */
export async function attempt<T = unknown>(c: PoolClient, sql: string, params: unknown[] = []): Promise<Outcome<T>> {
  await c.query('savepoint kill_attempt');
  try {
    const { rows } = await c.query<{ r: T }>(sql, params);
    await c.query('release savepoint kill_attempt');
    return { ok: true, r: rows[0]?.r as T };
  } catch (e) {
    await c.query('rollback to savepoint kill_attempt');
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** The result of a statement that must succeed (throws the refusal otherwise). */
export async function value<T = unknown>(c: PoolClient, sql: string, params: unknown[] = []): Promise<T> {
  const o = await attempt<T>(c, sql, params);
  if (!o.ok) throw new Error(o.message);
  return o.r;
}

/** The refusal's EBMR code ('ok' when the statement succeeded). */
export async function code(c: PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  const o = await attempt(c, sql, params);
  if (o.ok) return 'ok';
  return /EBMR-[A-Z0-9]+-\d{3,4}/.exec(o.message)?.[0] ?? o.message;
}

export const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

/** `work` in `actor`'s command on `server` (a service identity or the system administrator), as the superuser; always rolled back. */
export async function inActor<T>(server: TestServer, actor: ActorContext, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...actor, correlationId: randomUUID() }))]);
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

/** A test run batch on `site` whose MBR content is `content` (replica mode); its id. */
export async function batchWith(c: PoolClient, site: string, content: unknown, product = 'P1'): Promise<string> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  await c.query(
    `insert into recipe.test_package (package_hash, file_name, package, content, content_hash, family_id, family_code, product, version_id, version_number,
                                      revision, version_state, exporter, exported_at_us, source, imported_by_person, imported_by_account, correlation_id)
     values ($1, $1 || '.json', '{}', $2, $1, gen_random_uuid(), 'FAM', jsonb_build_object('code', $3::text, 'strength', '1 mg'), gen_random_uuid(), '1', 1, 'APPROVED',
             '{}', 0, '{}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [hash, JSON.stringify(content), product],
  );
  await c.query(
    `insert into recipe.batch_execution (id, batch_number, package_hash, content_hash, installation, purpose, engine_version, registry_fingerprint, policy,
                                         policy_hash, issue_request, market_set, batch_size, site_code, site_zone, issued_at_us, issued_by_person,
                                         issued_by_account, correlation_id)
     values ($1, $2, $3, $3, 'SANDBOX', 'SANDBOX_TEST_RUN', '1', $3, '{}', $3, '{}', '{IN}', 'BS', $4, 'Asia/Kolkata', 0, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`,
    [id, `B-${id.slice(0, 8).toUpperCase()}`, hash, site],
  );
  return id;
}
