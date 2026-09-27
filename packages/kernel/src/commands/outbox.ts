/**
 * Transactional outbox (build outline 4.6; ADR 0012).
 *
 * Producers call `enqueue` (platform.enqueue) inside their command transaction, so the message
 * exists only if the business change commits. A relay claims pending messages with
 * FOR UPDATE SKIP LOCKED (two relays never hold the same message), hands each to a handler,
 * records the attempt and marks the message delivered, all in the relay's transaction.
 *
 * Delivery is at least once: if a relay dies after its handler ran but before commit, the
 * message is delivered again. Handlers must therefore be idempotent on `messageId`; consumers
 * inside this database use `consumeOnce` in the same transaction as their effect.
 * Messages of one aggregate are delivered in the order they were written.
 *
 * The relay holds its transaction open while handlers run; keep handlers short (hand off to a
 * queue or perform one idempotent call) and batches small.
 */
import type pg from 'pg';
import type { JsonValue } from './json.ts';

export interface OutboxMessage {
  /** Outbox row id (bigint as a decimal string). */
  outboxId: string;
  /** Unique message id: the consumer-side deduplication key. */
  messageId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: { [key: string]: JsonValue };
  /** Correlation ID of the command that wrote the message (links to its audit events). */
  correlationId: string;
  recordedAt: Date;
  /** 1 for the first delivery attempt. */
  attempt: number;
}

export type OutboxHandler = (message: OutboxMessage) => Promise<void>;

export interface RelayOptions {
  /** Name of this relay instance, recorded with every attempt. */
  relayId: string;
  handler: OutboxHandler;
  /** Messages claimed per transaction; default 10. */
  batchSize?: number;
}

export interface RelayBatchResult {
  claimed: number;
  delivered: string[];
  failed: { messageId: string; error: string }[];
}

interface ClaimRow {
  outbox_id: string;
  message_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: { [key: string]: JsonValue };
  correlation_id: string;
  recorded_at: Date;
  attempt_no: number;
}

/** Writes an outbox message in the caller's command transaction. `aggregate` is "type:id". */
export async function enqueue(client: pg.PoolClient, topic: string, aggregate: string, payload: { [key: string]: JsonValue }): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select platform.enqueue($1, $2, $3::jsonb) as id', [topic, aggregate, JSON.stringify(payload)]);
  const id = rows[0]?.id;
  if (!id) throw new Error('platform.enqueue returned no message id');
  return id;
}

/** Claims one batch, delivers it and commits. Handler failures are recorded, not thrown. */
export async function relayOutboxBatch(pool: pg.Pool, options: RelayOptions): Promise<RelayBatchResult> {
  const result: RelayBatchResult = { claimed: 0, delivered: [], failed: [] };
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<ClaimRow>('select * from platform.outbox_claim($1, $2)', [options.relayId, options.batchSize ?? 10]);
    result.claimed = rows.length;
    for (const row of rows) {
      const message: OutboxMessage = {
        outboxId: row.outbox_id,
        messageId: row.message_id,
        topic: row.topic,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        correlationId: row.correlation_id,
        recordedAt: row.recorded_at,
        attempt: row.attempt_no,
      };
      let failure: string | undefined;
      try {
        await options.handler(message);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (failure === undefined) {
        await client.query('select platform.outbox_mark_delivered($1, $2)', [row.outbox_id, options.relayId]);
        result.delivered.push(row.message_id);
      } else {
        await client.query('select platform.outbox_mark_failed($1, $2, $3)', [row.outbox_id, options.relayId, failure]);
        result.failed.push({ messageId: row.message_id, error: failure });
      }
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Relays batches until nothing is claimable (or `maxBatches` is reached). */
export async function drainOutbox(pool: pg.Pool, options: RelayOptions, maxBatches = 100): Promise<RelayBatchResult> {
  const total: RelayBatchResult = { claimed: 0, delivered: [], failed: [] };
  for (let i = 0; i < maxBatches; i++) {
    const batch = await relayOutboxBatch(pool, options);
    total.claimed += batch.claimed;
    total.delivered.push(...batch.delivered);
    total.failed.push(...batch.failed);
    if (batch.claimed === 0) break;
  }
  return total;
}

/**
 * Consumer-side deduplication for consumers inside this database: true the first time
 * `consumer` sees `messageId`, false afterwards. Call it in the same transaction as the effect.
 */
export async function consumeOnce(client: pg.PoolClient, consumer: string, messageId: string): Promise<boolean> {
  const { rows } = await client.query<{ first: boolean }>('select platform.consume_once($1, $2) as first', [consumer, messageId]);
  return rows[0]?.first === true;
}
