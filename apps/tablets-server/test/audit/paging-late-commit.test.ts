/**
 * Review finding P11 (DI-22): audit paging never skips an entry that commits late. Entry ids are handed out when a
 * row is inserted, not when its transaction commits; within one chain the chain-head lock makes commit order follow
 * id order, but across chains (a person, a correlation, a time window, or no filter) a later id can commit first. A
 * page must therefore never step past an entry that a transaction still in progress may yet commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toDbContext, withCommand } from '@ebmr/kernel';
import { routes, type AuditEventView } from '@ebmr/api-contract';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { actorOfBrowser, personaIn, startSigningServer, valueOf } from '../esig/support.ts';

// The test entries go on chains of a RECORD-class prefix (esig_stub:), which the author's role reads (tablets 0420,
// review F35: a chain of a prefix nobody classified is a governance chain, read only in a governance or audit role).
let gmp: TestServer;
let author: TestBrowser;
/** The same person in a second session (each command locks its own session row, kernel 0190). */
let authorElsewhere: TestBrowser;

beforeAll(async () => {
  gmp = await startSigningServer('GMP');
  author = await gmp.asPersona('author');
  authorElsewhere = await gmp.asPersona('author');
});
afterAll(async () => {
  await gmp?.close();
});

const entry = (chainKey: string, message: string) => `select kernel.audit_business_event('${chainKey}', '${message}', '{}'::jsonb)::text as id`;

async function committedEntry(chainKey: string, message: string): Promise<string> {
  return withCommand(gmp.db.app, await actorOfBrowser(gmp, authorElsewhere, 'author'), async (c) => {
    const { rows } = await c.query<{ id: string }>(entry(chainKey, message));
    return rows[0]?.id ?? '';
  });
}

async function page(query: Record<string, string>): Promise<{ events: AuditEventView[]; nextCursor: string | null }> {
  return valueOf(await author.call(routes.audit.events, { query }));
}

describe('P11 audit paging and entries that commit late', () => {
  it('[DI-22] paging the entries of a person never skips an entry whose transaction commits after a later entry was committed', async () => {
    const me = personaIn(gmp, 'author');
    const chainA = `esig_stub:review-p11-${randomUUID()}`;
    const chainB = `esig_stub:review-p11-${randomUUID()}`;

    // Transaction A writes its entry on chain A and is still running.
    const a = await gmp.db.app.connect();
    let aId = '';
    const bIds: string[] = [];
    const seen: string[] = [];
    let first: { events: AuditEventView[]; nextCursor: string | null } | undefined;
    try {
      await a.query('begin');
      await a.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await actorOfBrowser(gmp, author, 'author')))]);
      aId = (await a.query<{ id: string }>(entry(chainA, 'late entry'))).rows[0]?.id ?? '';
      // Two commands on chain B commit meanwhile: their ids are higher than A's.
      bIds.push(await committedEntry(chainB, 'first on time'), await committedEntry(chainB, 'second on time'));
      expect(bIds.every((b) => BigInt(b) > BigInt(aId))).toBe(true);

      // A reviewer pages this person's entries one by one, starting just before A's entry.
      let cursor = (BigInt(aId) - 1n).toString();
      first = await page({ personId: me.personId, limit: '1', cursor });
      seen.push(...first.events.map((e) => e.eventId));
      cursor = first.nextCursor ?? cursor;

      // The chain view of B is not held back: within one chain, commit order follows id order.
      expect((await page({ chainKey: chainB })).events.map((e) => e.eventId)).toEqual(bIds);

      await a.query('commit');

      for (let i = 0; i < 10; i += 1) {
        const next = await page({ personId: me.personId, limit: '1', cursor });
        seen.push(...next.events.map((e) => e.eventId));
        if (!next.nextCursor) break;
        cursor = next.nextCursor;
      }
    } finally {
      await a.query('rollback').catch(() => undefined);
      a.release();
    }
    // Every entry, once, in id order: A's entry is not skipped although B's committed first.
    expect(seen).toEqual([aId, ...bIds]);
    // While A was running, nothing beyond its entry was shown, and the paging was not declared over.
    expect(first?.events).toEqual([]);
    expect(first?.nextCursor).not.toBeNull();
  });

  it('[DI-22] the unfiltered list and a time window are held back the same way while a transaction is in progress, and complete once it ends', async () => {
    for (const filter of [{}, { from: '0' }] as Record<string, string>[]) await heldBackThenComplete(filter);
  });
});

/** While transaction A (chain A) runs and B (chain B, a higher id) has committed, a cross-chain list holds back. */
async function heldBackThenComplete(filter: Record<string, string>): Promise<void> {
  const chainA = `esig_stub:review-p11-${randomUUID()}`;
  const chainB = `esig_stub:review-p11-${randomUUID()}`;
  const a = await gmp.db.app.connect();
  try {
    await a.query('begin');
    await a.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(await actorOfBrowser(gmp, author, 'author')))]);
    const aId = (await a.query<{ id: string }>(entry(chainA, 'late entry'))).rows[0]?.id ?? '';
    const bId = await committedEntry(chainB, 'on time');
    const after = (BigInt(aId) - 1n).toString();
    const held = await page({ ...filter, limit: '50', cursor: after });
    await a.query('commit');
    const all: string[] = [];
    let cursor: string | null = held.nextCursor;
    for (let i = 0; i < 10 && cursor; i += 1) {
      const next = await page({ ...filter, limit: '50', cursor });
      all.push(...next.events.map((e) => e.eventId));
      cursor = next.nextCursor;
    }
    expect({ filter, held: held.events.map((e) => e.eventId), after: [...held.events.map((e) => e.eventId), ...all] }).toEqual({ filter, held: [], after: [aId, bId] });
  } finally {
    await a.query('rollback').catch(() => undefined);
    a.release();
  }
}
