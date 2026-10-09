/**
 * Commands (ADR 0006; kernel withCommand): every GMP write runs in one transaction that declares the actor
 * first. The platform wraps the kernel so that refusals on authority (EBMR-IAM-040) and segregation
 * (EBMR-IAM-041) are logged again outside the rolled-back command (identity.withGuardedCommand), for plain
 * commands and idempotent ones alike. A refusal that must leave a durable record of its own (a DI-20 alert of a
 * refused scale reading claim) carries it as an action to run after the rollback (`afterRollback`); both wrappers
 * run it once the command's transaction has rolled back and its connection is released, under the same actor.
 */
import type pg from 'pg';
import { commands, identity, type ActorContext } from '@ebmr/kernel';
import { HttpRefusal } from '../http/refusal.ts';

/** Work a refusal leaves to be done after its command rolled back: typically a guarded command of its own under `actor`. */
export type AfterRollback = (pool: pg.Pool, actor: ActorContext) => Promise<void>;

const AFTER_ROLLBACK = Symbol('ebmr.afterRollback');

/**
 * Attaches `action` to `error`, a refusal thrown inside a command: the command wrappers below run it after the
 * command's transaction has rolled back (not before: the rolled-back transaction still holds its session and
 * authentication-event locks until then). A failure of the action never hides the refusal.
 */
export function afterRollback<E extends object>(error: E, action: AfterRollback): E {
  Object.defineProperty(error, AFTER_ROLLBACK, { value: action, enumerable: false, configurable: true });
  return error;
}

async function runAfterRollback(pool: pg.Pool, actor: ActorContext, error: unknown): Promise<void> {
  if (typeof error !== 'object' || error === null) return;
  const action = (error as { [AFTER_ROLLBACK]?: unknown })[AFTER_ROLLBACK];
  if (typeof action !== 'function') return;
  await (action as AfterRollback)(pool, actor).catch(() => undefined);
}

/** `withActorCommand` = identity.withGuardedCommand, then the refusal's after-rollback action, if any. */
export async function withActorCommand<T>(pool: pg.Pool, actor: ActorContext, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await identity.withGuardedCommand(pool, actor, work);
  } catch (error) {
    await runAfterRollback(pool, actor, error);
    throw error;
  }
}

export interface IdempotentResult<T> {
  result: T;
  /** True when an earlier execution stored the result and the work did not run now (decision D1). */
  replayed: boolean;
}

export interface IdempotentOptions<T> {
  /**
   * Runs inside the replaying command, after begin_command consumed the actor's authentication event and before the
   * stored result is returned (the e-signature ceremony logs a replayed refusal here, with the resend's own
   * authentication event, so the kernel sees that event's use as this command's own: see features/esig). When it
   * throws, the replay rolls back and commits nothing.
   */
  onReplay?: (client: pg.PoolClient, result: T) => Promise<void>;
}

/**
 * One idempotent command (outline 5.7; kernel platform.claim_idempotency_key): the key is claimed in the
 * command's own transaction and the JSON result stored with it, so a resend with the same key and request hash
 * returns the stored result. `begin_command` runs first and consumes the actor's authentication event (INV-40),
 * so a resend needs a fresh tap by the same person (decision D1).
 *
 * A refusal the work throws as an HttpRefusal (a feature's own check, e.g. a step command from a terminal outside the
 * step's room) is rethrown as it is, so the answer keeps the kind, controls and advice the feature declared; only
 * database and kernel errors become KernelErrors, answered through the guidance catalogue.
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
        if (options.onReplay) await options.onReplay(client, stored);
        return { result: stored, replayed: true };
      }
      const result = await work(client);
      const json = JSON.stringify(result) as string | undefined;
      if (json === undefined) throw new TypeError('an idempotent command must return a JSON value');
      await client.query('select platform.complete_idempotency_key($1, $2)', [key, json]);
      return { result: JSON.parse(json) as T, replayed: false };
    });
  } catch (error) {
    await runAfterRollback(pool, actor, error);
    if (error instanceof HttpRefusal) throw error;
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
