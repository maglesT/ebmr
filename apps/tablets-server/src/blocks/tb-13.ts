/**
 * TB-13@1 Tablet physical IPC: breaking force, thickness, diameter and appearance (tablets spec B.2 TB-13, C-17;
 * Phase 3 slice 3c, builder B). Controls IN-35, PR-29, DI-32.
 *
 * The configuration names the tablets per check (n) and, for each parameter it examines, its limits on the individual
 * values and on the mean, each with action limits and optional alert limits inside them (in-house [P]); breaking force
 * is read in N or kp (1 kp = 9.80665 N, converted exactly; pressure units are not breaking force and are not
 * accepted) and its limits are in N; appearance examines the MBR's defect list (capping, lamination, sticking,
 * picking, chipping, embossing, black specks, lubricant-oil contamination). A PHYSICAL_CHECK records each tablet's
 * values together (one tablet's readings stay linked) and the defects observed. Any defect, an individual or a mean
 * outside its action limits fails the check (IPC_CHECK_FAILED: the steps after it wait for a deviation, and at a TB-11
 * step the output since the last passing check is held); outside alert limits only, IPC_CHECK_ALERT. Gauge values keyed
 * by hand are flagged and need a second person. The database recomputes the evaluation (tablets 0891).
 */
import { Dec } from '@ebmr/expr';
import { dec, fixed, judge, KP_TO_N, statistics, worst, type Tiers, type Verdict } from './ipc/calc.ts';
import {
  commonOf,
  configError,
  isRecord,
  LATE_ENTRY,
  POSITIVE_DECIMAL,
  problem,
  refuse,
  TEST_EXCEPTION_RULES,
  TEST_EXCEPTION_TYPES,
  TEST_FIELDS,
  testConfig,
  tierProblems,
  tiersOf,
  TIERS,
  type BlockVersion,
  type ConfigProblem,
  type Entry,
  type EntryResult,
  type HandlerProblem,
  type HandlerView,
  type ObjectSchema,
} from './ipc/common.ts';
import { resultOf, type TestOutcome } from './tb-12.ts';
import { PHYSICAL_SUMMARIES } from './summaries.ts';

const CONTROLS = ['IN-35', 'PR-29', 'DI-32'];
export const PHYSICAL_PARAMETERS = ['thickness', 'diameter', 'hardness'] as const;
export const DEFECTS = ['CAPPING', 'LAMINATION', 'STICKING', 'PICKING', 'CHIPPING', 'EMBOSSING', 'BLACK_SPECKS', 'OIL_CONTAMINATION'] as const;

const PARAMETER: ObjectSchema = {
  type: 'object',
  description: 'Limits of a dimension in mm: on each tablet and on the mean',
  fields: { individual: { ...TIERS, optional: true }, mean: { ...TIERS, optional: true } },
};

export const PHYSICAL_CONFIG: ObjectSchema = {
  type: 'object',
  description: 'Tablets per check, the parameters examined with their limits, and the appearance defects examined',
  fields: {
    n: { type: 'integer', min: 1, max: 20, description: 'Tablets per check' },
    thickness: { ...PARAMETER, optional: true },
    diameter: { ...PARAMETER, optional: true },
    hardness: {
      type: 'object',
      optional: true,
      description: 'Breaking force: the unit the tester reads (N or kp) and limits in N',
      fields: { unit: { type: 'string', enum: ['N', 'kp'], description: 'Unit the tester reads' }, individual: { ...TIERS, optional: true }, mean: { ...TIERS, optional: true } },
    },
    defects: { type: 'array', optional: true, items: { type: 'string', enum: [...DEFECTS], description: 'Defect' }, minItems: 1, maxItems: 8, description: 'Appearance defects examined' },
    lateEntry: LATE_ENTRY,
  },
};

export const PHYSICAL_ENTRIES: Readonly<Record<string, ObjectSchema>> = {
  PHYSICAL_CHECK: {
    type: 'object',
    description: 'A physical check: each tablet\'s values together, and the defects observed',
    fields: {
      ...TEST_FIELDS,
      tablets: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        description: 'The tablets in order',
        items: {
          type: 'object',
          description: 'One tablet\'s values',
          fields: {
            thickness: { ...POSITIVE_DECIMAL, optional: true, description: 'Thickness, mm' },
            diameter: { ...POSITIVE_DECIMAL, optional: true, description: 'Diameter or length, mm' },
            hardness: { ...POSITIVE_DECIMAL, optional: true, description: 'Breaking force in the tester\'s unit' },
          },
        },
      },
      defects: { type: 'array', optional: true, items: { type: 'string', enum: [...DEFECTS], description: 'Defect' }, maxItems: 8, description: 'Defects observed (none: an empty list)' },
    },
  },
};

/** The parameters a configuration examines, in the fixed order of the readings. */
export const examined = (cfg: Readonly<Record<string, unknown>>): (typeof PHYSICAL_PARAMETERS)[number][] => PHYSICAL_PARAMETERS.filter((p) => isRecord(cfg[p]));

/** A value of parameter `p` in its limit unit (breaking force in N). */
function inLimitUnit(cfg: Readonly<Record<string, unknown>>, p: string, v: string): Dec {
  const h = cfg['hardness'];
  return p === 'hardness' && isRecord(h) && h['unit'] === 'kp' ? dec(v).times(dec(KP_TO_N)) : dec(v);
}

/** A PHYSICAL_CHECK, evaluated (shared by TB-13 and TB-11). */
export function acceptPhysicalCheck(view: HandlerView, entry: Entry): { ok: true; t: TestOutcome } | { ok: false; problems: HandlerProblem[] } {
  const cfg = testConfig(view, 'physical');
  const params = examined(cfg);
  const tablets = Array.isArray(entry['tablets']) ? (entry['tablets'] as Record<string, unknown>[]) : [];
  const n = Number(cfg['n'] ?? 0);
  if (tablets.length !== n) return refuse('TB13-COUNT', `This check examines ${n} tablets, not ${tablets.length}`, ['PR-29', 'IN-35']);
  for (const t of tablets) {
    const has = PHYSICAL_PARAMETERS.filter((p) => t[p] !== undefined);
    if (has.length !== params.length || has.some((p) => !params.includes(p))) {
      return refuse('TB13-PARAMETERS', `Each tablet gives exactly the parameters the MBR examines (${params.join(', ') || 'none'})`, ['PR-29', 'DI-32']);
    }
  }
  const examinesDefects = Array.isArray(cfg['defects']);
  const defects = Array.isArray(entry['defects']) ? (entry['defects'] as string[]) : undefined;
  if (examinesDefects !== (defects !== undefined)) return refuse('TB13-APPEARANCE', examinesDefects ? 'The MBR examines appearance: list the defects observed (an empty list when none)' : 'The MBR examines no appearance at this check', ['IN-35', 'PR-29']);
  if (defects && (new Set(defects).size !== defects.length || defects.some((d) => !(cfg['defects'] as string[]).includes(d)))) {
    return refuse('TB13-APPEARANCE', 'The defects observed are listed once each, from the defects the MBR examines', ['IN-35']);
  }
  const c = commonOf(view, entry, tablets.length * params.length, 'TB13');
  if (!c.ok) return c;
  const evaluation: Record<string, unknown> = {};
  const verdicts: Verdict[] = [];
  for (const p of params) {
    const spec = cfg[p] as Record<string, unknown>;
    const vs = tablets.map((t) => inLimitUnit(cfg, p, String(t[p])));
    const ind = tiersOf(spec['individual']);
    const mean = tiersOf(spec['mean']);
    const st = statistics(vs);
    const vi = ind ? worst(vs.map((v) => judge(v, ind))) : 'PASS';
    const vm = mean ? judge(dec(st.sum).div(Dec.fromInteger(vs.length)), mean) : 'PASS';
    const v = worst([vi, vm]);
    verdicts.push(v);
    evaluation[p] = { unit: p === 'hardness' ? 'N' : 'mm', mean: st.mean, min: st.min, max: st.max, result: v };
  }
  if (defects) {
    const v: Verdict = defects.length > 0 ? 'FAIL' : 'PASS';
    verdicts.push(v);
    evaluation['appearance'] = { defects, result: v };
  }
  const outcome = worst(verdicts);
  const data: Record<string, unknown> = { ...c.common.base, tablets: entry['tablets'], ...(defects ? { defects } : {}), evaluation, result: outcome };
  return { ok: true, t: { data, outcome, manual: c.common.manual, late: c.common.late, what: 'The physical check' } };
}

function accept(view: HandlerView, entry: Entry): EntryResult {
  if (entry.kind !== 'PHYSICAL_CHECK') return refuse('TB13-ENTRY', `${entry.kind} is not an entry of a physical check step`, ['PR-29']);
  const r = acceptPhysicalCheck(view, entry);
  return r.ok ? resultOf(view, r.t) : r;
}

function beforePerform(view: HandlerView): HandlerProblem[] {
  return view.entries('PHYSICAL_CHECK').length === 0 ? [problem('TB13-NO-CHECK', `${view.stepKey} has no physical check`, ['PR-29', 'IN-35'])] : [];
}

/** Definition checks of a physical configuration (TB-13 and TB-11's `physical`). */
export function physicalConfigProblems(where: string, cfg: Readonly<Record<string, unknown>>): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (examined(cfg).length === 0 && !Array.isArray(cfg['defects'])) out.push(configError('TB13-NOTHING', `${where} examines no parameter and no appearance`, ['PR-29']));
  for (const p of examined(cfg)) {
    const spec = cfg[p] as Record<string, unknown>;
    if (!isRecord(spec['individual']) && !isRecord(spec['mean'])) out.push(configError('TB13-LIMITS', `${where}: ${p} has no limits`, ['PR-29', 'IN-35']));
    out.push(...tierProblems(`${where}: ${p} individual`, tiersOf(spec['individual']), 'TB13-LIMITS', ['PR-29']));
    out.push(...tierProblems(`${where}: ${p} mean`, tiersOf(spec['mean']), 'TB13-LIMITS', ['PR-29']));
  }
  return out;
}

/** Nominal values: each examined parameter in the middle of its individual action limits. */
export function physicalNominal(cfg: Readonly<Record<string, unknown>>, stream: string | undefined): (Record<string, unknown> & { kind: string })[] {
  const params = examined(cfg);
  const mid = (p: string): string => {
    const spec = cfg[p] as Record<string, unknown>;
    const t: Tiers | undefined = tiersOf(spec['individual']) ?? tiersOf(spec['mean']);
    const lo = t?.action.min ?? t?.action.max ?? '1';
    const hi = t?.action.max ?? t?.action.min ?? '1';
    const m = dec(lo).plus(dec(hi)).div(dec('2'));
    const h = cfg['hardness'];
    return fixed(p === 'hardness' && isRecord(h) && h['unit'] === 'kp' ? m.div(dec(KP_TO_N)) : m, 2);
  };
  const n = Number(cfg['n'] ?? 1);
  const tablets = Array.from({ length: n }, () => Object.fromEntries(params.map((p) => [p, mid(p)])));
  const readings = Array.from({ length: n * params.length }, (_, i) => `00000000-0000-4000-8000-${(i + 101).toString().padStart(12, '0')}`);
  return [
    {
      kind: 'PHYSICAL_CHECK',
      instrument: 'TEST-HT-01',
      capture: 'DEVICE',
      ...(readings.length > 0 ? { readings } : { capture: 'MANUAL' }),
      tablets,
      ...(Array.isArray(cfg['defects']) ? { defects: [] } : {}),
      ...(stream !== undefined ? { stream } : {}),
    },
  ];
}

export const TB13: BlockVersion = {
  type: 'TB-13',
  version: '1',
  title: 'Tablet breaking force, thickness, diameter and appearance',
  edition: 'tablets',
  aliases: { tablets: 'TB-13' },
  level: 'PHASE',
  controls: CONTROLS,
  configSchema: PHYSICAL_CONFIG,
  entrySummaries: PHYSICAL_SUMMARIES,
  dataSchema: { entries: PHYSICAL_ENTRIES },
  checkConfig: (phase, config) => physicalConfigProblems(`Physical check ${phase.id}`, config),
  handler: { acceptEntry: accept, beforePerform },
  exceptionRules: TEST_EXCEPTION_RULES,
  simulatorModel: { exceptionTypes: () => TEST_EXCEPTION_TYPES, nominalEntries: (input) => physicalNominal(input.config, undefined) },
  goldenFixture: {
    description:
      'Three tablets: thickness 3.40 to 3.45 mm within 3.2 to 3.6 mm, breaking force read in kp (7.5 to 8.0 kp, 73.5 to 78.5 N) within 60 to 120 N, no appearance defect: the check passes',
    controls: ['IN-35', 'PR-29'],
    phase: {
      block: { type: 'TB-13', version: '1' },
      config: {
        n: 3,
        thickness: { individual: { action: { min: '3.2', max: '3.6' } } },
        hardness: { unit: 'kp', individual: { action: { min: '60', max: '120' } }, mean: { action: { min: '60' }, alert: { min: '65' } } },
        defects: ['CAPPING', 'LAMINATION', 'STICKING', 'OIL_CONTAMINATION'],
      },
    },
    script: [
      {
        entry: {
          kind: 'PHYSICAL_CHECK',
          instrument: 'TEST-HT-01',
          capture: 'DEVICE',
          readings: Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${(i + 201).toString().padStart(12, '0')}`),
          tablets: [
            { thickness: '3.40', hardness: '7.5' },
            { thickness: '3.42', hardness: '8.0' },
            { thickness: '3.45', hardness: '7.8' },
          ],
          defects: [],
        },
      },
    ],
    expect: { exceptions: [], status: 'COMPLETED' },
  },
  tests: ['apps/tablets-server/test/blocks/ipc/blocks.test.ts', 'apps/tablets-server/test/blocks/ipc/db-guards.test.ts'],
};
