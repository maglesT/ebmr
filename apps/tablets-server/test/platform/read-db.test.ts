/**
 * The Kysely read database never owns the application pool: closing the app after a read leaves the pool to its
 * owner (Pools), so the pool is ended exactly once (module C0; found by C1's audit viewer).
 */
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { startServer } from '../support/harness.ts';

describe('read database', () => {
  it('reads through the shared application pool and does not end it when the app closes', async () => {
    const server = await startServer('GMP');
    let closed = false;
    try {
      const { rows } = await sql<{ one: number }>`select 1 as one`.execute(server.built.ctx.readDb);
      expect(rows).toEqual([{ one: 1 }]);
      await server.built.close();
      const { rows: after } = await server.db.app.query<{ one: number }>('select 1 as one');
      expect(after).toEqual([{ one: 1 }]);
      await server.db.close();
      closed = true;
    } finally {
      if (!closed) await server.close().catch(() => undefined);
    }
  });
});
