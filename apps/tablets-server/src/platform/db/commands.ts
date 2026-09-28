/**
 * Commands (ADR 0006; kernel withCommand): every GMP write runs in one transaction that declares the actor
 * first. The platform wraps the kernel so that refusals on authority (EBMR-IAM-040) and segregation
 * (EBMR-IAM-041) are logged again outside the rolled-back command (identity.withGuardedCommand), for plain
 * commands and idempotent ones alike.
 */
import type pg from 'pg';
import { commands, identity, type ActorContext } from '@ebmr/kernel';

/** `withActorCommand` = identity.withGuardedCommand. */
export function withActorCommand<T>(pool: pg.Pool, actor: ActorContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return identity.withGuardedCommand(pool, actor, work);
}

export interface IdempotentResult<T> {
  result: T;
  /** True when an earlier execution stored the result and the work did not run now (decision D1). */
  replayed: boolean;
}

export interface IdempotentOptions<T> {
  /**
   * Runs inside the transaction before a stored result is replayed. When it throws, the replay rolls back and
   * commits nothing, not even the use of the actor's authentication event (the e-signature ceremony uses this for a
   * replayed refusal, which it logs with that event afterwards, see features/esig).
   */
  beforeReplay?: (result: T) => void;
}

/**
 * One idempotent command (outline 5.7; kernel platform.claim_idempotency_key): the key is claimed in the
 * command's own transaction and the JSON result stored with it, so a resend with the same key and request hash
 * returns the stored result. `begin_command` runs first and consumes the actor's authentication event (INV-40),
 * so a resend needs a fresh tap by the same person (decision D1).
 */
export async function withIdempotentActorCommand<T extends commands.JsonValue>(
  pool: pg.Pool,
  actor: ActorContext,
  key: string,
  requestHash: string,
  work: (client: pg.PoolClient) => Promise<T>,
  options: IdempotentOptions<T> = {},
): Promise<IdempotentResult<T>> {
  try {
    return await identity.withGuardedCommand(pool, actor, async (client) => {
      const { rows } = await client.query<{ claim: { status: 'NEW' | 'REPLAY'; result_json?: string } }>('select platform.claim_idempotency_key($1, $2) as claim', [key, requestHash]);
      const claim = rows[0]?.claim;
      if (!claim) throw new Error('platform.claim_idempotency_key returned nothing');
      if (claim.status === 'REPLAY') {
        if (claim.result_json === undefined) throw new Error(`idempotency key ${key} has no stored result`);
        const stored = JSON.parse(claim.result_json) as T;
        options.beforeReplay?.(stored);
        return { result: stored, replayed: true };
      }
      const result = await work(client);
      const json = JSON.stringify(result) as string | undefined;
      if (json === undefined) throw new TypeError('an idempotent command must return a JSON value');
      await client.query('select platform.complete_idempotency_key($1, $2)', [key, json]);
      return { result: JSON.parse(json) as T, replayed: false };
    });
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

/** The database clock in UTC epoch microseconds (GMP time always comes from the database). */
export async function dbNowUs(db: pg.Pool | pg.PoolClient): Promise<bigint> {
  const { rows } = await db.query<{ us: string }>('select tab.now_micros() as us');
  const us = rows[0]?.us;
  if (!us) throw new Error('the database returned no time');
  return BigInt(us);
}
