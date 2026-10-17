/**
 * The synthetic analytics history (Phase 6A slice 6A-0; interfaces slice-6A-0-interfaces.md section 6; D-6A-17), so
 * the analytics slices build in parallel without waiting for each other's input views.
 *
 * `analyticsHistory(seed)` is deterministic (a seeded PRNG, no clock): the same seed gives the same rows. For GB-T-01's
 * product (the invented Exemplazine 250 mg tablet, family GB-T-01) it gives the rows the input views read, every GMP
 * value as decimal text:
 *   - 30 completed, released batches, one a day;
 *   - the granulation end-point (amperage) shifts up by one sigma from batch 24. So that Nelson rule 2 (nine in a row on
 *     one side) can see it, batches 22 and 23 also fall above the centre line of the Phase I batches 1 to 20 by their
 *     own noise (D-6A-0-7);
 *   - batch 27 is within every limit, but its hardness and thickness break their correlation (hardness high, thickness
 *     low: a Q-residual signal);
 *   - deviations: room R-2 runs at three times the others' rate (9 of its 10 batches against 6 of the other 20);
 *   - audit events of four clean persons, plus one late entry, one back-dated entry, one account on two terminals within
 *     a minute, one person whose manual entries show terminal-digit preference, and one repeat-until-pass;
 *   - 20 normal press-force curves and one abnormal one (its plateau sags).
 * `ANALYTICS_HISTORY_EXPECTED` lists the flags a correct method raises on it; `analyticsHistorySql` writes the same
 * rows as SQL into view-shaped tables of a fixture schema, for database tests (D-6A-0-8). The numbers here are test
 * data generation only; what leaves the generator is decimal text.
 */

export const HISTORY_PRODUCT = { code: 'EXZ-250', family: 'GB-T-01', strength: '250 mg', mbrVersionId: '6a000000-0000-4000-8000-0000000000f1' } as const;
export const HISTORY_DATA_AS_OF = '2026-08-01T00:00:00.000Z';

export interface BatchFact {
  batch_id: string;
  batch_number: string;
  product_code: string;
  strength: string;
  mbr_version_id: string;
  family_code: string;
  status: 'COMPLETED';
  issued_at: string;
  completed_at: string;
  released: boolean;
}

export interface CppValue {
  batch_id: string;
  kind: 'PARAMETER' | 'CALCULATION';
  item: string;
  step: string;
  attempt: number;
  role: 'PROCESS_PARAMETER' | 'IPC' | 'PROCESS_ENDPOINT';
  value_text: string;
  unit: string;
  lower_text: string;
  upper_text: string;
  target_text: string;
  failed: boolean;
  recorded_at: string;
  /** Who recorded it (not a column of report.cpp_value_v1; the audit facts tie a person to an entry). */
  person_id: string;
}

export interface StepUse {
  batch_id: string;
  step: string;
  equipment_code: string;
  equipment_type: string;
  room_code: string;
  started_at: string;
  ended_at: string;
  person_ids: string[];
  material_lots: { lot_code: string; supplier_code: string }[];
}

export interface DeviationFact {
  deviation_id: string;
  classification: 'MINOR' | 'MAJOR';
  raised_at: string;
  batch_id: string;
  step: string | null;
  equipment_code: string | null;
  room_code: string | null;
  material_lot: string | null;
  supplier_code: string | null;
  shift: 'A' | 'B' | 'C';
}

export interface AuditFact {
  event_id: string;
  recorded_at: string;
  claimed_at: string | null;
  person_id: string;
  account_id: string;
  role: string;
  terminal: string;
  action: 'INSERT' | 'UPDATE';
  table_name: string;
  field: string | null;
  is_correction: boolean;
  reason_code: string | null;
  batch_id: string | null;
  step: string | null;
}

export interface AuthFact {
  account_id: string;
  person_id: string;
  terminal: string;
  kind: 'LOGIN' | 'FAILED' | 'LOCKOUT';
  at: string;
}

/** A manual entry's value with who keyed it (the terminal-digit test's input; 6A-4 decides its view). */
export interface ManualEntry {
  person_id: string;
  batch_id: string;
  item: string;
  value_text: string;
  recorded_at: string;
}

export interface SeriesSample {
  source_time: string;
  raw_text: string;
  status: 'GOOD' | 'UNCERTAIN' | 'BAD';
}

export interface PressCurve {
  batch_id: string;
  step: string;
  equipment_code: string;
  equipment_type: string;
  tag: string;
  unit: string;
  abnormal: boolean;
  samples: SeriesSample[];
}

export interface HistoryPerson {
  key: string;
  person_id: string;
  account_id: string;
  role: string;
  /** The anomaly seeded for this person, or null for a clean person. */
  anomaly: 'LATE_ENTRY' | 'BACK_DATED' | 'TWO_TERMINALS' | 'TOO_REGULAR' | 'REPEAT_UNTIL_PASS' | null;
}

export interface ExpectedFlag {
  method: string;
  rule: string;
  subjectKind: 'BATCH' | 'PRODUCT_ITEM' | 'GROUP' | 'PERSON';
  subjectRef: string;
  note: string;
}

export interface AnalyticsHistory {
  seed: number;
  product: typeof HISTORY_PRODUCT;
  persons: HistoryPerson[];
  batches: BatchFact[];
  cppValues: CppValue[];
  stepUses: StepUse[];
  deviations: DeviationFact[];
  auditEvents: AuditFact[];
  authEvents: AuthFact[];
  manualEntries: ManualEntry[];
  pressCurves: PressCurve[];
  expected: ExpectedFlag[];
}

/** mulberry32: a small, fast, seeded PRNG (uniform in [0, 1)). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box-Muller), clipped to [-limit, limit] so no seeded point falls beyond the limits by chance. */
function normal(rand: () => number, limit = 2.5): number {
  const u = Math.max(rand(), 1e-12);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  return Math.max(-limit, Math.min(limit, z));
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
/** A deterministic UUID (version 4 form) for entity kind `kind` and number `n` of seed `seed`. */
const uuid = (seed: number, kind: number, n: number): string => `6a${hex(seed % 256, 2)}${hex(kind, 4)}-0000-4000-8000-${hex(n, 12)}`;
const at = (dayIndex: number, minutes: number): string => new Date(Date.UTC(2026, 5, 1 + dayIndex, 4, 30) + minutes * 60_000).toISOString();
const fixed = (x: number, digits: number): string => {
  const t = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t;
};

export const HISTORY_ITEMS = {
  endpoint: { item: 'granulation.endpoint', step: 'granulation', unit: 'A', mean: 7.5, sd: 0.1, lower: '7.00', upper: '8.00', target: '7.50', digits: 2 },
  hardness: { item: 'compression.hardness', step: 'compression', unit: 'kp', mean: 9.0, sd: 0.4, lower: '7.0', upper: '11.0', target: '9.0', digits: 1 },
  thickness: { item: 'compression.thickness', step: 'compression', unit: 'mm', mean: 4.2, sd: 0.04, lower: '4.05', upper: '4.35', target: '4.20', digits: 2 },
} as const;

/** The batch numbers (1-based) the seeded anomalies sit on. */
export const HISTORY_SEEDS = { shiftFrom: 24, nelsonRunFrom: 22, brokenCorrelation: 27, repeatUntilPass: 16, abnormalCurve: 18, curves: 21 } as const;

export function analyticsHistory(seed = 6): AnalyticsHistory {
  const rand = prng(seed);
  const persons: HistoryPerson[] = [
    ...['op1', 'op2', 'op3', 'op4'].map((key) => ({ key, anomaly: null })),
    { key: 'op-late', anomaly: 'LATE_ENTRY' as const },
    { key: 'op-back', anomaly: 'BACK_DATED' as const },
    { key: 'op-two', anomaly: 'TWO_TERMINALS' as const },
    { key: 'op-digits', anomaly: 'TOO_REGULAR' as const },
    { key: 'op-repeat', anomaly: 'REPEAT_UNTIL_PASS' as const },
  ].map((p, i) => ({ ...p, person_id: uuid(seed, 1, i + 1), account_id: uuid(seed, 2, i + 1), role: 'OPERATOR' }));
  const clean = persons.filter((p) => p.anomaly === null);
  const byKey = (key: string): HistoryPerson => persons.find((p) => p.key === key) as HistoryPerson;
  const rooms = ['R-1', 'R-2', 'R-3'];

  const batches: BatchFact[] = [];
  const cppValues: CppValue[] = [];
  const stepUses: StepUse[] = [];
  const deviations: DeviationFact[] = [];
  const auditEvents: AuditFact[] = [];
  const manualEntries: ManualEntry[] = [];
  let eventNo = 0;
  const audit = (p: HistoryPerson, recordedAt: string, claimedAt: string | null, batchId: string, step: string, field: string, terminal: string): void => {
    eventNo += 1;
    auditEvents.push({
      event_id: String(eventNo), recorded_at: recordedAt, claimed_at: claimedAt, person_id: p.person_id, account_id: p.account_id, role: p.role,
      terminal, action: 'INSERT', table_name: 'recipe.execution_command', field, is_correction: false, reason_code: null, batch_id: batchId, step,
    });
  };

  // The values: end-point first (its Phase I centre decides the run before the shift), then hardness and thickness.
  const ep = HISTORY_ITEMS.endpoint;
  const endpoints: number[] = [];
  for (let n = 1; n <= 30; n++) {
    const shift = n >= HISTORY_SEEDS.shiftFrom ? ep.sd : 0;
    endpoints.push(ep.mean + shift + normal(rand) * ep.sd);
  }
  const phaseOne = endpoints.slice(0, 20);
  const centre = phaseOne.reduce((s, x) => s + x, 0) / phaseOne.length;
  for (let n = HISTORY_SEEDS.nelsonRunFrom; n <= 30; n++) {
    const i = n - 1;
    const v = endpoints[i] ?? centre;
    if (v <= centre + 0.02) endpoints[i] = centre + 0.02 + Math.abs(normal(rand)) * 0.03;
  }

  for (let n = 1; n <= 30; n++) {
    const day = n - 1;
    const batchId = uuid(seed, 10, n);
    const room = rooms[(n - 1) % 3] as string;
    const press = n % 2 === 0 ? 'PRESS-02' : 'PRESS-01';
    batches.push({
      batch_id: batchId, batch_number: `EXZ250-26-${String(n).padStart(3, '0')}`, product_code: HISTORY_PRODUCT.code, strength: HISTORY_PRODUCT.strength,
      mbr_version_id: HISTORY_PRODUCT.mbrVersionId, family_code: HISTORY_PRODUCT.family, status: 'COMPLETED', issued_at: at(day, 0), completed_at: at(day, 480), released: true,
    });
    const operator = clean[(n - 1) % clean.length] as HistoryPerson;
    const lots = [{ lot_code: `LOT-EXZ-${String(Math.ceil(n / 5)).padStart(3, '0')}`, supplier_code: n <= 15 ? 'SUP-A' : 'SUP-B' }];
    stepUses.push(
      { batch_id: batchId, step: 'granulation', equipment_code: 'HSG-01', equipment_type: 'HIGH_SHEAR_GRANULATOR', room_code: 'R-G', started_at: at(day, 30), ended_at: at(day, 150), person_ids: [operator.person_id], material_lots: lots },
      { batch_id: batchId, step: 'compression', equipment_code: press, equipment_type: 'TABLET_PRESS', room_code: room, started_at: at(day, 240), ended_at: at(day, 420), person_ids: [operator.person_id], material_lots: lots },
    );

    // Hardness and thickness move together (a shared factor), except on batch 27.
    const h = HISTORY_ITEMS.hardness;
    const t = HISTORY_ITEMS.thickness;
    let zh: number;
    let zt: number;
    if (n === HISTORY_SEEDS.brokenCorrelation) {
      zh = 1.6;
      zt = -1.6;
    } else {
      const common = normal(rand, 2);
      zh = 0.95 * common + 0.3 * normal(rand, 1);
      zt = 0.95 * common + 0.3 * normal(rand, 1);
    }
    const values: [typeof ep | typeof h | typeof t, number][] = [[ep, endpoints[n - 1] ?? ep.mean], [h, h.mean + zh * h.sd], [t, t.mean + zt * t.sd]];
    values.forEach(([spec, v], k) => {
      const recordedAt = at(day, spec.step === 'granulation' ? 140 : 300 + k);
      const p = n === HISTORY_SEEDS.repeatUntilPass && spec === h ? byKey('op-repeat') : operator;
      if (n === HISTORY_SEEDS.repeatUntilPass && spec === h) {
        // Repeat until pass: two failed attempts of the same IPC before a pass, with no deviation.
        for (const [attempt, failing] of [[1, '6.5'], [2, '6.8']] as const) {
          const when = at(day, 290 + attempt);
          cppValues.push({ batch_id: batchId, kind: 'PARAMETER', item: spec.item, step: spec.step, attempt, role: 'IPC', value_text: failing, unit: spec.unit,
            lower_text: spec.lower, upper_text: spec.upper, target_text: spec.target, failed: true, recorded_at: when, person_id: p.person_id });
          audit(p, when, when, batchId, spec.step, spec.item, 'TAB-PRESS-01');
        }
      }
      const attempt = n === HISTORY_SEEDS.repeatUntilPass && spec === h ? 3 : 1;
      cppValues.push({
        batch_id: batchId, kind: 'PARAMETER', item: spec.item, step: spec.step, attempt, role: spec === ep ? 'PROCESS_ENDPOINT' : 'IPC',
        value_text: fixed(v, spec.digits), unit: spec.unit, lower_text: spec.lower, upper_text: spec.upper, target_text: spec.target, failed: false,
        recorded_at: recordedAt, person_id: p.person_id,
      });
      // A clean entry: recorded one to five minutes after the time it claims, on the step's own terminal.
      const lag = 1 + Math.floor(rand() * 5);
      audit(p, at(day, (spec.step === 'granulation' ? 140 : 300 + k) + lag), recordedAt, batchId, spec.step, spec.item, spec.step === 'granulation' ? 'TAB-GRAN-01' : 'TAB-PRESS-01');
    });

    // Deviations: R-2 has one on 9 of its 10 batches, R-1 and R-3 on 3 of their 10 each (three times the rate).
    const roomIndex = Math.floor((n - 1) / 3); // 0..9 within the room
    const deviates = room === 'R-2' ? roomIndex !== 4 : [1, 4, 7].includes(roomIndex);
    if (deviates) {
      deviations.push({
        deviation_id: uuid(seed, 20, n), classification: n % 4 === 0 ? 'MAJOR' : 'MINOR', raised_at: at(day, 330), batch_id: batchId, step: 'compression',
        equipment_code: press, room_code: room, material_lot: lots[0]?.lot_code ?? null, supplier_code: lots[0]?.supplier_code ?? null, shift: 'A',
      });
    }
  }

  // The seeded audit anomalies (one each).
  const b = (n: number): string => uuid(seed, 10, n);
  const late = byKey('op-late');
  audit(late, at(11, 347), at(11, 300), b(12), 'compression', 'compression.weight', 'TAB-PRESS-02'); // 47 minutes late
  const back = byKey('op-back');
  audit(back, at(8, 320), at(8, 310), b(9), 'compression', 'compression.weight', 'TAB-PRESS-01');
  // Claims a time before the step's previous entry, though recorded only 14 minutes later (so it is not late as well).
  audit(back, at(8, 321), at(8, 307), b(9), 'compression', 'compression.friability', 'TAB-PRESS-01');
  const digits = byKey('op-digits');
  for (let k = 0; k < 60; k++) {
    const day = k % 30;
    const value = fixed(250 + 5 * Math.floor(rand() * 4) - 5 + (k % 2 === 0 ? 0 : 5), 0); // every value ends in 0 or 5
    manualEntries.push({ person_id: digits.person_id, batch_id: b(day + 1), item: 'compression.weight', value_text: value, recorded_at: at(day, 360 + (k >= 30 ? 30 : 0)) });
    audit(digits, at(day, 362 + (k >= 30 ? 30 : 0)), at(day, 360 + (k >= 30 ? 30 : 0)), b(day + 1), 'compression', 'compression.weight', 'TAB-PRESS-01');
  }
  for (const p of clean) {
    for (let k = 0; k < 60; k++) {
      const day = k % 30;
      manualEntries.push({ person_id: p.person_id, batch_id: b(day + 1), item: 'compression.weight', value_text: fixed(245 + rand() * 10, 0), recorded_at: at(day, 365) });
    }
  }
  const authEvents: AuthFact[] = [];
  for (const p of persons) {
    for (let day = 0; day < 30; day += 7) {
      authEvents.push({ account_id: p.account_id, person_id: p.person_id, terminal: 'TAB-PRESS-01', kind: 'LOGIN', at: at(day, 200) });
    }
  }
  const two = byKey('op-two');
  authEvents.push(
    { account_id: two.account_id, person_id: two.person_id, terminal: 'TAB-PRESS-01', kind: 'LOGIN', at: at(20, 250) },
    { account_id: two.account_id, person_id: two.person_id, terminal: 'TAB-GRAN-01', kind: 'LOGIN', at: new Date(Date.parse(at(20, 250)) + 50_000).toISOString() },
  );

  // Press-force curves of the compression step: 20 normal and one abnormal.
  const pressCurves: PressCurve[] = [];
  for (let n = 1; n <= HISTORY_SEEDS.curves; n++) {
    const abnormal = n === HISTORY_SEEDS.abnormalCurve;
    const start = Date.parse(at(n - 1, 240));
    const samples: SeriesSample[] = [];
    const count = 120;
    for (let i = 0; i < count; i++) {
      const x = i / (count - 1);
      const ramp = x < 0.1 ? x / 0.1 : x > 0.9 ? (1 - x) / 0.1 : 1;
      const sag = abnormal && x > 0.35 && x < 0.65 ? 0.82 : 1;
      const force = 12 * ramp * sag + 0.3 * Math.sin(12 * Math.PI * x) * ramp + normal(rand, 2) * 0.08;
      const bad = n === 3 && (i === 40 || i === 41);
      samples.push({ source_time: new Date(start + i * 1_000).toISOString(), raw_text: fixed(Math.max(force, 0), 2), status: bad ? 'BAD' : 'GOOD' });
    }
    pressCurves.push({ batch_id: b(n), step: 'compression', equipment_code: n % 2 === 0 ? 'PRESS-02' : 'PRESS-01', equipment_type: 'TABLET_PRESS', tag: 'press.force.main', unit: 'kN', abnormal, samples });
  }

  auditEvents.sort((x, y) => (x.recorded_at < y.recorded_at ? -1 : x.recorded_at > y.recorded_at ? 1 : Number(x.event_id) - Number(y.event_id)));

  const expected: ExpectedFlag[] = [
    { method: 'SPC.IMR', rule: 'NELSON_2', subjectKind: 'PRODUCT_ITEM', subjectRef: `${HISTORY_PRODUCT.code}|${HISTORY_PRODUCT.family}|${ep.item}`,
      note: `nine in a row above the Phase I centre, batches ${HISTORY_SEEDS.nelsonRunFrom} to 30 (the shift starts at ${HISTORY_SEEDS.shiftFrom})` },
    { method: 'MSPC.PCA', rule: 'Q_ABOVE', subjectKind: 'BATCH', subjectRef: b(HISTORY_SEEDS.brokenCorrelation), note: 'within every limit; hardness and thickness break their correlation' },
    { method: 'RATE.DEVIATION', rule: 'RATE_ABOVE', subjectKind: 'GROUP', subjectRef: 'ROOM:R-2', note: 'deviations on 9 of 10 batches against 6 of 20 elsewhere' },
    { method: 'ATA.RULES', rule: 'LATE_ENTRY', subjectKind: 'PERSON', subjectRef: late.person_id, note: 'recorded 47 minutes after the time it claims' },
    { method: 'ATA.RULES', rule: 'BACK_DATED', subjectKind: 'PERSON', subjectRef: back.person_id, note: "claims a time before the step's previous entry" },
    { method: 'ATA.RULES', rule: 'TWO_TERMINALS', subjectKind: 'PERSON', subjectRef: two.person_id, note: 'one account on two terminals within 50 seconds' },
    { method: 'ATA.RULES', rule: 'TOO_REGULAR', subjectKind: 'PERSON', subjectRef: digits.person_id, note: '60 manual entries, every one ending in 0 or 5' },
    { method: 'ATA.RULES', rule: 'REPEAT_UNTIL_PASS', subjectKind: 'PERSON', subjectRef: byKey('op-repeat').person_id,
      note: `two failed hardness attempts before a pass on batch ${HISTORY_SEEDS.repeatUntilPass}, no deviation` },
    { method: 'GBP.DTW_BAND', rule: 'OUT_OF_BAND', subjectKind: 'BATCH', subjectRef: b(HISTORY_SEEDS.abnormalCurve), note: 'the plateau sags by 18 % over its middle third' },
  ];

  return { seed, product: HISTORY_PRODUCT, persons, batches, cppValues, stepUses, deviations, auditEvents, authEvents, manualEntries, pressCurves, expected };
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  if (typeof v !== 'string') throw new Error(`no SQL literal for a ${typeof v}`);
  return `'${v.replace(/'/g, "''")}'`;
};

/** The columns of each view-shaped fixture table (the input views' columns, values as text; interfaces section 3). */
const TABLES: Record<string, [string, string][]> = {
  batch_fact_v1: [['batch_id', 'uuid'], ['batch_number', 'text'], ['product_code', 'text'], ['strength', 'text'], ['mbr_version_id', 'uuid'], ['family_code', 'text'],
    ['status', 'text'], ['issued_at', 'timestamptz'], ['completed_at', 'timestamptz'], ['released', 'boolean']],
  cpp_value_v1: [['batch_id', 'uuid'], ['kind', 'text'], ['item', 'text'], ['step', 'text'], ['attempt', 'integer'], ['role', 'text'], ['value_text', 'text'], ['unit', 'text'],
    ['lower_text', 'text'], ['upper_text', 'text'], ['target_text', 'text'], ['failed', 'boolean'], ['recorded_at', 'timestamptz']],
  step_use_v1: [['batch_id', 'uuid'], ['step', 'text'], ['equipment_code', 'text'], ['equipment_type', 'text'], ['room_code', 'text'], ['started_at', 'timestamptz'],
    ['ended_at', 'timestamptz'], ['person_ids', 'uuid[]'], ['material_lots', 'jsonb']],
  deviation_fact_v1: [['deviation_id', 'uuid'], ['classification', 'text'], ['raised_at', 'timestamptz'], ['batch_id', 'uuid'], ['step', 'text'], ['equipment_code', 'text'],
    ['room_code', 'text'], ['material_lot', 'text'], ['supplier_code', 'text'], ['shift', 'text']],
  audit_fact_v1: [['event_id', 'text'], ['recorded_at', 'timestamptz'], ['claimed_at', 'timestamptz'], ['person_id', 'uuid'], ['account_id', 'uuid'], ['role', 'text'],
    ['terminal', 'text'], ['action', 'text'], ['table_name', 'text'], ['field', 'text'], ['is_correction', 'boolean'], ['reason_code', 'text'], ['batch_id', 'uuid'], ['step', 'text']],
  auth_fact_v1: [['account_id', 'uuid'], ['person_id', 'uuid'], ['terminal', 'text'], ['kind', 'text'], ['at', 'timestamptz']],
  series_sample_v1: [['batch_id', 'uuid'], ['step', 'text'], ['tag', 'text'], ['source_time', 'timestamptz'], ['raw_text', 'text'], ['status', 'text']],
};

/**
 * The history as SQL: a schema `schema` with one view-shaped table per input (with read_at and data_as_of, as the views
 * carry them) and the rows. For database tests of the runner and the methods; the input views' own tests seed GMP rows.
 */
export function analyticsHistorySql(h: AnalyticsHistory, schema = 'analytics_fixture'): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`not a schema name: ${schema}`);
  const rows: Record<string, Record<string, unknown>[]> = {
    batch_fact_v1: h.batches as unknown as Record<string, unknown>[],
    cpp_value_v1: h.cppValues as unknown as Record<string, unknown>[],
    step_use_v1: h.stepUses.map((s) => ({ ...s, person_ids: `{${s.person_ids.join(',')}}` })),
    deviation_fact_v1: h.deviations as unknown as Record<string, unknown>[],
    audit_fact_v1: h.auditEvents as unknown as Record<string, unknown>[],
    auth_fact_v1: h.authEvents as unknown as Record<string, unknown>[],
    series_sample_v1: h.pressCurves.flatMap((c) => c.samples.map((s) => ({ batch_id: c.batch_id, step: c.step, tag: c.tag, ...s }))),
  };
  const out = [`create schema ${schema};`];
  for (const [table, cols] of Object.entries(TABLES)) {
    out.push(`create table ${schema}.${table} (${cols.map(([c, t]) => `${c} ${t}`).join(', ')}, read_at timestamptz not null default '${HISTORY_DATA_AS_OF}', data_as_of timestamptz not null default '${HISTORY_DATA_AS_OF}');`);
    const list = rows[table] ?? [];
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      out.push(`insert into ${schema}.${table} (${cols.map(([c]) => c).join(', ')}) values\n${chunk.map((r) => `(${cols.map(([c]) => lit(r[c])).join(', ')})`).join(',\n')};`);
    }
  }
  return `${out.join('\n')}\n`;
}
