/**
 * Protected identifiers that are never reused, including after a restore (INV-27).
 *
 * Counters are write-ahead: a block of values is first written to the external ledger as a ceiling,
 * then acknowledged in the database (continuity.reserve_counter_ceiling), and only then can the owning
 * module issue values up to that ceiling (continuity.next_counter_value, called from its SECURITY
 * DEFINER functions). Because the ceiling outside the database is always at least the highest value
 * ever issued, a restore can move every counter past the lost window (continuity.after_restore). A
 * block is also bound to the server start: after any start (which may follow a physical copy or a
 * snapshot rollback that keeps the database incarnation) the rest of the block is retired and a new
 * block is reserved (EBMR-CONT-011, handled by withProtectedNumbers).
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { withGuardedCommand } from '../identity/authority.ts';
import { ledgerMaxCeiling, type ExternalLedger, type HighWaterMark } from './ledger.ts';

export type Db = pg.Pool | pg.PoolClient;

/** Error codes raised by the database when a counter cannot issue a value. */
export const NO_CEILING = 'EBMR-CONT-011';
export const INCARNATION_CHANGED = 'EBMR-CONT-012';

export class ContinuityError extends Error {
  override readonly name = 'ContinuityError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code} ${message}`);
  }
}

interface PgError {
  message?: string;
  detail?: string;
}

/** The counter key a database error asks to reserve for, if it is a "no ceiling left" error. */
export function counterNeedingReservation(error: unknown): string | null {
  const e = error as PgError | null;
  if (e && typeof e.message === 'string' && e.message.startsWith(NO_CEILING) && typeof e.detail === 'string') return e.detail;
  return null;
}

/**
 * Reserve the next block of a protected counter: write the new ceiling to the external ledger first,
 * then acknowledge it in the database. One transaction, in this order:
 *   1. continuity.prepare_counter_reservation authorises the actor (DI-18, DI-17 in the counter's scope),
 *      locks the counter and checks the database incarnation. A refused actor, or a restored database,
 *      writes NOTHING outside the database: no ceiling reaches the ledger that the database could never
 *      acknowledge (which would later skip serials and raise a false LEDGER_AHEAD alarm).
 *   2. the new ceiling is appended to the external ledger (write-ahead);
 *   3. continuity.reserve_counter_ceiling acknowledges it, and the transaction commits.
 * Reservations of one counter are serialised (transaction advisory lock plus the counter row lock), so
 * the ledger and the database see them in the same order. A refusal on authority is logged again
 * outside the rolled-back transaction (withGuardedCommand, DI-17). Returns the ceiling now in force.
 */
export async function reserveCounterBlock(pool: pg.Pool, ctx: ActorContext, ledger: ExternalLedger, sequenceKey: string): Promise<bigint> {
  return withGuardedCommand(pool, ctx, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`continuity.counter:${sequenceKey}`]);
    const { rows } = await client.query<{ last_value: string; reserved_ceiling: string; block_size: string }>(
      'select last_value::text, reserved_ceiling::text, block_size::text from continuity.prepare_counter_reservation($1)',
      [sequenceKey],
    );
    const state = rows[0];
    if (!state) throw new ContinuityError('EBMR-CONT-010', `${sequenceKey} is not a protected counter`);
    const floor = (await ledgerMaxCeiling(ledger, sequenceKey)) ?? 0n;
    const last = BigInt(state.last_value);
    const reserved = BigInt(state.reserved_ceiling);
    let base = last > reserved ? last : reserved;
    if (floor > base) base = floor;
    const ceiling = base + BigInt(state.block_size);
    const receipt = await ledger.append({ type: 'CEILING', database: ledger.database, sequenceKey, ceiling: ceiling.toString(), floor: floor.toString() });
    const res = await client.query<{ ceiling: string }>('select continuity.reserve_counter_ceiling($1, $2, $3, $4)::text as ceiling', [
      sequenceKey,
      floor.toString(),
      ceiling.toString(),
      receipt.id,
    ]);
    return BigInt(res.rows[0]?.ceiling ?? '0');
  });
}

/**
 * Run a command that issues protected numbers. When a counter has no ceiling left, a block is reserved
 * (ledger first) and the command is retried; each retry is a fresh transaction, so nothing from the
 * failed attempt remains.
 */
export async function withProtectedNumbers<T>(
  pool: pg.Pool,
  ctx: ActorContext,
  ledger: ExternalLedger,
  work: (client: pg.PoolClient) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withCommand(pool, ctx, work);
    } catch (error) {
      const key = counterNeedingReservation(error);
      if (key === null || attempt >= maxAttempts) throw error;
      await reserveCounterBlock(pool, ctx, ledger, key);
    }
  }
}

/** Current high-water marks of every protected source, as exported with each external anchor. */
export async function readHighWater(db: Db): Promise<HighWaterMark[]> {
  const { rows } = await db.query<{ sequence_key: string; source_kind: 'PG_SEQUENCE' | 'COUNTER'; last_value: string; reserved_ceiling: string | null }>(
    'select sequence_key, source_kind, last_value::text, reserved_ceiling::text from continuity.sequence_high_water()',
  );
  return rows.map((r) => ({ sequenceKey: r.sequence_key, sourceKind: r.source_kind, lastValue: r.last_value, reservedCeiling: r.reserved_ceiling }));
}

/** Invariant queries for INV-27; each must return no rows. */
export async function numberInvariantViolations(db: Db): Promise<{ sequenceKey: string; problem: string }[]> {
  const { rows } = await db.query<{ sequence_key: string; problem: string }>('select sequence_key, problem from continuity.number_invariant_violations()');
  return rows.map((r) => ({ sequenceKey: r.sequence_key, problem: r.problem }));
}

/** Sequences no module has registered as protected (should be none in production). */
export async function unprotectedSequences(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ sequence_name: string }>('select sequence_name from continuity.unprotected_sequences()');
  return rows.map((r) => r.sequence_name);
}
