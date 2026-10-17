/**
 * Support of the Phase 6A exit browser flows (slice 6A-7; ADR 0020; draft controls DI-51, DI-52, DI-53, PR-61).
 *
 * The analytics flows run on a GMP database and server of their own (D-6A-7-b-1): a copy of the E2E GMP database made
 * with the kernel's backup path (continuity dumpDatabase and restoreDatabase, as the DI-32 trend spec makes one), marked a
 * demo installation, with its own GMP server (`analyticsCopy`). The test fixtures the flows need (records copied from the
 * set-up's review batch, the synthetic history's batch facts, a press series of the review batch) live only in that copy,
 * so the database the other specs share is never touched.
 *
 * TEST FIXTURE (D-6A-7-b-2). The runner runs a method on a batch completion (polled every five minutes) or nightly, and
 * the E2E stack has no completed GMP batch with critical values or equipment series, so the runs the screens show are
 * recorded here as the runner records one: as the analytics role, through its own record functions
 * (analytics.begin_run, record_output, record_flag, finish_run), for method versions a QA person puts in force under
 * the approved E2E change record (analytics.set_method_version, ANALYTICS.METHOD) and, for the golden profile, a
 * reference set QA approves from its model candidate (analytics.set_reference_set). The version's code identity is
 * not the running build's, so the copy's own runner would record a FAILED run rather than outputs of its own. The
 * statistics of each method are proven by the package and server tests; these flows prove the screens, the routes,
 * the restrictions, the disposition and the drill to the records.
 *
 *  - `analyticsCopy(e2e)`: the copy, its database handle and its server's origin;
 *  - `officeOn(browser, origin, terminal)`: an office browser context on the copy's server, on a demo terminal;
 *  - `asOwner(copy, statements)`: rows written as the database owner with triggers off (the server tests' fixtures);
 *  - `putInForce(copy, methods)` and `recordRun(copy, run)`: the method versions and the advisory runs;
 *  - `copyRecord(copy, batchId, number)`: a record in the review queue copied from the review batch (review.test.ts);
 *  - `imrChart(values)`, `pressBand(curves, scored)`: the fixture's own numbers (textbook I-MR limits and Nelson rules 1
 *    and 2; a resampled percentile band and a DTW distance), so what the screens show is self-consistent.
 * DEMO-ONLY credentials and data; every name is unique per run.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import pg from 'pg';
import type { Browser, Page } from '@playwright/test';
import { continuity, withCommand } from '@ebmr/kernel';
import { SERVER_MAIN, serverEnv, spawnNode, waitForHttp, WEB_DIST, type RunningProcess, type StartStackOptions } from '@ebmr/demo';
import { ADMIN_URL, dropDatabase, openDatabase, openPersonaSession, urlFor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';
import { pickTerminal, VIEWPORTS, type E2eWorld } from '../../fixtures/index.ts';
import { because, E2E_CHANGE_RECORD, endSessions, ensureChangeRecord } from '../phase6/support.ts';

type Json = Record<string, unknown>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface AnalyticsCopy {
  database: string;
  origin: string;
  db: DatabaseHandle;
  seed: SiteSeed;
  stop(): Promise<void>;
}

/** The copy of the E2E GMP database and a GMP server on it (its analytics runner on, as on any GMP installation). */
export async function analyticsCopy(e2e: E2eWorld): Promise<AnalyticsCopy> {
  // An E2E database name: the set-up marks only *_e2e_<hex> databases as demo installations (decision D6).
  const database = `ebmr_tablets_e2e_${randomBytes(5).toString('hex')}`;
  const work = join(e2e.state.keysDir, '..', `analytics-${randomBytes(3).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  let server: RunningProcess | null = null;
  let db: DatabaseHandle | null = null;
  const stop = async (): Promise<void> => {
    const s = server;
    if (s) await s.stop();
    const d = db;
    if (d) await d.close();
    await dropDatabase(database);
    rmSync(work, { recursive: true, force: true });
  };
  try {
    const artefact = await continuity.dumpDatabase({
      sourceUrl: urlFor(e2e.state.databases.GMP), directory: work, backupId: `e2e-analytics-${randomBytes(3).toString('hex')}`, snapshotTakenAt: new Date().toISOString(),
    });
    await continuity.restoreDatabase({ adminUrl: ADMIN_URL, artefact, targetDatabase: database, sourceDatabase: e2e.state.databases.GMP, isolate: false, workDir: work });
    const copy = new pg.Client({ connectionString: urlFor(database) });
    await copy.connect();
    try {
      // The restored copy names its source as the demo installation; the copy is one only once marked (decision D6).
      await copy.query('delete from tab.demo_installation');
      await copy.query("select tab.mark_demo_installation('E2E: copy for the Phase 6A analytics browser flows')");
      // The database's connect policy, as the set-up applies it (the analytics role connects to GMP databases only).
      await copy.query('select sandbox.apply_connect_policy()');
    } finally {
      await copy.end();
    }
    db = openDatabase(database, 'GMP');
    const port = await freePort();
    const origins = { gmp: `http://localhost:${port}`, sandbox: e2e.url('SANDBOX') };
    const opts: StartStackOptions = {
      databases: { GMP: database, SANDBOX: e2e.state.databases.SANDBOX }, keysDir: e2e.state.keysDir, exchangeDir: e2e.state.exchangeDir,
      ports: { sandbox: 0, gatewayListener: 0, gateway: 0, simulatorTcp: 0, simulatorHttp: 0, gmp: port }, webDist: WEB_DIST, host: 'localhost', echo: false, logLevel: 'warn',
    };
    server = spawnNode({ name: 'gmp-analytics', entry: SERVER_MAIN, env: serverEnv('GMP', opts, origins), echo: false });
    await waitForHttp(`http://127.0.0.1:${port}/api/meta`, 90_000, server.child);
    return { database, origin: origins.gmp, db, seed: e2e.seeds.GMP, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** An office browser context on the copy's server that has picked a demo terminal; the sign-in screen follows. */
export async function officeOn(browser: Browser, origin: string, terminal: string): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEWPORTS.office, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  const page = await context.newPage();
  await pickTerminal(page, origin, terminal);
  return page;
}

/** Statements as the database owner with triggers off, in one transaction (the server tests' fixture rows). */
export async function asOwner(copy: AnalyticsCopy, statements: { text: string; values?: unknown[] }[]): Promise<void> {
  const c = await copy.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** One connection as ebmr_analytics (it waits while the role's cluster-wide connection limit of 4 is reached). */
async function analyticsClient(copy: AnalyticsCopy): Promise<pg.Client> {
  for (let i = 0; ; i += 1) {
    const client = new pg.Client({ connectionString: urlFor(copy.database, { name: 'ebmr_analytics', password: 'ebmr_analytics' }) });
    try {
      await client.connect();
      return client;
    } catch (e) {
      await client.end().catch(() => undefined);
      if ((e as { code?: string }).code === '53300' && i < 60) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw e;
    }
  }
}

/** The code identity of the fixture's method versions: not the running build's (see the header). */
export const FIXTURE_CODE_IDENTITY = '@ebmr/analytics 0.1.0 (commit e2e-fixture)';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Version 1 of each method in force, recorded by the demo set's QA investigator (QA_REVIEWER, ANALYTICS.METHOD) under
 * the approved E2E change record, as the methods route records it (analytics.set_method_version). A version already in
 * force is left as it is (a version in force never changes, EBMR-ANA-013).
 */
export async function putInForce(copy: AnalyticsCopy, methods: readonly string[]): Promise<void> {
  const record = await ensureChangeRecord(copy.db);
  const qa = await openPersonaSession(copy.db, copy.seed, 'qaInvestigator');
  try {
    await withCommand(copy.db.app, { ...because(qa, 'E2E set-up: the analytics methods of the Phase 6A browser flows in force', 'CONFIG_CHANGE'), changeRecord: record }, async (c) => {
      for (const method of methods) {
        if ((await c.query("select 1 from analytics.method_version_v1 where method = $1 and version = 1 and status = 'EFFECTIVE'", [method])).rowCount !== 0) continue;
        const parameters = {};
        await c.query('select analytics.set_method_version($1::jsonb)', [JSON.stringify({
          method, version: 1, status: 'EFFECTIVE', title: `${method} (E2E fixture)`, intendedUse: 'E2E browser flows of the Phase 6A exit: advisory screens only',
          acceptance: { fixture: 'E2E' }, parameters, parametersSha256: sha256(JSON.stringify(parameters)), codeIdentity: FIXTURE_CODE_IDENTITY, validationRef: 'E2E-FIXTURE',
        })]);
      }
    });
  } finally {
    await endSessions(copy.db, qa);
  }
}

export interface DraftReason {
  code: string;
  text: string;
  weight?: number;
  evidence?: { kind: string; ref: string }[];
}
export interface DraftFlag {
  subjectKind: string;
  subjectRef: string;
  rule: string;
  severity: 'INFO' | 'ATTENTION' | 'HIGH';
  reasons: DraftReason[];
}
export interface DraftOutput {
  subjectKind: string;
  subjectRef: string;
  kind: string;
  values: Json;
  reasons: DraftReason[];
  /** Flags about this output's subject, linked to it. */
  flags?: DraftFlag[];
}

/**
 * A finished run of `method` version 1 (with `referenceSet` when it scores against one), its outputs and their flags,
 * written as the analytics role through its own record functions, as the runner writes a run. The inputs name
 * catalogued views (analytics.input_catalog_v1) with the rows the fixture read from them.
 */
export async function recordRun(
  copy: AnalyticsCopy,
  run: { method: string; referenceSet?: string | null; inputs: { view: string; rows: number }[]; outputs: DraftOutput[] },
): Promise<{ runId: string; outputIds: string[]; flagIds: string[] }> {
  const asOf = new Date().toISOString();
  const inputs = run.inputs.map((i) => ({ view: i.view, version: 1, filter: null, data_as_of: asOf, rows: i.rows, sha256: sha256(`${i.view}|${JSON.stringify(run.outputs)}`) }));
  const runtime = { package: '@ebmr/analytics 0.1.0', commit: 'e2e-fixture', node: process.version, libraries: {} };
  const client = await analyticsClient(copy);
  try {
    const one = async (text: string, values: unknown[]): Promise<string> => String((await client.query<{ id: string }>(text, values)).rows[0]?.id);
    const runId = await one("select analytics.begin_run($1, 1, $2, 'ON_DEMAND', $3::jsonb, $4::jsonb)::text as id", [run.method, run.referenceSet ?? null, JSON.stringify(inputs), JSON.stringify(runtime)]);
    const outputIds: string[] = [];
    const flagIds: string[] = [];
    for (const o of run.outputs) {
      const outputId = await one('select analytics.record_output($1, $2, $3, $4, $5::jsonb, $6::jsonb)::text as id',
        [runId, o.subjectKind, o.subjectRef, o.kind, JSON.stringify(o.values), JSON.stringify(o.reasons)]);
      outputIds.push(outputId);
      for (const f of o.flags ?? []) {
        flagIds.push(await one('select analytics.record_flag($1, $2, $3, $4, $5, $6, $7::jsonb)::text as id',
          [runId, outputId, f.subjectKind, f.subjectRef, f.rule, f.severity, JSON.stringify(f.reasons)]));
      }
    }
    await client.query("select analytics.finish_run($1, $2, '{}'::jsonb)", [runId, sha256(JSON.stringify(run.outputs))]);
    return { runId, outputIds, flagIds };
  } finally {
    await client.end();
  }
}

/**
 * A reference set approved by the demo set's QA investigator under the E2E change record from a model candidate, as
 * the reference-sets route records one: the candidate's own model, hash and batches (EBMR-ANA-010, -030).
 */
export async function approveReferenceSet(copy: AnalyticsCopy, method: string, scope: Json, candidateOutput: string): Promise<string> {
  const qa = await openPersonaSession(copy.db, copy.seed, 'qaInvestigator');
  try {
    return await withCommand(copy.db.app, { ...because(qa, 'E2E set-up: the golden profile reference set of the browser flow', 'CONFIG_CHANGE'), changeRecord: E2E_CHANGE_RECORD }, async (c) => {
      const { rows } = await c.query<{ values: Json }>('select "values" from analytics.output_v1 where output_id = $1', [candidateOutput]);
      const v = rows[0]?.values ?? {};
      const def = { method, scope, batchIds: v['batchIds'], candidateOutput, model: v['model'], modelSha256: v['modelSha256'], status: 'EFFECTIVE' };
      return String((await c.query<{ id: string }>('select analytics.set_reference_set($1::jsonb)::text as id', [JSON.stringify(def)])).rows[0]?.id);
    });
  } finally {
    await endSessions(copy.db, qa);
  }
}

/**
 * TEST FIXTURE: a record in the review queue copied from the review batch (its family, MBR pin, control recipe, batch
 * and state rows under new ids) at EXECUTION_COMPLETE, as the server's review-priority test copies one; no exception,
 * deviation or act of its own. Returns its id.
 */
export async function copyRecord(copy: AnalyticsCopy, source: string, number: string): Promise<string> {
  const [id, pin, cr] = [randomUUID(), randomUUID(), randomUUID()];
  const copyRow = (table: string, key: string, over: Json) => ({
    text: `insert into ${table} select (jsonb_populate_record(null::${table}, to_jsonb(t) || $2::jsonb)).* from ${table} t where t.${key} = $1`,
    values: [source, JSON.stringify(over)],
  });
  await asOwner(copy, [
    copyRow('recipe.stub_batch', 'id', { id, batch_number: number }),
    copyRow('recipe.batch_mbr_pin', 'batch_id', { id: pin, batch_id: id }),
    copyRow('recipe.control_recipe', 'batch_id', { id: cr, batch_id: id, pin_id: pin }),
    copyRow('recipe.batch_execution', 'id', { id, batch_number: number, control_recipe_id: cr, issue_signature_id: randomUUID() }),
    copyRow('recipe.execution_state', 'batch_id', { batch_id: id, status: 'EXECUTION_COMPLETE' }),
  ]);
  return id;
}

// ---------------------------------------------------------------------------------------------
// The fixture's numbers
// ---------------------------------------------------------------------------------------------

export interface ImrChart {
  centre: number;
  upper: number;
  lower: number;
  movingRanges: number[];
  movingRangeMean: number;
  movingRangeUpper: number;
  /** The rules each point hits (NELSON_1 beyond a control limit, NELSON_2 the ninth or later point on one side). */
  rules: string[][];
}

/** Textbook individuals and moving-range limits (2.66 and 3.267 times the mean moving range) and Nelson rules 1 and 2. */
export function imrChart(values: readonly number[]): ImrChart {
  const centre = values.reduce((a, x) => a + x, 0) / values.length;
  const movingRanges = values.slice(1).map((x, i) => Math.abs(x - (values[i] ?? x)));
  const movingRangeMean = movingRanges.reduce((a, x) => a + x, 0) / movingRanges.length;
  const upper = centre + 2.66 * movingRangeMean;
  const lower = centre - 2.66 * movingRangeMean;
  let run = 0;
  let side = 0;
  const rules = values.map((x) => {
    const s = Math.sign(x - centre);
    run = s !== 0 && s === side ? run + 1 : s === 0 ? 0 : 1;
    side = s;
    return [...(x > upper || x < lower ? ['NELSON_1'] : []), ...(run >= 9 ? ['NELSON_2'] : [])];
  });
  return { centre, upper, lower, movingRanges, movingRangeMean, movingRangeUpper: 3.267 * movingRangeMean, rules };
}

/** A curve resampled to `points` values over its normalised time (linear between the usable samples). */
export function resample(samples: readonly { t: number; v: number }[], points: number): number[] {
  const t0 = samples[0]?.t ?? 0;
  const span = (samples[samples.length - 1]?.t ?? 1) - t0 || 1;
  const xs = samples.map((s) => ({ u: (s.t - t0) / span, v: s.v }));
  return Array.from({ length: points }, (_, j) => {
    const u = j / (points - 1);
    const k = Math.max(1, xs.findIndex((x) => x.u >= u));
    const a = xs[k - 1] ?? xs[0]!;
    const b = xs[k] ?? a;
    return b.u === a.u ? a.v : a.v + ((b.v - a.v) * (u - a.u)) / (b.u - a.u);
  });
}

/** Dynamic time warping distance (absolute differences, no window). */
export function dtw(a: readonly number[], b: readonly number[]): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(Infinity));
  d[0]![0] = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.abs(a[i - 1]! - b[j - 1]!) + Math.min(d[i - 1]![j]!, d[i]![j - 1]!, d[i - 1]![j - 1]!);
    }
  }
  return d[a.length]![b.length]!;
}

const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((x, y) => x - y);
  const h = (s.length - 1) * q;
  const lo = Math.floor(h);
  return s[lo]! + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]!) - s[lo]!);
};

export interface PressBand {
  reference: number[];
  low: number[];
  high: number[];
  medoid: number;
  distanceLimit: number;
  curve: number[];
  distance: number;
  outside: number;
}

/**
 * The band of the reference curves (the 5th and 95th percentiles within one point either side), the medoid as the
 * reference curve (the smallest summed DTW distance to the others), the largest reference distance as the distance
 * limit, and the scored curve's distance and points outside the band.
 */
export function pressBand(references: readonly number[][], scored: readonly number[]): PressBand {
  const sums = references.map((a) => references.reduce((t, b) => t + dtw(a, b), 0));
  const medoid = sums.indexOf(Math.min(...sums));
  const reference = references[medoid]!;
  const at = (j: number): number[] => references.flatMap((r) => [r[j - 1], r[j], r[j + 1]].filter((x): x is number => x !== undefined));
  const low = reference.map((_, j) => quantile(at(j), 0.05));
  const high = reference.map((_, j) => quantile(at(j), 0.95));
  const distanceLimit = Math.max(...references.map((r) => dtw(r, reference)));
  const curve = [...scored];
  const outside = curve.filter((x, j) => x < low[j]! || x > high[j]!).length;
  return { reference, low, high, medoid, distanceLimit, curve, distance: dtw(curve, reference), outside };
}
