/**
 * Teardown of kernel test databases: the kernel test helpers that open pools of their own and then drop the database
 * with DROP DATABASE ... WITH (FORCE) (openSandbox().drop(), the restored copy of restoreCopy()) drop it only once the
 * socket of every connection of those pools has closed (endPool, ./pools.ts). A client that ended cleanly (an idle one
 * sends its Terminate message) sees its socket closed only when its backend has exited, so the drop terminates none of
 * those; a connection pg cuts itself (broken, or a query still running) can receive nothing from the drop.
 *
 * pg-pool's end() resolves while its clients are still ending; a forced drop run then terminated their backends
 * (FATAL 57P01), and a pool with no error listener re-emitted that as an unhandled error, which fails a test run
 * although every test passed. A relay between the pools and PostgreSQL (./relay.ts) keeps back each client's
 * Terminate message, as if its backend had not yet been scheduled to read it, and lets the connections go one at a
 * time (expectTeardownWaitsForEveryBackend): endPool must stay pending until the last backend of its pool has exited
 * and resolve as soon as it has; a drop() that drops before every backend of every pool has exited ends a backend
 * that is still held, which its pool reports as an unhandled error, and the backend is missing at the next check.
 * endPool must also wait for a client that pg-pool's idle timeout has already removed while it is still ending
 * (expectEndPoolWaitsForIdleRemovedClient): pg-pool's own end() no longer sees that client.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { KERNEL_MIGRATIONS } from '../../src/db/migrate.ts';
import { provisionSandboxDatabase } from '../../src/sandbox/provision.ts';
import { openRestoredCopy } from '../continuity/helpers.ts';
import { databaseExists, dropDatabase, openSandbox, sandboxTestName, uniqueSuffix } from '../sandbox/helpers.ts';
import { ADMIN_URL, urlFor } from '../support/db.ts';
import { endPool, openPool, urlOn } from './pools.ts';
import { expectEndPoolWaitsForIdleRemovedClient, expectTeardownWaitsForEveryBackend, onServer, poolsOf, startRelay, type Relay } from './relay.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A sandbox built once (kernel migrations only: enough for its login role to connect) and copied for each case. */
let sandboxTemplate = '';
beforeAll(async () => {
  sandboxTemplate = sandboxTestName();
  await provisionSandboxDatabase({ adminUrl: ADMIN_URL, database: sandboxTemplate, sources: [KERNEL_MIGRATIONS] });
}, 120_000);
afterAll(async () => {
  if (sandboxTemplate) await dropDatabase(sandboxTemplate);
});

/** Copies `template` as `name` and re-applies what a copy loses: the database privileges and the connect policy. */
async function copyOf(template: string, name: string): Promise<void> {
  await onServer(async (s) => {
    await s.query(`create database "${name}" template "${template}"`);
    await s.query(`revoke connect, temporary on database "${name}" from public`);
  });
  cleanups.push(() => dropDatabase(name));
  const admin = new pg.Client({ connectionString: urlFor(name) });
  await admin.connect();
  try {
    await admin.query('select sandbox.apply_connect_policy()');
  } finally {
    await admin.end();
  }
}

async function relay(): Promise<Relay> {
  const r = await startRelay();
  cleanups.push(() => r.close());
  return r;
}

describe('kernel test pools (openPool, endPool)', () => {
  it('[meta] a pool made by openPool refuses its own end(), which resolves before the backends have exited; endPool ends it', async () => {
    const pool = openPool({ connectionString: urlFor(inject('templateDb')), max: 1 });
    expect(() => pool.end()).toThrow(/^a pool made by openPool\(\) is ended with endPool\(\)/);
    expect(pool.ending).toBe(false);
    await endPool(pool);
    expect(pool.ended).toBe(true);
  });

  it('[meta] endPool refuses a pool whose connections it cannot follow, and leaves that pool as it was', async () => {
    const pool = new pg.Pool({ connectionString: urlFor(inject('templateDb')), max: 1 });
    await expect(endPool(pool)).rejects.toThrow(/^endPool\(\) waits only for pools made by openPool\(\)/);
    expect(pool.ending).toBe(false);
    await pool.end();
  });

  it('[meta] endPool resolves only once every backend of the pool has exited, and as soon as the last one has', async () => {
    const r = await relay();
    const name = `ebmr_t_${uniqueSuffix()}`;
    await copyOf(inject('templateDb'), name);
    const pool = openPool({ connectionString: urlOn(r.adminUrl, name), max: 2 });
    await expectTeardownWaitsForEveryBackend({ relay: r, database: name, pools: { pool }, last: 'pool', teardown: () => endPool(pool), resolvesWithLastBackend: true });
  });

  it.each([
    { others: 'no other client', withIdleClient: false },
    { others: 'another client still idle in the pool', withIdleClient: true },
  ])('[meta] endPool also waits for a client the idle timeout removed that is still ending, which pg-pool\'s end() no longer sees ($others)', async ({ withIdleClient }) => {
    const r = await relay();
    const name = `ebmr_t_${uniqueSuffix()}`;
    await copyOf(inject('templateDb'), name);
    await expectEndPoolWaitsForIdleRemovedClient({ relay: r, database: name, connectionString: urlOn(r.adminUrl, name), open: openPool, end: endPool, withIdleClient });
  });
});

describe('kernel test helpers drop a database only once the backends of their pools have exited', () => {
  it.each(['admin', 'sandbox'])('[meta] openSandbox().drop(): every backend of both pools has exited before the forced drop (%s let go last)', async (last) => {
    const r = await relay();
    const name = sandboxTestName();
    await copyOf(sandboxTemplate, name);
    const sandbox = openSandbox(name, r.adminUrl);
    const pools = poolsOf(sandbox);
    expect(Object.keys(pools)).toEqual(['admin', 'sandbox']);
    for (const pool of Object.values(pools)) expect(() => pool.end()).toThrow(/^a pool made by openPool\(\) is ended with endPool\(\)/);
    await expectTeardownWaitsForEveryBackend({ relay: r, database: name, pools, last, teardown: () => sandbox.drop(), resolvesWithLastBackend: false });
    expect(await databaseExists(name)).toBe(false);
  });

  it.each(['admin', 'app'])('[meta] the drop() of a restored copy: every backend of both pools has exited before the forced drop (%s let go last)', async (last) => {
    const r = await relay();
    const name = `ebmr_t_${uniqueSuffix()}`;
    await copyOf(inject('templateDb'), name);
    const copy = openRestoredCopy(name, r.adminUrl);
    const pools = poolsOf(copy);
    expect(Object.keys(pools)).toEqual(['admin', 'app']);
    for (const pool of Object.values(pools)) expect(() => pool.end()).toThrow(/^a pool made by openPool\(\) is ended with endPool\(\)/);
    await expectTeardownWaitsForEveryBackend({ relay: r, database: name, pools, last, teardown: () => copy.drop(), resolvesWithLastBackend: false });
    expect(await databaseExists(name)).toBe(false);
  });
});

/**
 * The kernel test files that may make a pg.Pool without openPool, and why. Every other pool a kernel test opens comes
 * from openPool and is ended with endPool, so a forced drop after it cannot end a backend under a closing client.
 */
const PLAIN_POOLS: Record<string, string> = {
  'harness/teardown.test.ts': 'this file: a plain pool shows what endPool refuses',
  'identity/helpers.ts': 'authnLoginPool gives its pool an error listener of its own',
  'review/f55.test.ts': 'the pools of a restored cluster, which is stopped, never dropped with FORCE',
  'support/db.ts': 'createTestDatabase (the Phase 2 plan leaves test/support as it is): drop() gives its two pools an error listener before the forced drop',
};

describe('kernel tests open the pools they end with openPool', () => {
  it('[meta] no kernel test file makes a pg.Pool of its own without openPool (harness/pools.ts), except the files named with a reason', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const plain = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && /\bnew\s+(?:pg\.)?Pool\s*\(/.test(readFileSync(join(root, file), 'utf8')))
      .sort();
    expect(plain).toEqual(Object.keys(PLAIN_POOLS).sort());
  });
});
