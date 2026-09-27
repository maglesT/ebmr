/**
 * Idempotent commands (build outline 5.7; ADR 0006 decision 2).
 *
 * Every mutating request carries an idempotency key chosen by the client (one per user action)
 * and a hash of the request. `withIdempotentCommand` runs the work at most once per key:
 *   - the key is claimed in the command's own transaction before the work runs, and the JSON
 *     result is stored in the same transaction, so the key exists only if the work committed;
 *   - a retry with the same key and request hash returns the stored result without running the
 *     work again (`replayed: true`);
 *   - the same key with a different request hash, or from another person or account, is refused
 *     (EBMR-PLAT-041 / EBMR-PLAT-042);
 *   - a concurrent duplicate waits for the first to commit and then replays its result.
 * Results are returned after a JSON round trip in both cases, so a replay is identical to the
 * original answer. Put decimals in results as strings.
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { asKernelError } from './errors.ts';
import type { JsonValue } from './json.ts';

export interface IdempotentOutcome<T extends JsonValue> {
  result: T;
  /** True when the result was stored by an earlier execution and the work did not run now. */
  replayed: boolean;
}

interface Claim {
  status: 'NEW' | 'REPLAY';
  result_json?: string;
}

export async function withIdempotentCommand<T extends JsonValue>(
  pool: pg.Pool,
  ctx: ActorContext,
  key: string,
  requestHash: string,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<IdempotentOutcome<T>> {
  try {
    return await withCommand(pool, ctx, async (client) => {
      const { rows } = await client.query<{ claim: Claim }>('select platform.claim_idempotency_key($1, $2) as claim', [key, requestHash]);
      const claim = rows[0]?.claim;
      if (!claim) throw new Error('platform.claim_idempotency_key returned nothing');
      if (claim.status === 'REPLAY') {
        if (claim.result_json === undefined) throw new Error(`idempotency key ${key} has no stored result`);
        return { result: JSON.parse(claim.result_json) as T, replayed: true };
      }
      const result = await work(client);
      const json = JSON.stringify(result) as string | undefined;
      if (json === undefined) throw new TypeError('an idempotent command must return a JSON value');
      await client.query('select platform.complete_idempotency_key($1, $2)', [key, json]);
      return { result: JSON.parse(json) as T, replayed: false };
    });
  } catch (error) {
    throw asKernelError(error);
  }
}
