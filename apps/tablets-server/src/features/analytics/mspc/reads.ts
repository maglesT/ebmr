/**
 * The reads of the multivariate monitoring screens (Phase 6A slice 6A-3; contract ns/analytics-mspc.ts; ADR 0020 point
 * 4; draft controls DI-51, DI-52). They read the recorded outputs of completed MSPC.PCA runs (analytics.output_v1), their
 * flags (analytics.flag_v1), the reference sets (analytics.reference_set_v1) and the batch facts (report.batch_fact_v1);
 * they compute no statistic. A recorded value comes back as the output holds it: the source's decimal text.
 *   chart       the newest scoring run of a product and family (a run against a reference set in force) with the
 *               model's variables, components and limits from the set's candidate.
 *   batch       the newest score of a batch, its contributions largest first (Q), and its flags.
 *   candidates  the newest model candidate of each product and family, with the reference set in force that carries its
 *               model (made from it, or from an earlier candidate of the same model), if any.
 */
import type pg from 'pg';
import type { AnalyticsMethodId, FlagView, ModelCandidateView, MspcBatchView, MspcCandidatesView, MspcChartView } from '@ebmr/api-contract';
import type { AppContext } from '../../../platform/context.ts';
import { usOf } from '../../common/people.ts';
import { dispositionsOf, flagViews, type FlagRow } from '../reads.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;
type Values = Record<string, unknown>;

interface OutputRow {
  output_id: string;
  run_id: string;
  method: string;
  version: number;
  reference_set: string | null;
  subject_ref: string;
  values: Values;
  reasons: { code: string; text: string; evidence?: { kind: string; ref: string }[] }[];
  asof_us: string;
  finished_us: string;
  age: number;
}

const OUTPUT_COLUMNS = `o.output_id::text, o.run_id::text, o.method, o.version, o.reference_set::text, o.subject_ref, o."values", o.reasons,
  ${usOf('o.data_as_of')} as asof_us, ${usOf('o.finished_at')} as finished_us,
  greatest(floor(extract(epoch from statement_timestamp() - o.data_as_of)), 0)::integer as age`;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const DECIMAL = /^-?\d+(\.\d+)?$/;

function envelopeOf(app: AppContext, o: OutputRow) {
  return {
    advisory: true as const,
    notForGmpDecisions: true as const,
    method: { id: o.method as AnalyticsMethodId, version: o.version },
    run: { id: o.run_id, dataAsOf: app.formatInstant(o.asof_us), finishedAt: app.formatInstant(o.finished_us) },
    dataAgeSeconds: o.age,
  };
}

/** The flags a run raised about the given subjects. */
async function runFlags(app: AppContext, db: Db, runId: string, subjectRefs: readonly string[]): Promise<FlagView[]> {
  if (subjectRefs.length === 0) return [];
  const { rows } = await db.query<FlagRow>(
    `select f.flag_id::text, f.run_id::text, f.method, f.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
            ${usOf('f.raised_at')} as raised_us, ${usOf('f.data_as_of')} as asof_us, ${usOf('f.finished_at')} as finished_us, false as restricted
       from analytics.flag_v1 f where f.run_id = $1 and f.subject_ref = any($2::text[]) order by f.subject_ref, f.rule, f.flag_id`,
    [runId, subjectRefs],
  );
  return (await flagViews(app, db, rows, await dispositionsOf(db, rows))).flags;
}

/** The model a scoring run used: its reference set's candidate output (variables, components, limits). */
async function candidateOf(db: Db, referenceSet: string): Promise<Values | null> {
  const { rows } = await db.query<{ values: Values }>(
    `select o."values" from analytics.reference_set_v1 s join analytics.output_v1 o on o.output_id = s.candidate_output
      where s.reference_set_id = $1 order by s.valid_from limit 1`,
    [referenceSet],
  );
  return rows[0]?.values ?? null;
}

const limitsOf = (v: Values): MspcChartView['limits'] => ({
  t2: num(v['t2New']), q: num(v['qLimit']), confidence: num(v['confidence']), t2Reference: num(v['t2Reference']),
  ...(v['qMethod'] === 'JACKSON_MUDHOLKAR' || v['qMethod'] === 'BOX' ? { qMethod: v['qMethod'] } : {}),
});

/** The batch facts (number, completion) of the given batches. */
async function factsOf(db: Db, ids: readonly string[]): Promise<Map<string, { batch_number: string; completed_us: string | null }>> {
  const { rows } = await db.query<{ batch_id: string; batch_number: string; completed_us: string | null }>(
    `select batch_id::text, batch_number, case when completed_at is null then null else ${usOf('completed_at')} end as completed_us
       from report.batch_fact_v1 where batch_id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.batch_id, r]));
}

/** The T-squared and Q chart of a product and family: the newest scoring run's batches, or null when none was recorded. */
export async function mspcChartView(app: AppContext, db: Db, q: { product: string; family: string }): Promise<MspcChartView | null> {
  const { rows } = await db.query<OutputRow>(
    `with s as (
       select o.* from analytics.output_v1 o
        where o.method = 'MSPC.PCA' and o.kind = 'MSPC_SCORE' and o.subject_kind = 'BATCH' and o.reference_set is not null
          and o."values" ->> 'product' = $1 and o."values" ->> 'family' = $2),
     r as (select s.run_id from s order by s.finished_at desc, s.run_id limit 1)
     select ${OUTPUT_COLUMNS} from s o where o.run_id = (select run_id from r)
      order by o."values" ->> 'completedAt', o.subject_ref`,
    [q.product, q.family],
  );
  const first = rows[0];
  if (!first || first.reference_set === null) return null;
  const cand = (await candidateOf(db, first.reference_set)) ?? {};
  const facts = await factsOf(db, rows.map((r) => r.subject_ref));
  const shown = rows.filter((r) => facts.get(r.subject_ref)?.completed_us);
  return {
    ...envelopeOf(app, first),
    product: q.product,
    family: q.family,
    referenceSet: first.reference_set,
    components: Math.max(1, num(cand['components'])),
    explainedVariance: nums(cand['explainedVariance']),
    variables: strs(first.values['variables']),
    limits: limitsOf(cand),
    batches: shown.map((r) => {
      const f = facts.get(r.subject_ref)!;
      return {
        batchId: r.subject_ref,
        batchNumber: f.batch_number,
        reference: r.values['reference'] === 'REFERENCE',
        t2: num(r.values['t2']),
        q: num(r.values['q']),
        scores: nums(r.values['scores']),
        flagged: strs(r.values['flagged']).length > 0,
        drill: `/analytics/mspc/batches/${r.subject_ref}`,
        completedAt: app.formatInstant(f.completed_us!),
        t2Limit: num(r.values['t2Limit']),
      };
    }),
    flags: await runFlags(app, db, first.run_id, rows.map((r) => r.subject_ref)),
    skipped: rows.length === shown.length ? [] : [{ subject: `${q.product}|${q.family}`, reason: `${(rows.length - shown.length).toString()} scored batch(es) are no longer completed GMP batches and are not shown` }],
  };
}

/** A batch's newest score with its contributions (largest Q contribution first), or null. */
export async function mspcBatchView(app: AppContext, db: Db, batchId: string): Promise<MspcBatchView | null> {
  const { rows } = await db.query<OutputRow>(
    `select ${OUTPUT_COLUMNS} from analytics.output_v1 o
      where o.method = 'MSPC.PCA' and o.kind = 'MSPC_SCORE' and o.subject_kind = 'BATCH' and o.subject_ref = $1 and o.reference_set is not null
      order by o.finished_at desc, o.recorded_at desc, o.output_id limit 1`,
    [batchId],
  );
  const o = rows[0];
  if (!o || o.reference_set === null) return null;
  const v = o.values;
  const cand = (await candidateOf(db, o.reference_set)) ?? {};
  const variables = strs(v['variables']);
  const texts = Array.isArray(v['valueTexts']) ? (v['valueTexts'] as unknown[]).map((x) => (typeof x === 'string' ? x : '')) : [];
  const t2c = nums(v['t2Contributions']);
  const qc = nums(v['qContributions']);
  const contributions = variables.map((variable, j) => {
    const readings = (texts[j] ?? '').split(';').filter((x) => DECIMAL.test(x));
    return {
      variable,
      value: readings.length === 1 ? readings[0]! : null,
      ...(readings.length > 1 ? { readings } : {}),
      t2: t2c[j] ?? 0,
      q: qc[j] ?? 0,
    };
  }).sort((a, b) => b.q - a.q || (a.variable < b.variable ? -1 : 1));
  const facts = await factsOf(db, [batchId]);
  return {
    ...envelopeOf(app, o),
    batchId,
    batchNumber: facts.get(batchId)?.batch_number ?? str(v['batchNumber']) ?? batchId,
    t2: num(v['t2']),
    q: num(v['q']),
    limits: limitsOf(cand),
    contributions,
    flags: await runFlags(app, db, o.run_id, [batchId]),
    drill: facts.has(batchId) ? `/review/${batchId}` : null,
    product: str(v['product']) ?? '-',
    family: str(v['family']) ?? '-',
    referenceSet: o.reference_set,
    reference: v['reference'] === 'REFERENCE',
  };
}

const LEFT_OUT = new Set(['NOT_REFERENCE', 'NOT_REFERENCE_MORE', 'MISSING_VARIABLE', 'BEYOND_PHASE_I', 'OLDER', 'VARIABLE_LEFT_OUT']);

/** The newest model candidate of each product and family, with the reference set in force made from it, if any. */
export async function mspcCandidatesView(app: AppContext, db: Db): Promise<MspcCandidatesView> {
  const { rows } = await db.query<OutputRow & { reference_set_id: string | null }>(
    `select ${OUTPUT_COLUMNS},
            (select s.reference_set_id::text from analytics.reference_set_v1 s
              where s.method = 'MSPC.PCA' and s.status = 'EFFECTIVE' and s.valid_to is null
                and (s.candidate_output = o.output_id or s.model_sha256 = o."values" ->> 'modelSha256')
              order by s.valid_from desc limit 1) as reference_set_id
       from (select distinct on (o.subject_ref) o.* from analytics.output_v1 o
              where o.method = 'MSPC.PCA' and o.kind = 'MODEL_CANDIDATE' and o.subject_kind = 'PRODUCT_ITEM'
              order by o.subject_ref, o.finished_at desc, o.recorded_at desc, o.output_id) o
      order by o.subject_ref`,
  );
  const candidates: ModelCandidateView[] = rows.map((r) => {
    const v = r.values;
    return {
      outputId: r.output_id,
      run: { id: r.run_id, dataAsOf: app.formatInstant(r.asof_us), finishedAt: app.formatInstant(r.finished_us) },
      product: str(v['product']) ?? r.subject_ref.split('|')[0]!,
      family: str(v['family']) ?? r.subject_ref.split('|')[1] ?? '-',
      batches: num(v['batches']),
      components: Math.max(1, num(v['components'])),
      modelSha256: str(v['modelSha256']) ?? '0'.repeat(64),
      fittedAt: app.formatInstant(r.finished_us),
      referenceSet: r.reference_set_id,
      skipped: r.reasons.filter((x) => LEFT_OUT.has(x.code)).map((x) => ({ subject: x.evidence?.[0]?.ref ?? r.subject_ref, reason: x.text })),
      batchIds: strs(v['batchIds']),
      batchNumbers: strs(v['batchNumbers']),
      variables: strs(v['variables']),
      explainedVariance: nums(v['explainedVariance']),
      limits: limitsOf(v),
      referenceT2: nums(v['referenceT2']),
      referenceQ: nums(v['referenceQ']),
    };
  });
  return { advisory: true, notForGmpDecisions: true, method: null, run: null, dataAgeSeconds: rows.length === 0 ? 0 : Math.min(...rows.map((r) => r.age)), candidates };
}
