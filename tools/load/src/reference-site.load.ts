/**
 * The reference-site load run (slice 7d; D-P7-4, D-P7-5): one Vitest file run by tools/load/src/cli.ts with
 * tools/load/src/vitest.load.config.ts (never by the suite: the name is not *.test.ts). Options in EBMR_LOAD_OPTIONS
 * (options.ts). Set-up (not measured): the site (site.ts), the history (generated batches, planned and issued through
 * the routes with the issuer's signature), one running batch per shop-floor session, the review batch (entries made by
 * the operators' commands, then marked complete: LOAD-ONLY shortcut, as the demo's review batch), the feeds (feeds.ts).
 * Measured, for `minutes`: every shop-floor session refreshes its batch and step and sends a badge-tapped command;
 * office sessions read the queues and the integration health; the issuers issue the signed acts (SLO-3) while every
 * feed publishes and every worker polls; QA opens the review batch (SLO-1) every two minutes; the server's resources
 * are sampled. Then the feeds are settled and reconciled (SLO-4), the analytics methods run as the nightly run with the
 * event-loop delay monitored (SLO-5) and their flag views timed (SLO-6). The record goes to EBMR_LOAD_OPTIONS.outDir.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { cpus, hostname, loadavg, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { personaOf } from '@ebmr/test-kit';
import { buildApp } from '../../../apps/tablets-server/src/app.ts';
import { catalogMethods } from '../../../apps/tablets-server/src/analytics/catalog.ts';
import { parseConfig } from '../../../apps/tablets-server/src/config.ts';
import { releaseMethodVersion } from '../../../apps/tablets-server/test/analytics/support.ts';
import { startFeeds, type Feeds } from './feeds.ts';
import { Recorder, elapsedMs } from './metrics.ts';
import type { NetBrowser } from './net-browser.ts';
import { effective, parseOptions, SMOKE, REFERENCE } from './options.ts';
import { buildRecord, renderSummary, writeRecord, type FeedResult } from './report.ts';
import { buildSite, dropSite, issueBatch, type Site } from './site.ts';

const options = effective(parseOptions(process.env['EBMR_LOAD_OPTIONS'], { ...REFERENCE, ...SMOKE }));
const log = (m: string) => process.stdout.write(`[load] ${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const STEP = 'p-disp-sop@';

/** A badge-tapped command of `persona` on `batchId` at a kiosk: the view's version, then the command (one retry on a stale version). */
async function floorCommand(site: Site, b: NetBrowser, persona: string, batchId: string, intent: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const view = await b.call(routes.batches.batch, { params: { batchId } });
    if (!view.ok) return false;
    const body = { expectedVersion: view.value.header.version, intent } as never;
    const p = personaOf(site.seed, persona);
    const attribution = { method: 'BADGE_TAP' as const, badgeUid: p.badgeUid ?? '', proof: await b.proof('POST', `/api/batches/${batchId}/commands`, body) };
    const r = await b.call(routes.batches.command, { params: { batchId }, body, attribution });
    if (r.ok) return true;
    if (!(r.error.kind === 'REFUSAL' && r.error.status === 409)) return false;
  }
  return false;
}

function procNumber(pid: number, file: string, field: RegExp): number | null {
  try {
    const m = field.exec(readFileSync(`/proc/${String(pid)}/${file}`, 'utf8'));
    return m?.[1] ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function openFiles(pid: number): number | null {
  try {
    return readdirSync(`/proc/${String(pid)}/fd`).length;
  } catch {
    return null;
  }
}

it('[meta] the reference-site load run (tools/load)', async () => {
  const startedAt = new Date().toISOString();
  const t0 = process.hrtime.bigint();
  const recorder = new Recorder();
  const notes: string[] = [];
  let site: Site | null = null;
  let feeds: Feeds | null = null;
  let feedResults: FeedResult[] = [];
  let addr = 10;
  let stoppedBy: string | undefined;
  const load: number[] = [];
  const nextAddress = () => `127.0.0.${String((addr++ % 240) + 10)}`;
  try {
    site = await buildSite({ sessions: options.sessions, offices: options.officeSessions, log });
    const s = site;
    const sets = Math.max(1, Math.ceil(options.sessions / 2));
    // Eight issuer sessions (the issuers of the persona sets in turn, each on its own office PC): each signs at most 18
    // times a minute, under the server's 20 a session (esig.sign), so the history is made at about 140 batches a minute.
    const issuerKeys = Array.from({ length: 8 }, (_, i) => (i % sets === 0 ? 'issuer' : `issuer-w${String(i % sets)}`));
    const issuers = await Promise.all(issuerKeys.map((k, i) => s.signIn(k, s.offices[i] ?? 'PC-LOAD-01', nextAddress(), 'ISSUER', recorder)));
    const totalBatches = options.historyBatches + options.sessions + 1 + options.signedActs;
    log(`posting ${String(totalBatches)} ERP orders`);
    await s.postOrders(totalBatches);

    // History: generated batches, issued through the routes (not measured). Each issuer has a session on the main server
    // and one on each extra server process (the signature's password check is the server's CPU work), used in turn.
    const h0 = process.hrtime.bigint();
    const extras = await Promise.all(Array.from({ length: options.historyServers }, () => s.extraServer()));
    const historyIssuers = [
      ...issuers.map((b, i) => ({ b, key: issuerKeys[i] ?? 'issuer' })),
      ...(await Promise.all(extras.flatMap((x) => issuerKeys.map(async (k, i) => ({ b: await s.signIn(k, s.offices[i] ?? 'PC-LOAD-01', nextAddress(), 'ISSUER', recorder, x), key: k }))))),
    ];
    let made = 0;
    await Promise.all(historyIssuers.map(async ({ b, key }) => {
      while (made < options.historyBatches) {
        made += 1;
        const r = await issueBatch(s, b, key, true);
        if (!r.ok) throw new Error(`history batch ${String(made)}: ${r.refusal ?? ''}`);
      }
    }));
    for (const h of historyIssuers.slice(issuers.length)) h.b.close();
    for (const x of extras) await x.close();
    recorder.operation('HISTORY', h0, true, { batches: options.historyBatches, serverProcesses: 1 + extras.length, perMinute: Math.round((options.historyBatches * 60_000) / elapsedMs(h0)) });
    log(`history: ${String(options.historyBatches)} batches in ${String(Math.round(elapsedMs(h0) / 1000))} s`);

    // One running batch per shop-floor session; its operator signs in at the session's kiosk and starts the step.
    const floor: { persona: string; b: NetBrowser; batchId: string }[] = [];
    for (let i = 0; i < options.sessions; i += 1) {
      const persona = s.operators[i] ?? 'operator1';
      const issued = await issueBatch(s, issuers[i % issuers.length] as NetBrowser, issuerKeys[i % issuers.length] ?? 'issuer', true);
      if (!issued.ok) throw new Error(`floor batch: ${issued.refusal ?? ''}`);
      const b = await s.signIn(persona, s.kiosks[i] ?? '', nextAddress(), 'FLOOR', recorder);
      if (!(await floorCommand(s, b, persona, issued.batchId, { type: 'START_STEP', stepKey: STEP }))) throw new Error(`${persona} could not start ${STEP}`);
      floor.push({ persona, b, batchId: issued.batchId });
    }
    log(`floor: ${String(floor.length)} sessions on their batches`);

    // The review batch: entries from the operators' commands (alerts noted on the open step), then complete (LOAD-ONLY).
    const r0 = process.hrtime.bigint();
    const review = await issueBatch(s, issuers[0] as NetBrowser, issuerKeys[0] ?? 'issuer');
    if (!review.ok) throw new Error(`review batch: ${review.refusal ?? ''}`);
    const firstFloor = floor[0];
    if (!firstFloor) throw new Error('no floor session');
    await floorCommand(s, firstFloor.b, firstFloor.persona, review.batchId, { type: 'START_STEP', stepKey: STEP });
    const entries = async () => Number((await s.db.admin.query<{ n: string }>('select count(*)::text as n from kernel.audit_event where chain_key = $1', [`batch:${review.batchId}`])).rows[0]?.n ?? 0);
    let n = await entries();
    while (n < options.reviewEntries) {
      await Promise.all(floor.map((f, k) => floorCommand(s, f.b, f.persona, review.batchId, { type: 'RAISE_EXCEPTION', stepKey: STEP, description: `Load observation ${String(n)}-${String(k)} at the booth`, severity: 'ALERT' })));
      n = await entries();
    }
    {
      // LOAD-ONLY shortcut with the triggers off for this transaction only (the state's own consistency checks re-read the
      // whole command history of a running record; the record is not run to its end here).
      const c = await s.db.admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        await c.query("update recipe.execution_state set status = 'EXECUTION_COMPLETE' where batch_id = $1", [review.batchId]);
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    }
    recorder.operation('REVIEW_BATCH', r0, true, { entries: n });
    notes.push(`The review batch holds ${String(n)} audit-trail entries made by badge-tapped commands (alerts noted on an open step); its status was then set EXECUTION_COMPLETE by the superuser with the triggers off for that one update (LOAD-ONLY shortcut, as the demo's review batch sets it), so QA can open it in review.`);
    log(`review batch: ${String(n)} entries`);

    // Office sessions: QA reviewers (one opens the review batch), each on its own PC.
    const qaKeys = Array.from({ length: Math.max(1, options.officeSessions) }, (_, i) => (i === 0 ? 'qaInvestigator' : i < sets ? `qaInvestigator-w${String(i)}` : 'qaInvestigator'));
    const office = await Promise.all(qaKeys.map((k, i) => s.signIn(k, s.offices[8 + i] ?? s.offices[0] ?? '', nextAddress(), i === 0 ? 'REVIEW' : 'OFFICE', recorder)));

    feeds = await startFeeds(s, options.feeds, { emsTags: options.opcuaTags, samplesPerChunk: Math.max(1, Math.round(options.pollEverySec)) });
    const f = feeds;
    log(`feeds: ${options.feeds.join(', ')}`);

    // The measured window.
    recorder.measuring = true;
    load.push(loadavg()[0] ?? 0);
    const end = performance.now() + options.minutes * 60_000;
    const until = async (everyMs: number, work: () => Promise<unknown>) => {
      while (performance.now() < end) {
        const t = performance.now();
        try {
          await work();
        } catch (error) {
          if (recorder.errors.length < 50) recorder.errors.push(`driver: ${(error as Error).message.slice(0, 300)}`);
        }
        await sleep(everyMs - (performance.now() - t));
      }
    };
    const sampler = async () => {
      const { rows } = await s.db.admin.query<{ c: string; b: string; series: string; inbound: string }>(
        `select (select count(*) from pg_stat_activity where datname = current_database())::text as c, pg_database_size(current_database())::text as b,
                (select coalesce(n_live_tup, 0) from pg_stat_user_tables where relid = 'plant.series'::regclass)::text as series,
                (select count(*) from platform.inbound_message)::text as inbound`);
      const x = rows[0];
      recorder.resources.push({ atMs: Math.round(recorder.sinceStartMs()), rssBytes: procNumber(s.pid, 'status', /VmRSS:\s+(\d+) kB/), openFiles: openFiles(s.pid), dbConnections: Number(x?.c ?? 0), dbBytes: Number(x?.b ?? 0), seriesRows: Number(x?.series ?? 0), inboundMessages: Number(x?.inbound ?? 0) });
    };
    const rate = options.rate;
    const signedEveryMs = (options.minutes * 60_000) / Math.max(1, options.signedActs);
    let signedDone = 0;
    const tasks: Promise<void>[] = [
      ...floor.map((x, i) => (async () => {
        await sleep((i * 997) % (options.viewEverySec * 1000));
        await Promise.all([
          until((options.viewEverySec * 1000) / rate, async () => {
            await x.b.call(routes.batches.batch, { params: { batchId: x.batchId } });
            await x.b.call(routes.batches.step, { params: { batchId: x.batchId, stepKey: STEP } });
          }),
          until((options.commandEverySec * 1000) / rate, () => floorCommand(s, x.b, x.persona, x.batchId, { type: 'RAISE_EXCEPTION', stepKey: STEP, description: 'Noted during the load run', severity: 'ALERT' })),
        ]);
      })()),
      ...office.slice(1).map((b) => until(10_000 / rate, async () => {
        await b.call(routes.review.queue, { query: {} });
        await b.call(routes.release.queue);
        await b.call(routes.integrations.adapters);
      })),
      until(120_000, async () => {
        const b = office[0] as NetBrowser;
        const t = process.hrtime.bigint();
        const a = await b.call(routes.review.batch, { params: { batchId: review.batchId } });
        const reg = await b.call(routes.review.register, { params: { batchId: review.batchId }, body: {} });
        const trail = await b.call(routes.review.auditTrail, { params: { batchId: review.batchId }, query: {} });
        const rec = await b.call(routes.batches.batch, { params: { batchId: review.batchId } });
        recorder.operation('REVIEW_OPEN', t, a.ok && reg.ok && trail.ok && rec.ok, { entries: n, statuses: [a.ok, reg.ok, trail.ok, rec.ok] });
      }),
      ...issuers.slice(0, 2).map((b, i) => until(signedEveryMs * 2, async () => {
        if (signedDone >= options.signedActs) return;
        signedDone += 1;
        const t = process.hrtime.bigint();
        const r = await issueBatch(s, b, issuerKeys[i] ?? 'issuer');
        recorder.operation('SIGNED_ACT', t, r.ok, { act: 'GMP_BATCH_ISSUE', attempts: r.attempts, refusal: r.refusal });
      })),
      ...f.feeds.map((x) => until(((x.system === 'EMS' ? options.pollEverySec : options.feedEverySec) * 1000) / rate, () => x.publish())),
      until(options.pollEverySec * 1000, () => f.cycle()),
      until(options.sampleEverySec * 1000, sampler),
    ];
    await Promise.all(tasks);
    load.push(loadavg()[0] ?? 0);
    await sampler();
    log('measured window over; settling the feeds');
    feedResults = await f.finish();

    if (options.analytics) {
      // The nightly run: every catalogued method in force (as the release writes it), run by the runner of a server built
      // in this process (its own analytics login), with the event-loop delay monitored; then the flag views as QA.
      for (const m of catalogMethods()) await releaseMethodVersion({ db: s.db }, m.id, 1);
      const admin = new URL(process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres');
      const env = parseConfig({ EBMR_INSTALLATION: 'GMP', EBMR_ENV: 'test', EBMR_DATABASE: s.database, EBMR_PG_HOST: admin.hostname, EBMR_PG_PORT: admin.port || '5432', EBMR_PUBLIC_ORIGIN: 'http://127.0.0.1:3999', EBMR_SEAL_KEY_FILE: s.sealKeyFile, EBMR_LOG_LEVEL: 'silent', EBMR_ANALYTICS: 'on' }, () => randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''));
      const built = await buildApp(env, { analytics: { pollMs: 3_600_000 } });
      try {
        const runner = built.analytics;
        if (!runner) throw new Error('no analytics runner');
        const h = monitorEventLoopDelay({ resolution: 10 });
        h.enable();
        const a0 = process.hrtime.bigint();
        const reports = await runner.runAll('SCHEDULED');
        h.disable();
        recorder.operation('ANALYTICS_RUN', a0, reports.every((x) => x.status === 'DONE'), { methods: reports.length, statuses: reports.map((x) => `${x.method}:${x.status}`), maxEventLoopBlockMs: Math.round(h.max / 1e5) / 10 });
      } finally {
        await built.close();
      }
      const qa = office[0] as NetBrowser;
      // The audit-trail flags name persons: data-integrity review only (EBMR-ANA-007), so the CSV/DI lead reads them.
      const diLead = await s.signInGranted('CSV_DI_LEAD', s.offices[s.offices.length - 1] ?? '', nextAddress(), 'REVIEW', recorder);
      for (const [route, input, who] of [[routes.analytics.flags, { query: {} }, qa], [routes.analyticsAudit.flags, { query: {} }, diLead], [routes.analyticsReview.priority, { params: { batchId: review.batchId } }, qa]] as const) {
        const t = process.hrtime.bigint();
        const r = await who.call(route as never, input as never);
        recorder.operation('ANALYTICS_VIEW', t, r.ok, { route: route.id, ...(r.ok ? {} : { error: JSON.stringify(r.error).slice(0, 200) }) });
      }
    }
    notes.push(`The data points (${String(options.opcuaTags)} tags at 1 Hz) reach the series store through the EMS feed and the EMS adapter worker (one chunk per tag and poll); the OPC UA path itself (simulator, gateway, signed feed, OPCUA adapter worker) is exercised by GB-T-03 and the OPC UA adapter tests, not by this driver.`);
    notes.push('SLO-3 is measured on the batch issue (plan, content, challenge and the ISSUED e-signature with its device proof, a protected number from the external ledger): the release act needs lots made READY by the full release path, which the driver does not build; see the residuals.');
  } catch (error) {
    stoppedBy = (error as Error).message;
    throw error;
  } finally {
    recorder.measuring = false;
    await feeds?.close().catch(() => undefined);
    const database = site?.database;
    const dir = site?.dir;
    const pg = await site?.db.admin.query<{ v: string }>("select current_setting('server_version') as v").catch(() => null);
    await site?.close().catch(() => undefined);
    const commit = (() => {
      try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        return 'unknown';
      }
    })();
    const rec = buildRecord({
      label: options.label,
      commit,
      host: { name: hostname(), cpus: cpus().length, memoryBytes: totalmem(), node: process.version, postgres: pg?.rows[0]?.v ?? 'unknown', ...(load.length === 2 ? { loadAverage: [load[0] ?? 0, load[1] ?? 0] as [number, number] } : {}) },
      options,
      startedAt,
      durationMs: Math.round(elapsedMs(t0)),
      feeds: feedResults,
      serverErrors: site?.serverErrors ?? [],
      notes,
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    }, recorder, ['FLOOR']);
    const file = writeRecord(options.outDir, rec);
    process.stdout.write(`\n${renderSummary(rec, file)}\n`);
    log(`record: ${file}`);
    if (database && process.env['EBMR_LOAD_KEEP'] !== '1') await dropSite(database).catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}, 48 * 3_600_000);
