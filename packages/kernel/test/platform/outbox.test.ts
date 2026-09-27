/**
 * Transactional outbox (outline 4.6; ADR 0012): messages commit with the business change, relays
 * never deliver the same message concurrently, delivery is at least once with consumer-side
 * deduplication, and messages of one aggregate stay in order.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeOnce, drainOutbox, enqueue, relayOutboxBatch, type OutboxMessage } from '../../src/commands/outbox.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { testActor } from './helpers.ts';

let db: TestDatabase;
let ctx: ActorContext;
beforeAll(async () => {
  db = await createTestDatabase();
  ctx = await testActor(db);
});
afterAll(async () => {
  await db.drop();
});

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

async function put(topic: string, aggregate: string, payload: Record<string, string | number> = {}): Promise<string> {
  return withCommand(db.app, ctx, (c) => enqueue(c, topic, aggregate, payload));
}

const ignore = () => Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('writing messages', () => {
  it('a message commits together with the business change it announces', async () => {
    const id = await withCommand(db.app, ctx, async (c) => {
      const { rows: r } = await c.query<{ id: string }>("insert into platform.stub_record (title, body) values ('announced', 'x') returning id");
      const recordId = r[0]?.id ?? '';
      await enqueue(c, 'sample_record.created', `sample_record:${recordId}`, { title: 'announced' });
      return recordId;
    });
    const [msg] = await rows<{ topic: string; aggregate_id: string; correlation_id: string; person_id: string }>(
      'select topic, aggregate_id, correlation_id, person_id from platform.outbox where aggregate_id = $1',
      [id],
    );
    expect(msg).toMatchObject({ topic: 'sample_record.created', aggregate_id: id, person_id: ctx.personId });
    const [audit] = await rows<{ correlation_id: string }>("select correlation_id from kernel.audit_event where chain_key = $1 and action = 'INSERT'", [`sample_record:${id}`]);
    expect(msg?.correlation_id).toBe(audit?.correlation_id);
    const [state] = await rows<{ status: string; attempts: number }>(
      'select s.status, s.attempts from platform.outbox_state s join platform.outbox o on o.id = s.outbox_id where o.aggregate_id = $1',
      [id],
    );
    expect(state).toEqual({ status: 'PENDING', attempts: 0 });
  });

  it('rollback of the business transaction leaves no outbox row', async () => {
    const aggregate = `batch:${randomUUID()}`;
    await expect(
      withCommand(db.app, ctx, async (c) => {
        await enqueue(c, 'batch.step_completed', aggregate, { step: 'S-10' });
        throw new Error('guard failed after enqueue');
      }),
    ).rejects.toThrow('guard failed after enqueue');
    expect(await rows('select 1 from platform.outbox where aggregate_type || $2 || aggregate_id = $1', [aggregate, ':'])).toHaveLength(0);
    expect(await rows('select 1 from platform.outbox_state where aggregate_type || $2 || aggregate_id = $1', [aggregate, ':'])).toHaveLength(0);
  });

  it('enqueue needs a command and well-formed topic, aggregate and payload', async () => {
    await expect(db.app.query("select platform.enqueue('a.b', 'batch:1', '{}')")).rejects.toThrow('EBMR-PLAT-001');
    const bad = (topic: string, aggregate: string, payload: string) =>
      withCommand(db.app, ctx, (c) => c.query('select platform.enqueue($1, $2, $3::jsonb)', [topic, aggregate, payload]));
    await expect(bad('NoDots', 'batch:1', '{}')).rejects.toThrow('EBMR-PLAT-050');
    await expect(bad('batch.done', 'batch', '{}')).rejects.toThrow('EBMR-PLAT-051');
    await expect(bad('batch.done', 'batch:1', '[1]')).rejects.toThrow('EBMR-PLAT-052');
  });

  it('the application cannot write topics reserved for kernel facts (state changes, incident requests)', async () => {
    for (const topic of ['state.transitioned', 'state.created', 'incident.requested', 'platform.anything']) {
      await expect(withCommand(db.app, ctx, (c) => enqueue(c, topic, `batch:${randomUUID()}`, {}))).rejects.toThrow('EBMR-PLAT-057');
    }
    await expect(
      withCommand(db.app, ctx, (c) => c.query("select platform.enqueue_message('state.transitioned', 'batch:1', '{}')")),
    ).rejects.toThrow(/permission denied/);
  });

  it('the outbox is insert-only and the application role cannot write it directly', async () => {
    const messageId = await put('test.protect', `batch:${randomUUID()}`);
    await expect(
      db.app.query("insert into platform.outbox (topic, aggregate_type, aggregate_id, payload, correlation_id, person_id, source) values ('a.b', 'x', '1', '{}', gen_random_uuid(), 'p', 'UI')"),
    ).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from platform.outbox where message_id = $1', [messageId])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update platform.outbox_state set status = 'DELIVERED', delivered_at = now()")).rejects.toThrow(/permission denied/);
    await expect(db.admin.query("update platform.outbox set payload = '{}' where message_id = $1", [messageId])).rejects.toThrow('EBMR-PLAT-002');
    await expect(db.admin.query('delete from platform.outbox where message_id = $1', [messageId])).rejects.toThrow('EBMR-PLAT-002');
    await expect(db.admin.query('truncate platform.outbox cascade')).rejects.toThrow('EBMR-PLAT-002');
    // A transaction can mark delivered only what it claimed itself.
    const [row] = await rows<{ id: string }>('select id::text from platform.outbox where message_id = $1', [messageId]);
    await expect(db.app.query("select platform.outbox_mark_delivered($1, 'rogue')", [row?.id])).rejects.toThrow('EBMR-PLAT-055');
    await drainOutbox(db.app, { relayId: 'cleanup', handler: ignore });
  });
});

describe('relaying messages', () => {
  it('a relay delivers each message once, records the attempt and marks it delivered', async () => {
    const aggregate = `batch:${randomUUID()}`;
    const ids = [await put('test.deliver', aggregate, { n: 1 }), await put('test.deliver', aggregate, { n: 2 })];
    const seen: OutboxMessage[] = [];
    const result = await drainOutbox(db.app, {
      relayId: 'relay-A',
      handler: (m) => {
        if (m.topic === 'test.deliver') seen.push(m);
        return Promise.resolve();
      },
    });
    expect(result.failed).toEqual([]);
    expect(seen.map((m) => m.messageId)).toEqual(ids);
    expect(seen.map((m) => m.payload['n'])).toEqual([1, 2]);
    expect(seen.every((m) => m.attempt === 1 && m.aggregateType === 'batch')).toBe(true);
    const states = await rows<{ status: string; attempts: number; delivered_by: string; outcome: string; relay: string }>(
      `select s.status, s.attempts, s.delivered_by, a.outcome, a.relay from platform.outbox o
         join platform.outbox_state s on s.outbox_id = o.id join platform.outbox_attempt a on a.outbox_id = o.id
        where o.message_id = any($1::uuid[]) order by o.id`,
      [ids],
    );
    expect(states).toEqual(ids.map(() => ({ status: 'DELIVERED', attempts: 1, delivered_by: 'relay-A', outcome: 'DELIVERED', relay: 'relay-A' })));
    expect((await drainOutbox(db.app, { relayId: 'relay-A', handler: () => Promise.reject(new Error('must not be called')) })).claimed).toBe(0);
  });

  it('a failed delivery is recorded and retried after a back-off; later messages of that aggregate wait', async () => {
    const aggregate = `batch:${randomUUID()}`;
    const first = await put('test.retry', aggregate, { n: 1 });
    const second = await put('test.retry', aggregate, { n: 2 });
    const r1 = await relayOutboxBatch(db.app, {
      relayId: 'relay-B',
      handler: (m) => (m.topic === 'test.retry' ? Promise.reject(new Error('ERP not reachable')) : Promise.resolve()),
    });
    expect(r1.failed).toEqual([{ messageId: first, error: 'ERP not reachable' }]);
    const [state] = await rows<{ status: string; attempts: number; last_error: string; waits: boolean }>(
      `select s.status, s.attempts, s.last_error, s.next_attempt_at > clock_timestamp() as waits
         from platform.outbox_state s join platform.outbox o on o.id = s.outbox_id where o.message_id = $1`,
      [first],
    );
    expect(state).toEqual({ status: 'PENDING', attempts: 1, last_error: 'ERP not reachable', waits: true });
    // Nothing of that aggregate is claimable during the back-off: the second message must not overtake the first.
    const early = await relayOutboxBatch(db.app, { relayId: 'relay-B', handler: ignore });
    expect(early.delivered).not.toContain(second);
    expect(early.delivered).not.toContain(first);
    // Test set-up: end the back-off now.
    await db.admin.query('update platform.outbox_state s set next_attempt_at = clock_timestamp() from platform.outbox o where o.id = s.outbox_id and o.message_id = $1', [first]);
    const order: string[] = [];
    await drainOutbox(db.app, {
      relayId: 'relay-B',
      handler: (m) => {
        if (m.topic === 'test.retry') order.push(`${m.messageId}#${m.attempt}`);
        return Promise.resolve();
      },
    });
    expect(order).toEqual([`${first}#2`, `${second}#1`]);
    const attempts = await rows<{ attempt_no: number; outcome: string }>(
      'select a.attempt_no, a.outcome from platform.outbox_attempt a join platform.outbox o on o.id = a.outbox_id where o.message_id = $1 order by a.attempt_no',
      [first],
    );
    expect(attempts).toEqual([
      { attempt_no: 1, outcome: 'FAILED' },
      { attempt_no: 2, outcome: 'DELIVERED' },
    ]);
  });

  it('a claim skips messages locked by another relay and later messages of the same aggregate', async () => {
    await drainOutbox(db.app, { relayId: 'cleanup', handler: ignore });
    const aggA = `batch:${randomUUID()}`;
    const aggB = `batch:${randomUUID()}`;
    const a1 = await put('test.skip', aggA);
    const a2 = await put('test.skip', aggA);
    const b1 = await put('test.skip', aggB);
    const relayA = await db.app.connect();
    const relayB = await db.app.connect();
    try {
      await relayA.query('begin');
      await relayB.query('begin');
      const claimedA = await relayA.query<{ message_id: string }>("select message_id from platform.outbox_claim('relay-A', 1)");
      const claimedB = await relayB.query<{ message_id: string }>("select message_id from platform.outbox_claim('relay-B', 10)");
      expect(claimedA.rows.map((r) => r.message_id)).toEqual([a1]);
      expect(claimedB.rows.map((r) => r.message_id)).toEqual([b1]);
      expect(claimedB.rows.map((r) => r.message_id)).not.toContain(a2);
    } finally {
      await relayA.query('rollback');
      await relayB.query('rollback');
      relayA.release();
      relayB.release();
    }
    await drainOutbox(db.app, { relayId: 'cleanup', handler: ignore });
  });

  it('two relays running together never deliver the same message concurrently, and keep per-aggregate order', async () => {
    await drainOutbox(db.app, { relayId: 'cleanup', handler: ignore });
    const aggregates = Array.from({ length: 8 }, () => `batch:${randomUUID()}`);
    const written: { id: string; aggregate: string; n: number }[] = [];
    for (let n = 0; n < 4; n++) {
      for (const aggregate of aggregates) written.push({ id: await put('test.concurrent', aggregate, { n }), aggregate, n });
    }
    const inFlight = new Set<string>();
    const deliveries: { id: string; relay: string; aggregate: string; n: number }[] = [];
    let overlaps = 0;
    const handlerFor = (relay: string) => async (m: OutboxMessage) => {
      if (m.topic !== 'test.concurrent') return;
      if (inFlight.has(m.messageId)) overlaps++;
      inFlight.add(m.messageId);
      await sleep(5);
      deliveries.push({ id: m.messageId, relay, aggregate: `${m.aggregateType}:${m.aggregateId}`, n: Number(m.payload['n']) });
      inFlight.delete(m.messageId);
    };
    const run = async (relay: string) => {
      for (let i = 0; i < 200; i++) {
        const r = await relayOutboxBatch(db.app, { relayId: relay, handler: handlerFor(relay), batchSize: 3 });
        if (r.claimed === 0 && deliveries.length >= written.length) break;
        if (r.claimed === 0) await sleep(5);
      }
    };
    await Promise.all([run('relay-1'), run('relay-2')]);
    expect(overlaps).toBe(0);
    expect(deliveries.map((d) => d.id).sort()).toEqual(written.map((w) => w.id).sort());
    expect(new Set(deliveries.map((d) => d.id)).size).toBe(written.length);
    expect(new Set(deliveries.map((d) => d.relay))).toEqual(new Set(['relay-1', 'relay-2']));
    for (const aggregate of aggregates) {
      expect(deliveries.filter((d) => d.aggregate === aggregate).map((d) => d.n)).toEqual([0, 1, 2, 3]);
    }
    const [attempts] = await rows<{ n: string; distinct_messages: string }>(
      `select count(*)::text as n, count(distinct a.outbox_id)::text as distinct_messages from platform.outbox_attempt a
         join platform.outbox o on o.id = a.outbox_id where o.topic = 'test.concurrent'`,
    );
    expect(attempts).toEqual({ n: String(written.length), distinct_messages: String(written.length) });
  });

  it('at least once: a relay that dies after delivering redelivers, and the consumer applies the message once', async () => {
    await drainOutbox(db.app, { relayId: 'cleanup', handler: ignore });
    const aggregate = `sample_record:${randomUUID()}`;
    const messageId = await put('test.once', aggregate, { title: 'from outbox' });
    let deliveries = 0;
    const consumer = async (m: OutboxMessage) => {
      if (m.topic !== 'test.once') return;
      deliveries++;
      await withCommand(db.app, await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM' }), async (c) => {
        if (await consumeOnce(c, 'test.consumer', m.messageId)) {
          await c.query("insert into platform.stub_record (title, body) values ($1, 'x')", [`consumed ${m.messageId}`]);
        }
      });
    };
    // Relay crash: the handler ran, but the relay's transaction never committed.
    const crashed = await db.app.connect();
    try {
      await crashed.query('begin');
      const { rows: claimed } = await crashed.query<{ message_id: string; topic: string; outbox_id: string }>(
        "select message_id, topic, outbox_id from platform.outbox_claim('relay-crash', 10)",
      );
      for (const r of claimed) await consumer({ messageId: r.message_id, topic: r.topic } as OutboxMessage);
    } finally {
      await crashed.query('rollback');
      crashed.release();
    }
    await drainOutbox(db.app, { relayId: 'relay-restarted', handler: consumer });
    expect(deliveries).toBe(2);
    const effects = await rows('select 1 from platform.stub_record where title = $1', [`consumed ${messageId}`]);
    expect(effects).toHaveLength(1);
    await expect(db.app.query("delete from platform.consumed_message where consumer = 'test.consumer'")).rejects.toThrow(/permission denied/);
  });
});
