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
import { analyticsRoleProblem, analyticsRoleProblems, connectRetrying, createAnalyticsPool, queryRetrying, type AnalyticsRoleFacts } from '../../src/analytics/pool.ts';
import { IMPLEMENTATIONS } from '../../src/analytics/implementation.ts';
import { AnalyticsRunner, type EffectiveVersion } from '../../src/analytics/runner.ts';
import { ThreadedAnalyticsRunner, type AnalyticsRunnerApi } from '../../src/analytics/threaded.ts';
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

const runner = (): AnalyticsRunnerApi => {
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

  it('[DI-51] the runner starts only on ebmr_analytics with no elevated attribute; on another login it does not start (P6A7-8)', async () => {
    const errors: unknown[] = [];
    const log = { ...SILENT, error: (o: unknown) => void errors.push(o) };
    const own = new AnalyticsRunner({ pool: createAnalyticsPool(analyticsUrl(gmp.database)), log, siteZone: () => 'Asia/Kolkata', commit: 'test', implementations: [] });
    try {
      expect(await own.start()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await own.stop();
    }
    // A misconfigured EBMR_DB_ANALYTICS_URL naming the application's login: the runner never starts.
    const wrong = new AnalyticsRunner({ pool: createAnalyticsPool(analyticsUrl(gmp.database).replace('ebmr_analytics:ebmr_analytics@', 'ebmr_app:ebmr_app@')), log, siteZone: () => 'UTC', commit: 'test', implementations: [] });
    try {
      expect(await wrong.start()).toBe(false);
      expect(JSON.stringify(errors)).toMatch(/connects as ebmr_app acting as ebmr_app, not as ebmr_analytics/);
    } finally {
      await wrong.stop();
    }
    // Each elevated attribute and any membership is a reason on its own (the database's answer, analyticsRoleProblems).
    const ok: AnalyticsRoleFacts = { current_user: 'ebmr_analytics', session_user: 'ebmr_analytics', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, member_of: [] };
    expect(analyticsRoleProblems(ok)).toEqual([]);
    for (const k of ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const) expect(analyticsRoleProblems({ ...ok, [k]: true })).toHaveLength(1);
    expect(analyticsRoleProblems({ ...ok, member_of: ['ebmr_app'] })).toEqual(['the role is a member of ebmr_app']);
    expect(analyticsRoleProblems({ ...ok, current_user: 'ebmr_owner' })).toHaveLength(1);
    expect(analyticsRoleProblems(undefined)).toHaveLength(1);
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

  it('[DI-52] a completed batch runs the methods it can change; the audit-trail methods wait for the nightly run (D-6A-7-R3)', async () => {
    const versions = ['ATA.BASELINE', 'ATA.RULES', 'REVIEW.PRIORITY', 'SPC.IMR'].map((method) => ({ method, version: 1, parameters: {}, parameters_sha256: '', code_identity: '' }));
    const fake = {
      connect: () => Promise.resolve({ query: (text: string) => Promise.resolve(/effective_methods/.test(text) ? { rows: versions } : { rows: [] }), release: () => undefined }),
      end: () => Promise.resolve(),
    } as unknown as pg.Pool;
    const r = new AnalyticsRunner({ pool: fake, log: SILENT, siteZone: () => 'UTC', commit: 'test' });
    const ran: string[] = [];
    r.runVersionAll = (v: EffectiveVersion) => {
      ran.push(v.method);
      return Promise.resolve([]);
    };
    expect(IMPLEMENTATIONS.filter((i) => i.onBatchComplete === false).map((i) => i.id).sort()).toEqual(['ATA.BASELINE', 'ATA.RULES']);
    await r.runAll('BATCH_COMPLETE');
    expect(ran).toEqual(['REVIEW.PRIORITY', 'SPC.IMR']);
    ran.length = 0;
    await r.runAll('SCHEDULED');
    expect(ran).toEqual(['ATA.BASELINE', 'ATA.RULES', 'REVIEW.PRIORITY', 'SPC.IMR']);
    ran.length = 0;
    await r.runAll('ON_DEMAND');
    expect(ran).toHaveLength(4);
  });
});

// Mutation campaign at the Phase 7 exit (D-P7-1 item 4): the role check kept in the worker thread (P6A7-8), which
// Stryker's per-test coverage does not see, and the pool's own rules, checked directly.
describe('the analytics runner\'s connection and its role check (pool.ts, threaded.ts)', () => {
  const ok: AnalyticsRoleFacts = { current_user: 'ebmr_analytics', session_user: 'ebmr_analytics', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false, member_of: [] };
  /** A pool whose connect() answers from `script` in turn (an error code, or a client answering `rows`). */
  const fakePool = (script: (string | readonly object[])[]) => {
    let calls = 0;
    const released: number[] = [];
    const pool = {
      connect: () => {
        const step = script[Math.min(calls, script.length - 1)]!;
        calls += 1;
        if (typeof step === 'string') return Promise.reject(Object.assign(new Error(`code ${step}`), { code: step }));
        return Promise.resolve({ query: () => Promise.resolve({ rows: step }), release: () => void released.push(calls) });
      },
    } as unknown as pg.Pool;
    return { pool, calls: () => calls, released };
  };

  it('[DI-51] the worker thread\'s runner starts only on ebmr_analytics: on another login, or when the role cannot be read, it does not start (P6A7-8)', async () => {
    const errors: string[] = [];
    const log = { ...SILENT, error: (o: unknown, msg?: string) => void errors.push(`${JSON.stringify(o)} ${msg ?? ''}`) };
    const make = (url: string) => new ThreadedAnalyticsRunner({ url, log, siteZone: () => 'Asia/Kolkata', commit: 'test', pollMs: 3_600_000 });
    const wrong = make(analyticsUrl(gmp.database).replace('ebmr_analytics:ebmr_analytics@', 'ebmr_app:ebmr_app@'));
    try {
      expect(await wrong.start()).toBe(false);
      expect(wrong.isRunning()).toBe(false);
      expect(errors.join(' ')).toMatch(/connects as ebmr_app acting as ebmr_app, not as ebmr_analytics/);
    } finally {
      await wrong.stop();
    }
    errors.length = 0;
    const unreadable = make(analyticsUrl(gmp.database).replace('ebmr_analytics:ebmr_analytics@', 'ebmr_analytics:not-the-password@'));
    try {
      expect(await unreadable.start()).toBe(false);
      expect(unreadable.isRunning()).toBe(false);
      expect(errors.join(' ')).toMatch(/its role could not be read: .*password.* analytics runner: not started, its database connection is not the analytics role alone/);
    } finally {
      await unreadable.stop();
    }
    // The in-process runner the same way.
    errors.length = 0;
    const inProcess = new AnalyticsRunner({ pool: createAnalyticsPool(analyticsUrl(gmp.database).replace('ebmr_analytics:ebmr_analytics@', 'ebmr_analytics:not-the-password@')), log, siteZone: () => 'UTC', commit: 'test', implementations: [] });
    try {
      expect(await inProcess.start()).toBe(false);
      expect(inProcess.isRunning()).toBe(false);
      expect(errors.join(' ')).toMatch(/its role could not be read: .*password.* analytics runner: not started, its database connection is not the analytics role alone/);
    } finally {
      await inProcess.stop();
    }
    errors.length = 0;
    const own = make(analyticsUrl(gmp.database));
    try {
      expect(await own.start()).toBe(true);
      expect(own.isRunning()).toBe(true);
      // A second start keeps the one timer.
      expect(await own.start()).toBe(true);
      await own.pause();
      expect(own.isRunning()).toBe(false);
      expect(await own.resume()).toBe(true);
      expect(own.isRunning()).toBe(true);
    } finally {
      await own.stop();
    }
    expect(own.isRunning()).toBe(false);
    expect(await own.start()).toBe(false);
    expect(errors).toEqual([]);
    // A worker that ends unexpectedly ends the runner: the pending request and every later one are refused with the reason,
    // the timer stops, and the end is logged.
    const lost = make(analyticsUrl(gmp.database));
    try {
      expect(await lost.start()).toBe(true);
      const pending = lost.nightlyDue();
      await (lost as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
      await expect(pending).rejects.toThrow(/^the analytics worker stopped \(exit code 1\)$/);
      await expect(lost.runAll('ON_DEMAND')).rejects.toThrow(/^the analytics worker stopped \(exit code 1\)$/);
      expect(lost.isRunning()).toBe(false);
      expect(await lost.start()).toBe(false);
      expect(errors.join(' ')).toMatch(/"reason":"the analytics worker stopped \(exit code 1\)"/);
    } finally {
      await lost.stop();
    }
  });

  it('[DI-51] each problem of the runner\'s role is named, and all are reported together', async () => {
    expect(analyticsRoleProblems({ ...ok, rolsuper: true, rolbypassrls: true, member_of: ['ebmr_app', 'ebmr_owner'] })).toEqual([
      'the role has the elevated attribute(s) superuser, bypass row-level security',
      'the role is a member of ebmr_app, ebmr_owner',
    ]);
    // SET ROLE ebmr_analytics from another login is not the analytics login.
    expect(analyticsRoleProblems({ ...ok, session_user: 'ebmr_owner' })).toEqual(['it connects as ebmr_owner acting as ebmr_analytics, not as ebmr_analytics']);
    const two = fakePool([[{ ...ok, current_user: 'ebmr_app', session_user: 'ebmr_app', rolcreatedb: true }]]);
    expect(await analyticsRoleProblem(two.pool)).toBe('it connects as ebmr_app acting as ebmr_app, not as ebmr_analytics; the role has the elevated attribute(s) create database');
    expect(await analyticsRoleProblem(fakePool([[ok]]).pool)).toBeNull();
    expect(await analyticsRoleProblem(fakePool([[]]).pool)).toBe('the database did not describe the connection\'s role');
    // The runner's connection names itself to pg_stat_activity.
    const pool = createAnalyticsPool(analyticsUrl(gmp.database));
    try {
      const { rows } = await queryRetrying<{ a: string }>(pool, "select current_setting('application_name') as a");
      expect(rows).toEqual([{ a: 'ebmr-analytics-runner' }]);
    } finally {
      await pool.end();
    }
  });

  it('[DI-51] the runner waits while the role\'s connection limit is reached, up to its attempts, and fails at once on any other error', async () => {
    const busy = fakePool(['53300', '53300', [{ n: 1 }]]);
    const client = await connectRetrying(busy.pool, 3, 1);
    expect(busy.calls()).toBe(3);
    client.release();
    expect(busy.released).toEqual([3]);
    const full = fakePool(['53300']);
    await expect(connectRetrying(full.pool, 3, 1)).rejects.toMatchObject({ code: '53300' });
    expect(full.calls()).toBe(3);
    const other = fakePool(['28P01', [{ n: 1 }]]);
    await expect(connectRetrying(other.pool, 3, 1)).rejects.toMatchObject({ code: '28P01' });
    expect(other.calls()).toBe(1);
    // The wait is real: two waits of 30 ms take at least that long.
    const timed = fakePool(['53300', '53300', [{ n: 1 }]]);
    const t0 = process.hrtime.bigint();
    await connectRetrying(timed.pool, 5, 30);
    expect(process.hrtime.bigint() - t0).toBeGreaterThanOrEqual(50_000_000n);
    const q = fakePool([[{ n: 1 }]]);
    expect((await queryRetrying(q.pool, 'select 1')).rows).toEqual([{ n: 1 }]);
    expect(q.released).toEqual([1]);
  });
});

