/**
 * The load record (slice 7d; interfaces section 6): the JSON record under .reports/load/ and its summary for
 * docs/validation/v1.0-rc/load-and-soak.md. The SLOs (phase-7-plan.md, slice 7d), each PASS, FAIL or NOT_MEASURED with
 * the measured value beside the target; a smoke at reduced scale shows the driver works and where the system stands,
 * the measured run and the soak on the pod are the evidence (D-P7-4, D-P7-5).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadOptions } from './options.ts';
import { latencies, percentile, summariseRequests, type Operation, type Recorder, type ResourceSample, type RouteSummary } from './metrics.ts';

export type SloStatus = 'PASS' | 'FAIL' | 'NOT_MEASURED';

export interface Slo {
  id: string;
  title: string;
  target: string;
  measured: string;
  status: SloStatus;
}

export interface FeedResult {
  system: string;
  published: number;
  received: number;
  refused: number;
  duplicates: number;
  reconciled: boolean;
}

export interface LoadRecord {
  kind: 'ebmr.load-record';
  version: 1;
  label: string;
  commit: string;
  /** loadAverage: the host's 1-minute load average at the start of the measured window and at its end (other work on a shared host shows here). */
  host: { name: string; cpus: number; memoryBytes: number; node: string; postgres: string; loadAverage?: [number, number] };
  options: LoadOptions & { historyBatches: number };
  startedAt: string;
  durationMs: number;
  slos: Slo[];
  soak: Slo[];
  routes: RouteSummary[];
  operations: Operation[];
  feeds: FeedResult[];
  resources: ResourceSample[];
  serverErrors: string[];
  /** The error that stopped the run before its end, if one did (the SLOs are then not all measured). */
  stoppedBy?: string;
  driverErrors: string[];
  notes: string[];
}

const fmt = (x: number | null, unit = 'ms'): string => (x === null ? 'n/a' : `${(Math.round(x * 10) / 10).toString()} ${unit}`);

export function evaluateSlos(r: Recorder, feeds: readonly FeedResult[], floorActors: readonly string[]): Slo[] {
  const ops = (name: string) => r.operations.filter((o) => o.name === name);
  const slos: Slo[] = [];
  const review = ops('REVIEW_OPEN');
  const worst = review.length ? Math.max(...review.map((o) => o.ms)) : null;
  const entries = review[0]?.detail['entries'];
  slos.push({ id: 'SLO-1', title: `the batch review of a ${scalar(entries)}-entry batch opens`, target: 'under 5 s (50,000 entries at the reference site)', measured: worst === null ? 'not measured' : `${fmt(worst)} (worst of ${String(review.length)})`, status: worst === null ? 'NOT_MEASURED' : worst < 5000 && review.every((o) => o.ok) ? 'PASS' : 'FAIL' });
  const commands = latencies(r, 'COMMAND', floorActors);
  const p95 = percentile(commands, 95);
  slos.push({ id: 'SLO-2', title: 'p95 of the shop-floor commands', target: 'under 300 ms on the loopback (an upper bound for a site LAN)', measured: `${fmt(p95)} over ${String(commands.length)} commands (p50 ${fmt(percentile(commands, 50))}, p99 ${fmt(percentile(commands, 99))})`, status: p95 === null ? 'NOT_MEASURED' : p95 < 300 ? 'PASS' : 'FAIL' });
  const signed = ops('SIGNED_ACT');
  const retriedTwice = signed.filter((o) => Number(o.detail['attempts'] ?? 1) > 2 || !o.ok).length;
  slos.push({ id: 'SLO-3', title: 'a signed act commits under concurrent ingestion with at most one serialisation retry', target: 'in 99 of 100 acts', measured: signed.length === 0 ? 'not measured' : `${String(signed.length - retriedTwice)} of ${String(signed.length)} within one retry (${String(signed.filter((o) => Number(o.detail['attempts'] ?? 1) === 2).length)} retried once)`, status: signed.length === 0 ? 'NOT_MEASURED' : retriedTwice * 100 <= signed.length ? 'PASS' : 'FAIL' });
  const lost = feeds.filter((f) => !f.reconciled || f.published !== f.received);
  slos.push({ id: 'SLO-4', title: 'no message lost or duplicated (counts and checksums equal at the end)', target: 'every feed reconciles', measured: feeds.length === 0 ? 'not measured' : feeds.map((f) => `${f.system} ${String(f.received)}/${String(f.published)}${f.reconciled ? ' reconciled' : ' NOT reconciled'}`).join(', '), status: feeds.length === 0 ? 'NOT_MEASURED' : lost.length === 0 ? 'PASS' : 'FAIL' });
  const run = ops('ANALYTICS_RUN')[0];
  const blockMs = run ? Number(run.detail['maxEventLoopBlockMs'] ?? NaN) : NaN;
  slos.push({ id: 'SLO-5', title: 'the nightly analytics run finishes and blocks the event loop briefly', target: 'within 30 min; no block over 200 ms', measured: run ? `${fmt(run.ms)}; longest block ${fmt(blockMs)}; ${scalar(run.detail['methods'])} method runs` : 'not measured', status: !run ? 'NOT_MEASURED' : run.ok && run.ms <= 30 * 60_000 && blockMs <= 200 ? 'PASS' : 'FAIL' });
  const views = ops('ANALYTICS_VIEW');
  const worstView = views.length ? Math.max(...views.map((o) => o.ms)) : null;
  slos.push({ id: 'SLO-6', title: 'each analytics flag view answers', target: 'under 1 s', measured: worstView === null ? 'not measured' : `${fmt(worstView)} (worst of ${String(views.length)}: ${views.map((v) => String(v.detail['route'])).join(', ')})`, status: worstView === null ? 'NOT_MEASURED' : worstView < 1000 && views.every((v) => v.ok) ? 'PASS' : 'FAIL' });
  return slos;
}

/** The soak's checks (D-P7-5), judged after the warm-up (the first quarter of the run). */
export function evaluateSoak(samples: readonly ResourceSample[], serverErrors: readonly string[], minutes: number): Slo[] {
  const after = samples.slice(Math.floor(samples.length / 4));
  const first = after[0];
  const last = after[after.length - 1];
  const informational = minutes < 60;
  const st = (ok: boolean): SloStatus => (after.length < 2 ? 'NOT_MEASURED' : ok ? 'PASS' : 'FAIL');
  const growth = first?.rssBytes && last?.rssBytes ? (last.rssBytes - first.rssBytes) / first.rssBytes : null;
  const handles = first?.openFiles !== null && last?.openFiles !== null && first && last ? (last.openFiles ?? 0) - (first.openFiles ?? 0) : null;
  const conns = after.map((s) => s.dbConnections);
  const note = informational ? ' (a short run: informational; the soak runs 4 hours)' : '';
  return [
    { id: 'SOAK-1', title: `the server's memory is steady after the warm-up${note}`, target: 'RSS growth under 10 %', measured: growth === null ? 'n/a' : `${(growth * 100).toFixed(1)} % (${String(Math.round((first?.rssBytes ?? 0) / 1048576))} to ${String(Math.round((last?.rssBytes ?? 0) / 1048576))} MiB)`, status: growth === null ? 'NOT_MEASURED' : st(growth < 0.1) },
    { id: 'SOAK-2', title: `no file-handle leak${note}`, target: 'open handles flat after the warm-up (within 16)', measured: handles === null ? 'n/a' : `${String(first?.openFiles)} to ${String(last?.openFiles)}`, status: handles === null ? 'NOT_MEASURED' : st(handles <= 16) },
    { id: 'SOAK-3', title: `no connection leak${note}`, target: 'database connections bounded (the pools\' sizes)', measured: conns.length ? `${String(Math.min(...conns))} to ${String(Math.max(...conns))}` : 'n/a', status: st(conns.length > 0 && Math.max(...conns) - Math.min(...conns) <= 8) },
    { id: 'SOAK-4', title: 'no error in the server\'s log', target: 'no line at error or fatal level', measured: `${String(serverErrors.length)} line(s)`, status: serverErrors.length === 0 ? 'PASS' : 'FAIL' },
  ];
}

export function buildRecord(base: Omit<LoadRecord, 'kind' | 'version' | 'slos' | 'soak' | 'routes' | 'operations' | 'resources' | 'driverErrors'>, r: Recorder, floorActors: readonly string[]): LoadRecord {
  return {
    kind: 'ebmr.load-record',
    version: 1,
    ...base,
    slos: evaluateSlos(r, base.feeds, floorActors),
    soak: evaluateSoak(r.resources, base.serverErrors, base.options.minutes),
    routes: summariseRequests(r),
    operations: r.operations,
    resources: r.resources,
    driverErrors: r.errors,
  };
}

export function writeRecord(dir: string, rec: LoadRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `load-${rec.label}-${rec.startedAt.replace(/[:.]/g, '')}.json`);
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}

/** A detail value as text: a number or a string, else '?'. */
const scalar = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '?');

const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The record's summary: one section per run, for docs/validation/v1.0-rc/load-and-soak.md. */
export function renderSummary(rec: LoadRecord, file: string): string {
  const o = rec.options;
  const L: string[] = [];
  L.push(`## ${rec.label} run of ${rec.startedAt} (${rec.stoppedBy !== undefined ? 'STOPPED before its end' : rec.slos.every((s) => s.status !== 'FAIL') ? 'no SLO failed' : 'an SLO FAILED'})`, '');
  if (rec.stoppedBy !== undefined) L.push(`The run stopped: \`${cell(rec.stoppedBy.slice(0, 300))}\`.`, '');
  L.push(`Commit \`${rec.commit}\`, host \`${rec.host.name}\` (${String(rec.host.cpus)} CPUs, ${String(Math.round(rec.host.memoryBytes / 1073741824))} GiB, Node ${rec.host.node}, PostgreSQL ${rec.host.postgres}${rec.host.loadAverage ? `; 1-minute load average ${rec.host.loadAverage[0].toFixed(1)} when the measured window began and ${rec.host.loadAverage[1].toFixed(1)} when it ended` : ''}). Record \`${file}\`.`, '');
  L.push(`Inputs: ${String(o.minutes)} min of traffic at rate ${String(o.rate)} and scale ${String(o.scale)}: ${String(o.sessions)} shop-floor and ${String(o.officeSessions)} office sessions, a command every ${String(o.commandEverySec / o.rate)} s and a screen refresh every ${String(o.viewEverySec / o.rate)} s per floor session; ${String(o.historyBatches)} history batches (${String(o.historyDays)} days x ${String(o.batchesPerDay)} a day x scale); ${String(o.pointsPerBatch)} data points a batch over ${String(o.opcuaTags)} tags; a review batch of ${String(o.reviewEntries)} entries; ${String(o.signedActs)} signed acts; feeds ${o.feeds.join(', ')} every ${String(o.feedEverySec / o.rate)} s.`, '');
  L.push('| SLO | What | Target | Measured | Result |', '|---|---|---|---|---|');
  for (const s of [...rec.slos, ...rec.soak]) L.push(`| ${s.id} | ${cell(s.title)} | ${cell(s.target)} | ${cell(s.measured)} | ${s.status} |`);
  L.push('', '| Actor | Route | Requests | Errors | p50 | p95 | p99 | max |', '|---|---|---|---|---|---|---|---|');
  for (const x of rec.routes) L.push(`| ${x.actor} | ${x.route} | ${String(x.count)} | ${String(x.errors)} | ${fmt(x.p50)} | ${fmt(x.p95)} | ${fmt(x.p99)} | ${fmt(x.max)} |`);
  if (rec.notes.length > 0) L.push('', ...rec.notes.map((n) => `- ${n}`));
  if (rec.serverErrors.length + rec.driverErrors.length > 0) L.push('', 'Errors:', '', ...[...rec.serverErrors, ...rec.driverErrors].slice(0, 20).map((e) => `- \`${cell(e.slice(0, 300))}\``));
  return `${L.join('\n')}\n`;
}
