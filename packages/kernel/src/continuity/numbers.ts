/**
 * Protected identifiers that are never reused, including after a restore (INV-27).
 *
 * Counters are write-ahead: a block of values is first written to the external ledger as a ceiling,
 * then acknowledged in the database (continuity.reserve_counter_ceiling), and only then can the owning
 * module issue values up to that ceiling (continuity.next_counter_value, called from its SECURITY
 * DEFINER functions). Because the ceiling outside the database is always at least the highest value
 * ever issued, a restore can move every counter past the lost window (continuity.after_restore).
 */
import type pg from 'pg';
import { toDbContext, withCommand, type ActorContext } from '../db/command.ts';
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
 * then acknowledge it in the database. Serialised per counter with an advisory lock, so the ledger and
 * the database see reservations in the same order. Returns the ceiling now in force.
 */
export async function reserveCounterBlock(pool: pg.Pool, ctx: ActorContext, ledger: ExternalLedger, sequenceKey: string): Promise<bigint> {
  const client = await pool.connect();
  const lockKey = `continuity.counter:${sequenceKey}`;
  try {
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    try {
      const { rows } = await client.query<{
        last_value: string;
        reserved_ceiling: string;
        block_size: string;
        ceiling_incarnation: string | null;
        current_incarnation: string;
      }>(
        `select c.last_value, c.reserved_ceiling, p.block_size, c.ceiling_incarnation, continuity.current_incarnation() as current_incarnation
           from continuity.counter c join continuity.protected_sequence p on p.sequence_key = c.sequence_key
          where c.sequence_key = $1`,
        [sequenceKey],
      );
      const state = rows[0];
      if (!state) throw new ContinuityError('EBMR-CONT-010', `${sequenceKey} is not a protected counter`);
      if (state.ceiling_incarnation !== null && state.ceiling_incarnation !== state.current_incarnation) {
        // Nothing is written to the ledger: the restore procedure must run first.
        throw new ContinuityError(INCARNATION_CHANGED, `the database incarnation changed since the ceiling of ${sequenceKey} was reserved; run the restore procedure`);
      }
      const floor = (await ledgerMaxCeiling(ledger, sequenceKey)) ?? 0n;
      const last = BigInt(state.last_value);
      const reserved = BigInt(state.reserved_ceiling);
      let base = last > reserved ? last : reserved;
      if (floor > base) base = floor;
      const ceiling = base + BigInt(state.block_size);
      const receipt = await ledger.append({ type: 'CEILING', database: ledger.database, sequenceKey, ceiling: ceiling.toString(), floor: floor.toString() });
      await client.query('begin');
      try {
        await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
        const res = await client.query<{ ceiling: string }>('select continuity.reserve_counter_ceiling($1, $2, $3, $4) as ceiling', [
          sequenceKey,
          floor.toString(),
          ceiling.toString(),
          receipt.id,
        ]);
        await client.query('commit');
        return BigInt(res.rows[0]?.ceiling ?? '0');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    } finally {
      await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]);
    }
  } finally {
    client.release();
  }
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
