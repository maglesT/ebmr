/**
 * The dashboards' reads (Phase 6 slice 6g; contract ns/dashboards.ts; recipe-core 1070): every number comes from the
 * report views (the same views the reporting role reads), aggregated here in SQL. Ratios, hours and quantities stay
 * decimal text from the database; no JavaScript number carries a GMP value (counts and ages are whole numbers).
 * Periods are site-zone dates; the default is the 90 days up to today (D-P6g-0-3).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type {
  AlarmTrendView,
  ChangeImpactItem,
  ChangeImpactKind,
  ChangeImpactView,
  DeviationAgeingView,
  ExceptionParetoView,
  HoldTimeRiskView,
  OverdueReviewsView,
  PressOeeView,
  ReportCatalogView,
  ReportExportView,
  ReviewCycleTimeView,
  RightFirstTimeView,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

/** How many alarms the alarm trend lists (the counts are never cut). */
export const ALARM_LIST_MAX = 500;

interface Stamp {
  dataAsOf: ReturnType<AppContext['formatInstant']>;
  readAt: ReturnType<AppContext['formatInstant']>;
  dataAgeSeconds: number;
  notForGmpDecisions: true;
}

/** When the data was current and when it was read (report.data_as_of; D-P6g-0-1). */
async function stamp(app: AppContext, db: Db): Promise<Stamp> {
  const { rows } = await db.query<{ read_us: string; asof_us: string; age: number }>(
    `select ${usOf('statement_timestamp()')} as read_us, ${usOf('report.data_as_of()')} as asof_us,
            greatest(floor(extract(epoch from statement_timestamp() - report.data_as_of())), 0)::integer as age`,
  );
  const r = rows[0]!;
  return { dataAsOf: app.formatInstant(r.asof_us), readAt: app.formatInstant(r.read_us), dataAgeSeconds: r.age, notForGmpDecisions: true };
}

interface PeriodBounds {
  from: string;
  to: string;
  zone: string;
}

/** The period asked, or the 90 site-zone days up to today; `from` after `to` is refused. */
async function period(app: AppContext, db: Db, q: { from?: string | undefined; to?: string | undefined }): Promise<PeriodBounds> {
  const zone = app.siteZone.current();
  const { rows } = await db.query<{ from: string; to: string }>(
    `select coalesce($1::date, coalesce($2::date, (statement_timestamp() at time zone $3)::date) - 89)::text as from,
            coalesce($2::date, (statement_timestamp() at time zone $3)::date)::text as to`,
    [q.from ?? null, q.to ?? null, zone],
  );
  const p = { from: rows[0]!.from, to: rows[0]!.to, zone };
  if (p.from > p.to) {
    throw refusal(400, { code: 'EBMR-RPT-001', kind: 'INVALID_INPUT', whatHappened: 'The period starts after it ends.', whatYouCanDo: ['Choose a start date on or before the end date.'] });
  }
  return p;
}

/** SQL: whether timestamptz `col` falls in the period whose from, to and zone are parameters $a, $b, $c. */
const inPeriod = (col: string, a: number, b: number, c: number): string =>
  `${col} >= ($${a}::date::timestamp at time zone $${c}) and ${col} < (($${b}::date + 1)::timestamp at time zone $${c})`;

const batchDrill = (id: string): string => `/review/${id}`;

export async function rightFirstTime(app: AppContext, db: Db, q: { from?: string; to?: string }): Promise<RightFirstTimeView> {
  const s = await stamp(app, db);
  const p = await period(app, db, q);
  const { rows } = await db.query<{ batch_id: string; batch_number: string; product_code: string | null; qa_us: string; day: string; rft: boolean; exceptions: number; deviations: number; cycles: number }>(
    `select o.batch_id, o.batch_number, o.product_code, ${usOf('o.qa_reviewed_at')} as qa_us, (o.qa_reviewed_at at time zone $3)::date::text as day,
            o.right_first_time as rft, o.exception_count as exceptions, o.deviation_count as deviations, o.review_cycles as cycles
       from report.batch_outcome_v1 o
      where o.status = 'QA_REVIEWED' and ${inPeriod('o.qa_reviewed_at', 1, 2, 3)}
      order by o.qa_reviewed_at, o.batch_number`,
    [p.from, p.to, p.zone],
  );
  const { rows: rate } = await db.query<{ rate: string | null }>(
    'select case when $1::int = 0 then null else round($2::numeric / $1::numeric, 2)::text end as rate',
    [rows.length, rows.filter((r) => r.rft).length],
  );
  const days = new Map<string, { day: string; batches: number; rightFirstTime: number }>();
  for (const r of rows) {
    const d = days.get(r.day) ?? { day: r.day, batches: 0, rightFirstTime: 0 };
    d.batches += 1;
    if (r.rft) d.rightFirstTime += 1;
    days.set(r.day, d);
  }
  return {
    ...s,
    period: { from: p.from, to: p.to },
    summary: { batches: rows.length, rightFirstTime: rows.filter((r) => r.rft).length, rate: rate[0]!.rate },
    runChart: [...days.values()],
    batches: rows.map((r) => ({
      batchId: r.batch_id, batchNumber: r.batch_number, productCode: r.product_code, qaReviewedAt: app.formatInstant(r.qa_us), rightFirstTime: r.rft,
      exceptionCount: r.exceptions, deviationCount: r.deviations, reviewCycles: r.cycles, drill: batchDrill(r.batch_id),
    })),
  };
}

export async function exceptionPareto(app: AppContext, db: Db, q: { from?: string; to?: string }): Promise<ExceptionParetoView> {
  const s = await stamp(app, db);
  const p = await period(app, db, q);
  const { rows } = await db.query<{ category: string; n: number; cum: string; batches: { id: string; number: string }[] }>(
    `with c as (select e.category, count(*)::int as n,
                       jsonb_agg(distinct jsonb_build_object('id', e.batch_id, 'number', e.batch_number)) as batches
                  from report.exception_v1 e where ${inPeriod('e.raised_at', 1, 2, 3)} group by e.category)
     select c.category, c.n, round(100 * sum(c.n) over (order by c.n desc, c.category) / nullif(sum(c.n) over (), 0), 2)::text as cum, c.batches
       from c order by c.n desc, c.category`,
    [p.from, p.to, p.zone],
  );
  return {
    ...s,
    period: { from: p.from, to: p.to },
    total: rows.reduce((t, r) => t + r.n, 0),
    categories: rows.map((r) => ({
      category: r.category, count: r.n, cumulativePercent: r.cum,
      batches: r.batches.map((b) => ({ batchId: b.id, batchNumber: b.number, drill: `/review/${b.id}/register` })).sort((a, b) => a.batchNumber.localeCompare(b.batchNumber)),
    })),
  };
}

export async function reviewCycleTime(app: AppContext, db: Db, q: { from?: string; to?: string }): Promise<ReviewCycleTimeView> {
  const s = await stamp(app, db);
  const p = await period(app, db, q);
  const { rows } = await db.query<{ batch_id: string; batch_number: string; done_us: string; qa_us: string; days: string; cycles: number }>(
    `select o.batch_id, o.batch_number, ${usOf('o.completed_at')} as done_us, ${usOf('o.qa_reviewed_at')} as qa_us,
            round((extract(epoch from o.qa_reviewed_at - o.completed_at) / 86400)::numeric, 1)::text as days, o.review_cycles as cycles
       from report.batch_outcome_v1 o
      where o.status = 'QA_REVIEWED' and o.completed_at is not null and ${inPeriod('o.qa_reviewed_at', 1, 2, 3)}
      order by o.qa_reviewed_at, o.batch_number`,
    [p.from, p.to, p.zone],
  );
  const { rows: sum } = await db.query<{ median: string | null; max: string | null }>(
    `select round(percentile_cont(0.5) within group (order by d)::numeric, 1)::text as median, max(d)::text as max from unnest($1::numeric[]) d`,
    [rows.map((r) => r.days)],
  );
  return {
    ...s,
    period: { from: p.from, to: p.to },
    summary: { batches: rows.length, medianDays: sum[0]!.median, maxDays: sum[0]!.max },
    batches: rows.map((r) => ({
      batchId: r.batch_id, batchNumber: r.batch_number, completedAt: app.formatInstant(r.done_us), qaReviewedAt: app.formatInstant(r.qa_us),
      cycleDays: r.days, reviewCycles: r.cycles, drill: batchDrill(r.batch_id),
    })),
  };
}

const BUCKETS = ['0-30', '31-60', '61-90', '>90'] as const;
const bucketOf = (days: number): (typeof BUCKETS)[number] => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '>90');

export async function deviationAgeing(app: AppContext, db: Db): Promise<DeviationAgeingView> {
  const s = await stamp(app, db);
  const { rows } = await db.query<{ deviation_id: string; ref: string; kind: string; classification: string; state: string; raised_us: string; age_days: number }>(
    `select d.deviation_id, d.ref, d.kind, d.classification, d.state, ${usOf('d.raised_at')} as raised_us, d.age_days
       from report.deviation_ageing_v1 d where d.state not in ('CLOSED', 'CANCELLED') order by d.age_days desc, d.ref`,
  );
  const open = rows.map((r) => ({
    deviationId: r.deviation_id, ref: r.ref, kind: r.kind, classification: r.classification, state: r.state, raisedAt: app.formatInstant(r.raised_us),
    ageDays: Math.max(r.age_days, 0), bucket: bucketOf(r.age_days), drill: `/quality/deviations/${r.deviation_id}`,
  }));
  return { ...s, buckets: BUCKETS.map((bucket) => ({ bucket, count: open.filter((o) => o.bucket === bucket).length })), open };
}

export async function holdTimeRisk(app: AppContext, db: Db): Promise<HoldTimeRiskView> {
  const s = await stamp(app, db);
  const { rows } = await db.query<{ container_id: string; label_code: string; batch_id: string; batch_number: string; product_code: string; strength: string; closed_us: string;
    max_hold_hours: number; held_hours: string; used: string; risk: 'OK' | 'AT_RISK' | 'OVER' }>(
    `select h.container_id, h.label_code, h.batch_id, h.batch_number, h.product_code, h.strength, ${usOf('h.closed_at')} as closed_us, h.max_hold_hours, h.held_hours,
            round(100 * h.held_hours::numeric / h.max_hold_hours, 2)::text as used,
            case when h.held_hours::numeric > h.max_hold_hours then 'OVER' when h.held_hours::numeric >= 0.8 * h.max_hold_hours then 'AT_RISK' else 'OK' end as risk
       from report.hold_time_risk_v1 h
      where h.disposition = 'LEFT' and h.max_hold_hours is not null
      order by h.held_hours::numeric / h.max_hold_hours desc, h.label_code`,
  );
  return {
    ...s,
    summary: { held: rows.length, atRisk: rows.filter((r) => r.risk === 'AT_RISK').length, over: rows.filter((r) => r.risk === 'OVER').length },
    containers: rows.map((r) => ({
      containerId: r.container_id, labelCode: r.label_code, batchId: r.batch_id, batchNumber: r.batch_number, productCode: r.product_code, strength: r.strength,
      closedAt: app.formatInstant(r.closed_us), maxHoldHours: r.max_hold_hours, heldHours: r.held_hours, usedPercent: r.used, risk: r.risk,
      drill: `/review/${r.batch_id}/containers`,
    })),
  };
}

export async function overdueReviews(app: AppContext, db: Db): Promise<OverdueReviewsView> {
  const s = await stamp(app, db);
  const { rows } = await db.query<{ version_id: string; document_id: string; family_code: string; version_number: number; review_due: string; days_overdue: number;
    last_us: string | null; in_use: boolean }>(
    `select o.version_id, o.document_id, o.family_code, o.version_number, o.review_due::text as review_due, o.days_overdue,
            case when o.last_review_at is null then null else ${usOf('o.last_review_at')} end as last_us, o.in_use
       from report.overdue_review_v1 o order by o.days_overdue desc, o.document_id`,
  );
  return {
    ...s,
    versions: rows.map((r) => ({
      versionId: r.version_id, documentId: r.document_id, familyCode: r.family_code, versionNumber: r.version_number, reviewDue: r.review_due,
      daysOverdue: r.days_overdue, lastReviewAt: r.last_us === null ? null : app.formatInstant(r.last_us), inUse: r.in_use, drill: `/mbr/versions/${r.version_id}`,
    })),
  };
}

export async function pressOee(app: AppContext, db: Db, q: { from?: string; to?: string }): Promise<PressOeeView> {
  const s = await stamp(app, db);
  const p = await period(app, db, q);
  const { rows } = await db.query<{ equipment_id: string; equipment_code: string; batch_id: string; batch_number: string; from_us: string; to_us: string; running: string;
    observed: string; tablets: string | null; rejects: string | null; availability: string | null; quality: string | null; oee: string | null }>(
    `with x as (
       select c.*, case when c.observed_seconds::numeric > 0 then c.running_seconds::numeric / c.observed_seconds::numeric end as a,
              case when c.tablets is not null and c.tablets::numeric > 0 then (c.tablets::numeric - coalesce(c.rejects::numeric, 0)) / c.tablets::numeric end as q
         from report.press_counter_v1 c where ${inPeriod('c.first_event_at', 1, 2, 3)})
     select x.equipment_id, x.equipment_code, x.batch_id, x.batch_number, ${usOf('x.first_event_at')} as from_us, ${usOf('x.last_event_at')} as to_us,
            x.running_seconds as running, x.observed_seconds as observed, x.tablets, x.rejects,
            round(x.a, 4)::text as availability, round(x.q, 4)::text as quality, round(x.a * x.q, 4)::text as oee
       from x order by x.first_event_at, x.equipment_code`,
    [p.from, p.to, p.zone],
  );
  return {
    ...s,
    period: { from: p.from, to: p.to },
    presses: rows.map((r) => ({
      equipmentId: r.equipment_id, equipmentCode: r.equipment_code, batchId: r.batch_id, batchNumber: r.batch_number, from: app.formatInstant(r.from_us), to: app.formatInstant(r.to_us),
      runningSeconds: r.running, observedSeconds: r.observed, tablets: r.tablets, rejects: r.rejects, availability: r.availability, quality: r.quality, oee: r.oee,
      drill: batchDrill(r.batch_id),
    })),
  };
}

export async function alarmTrend(app: AppContext, db: Db, q: { from?: string; to?: string }): Promise<AlarmTrendView> {
  const s = await stamp(app, db);
  const p = await period(app, db, q);
  const where = inPeriod('a.raised_at', 1, 2, 3);
  const { rows: totals } = await db.query<{ total: number; critical: number }>(
    `select count(*)::int as total, count(*) filter (where a.gmp_critical)::int as critical from report.alarm_v1 a where ${where}`,
    [p.from, p.to, p.zone],
  );
  const { rows: byDay } = await db.query<{ day: string; n: number }>(
    `select (a.raised_at at time zone $3)::date::text as day, count(*)::int as n from report.alarm_v1 a where ${where} group by 1 order by 1`,
    [p.from, p.to, p.zone],
  );
  const { rows: byCode } = await db.query<{ code: string; n: number; critical: number; batches: number }>(
    `select a.alarm_code as code, count(*)::int as n, count(*) filter (where a.gmp_critical)::int as critical,
            (select count(distinct b) from report.alarm_v1 y cross join lateral unnest(y.batch_numbers) b
              where y.alarm_code = a.alarm_code and ${inPeriod('y.raised_at', 1, 2, 3)})::int as batches
       from report.alarm_v1 a where ${where} group by a.alarm_code order by n desc, code`,
    [p.from, p.to, p.zone],
  );
  const { rows: list } = await db.query<{ alarm_id: string; alarm_code: string; source: string; subject_code: string | null; raised_us: string; gmp_critical: boolean;
    acknowledged: boolean; batch_numbers: string[] }>(
    `select a.alarm_id, a.alarm_code, a.source, a.subject_code, ${usOf('a.raised_at')} as raised_us, a.gmp_critical, a.acked_at is not null as acknowledged, a.batch_numbers
       from report.alarm_v1 a where ${where} order by a.raised_at desc, a.alarm_id limit ${ALARM_LIST_MAX + 1}`,
    [p.from, p.to, p.zone],
  );
  return {
    ...s,
    period: { from: p.from, to: p.to },
    total: totals[0]!.total,
    gmpCritical: totals[0]!.critical,
    byDay: byDay.map((d) => ({ day: d.day, count: d.n })),
    byCode: byCode.map((c) => ({ alarmCode: c.code, count: c.n, gmpCritical: c.critical, batches: c.batches })),
    alarms: list.slice(0, ALARM_LIST_MAX).map((a) => ({
      alarmId: a.alarm_id, alarmCode: a.alarm_code, source: a.source, subjectCode: a.subject_code, raisedAt: app.formatInstant(a.raised_us), gmpCritical: a.gmp_critical,
      acknowledged: a.acknowledged, batchNumbers: a.batch_numbers, drill: '/alarms',
    })),
    listTruncated: list.length > ALARM_LIST_MAX,
  };
}

export async function catalog(app: AppContext, db: Db): Promise<ReportCatalogView> {
  const s = await stamp(app, db);
  const { rows } = await db.query<{ view_name: string; version: number; grain: string; description: string; columns: { name: string; type: string }[] }>(
    'select view_name, version, grain, description, columns from report.catalog_v1 order by view_name',
  );
  return { ...s, views: rows.map((r) => ({ viewName: r.view_name, version: r.version, grain: r.grain, description: r.description, columns: r.columns })) };
}

/** The documented export of one report view: only a view the catalogue lists, its columns in catalogue order, values as text. */
export async function exportView(app: AppContext, db: Db, view: string): Promise<ReportExportView> {
  const { rows: known } = await db.query<{ columns: { name: string }[] }>('select columns from report.catalog_v1 where view_name = $1', [view]);
  if (known.length === 0) {
    throw refusal(404, { code: 'EBMR-RPT-002', kind: 'INVALID_INPUT', whatHappened: `There is no report view ${view}.`, whatYouCanDo: ['Choose a view from the catalogue.'] });
  }
  const s = await stamp(app, db);
  const columns = known[0]!.columns.map((c) => c.name).filter((c) => c !== 'read_at' && c !== 'data_as_of');
  const select = columns.map((c) => `(${quoteIdent(c)})::text`).join(', ');
  const { rows } = await db.query<Record<string, string | null>>({ text: `select ${select} from report.${quoteIdent(view)}`, values: [], rowMode: 'array' } as pg.QueryConfig);
  const data = rows as unknown as (string | null)[][];
  const sha256 = createHash('sha256').update(JSON.stringify({ view, columns, rows: data })).digest('hex');
  return { ...s, viewName: view, columns, rows: data, sha256 };
}

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

// ---------------------------------------------------------------------------------------------
// Change impact
// ---------------------------------------------------------------------------------------------

interface ImpactRow {
  impact: 'MBR_VERSION' | 'OPEN_BATCH' | 'RELEASED_LOT' | 'MARKET' | 'CONFIG_HISTORY';
  id: string | null;
  label: string;
  detail: string | null;
  via: string | null;
}

const impactDrill = (r: ImpactRow): string | null => {
  if (r.id === null) return null;
  if (r.impact === 'MBR_VERSION') return `/mbr/versions/${r.id}`;
  if (r.impact === 'OPEN_BATCH') return `/review/${r.id}`;
  if (r.impact === 'RELEASED_LOT') return `/genealogy/lots/${r.id}/supply-chain`;
  return null;
};

export async function changeImpact(app: AppContext, db: Db, kind: ChangeImpactKind, ref: string): Promise<ChangeImpactView> {
  const { rows } = await db.query<ImpactRow>('select impact, id, label, detail, via from recipe.change_impact($1, $2)', [kind, ref]);
  const { rows: now } = await db.query<{ us: string }>(`select ${usOf('statement_timestamp()')} as us`);
  const items = (k: ImpactRow['impact']): ChangeImpactItem[] =>
    rows.filter((r) => r.impact === k).map((r) => ({ id: r.id, label: r.label, detail: r.detail, via: r.via, drill: impactDrill(r) }));
  const lists = {
    versions: items('MBR_VERSION'),
    openBatches: items('OPEN_BATCH'),
    releasedLots: items('RELEASED_LOT'),
    markets: items('MARKET'),
    configHistory: items('CONFIG_HISTORY'),
  };
  const contentHash = createHash('sha256').update(JSON.stringify({ kind, ref, ...lists })).digest('hex');
  return {
    kind,
    ref,
    generatedAt: app.formatInstant(now[0]!.us),
    contentHash,
    counts: {
      versions: lists.versions.length, openBatches: lists.openBatches.length, releasedLots: lists.releasedLots.length,
      markets: lists.markets.length, configHistory: lists.configHistory.length,
    },
    ...lists,
  };
}
