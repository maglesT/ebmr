/**
 * The method registry (interfaces slice-6A-0-interfaces.md sections 1 and 4): one entry per method id with its slice,
 * input kind and input views, output kinds, flag rules, parameter schema with the plan's defaults (D-6A-7 to D-6A-16)
 * and `changesGmpData: false` (PR-60: no analytics output changes GMP data). The catalogue route (analytics.catalog)
 * lists this registry; a method version row (analytics.method_version) holds its parameters.
 */
import type { MethodId, ParameterValue, Parameters } from './method.ts';
import type { OutputKind } from './types.ts';

/** What a method reads, as the runner assembles it from the input views. */
export type InputKind = 'BATCH_VALUE' | 'SUBGROUP_VALUES' | 'DEVIATION_GROUPS' | 'BATCH_VECTOR' | 'AUDIT_EVENTS' | 'REVIEW_FACTS' | 'SERIES_PROFILE';

export type ParameterSpec =
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly default: number; readonly note: string }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number; readonly default: number; readonly note: string }
  | { readonly kind: 'choices'; readonly choices: readonly string[]; readonly default: readonly string[]; readonly note: string }
  | { readonly kind: 'weights'; readonly terms: readonly string[]; readonly default: Readonly<Record<string, number>>; readonly note: string };

export interface MethodEntry {
  readonly id: MethodId;
  readonly title: string;
  readonly intendedUse: string;
  /** The slice that builds it (its folder is packages/analytics/src/methods/<family>/). */
  readonly slice: '6A-2' | '6A-3' | '6A-4' | '6A-5' | '6A-6';
  readonly family: 'spc' | 'capability' | 'drift' | 'rates' | 'mspc' | 'audit' | 'review' | 'profile';
  readonly inputKind: InputKind;
  /** The catalogued inputs it reads (analytics.input_catalog_v1 names). */
  readonly inputs: readonly string[];
  readonly reference: 'NONE' | 'OPTIONAL' | 'REQUIRED';
  readonly outputKinds: readonly OutputKind[];
  readonly flagRules: readonly string[];
  readonly parameters: Readonly<Record<string, ParameterSpec>>;
  /** Always false (PR-60): an analytics output never changes GMP data. */
  readonly changesGmpData: false;
}

const NELSON = ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'] as const;
const spcParameters = {
  rules: { kind: 'choices', choices: NELSON, default: NELSON, note: 'Nelson rules 1, 2, 3 and 5 only, to keep false alarms low (D-6A-7)' },
  phaseOneBatches: { kind: 'integer', min: 10, max: 100, default: 20, note: 'Phase I limits from the first 20 batches when no reference set is effective (D-6A-7)' },
} as const satisfies Record<string, ParameterSpec>;

export const METHODS: Readonly<Record<MethodId, MethodEntry>> = {
  'SPC.IMR': {
    id: 'SPC.IMR',
    title: 'Individuals and moving-range chart',
    intendedUse: 'Trend one critical value per batch against control limits and flag run-rule hits for QA attention (advisory; CPV support)',
    slice: '6A-2',
    family: 'spc',
    inputKind: 'BATCH_VALUE',
    inputs: ['report.cpp_value_v1', 'report.batch_fact_v1'],
    reference: 'OPTIONAL',
    outputKinds: ['CONTROL_CHART'],
    flagRules: NELSON,
    parameters: spcParameters,
    changesGmpData: false,
  },
  'SPC.XBAR_S': {
    id: 'SPC.XBAR_S',
    title: 'Mean and standard-deviation chart',
    intendedUse: 'Trend subgrouped in-process readings (two or more per batch) against control limits and flag run-rule hits (advisory)',
    slice: '6A-2',
    family: 'spc',
    inputKind: 'SUBGROUP_VALUES',
    inputs: ['report.cpp_value_v1', 'report.batch_fact_v1'],
    reference: 'OPTIONAL',
    outputKinds: ['CONTROL_CHART'],
    flagRules: NELSON,
    parameters: { ...spcParameters, minSubgroup: { kind: 'integer', min: 2, max: 50, default: 2, note: 'Xbar-S needs two or more readings per batch (D-6A-7)' } },
    changesGmpData: false,
  },
  'CAP.INDEX': {
    id: 'CAP.INDEX',
    title: 'Process capability (Cpk, Ppk)',
    intendedUse: 'Show Cpk and Ppk with 95 % intervals against the specification limits, with a normality note; shown, never flagged (advisory)',
    slice: '6A-2',
    family: 'capability',
    inputKind: 'BATCH_VALUE',
    inputs: ['report.cpp_value_v1', 'report.batch_fact_v1'],
    reference: 'NONE',
    outputKinds: ['CAPABILITY'],
    flagRules: [],
    parameters: {
      minBatches: { kind: 'integer', min: 25, max: 1000, default: 25, note: 'capability is shown from 25 batches (D-6A-8)' },
      confidence: { kind: 'number', min: 0.8, max: 0.999, default: 0.95, note: '95 % intervals (Bissell; D-6A-8)' },
    },
    changesGmpData: false,
  },
  'DRIFT.TREND': {
    id: 'DRIFT.TREND',
    title: 'Drift alert (slope projection and EWMA)',
    intendedUse: 'Warn before a critical value drifts out of its specification: a significant slope projected to cross a limit, or an EWMA signal (advisory)',
    slice: '6A-2',
    family: 'drift',
    inputKind: 'BATCH_VALUE',
    inputs: ['report.cpp_value_v1', 'report.batch_fact_v1'],
    reference: 'NONE',
    outputKinds: ['DRIFT'],
    flagRules: ['DRIFT_SLOPE', 'DRIFT_EWMA'],
    parameters: {
      slopeWindow: { kind: 'integer', min: 5, max: 50, default: 10, note: 'the last 10 batches (D-6A-9)' },
      slopeAlpha: { kind: 'number', min: 0.001, max: 0.2, default: 0.05, note: 'a slope significant at p < 0.05 (D-6A-9)' },
      projectBatches: { kind: 'integer', min: 1, max: 20, default: 5, note: 'projected to cross a limit within 5 batches (D-6A-9)' },
      ewmaLambda: { kind: 'number', min: 0.05, max: 1, default: 0.2, note: 'EWMA lambda 0.2 (D-6A-9)' },
      ewmaL: { kind: 'number', min: 1, max: 4, default: 2.7, note: 'EWMA limit L 2.7 (D-6A-9)' },
    },
    changesGmpData: false,
  },
  'RATE.DEVIATION': {
    id: 'RATE.DEVIATION',
    title: 'Deviation-rate comparison',
    intendedUse: 'Compare the deviation rate of each step, equipment, room, supplier lot and shift with the rest, with intervals and false-discovery control (advisory)',
    slice: '6A-2',
    family: 'rates',
    inputKind: 'DEVIATION_GROUPS',
    inputs: ['report.deviation_fact_v1', 'report.step_use_v1', 'report.step_shift_v1', 'report.batch_fact_v1'],
    reference: 'NONE',
    outputKinds: ['RATE_COMPARISON'],
    flagRules: ['RATE_ABOVE'],
    parameters: {
      groupings: {
        kind: 'choices',
        choices: ['STEP', 'EQUIPMENT', 'ROOM', 'MATERIAL_LOT', 'SUPPLIER', 'SHIFT'],
        default: ['STEP', 'EQUIPMENT', 'ROOM', 'MATERIAL_LOT', 'SUPPLIER', 'SHIFT'],
        note: 'the groups compared (D-6A-10)',
      },
      minBatchesPerGroup: { kind: 'integer', min: 2, max: 100, default: 5, note: 'a group needs at least 5 batches (D-6A-10)' },
      falseDiscoveryRate: { kind: 'number', min: 0.01, max: 0.25, default: 0.1, note: 'Benjamini-Hochberg at 10 % (D-6A-10)' },
      confidence: { kind: 'number', min: 0.8, max: 0.999, default: 0.95, note: 'Wilson and Garwood 95 % intervals' },
    },
    changesGmpData: false,
  },
  'MSPC.PCA': {
    id: 'MSPC.PCA',
    title: 'Multivariate monitoring (PCA, Hotelling T-squared, Q residuals)',
    intendedUse: 'Show batches whose combination of critical values departs from the approved reference batches, with the contributing variables (advisory)',
    slice: '6A-3',
    family: 'mspc',
    inputKind: 'BATCH_VECTOR',
    inputs: ['report.cpp_value_v1', 'report.batch_fact_v1'],
    reference: 'REQUIRED',
    outputKinds: ['MODEL_CANDIDATE', 'MSPC_SCORE'],
    flagRules: ['T2_ABOVE', 'Q_ABOVE'],
    parameters: {
      maxComponents: { kind: 'integer', min: 1, max: 10, default: 5, note: 'at most 5 components (D-6A-11)' },
      varianceTarget: { kind: 'number', min: 0.5, max: 0.99, default: 0.9, note: 'components to 90 % cumulative variance (D-6A-11)' },
      limitConfidence: { kind: 'number', min: 0.9, max: 0.999, default: 0.99, note: 'T-squared and Q limits at 99 % (D-6A-11)' },
      minReferenceBatches: { kind: 'integer', min: 15, max: 500, default: 15, note: 'at least 15 reference batches chosen by QA (D-6A-11)' },
    },
    changesGmpData: false,
  },
  'ATA.RULES': {
    id: 'ATA.RULES',
    title: 'Audit-trail anomaly rules',
    intendedUse: 'Point QA data-integrity review at audit-trail patterns worth a look, with the entries behind each; never an automatic finding (advisory; DI-53)',
    slice: '6A-4',
    family: 'audit',
    inputKind: 'AUDIT_EVENTS',
    inputs: ['report.audit_fact_v1', 'report.auth_fact_v1', 'report.manual_digit_v1'],
    reference: 'NONE',
    outputKinds: ['AUDIT_RULE_HIT'],
    flagRules: ['LATE_ENTRY', 'BACK_DATED', 'CORRECTIONS_HIGH', 'TWO_TERMINALS', 'TOO_REGULAR', 'REPEAT_UNTIL_PASS', 'OFF_HOURS_CONFIG'],
    parameters: {
      lateEntryMinutes: { kind: 'integer', min: 1, max: 1440, default: 15, note: 'recorded more than 15 minutes after its claimed or source time' },
      backDatedMinutes: { kind: 'integer', min: 0, max: 120, default: 2, note: "claims a time more than 2 minutes before the step's previous entry (device clocks and keying order differ by less; D-6A-4-3)" },
      correctionsPercentile: { kind: 'number', min: 0.5, max: 0.999, default: 0.95, note: "corrections per person and week above the site's 95th percentile" },
      correctionsMinPersonWeeks: { kind: 'integer', min: 5, max: 10000, default: 20, note: "the site's percentile needs at least 20 active person-weeks (D-6A-4-4)" },
      twoTerminalsMinutes: { kind: 'integer', min: 1, max: 60, default: 2, note: 'one account on two terminals within 2 minutes' },
      digitTestMinEntries: { kind: 'integer', min: 20, max: 1000, default: 50, note: 'terminal-digit test over at least 50 manual entries' },
      digitTestAlpha: { kind: 'number', min: 0.0001, max: 0.1, default: 0.01, note: 'chi-square significance of the terminal-digit test' },
      repeatFailures: { kind: 'integer', min: 1, max: 10, default: 2, note: 'two or more failed attempts before a pass, with no deviation' },
      workingHoursStart: { kind: 'integer', min: 0, max: 23, default: 6, note: "start of the site's working hours (site time)" },
      workingHoursEnd: { kind: 'integer', min: 1, max: 24, default: 22, note: "end of the site's working hours (site time)" },
    },
    changesGmpData: false,
  },
  'ATA.BASELINE': {
    id: 'ATA.BASELINE',
    title: 'Per-person audit-trail baseline',
    intendedUse: "Point QA data-integrity review at a week that departs from the person's own trailing weeks (robust z); never an automatic finding (advisory; DI-53)",
    slice: '6A-4',
    family: 'audit',
    inputKind: 'AUDIT_EVENTS',
    inputs: ['report.audit_fact_v1', 'report.auth_fact_v1'],
    reference: 'NONE',
    outputKinds: ['AUDIT_BASELINE'],
    flagRules: ['BASELINE_Z'],
    parameters: {
      minHistoryWeeks: { kind: 'integer', min: 4, max: 52, default: 6, note: 'a person needs 6 weeks of history (D-6A-12)' },
      trailingWeeks: { kind: 'integer', min: 4, max: 52, default: 13, note: "against the person's own trailing 13 weeks" },
      robustZ: { kind: 'number', min: 2, max: 10, default: 3.5, note: 'flag at |robust z| above 3.5 (D-6A-12)' },
      lateEntryMinutes: { kind: 'integer', min: 1, max: 1440, default: 15, note: 'a late entry, for the weekly count, as ATA.RULES counts it (15 minutes)' },
    },
    changesGmpData: false,
  },
  'REVIEW.PRIORITY': {
    id: 'REVIEW.PRIORITY',
    title: 'Review priority',
    intendedUse: 'Order the QA review queue by a transparent weighted score with its reasons; never skips, narrows or completes a review (advisory; PR-61)',
    slice: '6A-5',
    family: 'review',
    inputKind: 'REVIEW_FACTS',
    inputs: ['report.review_fact_v1', 'report.cpp_value_v1', 'report.step_use_v1', 'report.batch_fact_v1', 'report.audit_fact_v1'],
    reference: 'NONE',
    outputKinds: ['REVIEW_PRIORITY'],
    flagRules: [],
    parameters: {
      weights: {
        kind: 'weights',
        terms: ['EXCEPTION_CRITICAL', 'EXCEPTION_MAJOR', 'EXCEPTION_MINOR', 'NEAR_LIMIT', 'CORRECTION', 'OPEN_AUDIT_FLAG', 'NEW_OPERATOR', 'NEW_EQUIPMENT', 'STEP_DURATION', 'DEVIATION'],
        default: {
          EXCEPTION_CRITICAL: 5, EXCEPTION_MAJOR: 3, EXCEPTION_MINOR: 1, NEAR_LIMIT: 1, CORRECTION: 1, OPEN_AUDIT_FLAG: 3, NEW_OPERATOR: 2, NEW_EQUIPMENT: 2,
          STEP_DURATION: 1, DEVIATION: 4,
        },
        note: 'weights v1 (D-6A-13)',
      },
      caps: {
        kind: 'weights',
        terms: ['NEAR_LIMIT', 'CORRECTION', 'STEP_DURATION'],
        default: { NEAR_LIMIT: 5, CORRECTION: 5, STEP_DURATION: 3 },
        note: 'each capped term (D-6A-13)',
      },
      nearLimitShare: { kind: 'number', min: 0.01, max: 0.5, default: 0.1, note: 'a value within 10 % of the range from a limit (D-6A-13)' },
      durationZ: { kind: 'number', min: 1, max: 10, default: 3, note: 'a step duration with |z| above 3 (D-6A-13)' },
      durationMinBatches: { kind: 'integer', min: 3, max: 100, default: 5, note: 'a step duration is assessed against at least 5 records of the same product, family and step (D-6A-5-5)' },
      topReasons: { kind: 'integer', min: 1, max: 10, default: 3, note: 'the score comes with its top three reasons' },
    },
    changesGmpData: false,
  },
  'GBP.DTW_BAND': {
    id: 'GBP.DTW_BAND',
    title: 'Golden batch profile (DTW band)',
    intendedUse: 'Overlay a batch\'s equipment curve on the band of approved reference batches and flag a curve outside it (advisory)',
    slice: '6A-6',
    family: 'profile',
    inputKind: 'SERIES_PROFILE',
    inputs: ['report.series_ref_v1', 'report.series_samples_v1(uuid,text,text)'],
    reference: 'REQUIRED',
    outputKinds: ['MODEL_CANDIDATE', 'PROFILE_DISTANCE'],
    flagRules: ['OUT_OF_BAND', 'DTW_DISTANCE'],
    parameters: {
      points: { kind: 'integer', min: 50, max: 2000, default: 200, note: '200 resampled points of normalised step time (D-6A-16)' },
      sakoeChiba: { kind: 'number', min: 0.01, max: 0.5, default: 0.1, note: 'a Sakoe-Chiba band of 10 % (D-6A-16)' },
      bandLowPercentile: { kind: 'number', min: 0, max: 50, default: 5, note: 'the band is the 5th to 95th percentile (D-6A-16)' },
      bandHighPercentile: { kind: 'number', min: 50, max: 100, default: 95, note: 'the band is the 5th to 95th percentile (D-6A-16)' },
      outsideShare: { kind: 'number', min: 0.01, max: 0.5, default: 0.1, note: 'flagged when more than 10 % of the points fall outside the band (D-6A-16)' },
      distancePercentile: { kind: 'number', min: 50, max: 100, default: 99, note: "or its distance is above the references' 99th percentile (D-6A-16)" },
      minReferenceBatches: { kind: 'integer', min: 10, max: 500, default: 10, note: 'at least 10 reference batches (D-6A-16)' },
      bandTolerancePoints: { kind: 'integer', min: 0, max: 20, default: 1, note: 'the band at a point spans its neighbours within 1 point, a timing tolerance of one resampling step (D-6A-6-3)' },
      maxGapShare: { kind: 'number', min: 0.01, max: 0.5, default: 0.05, note: 'a curve with a gap between usable samples longer than 5 % of its time is not assessed (D-6A-6-5)' },
      minSamples: { kind: 'integer', min: 10, max: 100000, default: 20, note: 'a curve needs at least 20 usable samples (D-6A-6-5)' },
    },
    changesGmpData: false,
  },
};

/** A method's parameters at the plan's defaults (what its version 1 row holds). */
export function defaultParameters(id: MethodId): Parameters {
  const out: Record<string, ParameterValue> = {};
  for (const [name, spec] of Object.entries(METHODS[id].parameters)) out[name] = spec.default;
  return out;
}

function specProblems(name: string, spec: ParameterSpec, value: unknown): string[] {
  switch (spec.kind) {
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (spec.kind === 'integer' && !Number.isInteger(value))) return [`${name} is not a${spec.kind === 'integer' ? 'n integer' : ' number'}`];
      return value < spec.min || value > spec.max ? [`${name} is outside ${spec.min} to ${spec.max}`] : [];
    case 'choices':
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || !spec.choices.includes(v)) || new Set(value).size !== value.length) {
        return [`${name} is not a non-empty list of distinct values of ${spec.choices.join(', ')}`];
      }
      return [];
    case 'weights': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${name} is not a map of ${spec.terms.join(', ')}`];
      const entries = Object.entries(value as Record<string, unknown>);
      const keys = entries.map(([k]) => k).sort();
      if (keys.join() !== [...spec.terms].sort().join()) return [`${name} names exactly ${spec.terms.join(', ')}`];
      return entries.filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v < 0).map(([k]) => `${name}.${k} is not a number of at least 0`);
    }
  }
}

/** What is wrong with `params` for method `id` (empty when they fit its parameter schema exactly). */
export function parameterProblems(id: MethodId, params: Readonly<Record<string, unknown>>): string[] {
  const specs = METHODS[id].parameters;
  const problems = Object.keys(params).filter((k) => !(k in specs)).map((k) => `${k} is not a parameter of ${id}`);
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in params)) problems.push(`${name} is missing`);
    else problems.push(...specProblems(name, spec, params[name]));
  }
  return problems;
}
