/**
 * The Kysely read database never owns the application pool: closing the app after a read leaves the pool to its
 * owner (Pools), so the pool is ended exactly once (module C0; found by C1's audit viewer).
 *
 * The pool's end() is watched. A pool made by openPool refuses its own end() and the app's close() lets an error of the
 * read database's destroy() go, so a pool handed to Kysely would still answer here: only the call shows it. The test
 * closes the app itself, so server.close(), which would close it again, is not its teardown: it ends the pools (a pool
 * already ended would refuse) and drops its copy of the GMP template, which must then be gone.
 */
import { sql } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { databaseExists, dropDatabase } from '@ebmr/test-kit';
import { startServer } from '../support/harness.ts';

describe('read database', () => {
  it('[meta] reads through the shared application pool and does not end it when the app closes', async () => {
    const server = await startServer('GMP');
    let appClosed = false;
    try {
      const end = vi.spyOn(server.db.app, 'end');
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(server.built.ctx.readDb);
      expect(rows).toEqual([{ one: 1 }]);
      await server.built.close();
      appClosed = true;
      expect(end).not.toHaveBeenCalled();
      const { rows: after } = await server.db.app.query<{ one: number }>('select 1 as one');
      expect(after).toEqual([{ one: 1 }]);
    } finally {
      if (appClosed) {
        try {
          await server.db.close();
        } finally {
          await dropDatabase(server.database);
        }
      } else {
        await server.close();
      }
    }
    expect(await databaseExists(server.database), `${server.database} is dropped`).toBe(false);
  });
});
