/**
 * INV-09, DI-37 (Phase 2 exit review F37, round-4 verification; kernel 1020): the per-record signing lock serialises a
 * signing with every change of its record only in a READ COMMITTED transaction, so it is taken in no other.
 *
 * esig.sign and esig.content_changed take esig.aggregate_lock and then read the record. Under READ COMMITTED each later
 * statement reads what committed before the lock was granted. Under REPEATABLE READ or SERIALIZABLE the whole
 * transaction reads the snapshot of its first statement, taken before the wait: a signing then signed the content its
 * snapshot showed although a change had committed meanwhile, and a change looked for the signatures to supersede in its
 * snapshot and left a signature committed meanwhile unsuperseded. Either way the signature read CONTENT_MISMATCH and
 * only esig.verify_signatures noticed (SSI does not see a READ COMMITTED partner). Now the lock refuses a transaction
 * that is not READ COMMITTED (EBMR-ESIG-015): nothing is signed or changed there, and no signature covers content its
 * record no longer has.
 *
 * The races themselves are shown on two connections where they happened, in
 * apps/tablets-server/test/execution/db-guards-proposal-race.test.ts (F37.R round 2: a proposal, a signing and a change of
 * an exception's content at either level, each before this migration ending in a signature over content the record no
 * longer had). For this stub record the two transactions also meet on the record's own audit chain, which already ended
 * the later one with a serialization failure (observed: "could not serialize access due to concurrent update"); a
 * record whose changes are audited on another chain than its signatures (the execution store's) had no such meeting
 * point, so the rule is tested here on one connection.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, type ActorContext } from '../../src/db/command.ts';
import { verifySignatures } from '../../src/esig/integrity.ts';
import { sign, signatureState } from '../../src/esig/signing.ts';
import type { SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { challengeFor, cmd, createStub, dbCount, ensureSealKey, shopFloor, signatureAuth, signStub, testActor, testKeyRing, testSealKey } from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

type Isolation = 'read committed' | 'repeatable read' | 'serializable';
const SNAPSHOT_LEVELS = ['repeatable read', 'serializable'] as const;

/**
 * A command of `ctx` in a transaction at `isolation`, its snapshot taken by kernel.begin_command, left open; `finish`
 * runs `work` in it and commits: 'ok', or the message it was refused with (rolled back).
 */
async function openAt(pool: pg.Pool, ctx: ActorContext, isolation: Isolation): Promise<{ finish: (work: (c: pg.PoolClient) => Promise<unknown>) => Promise<string> }> {
  const c = await pool.connect();
  await c.query(`begin isolation level ${isolation}`);
  await c.query("set local statement_timeout = '30s'");
  await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
  return {
    finish: async (work) => {
      try {
        await work(c);
        await c.query('commit');
        return 'ok';
      } catch (e) {
        await c.query('rollback');
        return e instanceof Error ? e.message : String(e);
      } finally {
        c.release();
      }
    },
  };
}

/** A PERFORMED signing of stub `id` by `op` prepared up to esig.sign: its challenge, the signer's authentication and the command it is made in. */
async function preparedSigning(op: SeededActor, id: string): Promise<{ ctx: ActorContext; sign: (c: pg.PoolClient) => Promise<unknown> }> {
  const ch = await challengeFor(db, op, id, { meaning: 'PERFORMED' });
  const authEventId = await signatureAuth(db, op, op, ch.challengeId);
  const ctx = shopFloor(op) ? { ...(await cmd(db, op)), authEventId } : await cmd(db, op);
  return { ctx, sign: (c) => sign(c, { challengeId: ch.challengeId, authEventId, expectedState: 'OPEN' }, testSealKey) };
}

const signaturesOf = (id: string): Promise<number> => dbCount(db, "select 1 from esig.signature where aggregate_type = 'esig_stub' and aggregate_id = $1", [id]);
const problemsOf = async (signatureIds: readonly string[]): Promise<string[]> =>
  (await verifySignatures(db.app, testKeyRing)).filter((p) => p.signatureId !== null && signatureIds.includes(p.signatureId)).map((p) => p.problem.split(':')[0] ?? p.problem);
const refusedHere = (level: string): RegExp =>
  new RegExp(`^EBMR-ESIG-015 a signature, and a change of signed content, are made only in a READ COMMITTED transaction: under ${level} the transaction reads esig_stub \\S+ as its snapshot saw it`);

describe('F37: the signing lock is taken only in READ COMMITTED (INV-09, DI-37; kernel 1020)', () => {
  it('[INV-09][DI-37] a signing in a REPEATABLE READ or SERIALIZABLE transaction is refused (EBMR-ESIG-015) and nothing is signed; the same signing in READ COMMITTED is made', async () => {
    const op = await testActor(db);
    for (const level of SNAPSHOT_LEVELS) {
      const id = await createStub(db, op);
      const signing = await preparedSigning(op, id);
      const t = await openAt(db.app, signing.ctx, level);
      expect(await t.finish(signing.sign), level).toMatch(refusedHere(level));
      expect(await signaturesOf(id), level).toBe(0);
    }
    const id = await createStub(db, op);
    const signing = await preparedSigning(op, id);
    expect(await (await openAt(db.app, signing.ctx, 'read committed')).finish(signing.sign)).toBe('ok');
    expect(await signaturesOf(id)).toBe(1);
  });

  it('[INV-09][DI-37] a change of signed content in a REPEATABLE READ or SERIALIZABLE transaction is refused (EBMR-ESIG-015) and the record keeps its signed content; the same correction in READ COMMITTED supersedes the signature in its own transaction', async () => {
    const op = await testActor(db);
    const corrector = await testActor(db);
    const correct = (c: pg.PoolClient, id: string) => c.query('update esig.stub_signable set value = $2 where id = $1', [id, '12.530']);
    const reason = { reasonCode: 'ENTRY_ERROR', reasonText: 'transcription error corrected' };
    for (const level of SNAPSHOT_LEVELS) {
      const id = await createStub(db, op);
      const signed = await signStub(db, op, id, { meaning: 'PERFORMED' });
      expect(await (await openAt(db.app, await cmd(db, corrector, reason), level)).finish((c) => correct(c, id)), level).toMatch(refusedHere(level));
      expect((await signatureState(db.app, signed.signatureId)).status, level).toBe('VALID');
      expect(await dbCount(db, "select 1 from esig.stub_signable where id = $1 and value = '12.503'", [id]), level).toBe(1);
    }
    const id = await createStub(db, op);
    const signed = await signStub(db, op, id, { meaning: 'PERFORMED' });
    expect(await (await openAt(db.app, await cmd(db, corrector, reason), 'read committed')).finish((c) => correct(c, id))).toBe('ok');
    expect((await signatureState(db.app, signed.signatureId)).status).toBe('SUPERSEDED_BY_CHANGE');
    expect(await problemsOf([signed.signatureId])).toEqual([]);
  });
});
