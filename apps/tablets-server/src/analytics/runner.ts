/**
 * The analytics runner (ADR 0020 points 1 to 6; decision 0015; draft controls DI-51, DI-52; D-6A-5, D-6A-6,
 * D-6A-0-3, D-6A-1-10 to D-6A-1-16). Part of the tablets server on the GMP installation only; it connects as
 * ebmr_analytics (pool.ts), so it can read its catalogued inputs and record advisory outputs and nothing else, and it
 * imports no server feature, command path or GMP package (dependency-cruiser analytics-runner-no-gmp-path).
 *
 * When it runs:
 *   - nightly, once a site-zone day at or after NIGHTLY_HOUR (02:00, D-6A-6), trigger SCHEDULED;
 *   - when it sees newly completed batches: every POLL_MS (5 minutes) it reads report.batch_outcome_v1 and compares
 *     the completed batches with those of its last poll (the first poll is the baseline; a batch completed while the
 *     server was down is taken by the next nightly run; D-6A-1-14), trigger BATCH_COMPLETE;
 *   - on demand (runAll, runVersion), trigger ON_DEMAND.
 * Its time is the database's: the site-zone day and hour come from statement_timestamp(), every recorded instant from
 * the analytics tables' defaults; the process timers only say when to look.
 *
 * What a run is (runVersion), for each method version EFFECTIVE at database time (analytics.effective_methods):
 *   1. A version no implementation of the running code covers is skipped and logged (D-6A-1-10).
 *   2. The inputs are read in one REPEATABLE READ READ ONLY snapshot (inputs.ts).
 *   3. The version is checked against the running code: its parameters must hash to the recorded SHA-256 and fit the
 *      method's schema, and its code identity must name the running package (D-6A-1-7); the method then runs.
 *   4. The run is recorded in one transaction: begin_run, every output and flag, finish_run with the SHA-256 of the
 *      canonical outputs and flags. A flag is linked to the run's output about the same subject, if there is one.
 *   5. Any failure in 2 to 4 rolls the recording back and records the run as begun and FAILED with the error, in a
 *      transaction of its own: a failed run leaves no output (D-6A-0-3).
 */
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { outputHash, type FlagDraft, type MethodId, type OutputDraft, type Parameters } from '@ebmr/analytics';
import { codeRuns, methodDefinitionProblems, parametersSha256, runtimeOf } from './catalog.ts';
import { IMPLEMENTATIONS, type MethodImplementation } from './implementation.ts';
import { readSnapshot, type InputRecord } from './inputs.ts';
import { connectRetrying, queryRetrying } from './pool.ts';

export type RunTrigger = 'SCHEDULED' | 'BATCH_COMPLETE' | 'ON_DEMAND';

/** How often the runner looks (a process timer: when to look, never a recorded time). */
export const POLL_MS = 5 * 60 * 1000;
/** The site-zone hour of the nightly run (D-6A-6). */
export const NIGHTLY_HOUR = 2;

/** A method version in force, as analytics.effective_methods() gives it. */
export interface EffectiveVersion {
  method: string;
  version: number;
  parameters: Record<string, unknown>;
  parameters_sha256: string;
  code_identity: string;
}

export interface RunReport {
  method: string;
  version: number;
  trigger: RunTrigger;
  status: 'DONE' | 'FAILED' | 'SKIPPED';
  runId: string | null;
  outputSha256?: string;
  outputs?: number;
  flags?: number;
  error?: string;
}

export interface RunnerOptions {
  pool: pg.Pool;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  /** The site zone (the server's site policy, DI-27). */
  siteZone: () => string;
  /** The build's commit (EBMR_COMMIT). */
  commit: string;
  implementations?: readonly MethodImplementation[];
  pollMs?: number;
  nightlyHour?: number;
}

class RunFailure extends Error {}

export class AnalyticsRunner {
  private readonly impls: readonly MethodImplementation[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private seen: Set<string> | null = null;
  private lastNightlyDay: string | null = null;
  private stopped = false;

  constructor(private readonly o: RunnerOptions) {
    this.impls = o.implementations ?? IMPLEMENTATIONS;
  }

  /** Starts the timer; the first tick sets the poll's baseline and the nightly day. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops the timer, waits for the work in progress, and closes the pool. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.busy.catch(() => undefined);
    await this.o.pool.end().catch(() => undefined);
  }

  /** One look: the nightly run when it is due, then the poll. Never throws (an operations alert is logged). */
  tick(): Promise<void> {
    const work = this.busy.then(async () => {
      if (this.stopped) return;
      try {
        if (await this.nightlyDue()) await this.runAllNow('SCHEDULED');
        if ((await this.pollCompleted()).length > 0) await this.runAllNow('BATCH_COMPLETE');
      } catch (error) {
        this.o.log.error({ err: error }, 'analytics runner: a scheduled look failed (advisory analytics only; no GMP data is affected)');
      }
    });
    this.busy = work;
    return work;
  }

  /** Whether the nightly run is due now (the site-zone day and hour from the database clock). */
  async nightlyDue(): Promise<boolean> {
    const { rows } = await queryRetrying<{ day: string; hour: number }>(this.o.pool,
      "select to_char(statement_timestamp() at time zone $1, 'YYYY-MM-DD') as day, extract(hour from statement_timestamp() at time zone $1)::integer as hour",
      [this.o.siteZone()],
    );
    const { day, hour } = rows[0]!;
    const atOrAfter = hour >= (this.o.nightlyHour ?? NIGHTLY_HOUR);
    if (this.lastNightlyDay === null) {
      // The first look: a start after the hour waits for the next day's run.
      this.lastNightlyDay = atOrAfter ? day : '';
      return false;
    }
    if (!atOrAfter || day === this.lastNightlyDay) return false;
    this.lastNightlyDay = day;
    return true;
  }

  /** The batches completed since the last poll (none on the first poll, which is the baseline). */
  async pollCompleted(): Promise<string[]> {
    const { rows } = await queryRetrying<{ batch_id: string }>(this.o.pool, 'select batch_id::text from report.batch_outcome_v1 where completed_at is not null');
    const now = new Set(rows.map((r) => r.batch_id));
    const previous = this.seen;
    this.seen = now;
    if (previous === null) return [];
    return [...now].filter((b) => !previous.has(b)).sort();
  }

  /** Runs every method version in force now (waits for work in progress first). */
  runAll(trigger: RunTrigger): Promise<RunReport[]> {
    const work = this.busy.then(() => this.runAllNow(trigger));
    this.busy = work.catch(() => undefined);
    return work;
  }

  private async runAllNow(trigger: RunTrigger): Promise<RunReport[]> {
    const { rows } = await queryRetrying<EffectiveVersion>(this.o.pool,
      'select method, version, parameters, parameters_sha256, code_identity from analytics.effective_methods() order by method, version',
    );
    const reports: RunReport[] = [];
    for (const v of rows) reports.push(await this.runVersion(v, trigger));
    return reports;
  }

  /** Runs one method version in force (see the header). */
  async runVersion(v: EffectiveVersion, trigger: RunTrigger): Promise<RunReport> {
    const impl = this.impls.find((i) => i.id === v.method && i.versions.includes(v.version));
    if (!impl) {
      this.o.log.warn({ method: v.method, version: v.version }, 'analytics runner: a method version in force has no implementation in the running code; it is not run');
      return { method: v.method, version: v.version, trigger, status: 'SKIPPED', runId: null, error: 'no implementation of this version in the running code' };
    }
    let inputs: InputRecord[] = impl.inputs.map((s) => ({ view: s.view, version: s.version, filter: s.filter, data_as_of: '1970-01-01T00:00:00Z', rows: 0, sha256: '0'.repeat(64) }));
    try {
      const snapshot = await readSnapshot(this.o.pool, impl.inputs);
      inputs = snapshot.inputs;
      const problems = [
        ...(parametersSha256(v.parameters) === v.parameters_sha256 ? [] : ['its parameters do not hash to the recorded SHA-256']),
        ...methodDefinitionProblems(v.method, v.parameters),
        ...(codeRuns(v.code_identity) ? [] : [`it was validated with ${v.code_identity}, not the running code`]),
      ];
      if (problems.length > 0) throw new RunFailure(`${v.method} version ${v.version} is not run: ${problems.join('; ')}`);
      const params = v.parameters as Parameters;
      const result = impl.method.run(impl.assemble(snapshot.rows, params), params, null);
      return await this.record(v, trigger, inputs, result.outputs, result.flags, result.skipped.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const runId = await this.recordFailure(v, trigger, inputs, message).catch((e: unknown) => {
        this.o.log.error({ err: e, method: v.method, version: v.version }, 'analytics runner: the failure of a run could not be recorded');
        return null;
      });
      this.o.log.warn({ method: v.method, version: v.version, runId, error: message }, 'analytics runner: a run failed and left no output');
      return { method: v.method, version: v.version, trigger, status: 'FAILED', runId, error: message };
    }
  }

  private runtime(): Record<string, unknown> {
    return runtimeOf(this.o.commit, process.version);
  }

  private async record(v: EffectiveVersion, trigger: RunTrigger, inputs: InputRecord[], outputs: readonly OutputDraft[], flags: readonly FlagDraft[], skipped: number): Promise<RunReport> {
    const sha = outputHash(outputs, flags);
    const client = await connectRetrying(this.o.pool);
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>('select analytics.begin_run($1, $2, null, $3, $4::jsonb, $5::jsonb)::text as id', [
        v.method, v.version, trigger, JSON.stringify(inputs), JSON.stringify(this.runtime()),
      ]);
      const runId = rows[0]!.id;
      const outputIds = new Map<string, string>();
      for (const o of outputs) {
        const { rows: r } = await client.query<{ id: string }>('select analytics.record_output($1, $2, $3, $4, $5::jsonb, $6::jsonb)::text as id', [
          runId, o.subjectKind, o.subjectRef, o.kind, JSON.stringify(o.values), JSON.stringify(o.reasons),
        ]);
        const key = `${o.subjectKind}|${o.subjectRef}`;
        if (!outputIds.has(key)) outputIds.set(key, r[0]!.id);
      }
      for (const f of flags) {
        await client.query('select analytics.record_flag($1, $2, $3, $4, $5, $6, $7::jsonb)', [
          runId, outputIds.get(`${f.subjectKind}|${f.subjectRef}`) ?? null, f.subjectKind, f.subjectRef, f.rule, f.severity, JSON.stringify(f.reasons),
        ]);
      }
      await client.query('select analytics.finish_run($1, $2, $3::jsonb)', [runId, sha, JSON.stringify({ outputs: outputs.length, flags: flags.length, skipped })]);
      await client.query('commit');
      this.o.log.info({ method: v.method, version: v.version, runId, outputs: outputs.length, flags: flags.length }, 'analytics runner: run recorded (advisory)');
      return { method: v.method, version: v.version, trigger, status: 'DONE', runId, outputSha256: sha, outputs: outputs.length, flags: flags.length };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async recordFailure(v: EffectiveVersion, trigger: RunTrigger, inputs: InputRecord[], message: string): Promise<string> {
    const client = await connectRetrying(this.o.pool);
    try {
      await client.query('begin');
      const { rows } = await client.query<{ id: string }>('select analytics.begin_run($1, $2, null, $3, $4::jsonb, $5::jsonb)::text as id', [
        v.method, v.version, trigger, JSON.stringify(inputs), JSON.stringify(this.runtime()),
      ]);
      const runId = rows[0]!.id;
      await client.query('select analytics.fail_run($1, $2)', [runId, message.slice(0, 2000)]);
      await client.query('commit');
      return runId;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** The method ids the running code implements (for the catalogue's screens). */
export function implementedMethods(impls: readonly MethodImplementation[] = IMPLEMENTATIONS): { id: MethodId; versions: number[] }[] {
  return impls.map((i) => ({ id: i.id, versions: [...i.versions] }));
}
