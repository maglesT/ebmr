/**
 * The reads of the SPC, capability and deviation-rate screens (Phase 6A slice 6A-2; contract ns/analytics-spc.ts; ADR
 * 0020 point 4; draft controls DI-51, DI-52). They read the recorded outputs of completed runs (analytics.output_v1), the
 * runs' flags (analytics.flag_v1) and, for a chart's points, the batch facts (report.batch_fact_v1); they compute no
 * statistic. The master's limits and the recorded values come back as the outputs hold them: the source's decimal text.
 */
import type pg from 'pg';
import type { AnalyticsMethodId, CapabilityView, FlagView, RatesView, SpcChartView } from '@ebmr/api-contract';
import type { AppContext } from '../../../platform/context.ts';
import { usOf } from '../../common/people.ts';
import { dispositionsOf, flagViews, type FlagRow } from '../reads.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;
type Values = Record<string, unknown>;

export interface OutputRow {
  output_id: string;
  run_id: string;
  method: string;
  version: number;
  subject_ref: string;
  values: Values;
  asof_us: string;
  finished_us: string;
  age: number;
}

const OUTPUT_COLUMNS = `o.output_id::text, o.run_id::text, o.method, o.version, o.subject_ref, o."values",
  ${usOf('o.data_as_of')} as asof_us, ${usOf('o.finished_at')} as finished_us,
  greatest(floor(extract(epoch from statement_timestamp() - o.data_as_of)), 0)::integer as age`;

/** The newest output of `kind` about `subjectRef` from a DONE run of one of `methods`. */
export async function latestOutput(db: Db, kind: string, methods: readonly string[], subjectRef: string): Promise<OutputRow | null> {
  const { rows } = await db.query<OutputRow>(
    `select ${OUTPUT_COLUMNS} from analytics.output_v1 o
      where o.kind = $1 and o.method = any($2::text[]) and o.subject_kind = 'PRODUCT_ITEM' and o.subject_ref = $3
      order by o.finished_at desc, o.recorded_at desc, o.output_id limit 1`,
    [kind, methods, subjectRef],
  );
  return rows[0] ?? null;
}

const FLAG_COLUMNS = `f.flag_id::text, f.run_id::text, f.method, f.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
  ${usOf('f.raised_at')} as raised_us, ${usOf('f.data_as_of')} as asof_us, ${usOf('f.finished_at')} as finished_us, false as restricted`;

/** The flags a run raised about the given subjects. */
export async function runFlags(app: AppContext, db: Db, runId: string, subjectRefs: readonly string[]): Promise<FlagView[]> {
  if (subjectRefs.length === 0) return [];
  const { rows } = await db.query<FlagRow>(
    `select ${FLAG_COLUMNS} from analytics.flag_v1 f where f.run_id = $1 and f.subject_ref = any($2::text[]) order by f.rule, f.raised_at, f.flag_id`,
    [runId, subjectRefs],
  );
  const dispositions = await dispositionsOf(db, rows);
  return (await flagViews(app, db, rows, dispositions)).flags;
}

/** The current drift flags about a subject: those of the newest DONE DRIFT.TREND run that assessed it. */
async function driftFlags(app: AppContext, db: Db, subjectRef: string): Promise<FlagView[]> {
  const drift = await latestOutput(db, 'DRIFT', ['DRIFT.TREND'], subjectRef);
  return drift ? runFlags(app, db, drift.run_id, [subjectRef]) : [];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function envelopeOf(app: AppContext, o: OutputRow) {
  return {
    advisory: true as const,
    notForGmpDecisions: true as const,
    method: { id: o.method as AnalyticsMethodId, version: o.version },
    run: { id: o.run_id, dataAsOf: app.formatInstant(o.asof_us), finishedAt: app.formatInstant(o.finished_us) },
    dataAgeSeconds: o.age,
  };
}

function specificationOf(v: Values): SpcChartView['specification'] {
  return { lower: str(v['specLower']), upper: str(v['specUpper']), target: str(v['specTarget']), unit: str(v['unit']) ?? 'unit not stated' };
}

const subject = (q: { product: string; family: string; item: string }): string => `${q.product}|${q.family}|${q.item}`;

/** The control chart of an item (the newest of SPC.IMR and SPC.XBAR_S), or null when none was recorded. */
export async function chartView(app: AppContext, db: Db, q: { product: string; family: string; item: string }): Promise<SpcChartView | null> {
  const ref = subject(q);
  const o = await latestOutput(db, 'CONTROL_CHART', ['SPC.IMR', 'SPC.XBAR_S'], ref);
  if (!o) return null;
  const v = o.values;
  const ids = (str(v['batchIds']) ?? '').split(',').filter((x) => x !== '');
  const { rows: facts } = await db.query<{ batch_id: string; batch_number: string; completed_us: string | null }>(
    `select batch_id::text, batch_number, case when completed_at is null then null else ${usOf('completed_at')} end as completed_us
       from report.batch_fact_v1 where batch_id = any($1::uuid[])`,
    [ids],
  );
  const byId = new Map(facts.map((f) => [f.batch_id, f]));
  const imr = v['chart'] === 'IMR';
  const texts = imr ? (str(v['valueTexts']) ?? '').split(',') : [];
  const plotted = nums(v['plotted']);
  const spread = nums(v['spread']);
  const rules = (str(v['pointRules']) ?? '').split(',');
  const points = ids.flatMap((id, k) => {
    const f = byId.get(id);
    if (!f || f.completed_us === null) return [];
    return [{
      batchId: id,
      batchNumber: f.batch_number,
      completedAt: app.formatInstant(f.completed_us),
      value: imr ? (texts[k] ?? null) : null,
      plotted: plotted[k] ?? 0,
      // The moving range belongs to the second and later points; a subgroup has its own standard deviation.
      spread: imr ? (k === 0 ? null : (spread[k - 1] ?? null)) : (spread[k] ?? null),
      rules: (rules[k] ?? '').split(';').filter((r) => /^NELSON_[1235]$/.test(r)),
      drill: `/review/${id}`,
    }];
  });
  const flags = [...(await runFlags(app, db, o.run_id, [ref])), ...(await driftFlags(app, db, ref))];
  // Slice 6A-3 (D-6A-3-7): the reference set behind REFERENCE_SET limits, or the run's candidate of its Phase I limits.
  const { rows: runRows } = await db.query<{ reference_set: string | null }>('select reference_set::text from analytics.run_v1 where run_id = $1', [o.run_id]);
  const { rows: cand } = await db.query<{ output_id: string; values: Values }>(
    `select output_id::text, "values" from analytics.output_v1 where run_id = $1 and kind = 'MODEL_CANDIDATE' and subject_ref = $2 order by output_id limit 1`, [o.run_id, ref]);
  const c = cand[0];
  const candidateIds = c && Array.isArray(c.values['batchIds']) ? (c.values['batchIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    ...envelopeOf(app, o),
    product: q.product,
    family: q.family,
    item: q.item,
    chart: imr ? 'IMR' : 'XBAR_S',
    limitsSource: v['limitsSource'] === 'REFERENCE_SET' ? 'REFERENCE_SET' : 'PHASE_I',
    specification: specificationOf(v),
    centre: num(v['centre']),
    upperControl: num(v['upperControl']),
    lowerControl: num(v['lowerControl']),
    spreadChart: imr
      ? { kind: 'MR', centre: num(v['movingRangeMean']), upper: num(v['movingRangeUpper']), lower: 0 }
      : { kind: 'S', centre: num(v['sCentre']), upper: num(v['sUpper']), lower: num(v['sLower']) },
    points,
    flags,
    skipped: ids.length === points.length ? [] : [{ subject: ref, reason: `${(ids.length - points.length).toString()} charted batch(es) are no longer completed GMP batches and are not shown` }],
    referenceSet: runRows[0]?.reference_set ?? null,
    candidate: c && str(c.values['modelSha256']) && candidateIds.length > 0
      ? { outputId: c.output_id, modelSha256: str(c.values['modelSha256'])!, batches: candidateIds.length, batchIds: candidateIds }
      : null,
  };
}

/** The capability of an item (the newest CAP.INDEX output), or null. */
export async function capabilityView(app: AppContext, db: Db, q: { product: string; family: string; item: string }): Promise<CapabilityView | null> {
  const o = await latestOutput(db, 'CAPABILITY', ['CAP.INDEX'], subject(q));
  if (!o) return null;
  const v = o.values;
  const shown = v['status'] === 'SHOWN';
  const confidence = num(v['confidence']);
  const interval = (k: string) => ({ value: num(v[k]), lower: num(v[`${k}Lower`]), upper: num(v[`${k}Upper`]), confidence });
  return {
    ...envelopeOf(app, o),
    product: q.product,
    family: q.family,
    item: q.item,
    specification: specificationOf(v),
    batches: num(v['batches']),
    shown,
    notShownReason: shown ? null : (str(v['notShownReason']) ?? 'Capability is not shown'),
    cpk: shown ? interval('cpk') : null,
    ppk: shown ? interval('ppk') : null,
    normality: shown ? { andersonDarling: num(v['andersonDarling']), pValue: num(v['andersonDarlingP']), note: str(v['normalityNote']) ?? 'Anderson-Darling' } : null,
  };
}

/**
 * The deviation rates of a product by one grouping: the groups of the newest DONE RATE.DEVIATION run that compared the
 * product, or, with a period, of the newest run whose compared batches all completed within it (site-zone days). Null
 * when none was recorded.
 */
export async function ratesView(app: AppContext, db: Db, q: { product: string; by: RatesView['by']; from: string | null; to: string | null; zone: string }): Promise<RatesView | null> {
  const { rows } = await db.query<OutputRow & { from_day: string; to_day: string }>(
    `with c as (
       select o.*, ((o."values" ->> 'periodFrom')::timestamptz at time zone $5)::date as from_day, ((o."values" ->> 'periodTo')::timestamptz at time zone $5)::date as to_day
         from analytics.output_v1 o
        where o.kind = 'RATE_COMPARISON' and o.method = 'RATE.DEVIATION' and o.subject_kind = 'GROUP'
          and o."values" ->> 'product' = $1 and o."values" ->> 'grouping' = $2),
     r as (
       select c.run_id from c where ($3::date is null or c.from_day >= $3::date) and ($4::date is null or c.to_day <= $4::date)
        order by c.finished_at desc, c.run_id limit 1)
     select ${OUTPUT_COLUMNS}, o.from_day::text, o.to_day::text from c o where o.run_id = (select run_id from r)
      order by o."values" ->> 'group'`,
    [q.product, q.by, q.from, q.to, q.zone],
  );
  const first = rows[0];
  if (!first) return null;
  const v0 = first.values;
  const compared = rows.filter((r) => r.values['status'] === 'COMPARED');
  const confidence = num(v0['confidence']);
  return {
    ...envelopeOf(app, first),
    product: q.product,
    by: q.by,
    period: { from: first.from_day, to: first.to_day },
    overall: { batches: num(v0['overallBatches']), withDeviation: num(v0['overallWithDeviation']), share: num(v0['overallShare']), unattributedDeviations: num(v0['unattributedDeviations']) },
    groups: compared.map((r) => {
      const v = r.values;
      return {
        group: str(v['group']) ?? r.subject_ref,
        batches: num(v['batches']),
        withDeviation: num(v['withDeviation']),
        deviations: num(v['deviations']),
        share: { value: num(v['share']), lower: num(v['shareLower']), upper: num(v['shareUpper']), confidence },
        per100: { value: num(v['per100']), lower: num(v['per100Lower']), upper: num(v['per100Upper']), confidence },
        pValue: num(v['pValue']),
        qValue: num(v['qValue']),
        above: v['above'] === 'YES',
        funnel: { lower: num(v['funnelLower']), upper: num(v['funnelUpper']) },
      };
    }),
    flags: await runFlags(app, db, first.run_id, rows.map((r) => r.subject_ref)),
    skipped: rows.filter((r) => r.values['status'] !== 'COMPARED').map((r) => ({ subject: str(r.values['group']) ?? r.subject_ref, reason: str(r.values['notComparedReason']) ?? 'not compared' })),
  };
}
