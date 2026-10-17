/**
 * The runner's implementation of GBP.DTW_BAND, the golden batch profile (slice 6A-6; D-6A-16, D-6A-6-1 to D-6A-6-8).
 * It reads the series references of the latest 50 curves of each scope whose window on the unit has ended
 * (report.series_ref_v1, column recency), the native
 * samples of each (report.series_samples_v1, called once per batch, step and tag) and, for a run against a reference
 * set, that set in force (report.analytics_reference_v1, recipe-core 1170). It narrows a reference set's run to the
 * set's scope. A sample belongs to the unit whose chunk holds it (the reference row's chunk ids), so a step that ran on
 * two units gives two curves. GMP values stay decimal text here; the method converts them with statOf.
 */
import {
  GBP_DTW_BAND,
  canonicalText,
  type GbpParameters,
  type ProfileCurve,
  type ProfileInput,
  type ProfileSample,
  type SampleStatus,
} from '@ebmr/analytics';
import type { InputRow, InputSpec, MethodImplementation, ReferenceRow } from './method-types.ts';

const REF = 'report.series_ref_v1';
const SAMPLES = 'report.series_samples_v1(uuid,text,text)';
const REFERENCES: InputSpec = { view: 'report.analytics_reference_v1', version: 1, filter: { method: 'GBP.DTW_BAND' } };

/**
 * The latest curves of each scope a run reads (D-6A-6-12): the candidate is fitted on the reference batches among
 * them, and a scoring run scores them; an older batch keeps the profile it was given.
 */
export const RECENT_CURVES = 50;
const refInput = (filter: Readonly<Record<string, string | number | boolean>>): InputSpec => ({
  view: REF, version: 1, filter: { ended: true, ...filter }, atMost: { recency: RECENT_CURVES },
});
const samplesInput: InputSpec = { view: SAMPLES, version: 1, filter: null, call: { from: REF, args: ['batch_id', 'step', 'tag'] } };

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');
const orDash = (v: unknown): string => text(v) || '-';
const STATUSES: readonly SampleStatus[] = ['GOOD', 'UNCERTAIN', 'BAD'];
const statusOf = (v: unknown): SampleStatus => (STATUSES.includes(v as SampleStatus) ? (v as SampleStatus) : 'BAD');

/** PostgreSQL array text ({a,b}) or a parsed array, as strings. */
function texts(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(text);
  if (typeof v === 'string' && /^\{.*\}$/.test(v)) return v.slice(1, -1).split(',').filter((x) => x !== '');
  return [];
}

/** Why a batch may not be a reference batch of its step (D-6A-6-2), or null when it may. */
function notReference(r: InputRow): string | null {
  const why: string[] = [];
  if (r['released'] !== true) why.push('not released');
  const deviations = typeof r['deviations'] === 'number' ? r['deviations'] : 0;
  const alarms = typeof r['alarms'] === 'number' ? r['alarms'] : 0;
  if (deviations > 0) why.push(`${deviations} deviation(s) linked to the batch`);
  if (alarms > 0) why.push(`${alarms} alarm(s) on the step`);
  return why.length > 0 ? why.join('; ') : null;
}

/** The method's input from the canonical rows: one curve per series reference row, with its own unit's samples. */
export function assembleProfile(rows: Readonly<Record<string, readonly InputRow[]>>): ProfileInput {
  const samples = new Map<string, InputRow[]>();
  for (const s of rows[SAMPLES] ?? []) {
    const key = `${text(s['batch_id'])}|${text(s['step'])}|${text(s['tag'])}`;
    const list = samples.get(key) ?? [];
    list.push(s);
    samples.set(key, list);
  }
  const curves: ProfileCurve[] = (rows[REF] ?? []).map((r) => {
    const chunks = new Set(texts(r['chunk_ids']));
    const own = (samples.get(`${text(r['batch_id'])}|${text(r['step'])}|${text(r['tag'])}`) ?? []).filter((s) => chunks.has(text(s['chunk_id'])));
    const points: ProfileSample[] = own.map((s) => ({ sourceUs: text(s['source_us']), value: s['value_text'] === null || s['value_text'] === undefined ? null : text(s['value_text']), status: statusOf(s['status']) }));
    return {
      batchId: text(r['batch_id']), batchNumber: text(r['batch_number']), productCode: orDash(r['product_code']), familyCode: orDash(r['family_code']),
      equipmentType: text(r['equipment_type']), equipmentCode: text(r['equipment_code']), step: text(r['step']), tag: text(r['tag']), unit: text(r['unit']),
      ended: r['ended'] === true, notReference: notReference(r), samples: points,
    };
  });
  return { curves };
}

/** The scope of a reference set's model as input filters (empty when the model names none). */
function scopeFilter(ref: ReferenceRow): Record<string, string> {
  const scope = (ref.model['scope'] ?? {}) as Record<string, unknown>;
  const pairs: [string, unknown][] = [
    ['product_code', scope['productCode']], ['family_code', scope['familyCode']], ['equipment_type', scope['equipmentType']], ['step', scope['step']], ['tag', scope['tag']],
  ];
  return Object.fromEntries(pairs.filter(([, v]) => typeof v === 'string' && v !== '' && v !== '-')) as Record<string, string>;
}

const PROFILE: MethodImplementation<ProfileInput, GbpParameters> = {
  id: 'GBP.DTW_BAND',
  versions: [1],
  inputs: [refInput({}), samplesInput],
  assemble: (rows) => assembleProfile(rows),
  method: GBP_DTW_BAND,
  references: REFERENCES,
  inputsFor: (ref) => [refInput(scopeFilter(ref)), samplesInput],
  referenceProblems: (ref) => {
    const problems: string[] = [];
    const modelBatches = Array.isArray(ref.model['batchIds']) ? (ref.model['batchIds'] as unknown[]).map(text).sort() : [];
    if (canonicalText([...ref.batchIds].sort()) !== canonicalText(modelBatches)) problems.push("its batches are not its model's reference batches");
    const scope = (ref.model['scope'] ?? {}) as Record<string, unknown>;
    const given = ['productCode', 'familyCode', 'equipmentType', 'step', 'tag'].filter((k) => k in ref.scope);
    if (given.some((k) => text(ref.scope[k]) !== text(scope[k]))) problems.push("its scope is not its model's");
    return problems;
  },
};

/** GBP.DTW_BAND as the runner holds it (IMPLEMENTATIONS). */
export const GOLDEN_PROFILE: MethodImplementation = PROFILE;
