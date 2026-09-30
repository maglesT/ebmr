/**
 * Correctness under concurrency (decision 0003; outline 5.7): two commands at once never break a
 * life-cycle rule. Each case holds the first command open on its own connection, starts the second,
 * then commits the first; the second must wait and then decide on the committed state.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, clone, reason, scope, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

/**
 * Opens a command on its own connection and leaves the transaction open. The two sides of a race are
 * two persons (kernel.begin_command records activity on the session row, so one session serialises).
 */
async function open(actor: SeededActor, extra: Partial<ActorContext> = {}): Promise<pg.PoolClient> {
  const c = await db.app.connect();
  await c.query('begin');
  const { seed: _s, ...ctx } = actor;
  void _s;
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext({ ...ctx, correlationId: randomUUID(), ...extra }))]);
  return c;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('life-cycle commands racing each other', () => {
  it('[PR-06][DI-04] a content edit racing the start of verification: verification waits and then refuses the unverified content', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content);
    const edited = clone(content);
    edited.header.title = `${edited.header.title} (late edit)`;
    const c1 = await open(w.cast.author);
    const c2 = await open(w.cast.coAuthor);
    try {
      await lc.saveContent(c1, v.versionId, edited, 'late edit');
      const s = await w.state(v.versionId);
      const second = settle(lc.startVerification(c2, v.versionId, s.version));
      await pause(300);
      await c1.query('commit');
      const r = await second;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/validator_passed: the static validator has not been run on this exact content/);
      await c2.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    expect((await w.state(v.versionId)).state).toBe('DRAFT');
  });

  it('[PR-06] the start of verification racing a content edit: the edit waits and is then refused (the candidate is frozen)', async () => {
    const content = uniqueContent();
    const v = await w.newVersion(content);
    await w.prepare(v.versionId, content);
    const edited = clone(content);
    edited.header.title = `${edited.header.title} (too late)`;
    const s = await w.state(v.versionId);
    const c1 = await open(w.cast.author);
    const c2 = await open(w.cast.coAuthor);
    try {
      await lc.startVerification(c1, v.versionId, s.version);
      const second = settle(lc.saveContent(c2, v.versionId, edited, 'too late'));
      await pause(300);
      await c1.query('commit');
      const r = await second;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/EBMR-RCP-021/);
      await c2.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    expect((await w.state(v.versionId)).state).toBe('IN_VERIFICATION');
  });

  it('[INV-17][PR-05] a market activation racing the retirement of its version never leaves a retired version CURRENT', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content);
    const id = await w.run(w.cast.qa, (c) => lc.proposeMarketAuthorisation(c, { versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell('S1', 'L1', 'PO-20K')], regulatoryBasis: 'IN' }));
    const qaSig = await w.sign(w.cast.qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
    const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
    const s = await w.state(v.versionId);
    // The retirement goes first (directly through the engine, holding the version's state row) ...
    const c1 = await open(w.cast.qa2, reason('retire while activating'));
    // The activation carries the QA person's own reason, both halves (migration 0290).
    const c2 = await open(w.cast.qa, reason('activate while retiring'));
    try {
      await lc.transitionVersion(c1, v.versionId, 'RETIRE', s.version);
      const second = settle(lc.activateMarketAuthorisation(c2, id, qaSig, regSig));
      await pause(300);
      await c1.query('commit');
      // ... so the activation waits and then sees a retired version.
      const r = await second;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/is RETIRED: only an APPROVED version becomes CURRENT or BRIDGING/);
      await c2.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    expect((await lc.selectVersionForIssue(db.app, { familyId: v.familyId, markets: ['IN'], scope: scope('S1', 'L1', 'PO-20K') })).ok).toBe(false);
    expect(await w.violations()).toEqual([]);
  });

  it('[INV-17] two activations for the same market and scope at once: exactly one version ends up CURRENT', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
    const prepared = async (versionId: string, qa: SeededActor) => {
      const id = await w.run(qa, (c) => lc.proposeMarketAuthorisation(c, { versionId, market: 'IN', kind: 'CURRENT', cells: [cell('S1', 'L1', 'PO-20K')], regulatoryBasis: 'IN' }));
      const qaSig = await w.sign(qa, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'MBR_MARKET_AUTHORISED', 'PROPOSED');
      const regSig = await w.sign(w.cast.regulatory, lc.MARKET_AUTHORISATION_AGGREGATE, id, 'REGULATORY_CONFIRMED', 'PROPOSED');
      return { id, qaSig, regSig };
    };
    const a1 = await prepared(v1.versionId, w.cast.qa2);
    const a2 = await prepared(v2.versionId, w.cast.qa);
    // Each activation carries its QA person's own reason, both halves (migration 0290).
    const c1 = await open(w.cast.qa2, reason('activate v1 for IN'));
    const c2 = await open(w.cast.qa, reason('activate v2 for IN'));
    try {
      await lc.activateMarketAuthorisation(c2, a2.id, a2.qaSig, a2.regSig);
      const second = settle(lc.activateMarketAuthorisation(c1, a1.id, a1.qaSig, a1.regSig));
      await pause(300);
      await c2.query('commit');
      const r = await second;
      // v2 committed first; the older v1 may not supersede it.
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/The newer version 2 is CURRENT.*EBMR-RCP-089/);
      await c1.query('rollback');
    } finally {
      c1.release();
      c2.release();
    }
    const cells = await db.app.query<{ n: string }>("select count(*)::text as n from recipe.authorisation_cell where family_id = $1 and status = 'CURRENT'", [v1.familyId]);
    expect(cells.rows[0]?.n).toBe('1');
    expect(await lc.selectVersionForIssue(db.app, { familyId: v1.familyId, markets: ['IN'], scope: scope('S1', 'L1', 'PO-20K') })).toMatchObject({ ok: true, version_number: 2 });
    expect(await w.violations()).toEqual([]);
  });
});
