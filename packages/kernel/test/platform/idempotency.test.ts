/**
 * Idempotent commands (outline 5.7; ADR 0006 decision 2): retries and double clicks are harmless.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdempotentCommand } from '../../src/commands/idempotency.ts';
import { canonicalJson, requestHash } from '../../src/commands/json.ts';
import { KernelError } from '../../src/commands/errors.ts';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { testActor } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const key = () => `k-${randomUUID()}`;

async function recordCount(title: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('select count(*)::text as n from platform.stub_record where title = $1', [title]);
  return Number(rows[0]?.n);
}

describe('idempotency keys', () => {
  it('a retry with the same key and request returns the stored result without running the work again', async () => {
    const ctx = await testActor(db);
    const k = key();
    const title = `record ${k}`;
    const hash = requestHash({ command: 'create-record', title });
    let runs = 0;
    const work = async (c: pg.PoolClient) => {
      runs++;
      const { rows } = await c.query<{ id: string }>('insert into platform.stub_record (title, body) values ($1, $2) returning id', [title, 'x']);
      return { id: rows[0]?.id ?? '', quantity: '12.503' };
    };
    const first = await withIdempotentCommand(db.app, ctx, k, hash, work);
    const retry = await withIdempotentCommand(db.app, ctx, k, hash, work);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.result).toEqual(first.result);
    expect(runs).toBe(1);
    expect(await recordCount(title)).toBe(1);
  });

  it('the same key with a different request is refused (EBMR-PLAT-041)', async () => {
    const ctx = await testActor(db);
    const k = key();
    await withIdempotentCommand(db.app, ctx, k, requestHash({ value: '1.0' }), () => Promise.resolve('ok'));
    const refused = withIdempotentCommand(db.app, ctx, k, requestHash({ value: '1.1' }), () => Promise.resolve('changed'));
    await expect(refused).rejects.toThrow('EBMR-PLAT-041');
    await expect(refused).rejects.toBeInstanceOf(KernelError);
  });

  it('the same key from another person or account is refused (EBMR-PLAT-042)', async () => {
    const owner = await testActor(db);
    const k = key();
    const hash = requestHash({ a: 1 });
    await withIdempotentCommand(db.app, owner, k, hash, () => Promise.resolve({ secret: 'owner result' }));
    await expect(withIdempotentCommand(db.app, await testActor(db), k, hash, () => Promise.resolve({}))).rejects.toThrow('EBMR-PLAT-042');
    await expect(
      withIdempotentCommand(db.app, await testActor(db, { personId: owner.personId }), k, hash, () => Promise.resolve({})),
    ).rejects.toThrow('EBMR-PLAT-042');
  });

  it('a command that fails leaves no key behind, so the retry runs the work', async () => {
    const ctx = await testActor(db);
    const k = key();
    const hash = requestHash({ n: 1 });
    await expect(withIdempotentCommand(db.app, ctx, k, hash, () => Promise.reject(new Error('guard refused')))).rejects.toThrow('guard refused');
    const { rows } = await db.admin.query('select 1 from platform.idempotency_key where key = $1', [k]);
    expect(rows).toHaveLength(0);
    const retry = await withIdempotentCommand(db.app, ctx, k, hash, () => Promise.resolve({ ok: true }));
    expect(retry).toEqual({ result: { ok: true }, replayed: false });
  });

  it('two parallel executions with the same key run the work once', async () => {
    const ctx = await testActor(db);
    const k = key();
    const title = `parallel ${k}`;
    const hash = requestHash({ title });
    let runs = 0;
    const work = async (c: pg.PoolClient) => {
      runs++;
      await c.query('select pg_sleep(0.3)');
      const { rows } = await c.query<{ id: string }>('insert into platform.stub_record (title, body) values ($1, $2) returning id', [title, 'x']);
      return { id: rows[0]?.id ?? '' };
    };
    const outcomes = await Promise.all([1, 2, 3].map(() => withIdempotentCommand(db.app, ctx, k, hash, work)));
    expect(runs).toBe(1);
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => JSON.stringify(o.result))).size).toBe(1);
    expect(await recordCount(title)).toBe(1);
  });

  it('when the first of two parallel executions fails, the second runs the work itself', async () => {
    const ctx = await testActor(db);
    const k = key();
    const hash = requestHash({ x: 'y' });
    let runs = 0;
    const failing = withIdempotentCommand(db.app, ctx, k, hash, async (c) => {
      runs++;
      await c.query('select pg_sleep(0.3)');
      throw new Error('first attempt failed');
    });
    await new Promise((r) => setTimeout(r, 100));
    const second = withIdempotentCommand(db.app, ctx, k, hash, () => {
      runs++;
      return Promise.resolve({ attempt: 2 });
    });
    await expect(failing).rejects.toThrow('first attempt failed');
    await expect(second).resolves.toEqual({ result: { attempt: 2 }, replayed: false });
    expect(runs).toBe(2);
  });

  it('a key claimed without storing its result cannot commit', async () => {
    const ctx = await testActor(db);
    const k = key();
    await expect(withCommand(db.app, ctx, (c) => c.query('select platform.claim_idempotency_key($1, $2)', [k, requestHash({})]))).rejects.toThrow(
      'EBMR-PLAT-045',
    );
    await expect(withCommand(db.app, ctx, (c) => c.query('select platform.complete_idempotency_key($1, $2)', [k, '{}']))).rejects.toThrow('EBMR-PLAT-044');
  });

  it('keys and stored results are reachable only through the platform functions', async () => {
    await expect(db.app.query('select * from platform.idempotency_key')).rejects.toThrow(/permission denied/);
    await expect(
      db.app.query("insert into platform.idempotency_key (key, request_hash, person_id, account_id, correlation_id) values ('abcdefgh', repeat('a', 64), 'p', 'a', gen_random_uuid())"),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select platform.claim_idempotency_key('abcdefgh', repeat('a', 64))")).rejects.toThrow('EBMR-PLAT-001');
  });

  it('malformed keys and request hashes are refused', async () => {
    const ctx = await testActor(db);
    await expect(withIdempotentCommand(db.app, ctx, 'short', requestHash({}), () => Promise.resolve(1))).rejects.toThrow('EBMR-PLAT-040');
    await expect(withIdempotentCommand(db.app, ctx, 'has spaces in it', requestHash({}), () => Promise.resolve(1))).rejects.toThrow('EBMR-PLAT-040');
    await expect(withIdempotentCommand(db.app, ctx, key(), 'ABC', () => Promise.resolve(1))).rejects.toThrow('EBMR-PLAT-043');
  });

  it('request hashes are canonical: key order does not matter, any value change does', () => {
    expect(canonicalJson({ b: ['2', { d: null, c: true }], a: '1.50' })).toBe('{"a":"1.50","b":["2",{"c":true,"d":null}]}');
    expect(requestHash({ a: '1', b: '2' })).toBe(requestHash({ b: '2', a: '1' }));
    expect(requestHash({ a: '1.5' })).not.toBe(requestHash({ a: '1.50' }));
    expect(requestHash({ a: '1' })).toMatch(/^[0-9a-f]{64}$/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(RangeError);
  });
});
