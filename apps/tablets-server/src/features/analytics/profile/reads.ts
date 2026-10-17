/**
 * The golden batch profile's reads (Phase 6A slice 6A-6; contract ns/analytics-profile.ts; recipe-core 1170; kernel
 * 1243, 1245; D-6A-6-1 to D-6A-6-8). As the application role: the profile outputs, the model candidates and the flags
 * from the analytics.*_v1 views, the step's series reference from report.series_ref_v1 and its samples, exactly as
 * received, from report.series_samples_v1 (DI-32). Every statistic is the database's double precision as a JSON number
 * (StatNumber); the samples' raw text, shown decimal and status code are repeated unchanged; every instant is the
 * database's.
 */
import type pg from 'pg';
import type { ProfileCandidatesView, ProfileSampleView, ProfileView } from '@ebmr/api-contract';
import type { AppContext } from '../../../platform/context.ts';
import { refusal } from '../../../platform/http/refusal.ts';
import { usOf } from '../../common/people.ts';
import { dispositionsOf, envelope, flagViews, type FlagRow } from '../reads.ts';

type Db = Pick<pg.Pool | pg.PoolClient, 'query'>;
type Json = Record<string, unknown>;

const METHOD = 'GBP.DTW_BAND';

const noSeries = (step: string, tag: string) =>
  refusal(404, {
    code: 'EBMR-ANA-060', kind: 'INVALID_INPUT', whatHappened: 'There is no golden profile for this step and tag.',
    why: `The batch has no equipment series of ${tag} in step ${step}: the profile covers connected equipment only.`,
    whatYouCanDo: ['Choose a step that ran on connected equipment, and one of its tags (the trend viewer lists them).'], whoCanHelp: ['QA'], controls: ['DI-52'],
  });

const noProfile = (step: string, tag: string) =>
  refusal(404, {
    code: 'EBMR-ANA-061', kind: 'INVALID_INPUT', whatHappened: 'There is no golden profile for this step and tag yet.',
    why: `No profile run has scored ${tag} in step ${step} of this batch: no reference set of this step and tag is in force, or the runner has not run since.`,
    whatYouCanDo: ['Look at the profile candidates; QA makes one a reference set under a change record.', 'Try again after the next analytics run.'],
    whoCanHelp: ['QA'], controls: ['DI-52'],
  });

const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v !== '' ? v : fallback);

const FLAG_COLUMNS = `f.flag_id::text, f.run_id::text, f.method, f.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons,
  ${usOf('f.raised_at')} as raised_us, ${usOf('f.data_as_of')} as asof_us, ${usOf('f.finished_at')} as finished_us, false as restricted`;

interface OutputRow {
  output_id: string; run_id: string; version: number; reference_set: string | null; values: Json; asof_us: string; finished_us: string; age: number;
}

/** The latest profile of a batch's step and tag against the golden band, with the raw samples and the flags. */
export async function profileOf(app: AppContext, db: Db, batchId: string, step: string, tag: string): Promise<ProfileView> {
  const { rows: refs } = await db.query<{ batch_number: string; equipment_code: string; equipment_type: string; unit: string; chunk_ids: string[] }>(
    `select batch_number, equipment_code, equipment_type, unit, chunk_ids::text[] as chunk_ids from report.series_ref_v1
      where batch_id = $1 and step = $2 and tag = $3 order by equipment_code, unit`,
    [batchId, step, tag],
  );
  if (refs.length === 0) throw noSeries(step, tag);
  const { rows: outs } = await db.query<OutputRow>(
    `select output_id::text, run_id::text, version, reference_set::text, "values", ${usOf('data_as_of')} as asof_us, ${usOf('finished_at')} as finished_us,
            greatest(floor(extract(epoch from statement_timestamp() - data_as_of)), 0)::integer as age
       from analytics.output_v1
      where method = $4 and kind = 'PROFILE_DISTANCE' and subject_kind = 'BATCH' and subject_ref = $1::text
        and "values" ->> 'step' = $2 and "values" ->> 'tag' = $3 and reference_set is not null
      order by finished_at desc, recorded_at desc limit 1`,
    [batchId, step, tag, METHOD],
  );
  const out = outs[0];
  if (!out) throw noProfile(step, tag);
  const v = out.values;
  const { rows: models } = await db.query<{ model: Json }>(
    `select o."values" -> 'model' as model from analytics.reference_set_v1 s join analytics.output_v1 o on o.output_id = s.candidate_output
      where s.reference_set_id = $1 order by s.valid_from limit 1`,
    [out.reference_set],
  );
  const model = models[0]?.model ?? {};
  const equipmentCode = str(v['equipmentCode'], refs[0]!.equipment_code);
  const ref = refs.find((r) => r.equipment_code === equipmentCode) ?? refs[0]!;
  const profiled = v['status'] === 'PROFILED';
  const startUs = profiled && typeof v['startUs'] === 'string' ? v['startUs'] : null;
  const endUs = profiled && typeof v['endUs'] === 'string' ? v['endUs'] : null;
  const { rows: samples } = await db.query<{ source_us: string; raw_text: string; value_text: string | null; status_code: string; status: ProfileSampleView['quality']; at: number | null }>(
    `select s.source_us, s.raw_text, s.value_text, s.status_code, s.status,
            case when $4::text is null or $5::text is null or s.status = 'BAD' or s.value_text is null
                      or s.source_us::numeric < $4::numeric or s.source_us::numeric > $5::numeric or $5::numeric = $4::numeric then null
                 else ((s.source_us::numeric - $4::numeric) / ($5::numeric - $4::numeric))::float8 end as at
       from report.series_samples_v1($1, $2, $3) s
      where s.chunk_id = any($6::uuid[])
      order by s.source_us::numeric, s.chunk_no`,
    [batchId, step, tag, startUs, endUs, ref.chunk_ids],
  );
  const { rows: flagRows } = await db.query<FlagRow>(
    `select ${FLAG_COLUMNS} from analytics.flag_v1 f where f.run_id = $1 and f.subject_kind = 'BATCH' and f.subject_ref = $2::text order by f.raised_at, f.flag_id`,
    [out.run_id, batchId],
  );
  const { flags } = await flagViews(app, db, flagRows, await dispositionsOf(db, flagRows));
  return {
    ...envelope(out.age),
    method: { id: METHOD, version: out.version },
    run: { id: out.run_id, dataAsOf: app.formatInstant(out.asof_us), finishedAt: app.formatInstant(out.finished_us) },
    batchId,
    batchNumber: ref.batch_number,
    step,
    tag,
    equipmentType: ref.equipment_type,
    equipmentCode,
    unit: str(v['unit'], ref.unit),
    status: profiled ? 'PROFILED' : 'NOT_ASSESSED',
    why: profiled ? null : str(v['why'], 'the curve was not assessed'),
    referenceSet: out.reference_set!,
    referenceBatches: Array.isArray(model['batchIds']) ? model['batchIds'].length : 0,
    points: numbers(model['reference']).length || count(v['points']) || 1,
    band: { low: numbers(model['low']), high: numbers(model['high']), reference: numbers(model['reference']) },
    curve: profiled ? numbers(v['curve']) : [],
    outsideShare: profiled ? num(v['outsideShare']) : null,
    outsidePoints: count(v['outsidePoints']),
    distance: profiled ? num(v['distance']) : null,
    distanceLimit: num(model['distanceLimit']) ?? num(v['distanceLimit']) ?? 0,
    used: count(v['used']),
    droppedBad: count(v['droppedBad']),
    uncertain: count(v['uncertain']),
    samples: samples.map((s) => ({ sourceUs: s.source_us, raw: s.raw_text, value: s.value_text, statusCode: s.status_code, quality: s.status, at: s.at })),
    flags,
  };
}

/** The latest model candidate of each scope, and every candidate a reference set in force was made from. */
export async function candidatesOf(app: AppContext, db: Db): Promise<ProfileCandidatesView> {
  const { rows: sets } = await db.query<{ id: string; candidate: string }>(
    `select reference_set_id::text as id, candidate_output::text as candidate from analytics.reference_set_v1
      where method = $1 and status = 'EFFECTIVE' and valid_from <= statement_timestamp() and (valid_to is null or valid_to > statement_timestamp())`,
    [METHOD],
  );
  const inForce = new Map(sets.map((s) => [s.candidate, s.id]));
  const { rows } = await db.query<{ output_id: string; run_id: string; values: Json; reasons: { code: string; text: string; evidence?: { kind: string; ref: string }[] }[];
                                    asof_us: string; finished_us: string; age: number }>(
    `with c as (
       select o.*, row_number() over (partition by o.subject_ref order by o.finished_at desc, o.recorded_at desc) as n
         from analytics.output_v1 o where o.method = $1 and o.kind = 'MODEL_CANDIDATE')
     select output_id::text, run_id::text, "values", reasons, ${usOf('data_as_of')} as asof_us, ${usOf('finished_at')} as finished_us,
            greatest(floor(extract(epoch from statement_timestamp() - data_as_of)), 0)::integer as age
       from c where n = 1 or output_id = any($2::uuid[])
      order by subject_ref, finished_at desc`,
    [METHOD, [...inForce.keys()]],
  );
  return {
    ...envelope(rows.reduce((a, r) => Math.max(a, r.age), 0)),
    candidates: rows.map((r) => {
      const v = r.values;
      return {
        outputId: r.output_id,
        run: { id: r.run_id, dataAsOf: app.formatInstant(r.asof_us), finishedAt: app.formatInstant(r.finished_us) },
        productCode: str(v['productCode'], '-'), familyCode: str(v['familyCode'], '-'), equipmentType: str(v['equipmentType'], '-'), step: str(v['step'], '-'),
        tag: str(v['tag'], '-'), unit: str(v['unit'], '-'),
        batches: count(v['batches']),
        batchIds: Array.isArray(v['batchIds']) ? v['batchIds'].filter((x): x is string => typeof x === 'string') : [],
        medoidBatchId: str(v['medoidBatchId']),
        modelSha256: str(v['modelSha256']),
        distanceLimit: num(v['distanceLimit']) ?? 0,
        fittedAt: app.formatInstant(r.finished_us),
        referenceSet: inForce.get(r.output_id) ?? null,
        skipped: r.reasons.filter((x) => x.code === 'NOT_REFERENCE' || x.code === 'NOT_ASSESSED').map((x) => ({ subject: x.evidence?.[0]?.ref ?? '-', reason: x.text })),
      };
    }),
  };
}
