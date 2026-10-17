/**
 * The analytics runner (Phase 6A slice 6A-1; apps/tablets-server/src/analytics/; ADR 0020; draft controls DI-51, DI-52;
 * D-6A-5, D-6A-6, D-6A-1-10 to D-6A-1-16): it runs on the GMP installation only, as ebmr_analytics; it reads every input
 * of a run in one REPEATABLE READ READ ONLY snapshot; each output names its run, method version and inputs, and a re-run
 * on the same data reproduces it; a failed run leaves no output and is counted by the monitor; a version that does not
 * match the running code is not run; the poll sees newly completed batches and the nightly run comes once a site day,
 * both on the database clock.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_LIBRARIES, defaultParameters } from '@ebmr/analytics';
import { codeIdentity, parametersSha256 } from '../../src/analytics/catalog.ts';
import { readSnapshot } from '../../src/analytics/inputs.ts';
import { createAnalyticsPool } from '../../src/analytics/pool.ts';
import { AnalyticsRunner, type EffectiveVersion } from '../../src/analytics/runner.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { fixtureBatch, probe, releaseMethodVersion } from './support.ts';

let gmp: TestServer;
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const analyticsUrl = (db: string): string => {
  const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
  return `postgres://ebmr_analytics:ebmr_analytics@${admin.hostname}:${admin.port || '5432'}/${db}`;
};

beforeAll(async () => {
  gmp = await startServer('GMP', { env: { EBMR_ANALYTICS: 'on' }, analytics: { implementations: [probe('SPC.IMR'), probe('DRIFT.TREND', { fail: true })], pollMs: 3_600_000 } });
  await releaseMethodVersion(gmp, 'SPC.IMR', 1);
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

const runner = (): AnalyticsRunner => {
  const r = gmp.built.analytics;
  if (!r) throw new Error('the GMP server started without its analytics runner');
  return r;
};

describe('the analytics runner (apps/tablets-server/src/analytics)', () => {
  it('[DI-51] the runner runs on the GMP installation only, connected as ebmr_analytics; a sandbox never starts it', async () => {
    await runner().runAll('ON_DEMAND');
    const { rows } = await gmp.db.admin.query<{ usename: string }>(
      "select distinct usename from pg_stat_activity where datname = $1 and application_name = 'ebmr-analytics-runner'", [gmp.database]);
    expect(rows).toEqual([{ usename: 'ebmr_analytics' }]);
    const sbx = await startServer('SANDBOX', { env: { EBMR_ANALYTICS: 'on' } });
    try {
      expect(sbx.built.analytics).toBeNull();
      expect(sbx.config.analytics.enabled).toBe(false);
    } finally {
      await sbx.close();
    }
    // The server tests' default is off: the role has four connections on the whole cluster.
    expect(gmp.config.analytics.url).toMatch(/^postgres:\/\/ebmr_analytics:/);
  });

  it('[DI-52] every output names its run, method version and input references; a re-run reproduces it', async () => {
    await fixtureBatch(gmp, `AN-${randomUUID().slice(0, 6).toUpperCase()}`);
    const [first] = (await runner().runAll('ON_DEMAND')).filter((r) => r.method === 'SPC.IMR');
    const [second] = (await runner().runAll('ON_DEMAND')).filter((r) => r.method === 'SPC.IMR');
    expect(first).toMatchObject({ status: 'DONE', version: 1, outputs: 1, flags: 1 });
    expect(second).toMatchObject({ status: 'DONE', outputSha256: first!.outputSha256 });
    const { rows } = await gmp.db.admin.query<{ id: string; method: string; version: number; trigger: string; inputs: { view: string; version: number; data_as_of: string; rows: number; sha256: string }[];
                                                 runtime: { package: string; commit: string; node: string; libraries: Record<string, string> }; status: string; output_sha256: string; counts: Record<string, number> }>(
      `select r.id::text, r.method, r.version, r.trigger, r.inputs, r.runtime, e.status, e.output_sha256, e.counts
         from analytics.run r join analytics.run_end e on e.run = r.id where r.id = any($1::uuid[]) order by r.started_at`, [[first!.runId, second!.runId]]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ method: 'SPC.IMR', version: 1, trigger: 'ON_DEMAND', status: 'DONE', counts: { outputs: 1, flags: 1, skipped: 0 } });
      expect(r.inputs.map((i) => [i.view, i.version])).toEqual([['report.batch_fact_v1', 1], ['report.cpp_value_v1', 1]]);
      expect(new Set(r.inputs.map((i) => i.data_as_of)).size).toBe(1);
      expect(r.inputs[0]!.rows).toBeGreaterThanOrEqual(1);
      expect(r.runtime).toEqual({ package: '@ebmr/analytics 0.1.0', commit: 'development', node: process.version, libraries: RUNTIME_LIBRARIES });
    }
    // Same data, same inputs (row hashes) and same outputs; the read's own times are not part of the hash.
    expect(rows[1]!.inputs.map((i) => i.sha256)).toEqual(rows[0]!.inputs.map((i) => i.sha256));
    expect(rows[1]!.output_sha256).toBe(rows[0]!.output_sha256);
    // The output and its flag as the screens read them: the run, the method version, the data age, advisory.
    const { rows: shown } = await gmp.db.app.query<{ run_id: string; method: string; version: number; advisory: boolean; values: Record<string, number> }>(
      'select run_id::text, method, version, advisory, "values" from analytics.output_v1 where run_id = $1', [first!.runId]);
    expect(shown).toEqual([{ run_id: first!.runId, method: 'SPC.IMR', version: 1, advisory: true, values: expect.objectContaining({ batches: rows[0]!.inputs[0]!.rows }) as unknown }]);
    const { rows: flags } = await gmp.db.app.query<{ output_id: string | null }>('select output_id::text from analytics.flag_v1 where run_id = $1', [first!.runId]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.output_id).not.toBeNull();
    // New data is a new input hash.
    await fixtureBatch(gmp, `AN-${randomUUID().slice(0, 6).toUpperCase()}`);
    const [third] = (await runner().runAll('ON_DEMAND')).filter((r) => r.method === 'SPC.IMR');
    const { rows: t } = await gmp.db.admin.query<{ inputs: { sha256: string }[] }>('select inputs from analytics.run where id = $1', [third!.runId]);
    expect(t[0]!.inputs[0]!.sha256).not.toBe(rows[0]!.inputs[0]!.sha256);
  });

  it('[DI-52] a failed run leaves no output; a version that does not match the running code is not run; the monitor counts the failures', async () => {
    await releaseMethodVersion(gmp, 'DRIFT.TREND', 1);
    const reports = await runner().runAll('SCHEDULED');
    const failed = reports.find((r) => r.method === 'DRIFT.TREND')!;
    expect(failed).toMatchObject({ status: 'FAILED', error: 'probe failure on purpose' });
    const { rows } = await gmp.db.admin.query<{ status: string; error: string; outputs: number; flags: number }>(
      `select e.status, e.error, (select count(*)::int from analytics.output o where o.run = e.run) as outputs, (select count(*)::int from analytics.flag f where f.run = e.run) as flags
         from analytics.run_end e where e.run = $1`, [failed.runId]);
    expect(rows).toEqual([{ status: 'FAILED', error: 'probe failure on purpose', outputs: 0, flags: 0 }]);
    // A runner of its own (one more connection of the role) checks each version against the code before running it.
    const own = new AnalyticsRunner({ pool: createAnalyticsPool(analyticsUrl(gmp.database)), log: SILENT, siteZone: () => 'Asia/Kolkata', commit: 'test', implementations: [probe('SPC.IMR')] });
    try {
      const params = defaultParameters('SPC.IMR') as Record<string, unknown>;
      const v: EffectiveVersion = { method: 'SPC.IMR', version: 1, parameters: params, parameters_sha256: parametersSha256(params), code_identity: codeIdentity('test') };
      expect(await own.runVersion(v, 'ON_DEMAND')).toMatchObject({ status: 'DONE' });
      const badHash = await own.runVersion({ ...v, parameters_sha256: 'f'.repeat(64) }, 'ON_DEMAND');
      expect(badHash).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/do not hash to the recorded SHA-256/) as unknown });
      const otherCode = await own.runVersion({ ...v, code_identity: '@ebmr/analytics 0.2.0 (commit x)' }, 'ON_DEMAND');
      expect(otherCode).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/not the running code/) as unknown });
      const badParams = await own.runVersion({ ...v, parameters: { rules: ['NELSON_4'] }, parameters_sha256: parametersSha256({ rules: ['NELSON_4'] }) }, 'ON_DEMAND');
      expect(badParams).toMatchObject({ status: 'FAILED' });
      expect(await own.runVersion({ ...v, version: 2 }, 'ON_DEMAND')).toMatchObject({ status: 'SKIPPED', runId: null });
      const { rows: none } = await gmp.db.admin.query<{ n: number }>('select count(*)::int as n from analytics.output where run = any($1::uuid[])', [[badHash.runId, otherCode.runId, badParams.runId]]);
      expect(none).toEqual([{ n: 0 }]);
    } finally {
      await own.stop();
    }
    const { rows: monitor } = await gmp.db.app.query<{ method: string; failures: number }>(
      "select method, sum(failures)::int as failures from analytics.method_monitor_v1 where method in ('SPC.IMR', 'DRIFT.TREND') group by method order by method");
    expect(monitor).toEqual([{ method: 'DRIFT.TREND', failures: 1 }, { method: 'SPC.IMR', failures: 3 }]);
  });

  it('[DI-51] the runner reads every input of a run in one REPEATABLE READ READ ONLY snapshot as ebmr_analytics', async () => {
    const pool = createAnalyticsPool(analyticsUrl(gmp.database));
    const late = `AN-LATE-${randomUUID().slice(0, 6).toUpperCase()}`;
    // Between the two reads of the run, another transaction completes a batch record: the second read does not see it.
    const realConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
    let reads = 0;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      const client = await realConnect();
      const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
      (client as unknown as { query: typeof query }).query = async (text: string, values?: unknown[]) => {
        const out = await query(text, values);
        if (/^select \* from report\./.test(text) && ++reads === 1) await fixtureBatch(gmp, late);
        return out;
      };
      return client;
    };
    try {
      const snap = await readSnapshot(pool, [{ view: 'report.batch_fact_v1', version: 1, filter: null }, { view: 'report.batch_outcome_v1', version: 1, filter: null }]);
      const numbers = (v: string) => (snap.rows[v] ?? []).map((r) => r['batch_number']);
      expect(numbers('report.batch_fact_v1')).not.toContain(late);
      expect(numbers('report.batch_outcome_v1')).not.toContain(late);
      expect(snap.inputs.map((i) => i.data_as_of)).toEqual([snap.dataAsOf, snap.dataAsOf]);
      // Values stay text: no read time and no Date in a row.
      for (const row of snap.rows['report.batch_outcome_v1'] ?? []) {
        expect(row).not.toHaveProperty('read_at');
        for (const value of Object.values(row)) expect(value instanceof Date).toBe(false);
      }
      const again = await readSnapshot(pool, [{ view: 'report.batch_fact_v1', version: 1, filter: { batch_number: late } }]);
      expect(again.rows['report.batch_fact_v1']!.map((r) => r['batch_number'])).toEqual([late]);
      // The transaction is read only: the role could not write in it even if it held a right.
      const c = await realConnect();
      try {
        await c.query('begin transaction isolation level repeatable read read only');
        await expect(c.query("select analytics.fail_run(gen_random_uuid(), 'x')")).rejects.toThrow(/read-only transaction/);
        await c.query('rollback');
        const { rows } = await c.query<{ u: string }>('select current_user as u');
        expect(rows).toEqual([{ u: 'ebmr_analytics' }]);
      } finally {
        c.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('[DI-52] the poll sees a newly completed batch once; the nightly run comes once a site-zone day at 02:00, on the database clock', async () => {
    // A runner over a stand-in database: the completed batches and the database's site-zone day and hour it is told.
    let completed: string[] = [];
    let now = { day: '2026-10-17', hour: 1 };
    const fake = {
      connect: () => Promise.resolve({
        query: (text: string) => Promise.resolve(/batch_outcome_v1/.test(text) ? { rows: completed.map((b) => ({ batch_id: b })) } : /statement_timestamp/.test(text) ? { rows: [now] } : { rows: [] }),
        release: () => undefined,
      }),
      end: () => Promise.resolve(),
    } as unknown as pg.Pool;
    const r = new AnalyticsRunner({ pool: fake, log: SILENT, siteZone: () => 'Asia/Kolkata', commit: 'test', implementations: [] });
    completed = ['b-1'];
    expect(await r.pollCompleted()).toEqual([]);
    expect(await r.pollCompleted()).toEqual([]);
    completed = ['b-1', 'b-3', 'b-2'];
    expect(await r.pollCompleted()).toEqual(['b-2', 'b-3']);
    expect(await r.pollCompleted()).toEqual([]);
    // Started at 01:00: the first look sets the day; the run comes at 02:00, once, and again the next day.
    expect(await r.nightlyDue()).toBe(false);
    now = { day: '2026-10-17', hour: 2 };
    expect(await r.nightlyDue()).toBe(true);
    now = { day: '2026-10-17', hour: 23 };
    expect(await r.nightlyDue()).toBe(false);
    now = { day: '2026-10-18', hour: 0 };
    expect(await r.nightlyDue()).toBe(false);
    now = { day: '2026-10-18', hour: 3 };
    expect(await r.nightlyDue()).toBe(true);
    // Started after the hour: the next day's run.
    const late = new AnalyticsRunner({ pool: fake, log: SILENT, siteZone: () => 'Asia/Kolkata', commit: 'test', implementations: [] });
    now = { day: '2026-10-20', hour: 10 };
    expect(await late.nightlyDue()).toBe(false);
    expect(await late.nightlyDue()).toBe(false);
    now = { day: '2026-10-21', hour: 2 };
    expect(await late.nightlyDue()).toBe(true);
  });
});
