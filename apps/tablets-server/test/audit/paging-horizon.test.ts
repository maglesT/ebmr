/**
 * Review P11 (DI-22), the other side of the settled horizon: it holds a list across chains back only for transactions
 * that may still commit an audit entry. A transaction that holds an xid but writes no audit entry (a DBA's idle psql
 * session, a long job on other tables) must not freeze every audit list, also not right after a server start; while an
 * audit writer runs, the list is held back and says so (a next cursor), and it completes once that writer has ended.
 * The late-commit case itself is proven in paging-late-commit.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toDbContext, withCommand } from '@ebmr/kernel';
import { routes, type AuditEventView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { actorOfBrowser, startSigningServer, valueOf } from '../esig/support.ts';

// The test entries go on chains of a RECORD-class prefix (esig_stub:), which the author's role reads (tablets 0420,
// review F35: a chain of a prefix nobody classified is a governance chain, read only in a governance or audit role).
let gmp: TestServer;
let author: TestBrowser;
let authorElsewhere: TestBrowser;

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  author = await gmp.asPersona('author');
  authorElsewhere = await gmp.asPersona('author');
});
afterAll(async () => {
  await gmp?.close();
});

async function committedEntry(chainKey: string): Promise<string> {
  return withCommand(gmp.db.app, await actorOfBrowser(gmp, authorElsewhere, 'author'), async (c) => {
    const { rows } = await c.query<{ id: string }>(`select kernel.audit_business_event($1, 'on time', '{}'::jsonb)::text as id`, [chainKey]);
    return rows[0]?.id ?? '';
  });
}

async function page(query: Record<string, string>): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
  return valueOf(await author.call(routes.audit.events, { query }));
}

describe('P11: what holds the audit list back', () => {
  // First in this file: the server has answered no audit list yet (its horizon starts at nothing proven).
  it('[DI-22] an open transaction that wrote no audit entry does not hold back the lists across chains, from the first request after the start', async () => {
    const idle = await gmp.db.admin.connect();
    try {
      await idle.query('begin');
      await idle.query('select txid_current()');
      await idle.query('create temporary table p11_scratch (x int)');
      const entry = await committedEntry(`esig_stub:review-p11-${randomUUID()}`);
      const after = (BigInt(entry) - 1n).toString();
      for (const filter of [{}, { from: '0' }] as Record<string, string>[]) {
        const listed = await page({ ...filter, cursor: after, limit: '50' });
        expect({ filter, ids: listed.events.map((e) => e.eventId), nextCursor: listed.nextCursor }).toEqual({ filter, ids: [entry], nextCursor: null });
      }
    } finally {
      await idle.query('rollback').catch(() => undefined);
      idle.release();
    }
  });

  it('[DI-22] an open transaction that wrote an audit entry holds the list back at its entry, and the list completes once it commits', async () => {
    const writer = await gmp.db.app.connect();
    try {
      await writer.query('begin');
      await writer.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await actorOfBrowser(gmp, author, 'author')))]);
      const late = (await writer.query<{ id: string }>(`select kernel.audit_business_event($1, 'late', '{}'::jsonb)::text as id`, [`esig_stub:review-p11-${randomUUID()}`])).rows[0]?.id ?? '';
      const onTime = await committedEntry(`esig_stub:review-p11-${randomUUID()}`);
      const after = (BigInt(late) - 1n).toString();
      const held = await page({ cursor: after, limit: '50' });
      expect(held.events).toEqual([]);
      expect(held.nextCursor).toBe(after);
      await writer.query('commit');
      const done = await page({ cursor: after, limit: '50' });
      expect({ ids: done.events.map((e) => e.eventId), nextCursor: done.nextCursor }).toEqual({ ids: [late, onTime], nextCursor: null });
    } finally {
      await writer.query('rollback').catch(() => undefined);
      writer.release();
    }
  });
});
