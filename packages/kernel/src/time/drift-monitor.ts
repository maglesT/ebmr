/**
 * Drift monitor (build outline 5.6 "Drift and monotonicity"; control DI-27).
 *
 * For one database node, reads each configured time reference, measures the node's clock offset
 * against it, and records the check through platform.record_drift_check, which stores the
 * samples, raises alarms (offset above the policy threshold, loss of every reference, too few
 * references) with a data-integrity incident request, and clears alarms once the fault is gone.
 * The threshold and alarm rules live in the database; this module only gathers readings.
 *
 * The offset is measured against the database clock, not this process's clock: the node's time
 * is read with clock_timestamp() immediately before and after the reference reading, and
 *   offset = midpoint(node before, node after) - reference time
 * with half the bracket as uncertainty. A positive offset means the node is ahead.
 *
 * References are injected (`TimeReference`), so tests never call a real NTP server. Production
 * wiring supplies readers for the validated sources registered in platform.time_source.
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { Instant, microsToSeconds } from './instant.ts';

export interface TimeReference {
  /** platform.time_source.id of the validated source this reader queries. */
  sourceId: string;
  /** Returns the reference's current time; throws or rejects when the reference cannot be reached. */
  read(): Promise<Instant>;
}

export interface DriftCheckOptions {
  /** Database node name, e.g. db-primary. */
  node: string;
  /** SYSTEM actor under which the check is recorded. */
  actor: ActorContext;
  references: readonly TimeReference[];
  /** Per-reference read timeout; default 5000 ms. */
  timeoutMs?: number;
}

export interface DriftReading {
  sourceId: string;
  reachable: boolean;
  offsetMicros?: bigint;
  uncertaintyMicros?: bigint;
  error?: string;
}

export interface DriftAlarmRef {
  kind: string;
  alarmId: string;
}

export interface DriftCheckResult {
  checkId: string;
  thresholdSeconds: string;
  activeSources: number;
  reachableSources: number;
  sourcesOverThreshold: number;
  readings: DriftReading[];
  raised: DriftAlarmRef[];
  cleared: DriftAlarmRef[];
}

interface CheckSummary {
  check_id: string;
  threshold_s: string;
  active_sources: number;
  reachable_sources: number;
  sources_over_threshold: number;
  raised: { kind: string; alarm_id: string }[];
  cleared: { kind: string; alarm_id: string }[];
}

/** Reads the node's database clock in microseconds since the epoch. */
export async function nodeClock(db: pg.Pool | pg.PoolClient): Promise<Instant> {
  const { rows } = await db.query<{ us: string }>('select platform.epoch_micros(clock_timestamp())::text as us');
  const us = rows[0]?.us;
  if (us === undefined) throw new Error('database clock returned no row');
  return Instant.fromEpochMicros(us);
}

/** Measures one reference against the node clock. Never throws: an unreachable reference is a reading. */
export async function measureReference(db: pg.Pool, reference: TimeReference, timeoutMs = 5000): Promise<DriftReading> {
  try {
    const before = await nodeClock(db);
    const ref = await withTimeout(reference.read(), timeoutMs);
    const after = await nodeClock(db);
    const sum = before.epochMicros + after.epochMicros;
    const midpoint = sum / 2n;
    return {
      sourceId: reference.sourceId,
      reachable: true,
      offsetMicros: midpoint - ref.epochMicros,
      uncertaintyMicros: (after.epochMicros - before.epochMicros + 1n) / 2n,
    };
  } catch (error) {
    return { sourceId: reference.sourceId, reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs one drift check for a node and records it. */
export async function runDriftCheck(pool: pg.Pool, options: DriftCheckOptions): Promise<DriftCheckResult> {
  const readings: DriftReading[] = [];
  for (const reference of options.references) readings.push(await measureReference(pool, reference, options.timeoutMs));
  const samples = readings.map((r) =>
    r.reachable && r.offsetMicros !== undefined
      ? { source_id: r.sourceId, reachable: true, offset_s: microsToSeconds(r.offsetMicros), uncertainty_s: microsToSeconds(r.uncertaintyMicros ?? 0n) }
      : { source_id: r.sourceId, reachable: false, error: r.error ?? 'unreachable' },
  );
  const summary = await withCommand(pool, options.actor, async (client) => {
    const { rows } = await client.query<{ summary: CheckSummary }>('select platform.record_drift_check($1, $2::jsonb) as summary', [
      options.node,
      JSON.stringify(samples),
    ]);
    const s = rows[0]?.summary;
    if (!s) throw new Error('platform.record_drift_check returned no summary');
    return s;
  });
  return {
    checkId: summary.check_id,
    thresholdSeconds: summary.threshold_s,
    activeSources: summary.active_sources,
    reachableSources: summary.reachable_sources,
    sourcesOverThreshold: summary.sources_over_threshold,
    readings,
    raised: summary.raised.map((a) => ({ kind: a.kind, alarmId: a.alarm_id })),
    cleared: summary.cleared.map((a) => ({ kind: a.kind, alarmId: a.alarm_id })),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`time reference did not answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
