/**
 * Phase 3 slice 3c (builder B): the IPC blocks TB-11 to TB-15 through the engine with the tablets registry and
 * catalogue: the block contract, each golden fixture, the compendial rule sets and their market resolution, and each
 * block's rules (definition checks, refusals, evaluations, compendial stages, exceptions, the scheduler's due and missed
 * checks). The database's copy of the rules is proven in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, type flow } from '@ebmr/recipe-core/pure';
import { Dec } from '@ebmr/expr';
import { IPC_BLOCK_VERSIONS, TB11, TB12, TB13, TB14, TB15 } from '../../../src/blocks/ipc/index.ts';
import { bandOf, statistics, acceptanceValue } from '../../../src/blocks/ipc/calc.ts';
import { NOT_APPLICABLE, RULE_SETS, resolveRuleSets, ruleSetProblem, shared, uncoveredMarkets, utcDate, type UniformityParams } from '../../../src/blocks/ipc/rule-sets.ts';
import { counterOf, overdue } from '../../../src/blocks/tb-11.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, defineFor, fixturePhase, MIN, OP1, Run, runGolden, sig, T0, VER1 } from '../granulation/support.ts';
import { engine } from '@ebmr/recipe-core/pure';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const uuid = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`;
const uuids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => uuid(from + i));

/** A run of block `b` with phase config `config`, markets `markets` (the MBR's), started. */
function runOf(b: blocks.BlockVersion, config: Json, markets: string[] = ['IN']): Run {
  const p = fixturePhase(b, { config: config as never });
  const mbr = blockMbr(b, p);
  mbr.header.marketSet = markets;
  const run = Run.issue(defineFor(mbr), {}, T0);
  run.start('p');
  return run;
}

const rec = (run: Run, entry: Entry) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry });
const lastData = (run: Run, kind: string): Json => {
  const e = Object.values(run.state.entries).filter((x) => x.kind === kind).at(-1);
  if (!e) throw new Error(`no ${kind}`);
  return e.data;
};
const lastId = (run: Run, kind: string): string => Object.values(run.state.entries).filter((x) => x.kind === kind).at(-1)?.id ?? '';
const types = (run: Run) => run.exceptions().map((e) => e.type).sort();
const weigh = (weights: string[], extra: Json = {}): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', readings: uuids(weights.length), weights, ...extra });

describe('the IPC block versions (contract)', () => {
  it('[DI-10][DI-34] TB-11@1 to TB-15@1 are registered in the tablets registry with every execution part of the block contract, are significant IPC steps of the edition catalogue, and TB-11 takes the test entry kinds of TB-12 to TB-15 unchanged', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-11@1', 'TB-12@1', 'TB-13@1', 'TB-14@1', 'TB-15@1']));
    for (const r of reg.report().filter((x) => IPC_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of IPC_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.roles], b.type).toEqual(['tablets', true, ['IPC']]);
    }
    for (const b of [TB12, TB13, TB14, TB15]) for (const [k, s] of Object.entries(b.dataSchema?.entries ?? {})) expect(TB11.dataSchema?.entries[k], `${b.type} ${k}`).toBe(s);
  });
});

describe('golden fixtures of the IPC blocks', () => {
  for (const b of IPC_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p', out.frames)).toBe(f.expect.status);
      const declared = new Set([...(b.simulatorModel?.exceptionTypes(out.run.def.steps.get('p')?.node as never) ?? []), ...(b.exceptionRules ?? []).map((r) => r.type)]);
      for (const t of out.run.exceptions().map((e) => e.type)) expect(declared.has(t), `${b.type} raised ${t}`).toBe(true);
    });
  }

  it('[DI-34][PR-29] every IPC block runs its simulator model nominally to completion', () => {
    for (const b of IPC_BLOCK_VERSIONS) {
      const f = b.goldenFixture;
      if (!f) continue;
      const mbr = blockMbr(b, fixturePhase(b));
      const run = Run.issue(defineFor(mbr), {}, T0);
      run.start('p');
      const p = run.def.steps.get('p')?.node as flow.PhaseNode;
      for (const e of b.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr, frames: [], containers: [], target: () => undefined }) ?? []) run.entry('p', e);
      run.perform('p');
      if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p', [], VER1);
      expect(run.status('p'), b.type).toBe('COMPLETED');
    }
  });
});

describe('compendial rule sets (D-S3-2)', () => {
  it('[IN-34][DI-10] every rule set is data with its source, confidence and effective date; codes hold no digit (a test run records them); the resolution binds IP for every batch and the other markets\' rule sets beside it', () => {
    for (const r of RULE_SETS) {
      expect(r.source.length, r.code).toBeGreaterThan(10);
      expect(r.effectiveFrom, r.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.code, r.code).toMatch(/^[A-Z-]+$/);
    }
    expect(resolveRuleSets('UNIFORMITY_OF_WEIGHT', [], 'UNCOATED', '2026-10-10').map((r) => r.code)).toEqual(['IP-UOW']);
    expect(resolveRuleSets('UNIFORMITY_OF_WEIGHT', ['IN', 'EU', 'US'], 'FILM_COATED', '2026-10-10').map((r) => r.code)).toEqual(['IP-UOW', 'PHEUR-UOW']);
    expect(resolveRuleSets('UNIFORMITY_OF_WEIGHT', ['IN', 'US'], 'UNCOATED', '2026-10-10', true).map((r) => r.code)).toEqual(['IP-UOW', 'LEGACY-UOW']);
    expect(resolveRuleSets('UNIFORMITY_OF_WEIGHT', ['IN'], 'SUGAR_COATED', '2026-10-10')).toEqual([]);
    expect(resolveRuleSets('FRIABILITY', ['IN'], 'UNCOATED', '2023-01-01')).toEqual([]);
    expect(utcDate(T0)).toBe('2026-09-28');
    expect(utcDate(0n)).toBe('1970-01-01');
    expect(utcDate(951_782_400_000_000n)).toBe('2000-02-29');
  });

  it('[IN-34] catalogue test: a 300 mg tablet gets plus or minus 5 % for India and for India with the US; the legacy in-house table alone would give 7.5 %; bands are chosen from the average with exact boundaries', () => {
    const ip = RULE_SETS.find((r) => r.code === 'IP-UOW')?.params as UniformityParams;
    const legacy = RULE_SETS.find((r) => r.code === 'LEGACY-UOW')?.params as UniformityParams;
    const at = (p: UniformityParams, mg: string) => bandOf(p, Dec.parse(mg), 1);
    expect(at(ip, '300')).toBe('5');
    expect(at(legacy, '300')).toBe('7.5');
    expect([at(ip, '80'), at(ip, '80.01'), at(ip, '249.99'), at(ip, '250')]).toEqual(['10', '7.5', '7.5', '5']);
    expect([at(legacy, '130'), at(legacy, '130.01'), at(legacy, '324'), at(legacy, '324.01')]).toEqual(['10', '7.5', '7.5', '5']);
    // India with the US, the MBR opting into the legacy table: 6 tablets 6 % off a 300 mg average fail the IP band
    // (5 %) although the legacy table (7.5 %) passes them; the check fails: the legacy table never loosens.
    const run = runOf(TB12, { mode: 'UNIFORMITY', tabletType: 'UNCOATED', legacyTable: true }, ['IN', 'US']);
    const ws = [...Array.from({ length: 3 }, () => '318.0'), ...Array.from({ length: 3 }, () => '282.0'), ...Array.from({ length: 14 }, () => '300.0')];
    expect(rec(run, weigh(ws)).accepted).toBe(true);
    const d = lastData(run, 'WEIGHT_CHECK');
    expect(d['ruleSets']).toEqual([{ code: 'IP-UOW', version: 1 }, { code: 'LEGACY-UOW', version: 1 }]);
    const ev = d['evaluation'] as Json;
    expect(ev['criteria']).toEqual([
      { ruleSet: 'IP-UOW', version: 1, percent: '5', outside: 6, outsideDouble: 0, pass: false },
      { ruleSet: 'LEGACY-UOW', version: 1, percent: '7.5', outside: 0, outsideDouble: 0, pass: true },
    ]);
    expect([ev['mean'], ev['min'], ev['max'], ev['minDeviation'], ev['maxDeviation']]).toEqual(['300.0000', '282', '318', '-6.00', '6.00']);
    expect(d['result']).toBe('FAIL');
    expect(types(run)).toEqual(['IPC_CHECK_FAILED']);
  });
});

describe('rule-set coverage and agreement (review 3c finding 5)', () => {
  it('[IN-34][DI-10] every batch market needs a rule set for the test and tablet type or a recorded not-applicable decision (fail closed); bound rule sets must give one procedure', () => {
    expect(uncoveredMarkets('UNIFORMITY_OF_WEIGHT', ['IN', 'US'], 'UNCOATED', '2026-10-10')).toEqual([]);
    expect(NOT_APPLICABLE.map((n) => [n.test, n.market])).toEqual([['UNIFORMITY_OF_WEIGHT', 'US']]);
    expect(uncoveredMarkets('UNIFORMITY_OF_WEIGHT', ['IN', 'EU'], 'SUGAR_COATED', '2026-10-10')).toEqual(['EU', 'IN']);
    expect(uncoveredMarkets('SUBDIVISION', ['IN', 'EU', 'US'], 'UNCOATED', '2026-10-10')).toEqual(['IN', 'US']);
    expect(uncoveredMarkets('FRIABILITY', ['IN', 'EU', 'US'], 'UNCOATED', '2026-10-10')).toEqual([]);
    const ip = RULE_SETS.find((r) => r.code === 'IP-FRIABILITY');
    if (!ip) throw new Error('SETUP');
    const other = { ...ip, code: 'OTHER-FRIABILITY', params: { ...(ip.params as unknown as Record<string, unknown>), rotations: 150 } } as typeof ip;
    expect(shared([ip, other], 'rotations')).toBeUndefined();
    expect(shared([ip, other], 'rpmMin')).toBe('24');
    expect(ruleSetProblem('FRIABILITY', [ip, other], ['IN'], 'UNCOATED', '2026-10-10')).toMatch(/different procedures \(rotations\)/);
    expect(ruleSetProblem('FRIABILITY', [ip], ['IN'], 'UNCOATED', '2026-10-10')).toBeUndefined();
  });
});

describe('TB-12 weight', () => {
  it('[IN-34][PR-29] uniformity is refused where no rule set covers the tablet type (sugar-coated, India only) when the MBR is defined and when a check is recorded; the in-house individual limit is never looser than the band at the target', () => {
    const mbr = (config: Json, markets = ['IN']) => {
      const m = blockMbr(TB12, fixturePhase(TB12, { config: config as never }));
      m.header.marketSet = markets;
      return m;
    };
    expect(definitionCodes(mbr({ mode: 'UNIFORMITY', tabletType: 'SUGAR_COATED' }))).toEqual(['TB12-NO-RULE-SET']);
    // Review 3c finding 5: the legacy table is no market's rule set; India stays uncovered for sugar-coated tablets.
    expect(definitionCodes(mbr({ mode: 'UNIFORMITY', tabletType: 'SUGAR_COATED', legacyTable: true }))).toEqual(['TB12-NO-RULE-SET']);
    expect(definitionCodes(mbr({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '300.0', n: 10, individual: { action: '6' } }))).toEqual(['TB12-LOOSER']);
    expect(definitionCodes(mbr({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '300.0', n: 10, individual: { action: '5', alert: '6' } }))).toEqual(['TB12-CONFIG']);
    expect(definitionCodes(mbr({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '300.0', n: 10, individual: { action: '4', alert: '3' } }))).toEqual([]);
    expect(definitionCodes(mbr({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20 }))).toEqual(['TB12-CONFIG', 'TB12-CONFIG']);
    expect(definitionCodes(mbr({ mode: 'SUBDIVISION', tabletType: 'UNCOATED' }))).toEqual(['TB12-NO-RULE-SET']);
    expect(definitionCodes(mbr({ mode: 'SUBDIVISION', tabletType: 'UNCOATED' }, ['IN', 'EU']))).toEqual(['TB12-NO-RULE-SET']);
  });

  it('[PR-29][DI-29] group weight (a): the total against n x target with action and alert tiers; one tablet count only; every weight kept; an alert-limit breach warns, an action-limit breach fails', () => {
    const cfg = { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 5, weighing: 'INDIVIDUAL', tolerance: { action: '2', alert: '1' } };
    const run = runOf(TB12, cfg);
    expect(rec(run, weigh(['250.0', '250.0'])).refusal?.code).toBe('TB12-COUNT');
    expect(rec(run, { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', readings: uuids(1), groupWeight: '1250.0' }).refusal?.code).toBe('TB12-WEIGHTS');
    expect(rec(run, weigh(['252.0', '253.0', '254.0', '252.0', '254.0'])).accepted).toBe(true);
    const ev = lastData(run, 'WEIGHT_CHECK')['evaluation'] as Json;
    expect([ev['total'], ev['target'], ev['limits'], lastData(run, 'WEIGHT_CHECK')['result']]).toEqual([
      '1265',
      '1250',
      { action: { min: '1225', max: '1275' }, alert: { min: '1237.5', max: '1262.5' } },
      'ALERT',
    ]);
    expect(types(run)).toEqual(['IPC_CHECK_ALERT']);
    expect(rec(run, weigh(['263.0', '253.0', '254.0', '252.0', '254.0'])).accepted).toBe(true);
    expect(lastData(run, 'WEIGHT_CHECK')['result']).toBe('FAIL');
    expect(types(run)).toEqual(['IPC_CHECK_ALERT', 'IPC_CHECK_FAILED']);
    const failed = run.exceptions('IPC_CHECK_FAILED')[0];
    expect([failed?.severity, failed?.deviationRequired, failed?.block?.until]).toEqual(['ACTION', true, 'DEVIATION']);
  });

  it('[DI-32][PR-29] weights keyed by hand are flagged and need a second person; a device check names one reading per weight; a sample is never taken after it is recorded, and a late entry is flagged (DI-28)', () => {
    const cfg = { mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 3, individual: { action: '4' } };
    const run = runOf(TB12, cfg);
    expect(rec(run, weigh(['250.0', '250.1', '249.9'], { readings: uuids(2) })).refusal?.code).toBe('TB12-READINGS');
    expect(rec(run, weigh(['250.0', '250.1', '249.9'], { sampledAtUs: (T0 + 1n).toString() })).refusal?.code).toBe('TB12-SAMPLED-LATER');
    run.advance(20n * MIN);
    const manual = { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'MANUAL', weights: ['250.0', '250.1', '249.9'], sampledAtUs: T0.toString() };
    expect(rec(run, manual).accepted).toBe(true);
    const d = lastData(run, 'WEIGHT_CHECK');
    expect([d['capture'], d['late'], d['sampledAtUs'], d['result']]).toEqual(['MANUAL', true, T0.toString(), 'PASS']);
    expect(types(run)).toEqual(['IPC_LATE_ENTRY', 'IPC_MANUAL_ENTRY']);
    expect(run.inst('p')?.verificationRequired).toBe(true);
  });

  it('[INV-41][IN-34][PR-29] weight variation (d): a first stage of 10 that fails its acceptance value asks for the second stage; a new first stage never replaces it and the step cannot close; the second stage is evaluated on all 30 units, the first stage\'s kept', () => {
    const run = runOf(TB12, { mode: 'CONTENT', tabletType: 'UNCOATED' }, ['IN', 'US']);
    expect(rec(run, weigh(Array.from({ length: 10 }, () => '250.0'))).refusal?.code).toBe('TB12-ASSAY');
    const first = ['210.0', '290.0', '220.0', '280.0', '230.0', '270.0', '240.0', '260.0', '250.0', '250.0'];
    expect(rec(run, weigh(first, { assay: '99.0', assayRef: 'TEST-LIMS-01' })).accepted).toBe(true);
    const d = lastData(run, 'WEIGHT_CHECK');
    const crit = (d['evaluation'] as Json)['criteria'] as Json[];
    expect(crit.map((c) => c['ruleSet'])).toEqual(['IP-UDU', 'USP-UDU']);
    expect(crit[0]?.['av']).toBe(acceptanceValue(first.map((w) => Dec.parse(w)), Dec.parse('99.0'), Dec.parse('100'), RULE_SETS.find((r) => r.code === 'IP-UDU') as never, false)['av']);
    expect(d['result']).toBe('SECOND_STAGE');
    expect(types(run)).toEqual([]);
    expect(rec(run, weigh(Array.from({ length: 10 }, () => '250.0'), { assay: '99.0', assayRef: 'TEST-LIMS-01' })).refusal?.code).toBe('TB12-SECOND-STAGE-PENDING');
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) }).refusal?.code).toBe('TB12-SECOND-STAGE-PENDING');
    const second = (n: number) => ({ kind: 'WEIGHT_SECOND_STAGE', check: lastId(run, 'WEIGHT_CHECK'), instrument: 'TEST-BAL-01', capture: 'DEVICE', readings: uuids(n), weights: Array.from({ length: n }, () => '250.0') });
    expect(rec(run, second(10)).refusal?.code).toBe('TB12-COUNT');
    expect(rec(run, second(20)).accepted).toBe(true);
    const s = lastData(run, 'WEIGHT_SECOND_STAGE');
    const ev = s['evaluation'] as Json;
    expect([ev['stage'], ev['n'], s['result']]).toEqual(['SECOND', 30, 'PASS']);
    expect(rec(run, second(20)).refusal?.code).toBe('TB12-SECOND-STAGE-TWICE');
    expect(lastData(run, 'WEIGHT_CHECK')['weights']).toEqual(first);
    run.perform('p');
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
  });

  it('[PR-29] statistics (C-13): mean, SD with n - 1, RSD, min and max and their deviations from the mean', () => {
    expect(statistics(['249.8', '251.2', '250.4', '248.9', '252.0'].map((w) => Dec.parse(w)))).toEqual({
      n: 5, sum: '1252.3', mean: '250.4600', min: '248.9', max: '252', sd: '1.2033', rsd: '0.48', minDeviation: '-0.62', maxDeviation: '0.61',
    });
  });
});

describe('TB-13 physical', () => {
  const cfg = {
    n: 3,
    thickness: { individual: { action: { min: '3.2', max: '3.6' } } },
    hardness: { unit: 'kp', individual: { action: { min: '60', max: '120' } }, mean: { action: { min: '60' }, alert: { min: '75' } } },
    defects: ['CAPPING', 'STICKING'],
  };
  const check = (h: string[], defects: string[] = [], extra: Json = {}): Entry => ({
    kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'DEVICE', readings: uuids(6), tablets: h.map((x) => ({ thickness: '3.40', hardness: x })), defects, ...extra,
  });

  it('[IN-35][PR-29][DI-32] breaking force read in kp is judged in N (x 9.80665); one tablet\'s values stay together; a mean below its alert limit warns; a defect fails the check; the parameters and the tablet count are the MBR\'s', () => {
    const run = runOf(TB13, cfg);
    expect(rec(run, check(['7.5', '8.0'])).refusal?.code).toBe('TB13-COUNT');
    expect(rec(run, { ...check(['7.5', '8.0', '7.8']), tablets: [{ thickness: '3.4' }, { thickness: '3.4' }, { thickness: '3.4' }] }).refusal?.code).toBe('TB13-PARAMETERS');
    expect(rec(run, check(['7.5', '8.0', '7.8'], ['CHIPPING'])).refusal?.code).toBe('TB13-APPEARANCE');
    expect(rec(run, check(['7.5', '7.6', '7.7'])).accepted).toBe(true);
    const ev = lastData(run, 'PHYSICAL_CHECK')['evaluation'] as Json;
    expect(ev['hardness']).toEqual({ unit: 'N', mean: '74.5305', min: '73.549875', max: '75.511205', result: 'ALERT' });
    expect(types(run)).toEqual(['IPC_CHECK_ALERT']);
    expect(rec(run, check(['8.0', '8.0', '8.0'], ['CAPPING'])).accepted).toBe(true);
    expect(lastData(run, 'PHYSICAL_CHECK')['result']).toBe('FAIL');
    expect(types(run)).toEqual(['IPC_CHECK_ALERT', 'IPC_CHECK_FAILED']);
  });
});

describe('TB-14 friability', () => {
  const run1 = (initial: string, final: string, extra: Json = {}): Entry => ({
    kind: 'FRIABILITY_RUN', instrument: 'TEST-FRB-01', capture: 'DEVICE', readings: uuids(2), tablets: 26, initialMass: initial, finalMass: final, rotations: 100, rpm: '25.0', broken: false, ...extra,
  });

  it('[IN-35][PR-29] the sample, rotations and rate follow the rule set; the loss is compared after rounding to one decimal (C-15 example 0.645 % reported 0.6 %)', () => {
    const run = runOf(TB14, { tabletType: 'UNCOATED' });
    expect(rec(run, run1('7.100', '7.050')).refusal?.code).toBe('TB14-SAMPLE');
    expect(rec(run, run1('6.512', '6.470', { rotations: 99 })).refusal?.code).toBe('TB14-ROTATIONS');
    expect(rec(run, run1('6.512', '6.470', { rpm: '26.5' })).refusal?.code).toBe('TB14-RATE');
    expect(rec(run, run1('6.512', '6.470')).accepted).toBe(true);
    const d = lastData(run, 'FRIABILITY_RUN');
    expect([d['loss'], d['reported'], d['limit'], d['averageWeight'], d['result']]).toEqual(['0.6450', '0.6', '1', '250.46', 'PASS']);
  });

  it('[INV-41][DI-29][PR-29] a loss above the limit asks for two more runs and the mean of three decides; the first run is never replaced; a broken tablet fails; an MBR limit looser than the rule sets is refused', () => {
    const run = runOf(TB14, { tabletType: 'UNCOATED', limitPercent: '0.8' });
    expect(rec(run, run1('6.500', '6.435')).accepted).toBe(true);
    expect([lastData(run, 'FRIABILITY_RUN')['reported'], lastData(run, 'FRIABILITY_RUN')['result']]).toEqual(['1.0', 'REPEAT']);
    const first = lastId(run, 'FRIABILITY_RUN');
    expect(rec(run, run1('6.500', '6.470')).refusal?.code).toBe('TB14-REPEAT-PENDING');
    expect(rec(run, run1('6.500', '6.470', { repeatOf: first })).accepted).toBe(true);
    expect([lastData(run, 'FRIABILITY_RUN')['run'], lastData(run, 'FRIABILITY_RUN')['result']]).toEqual([2, 'REPEAT']);
    expect(rec(run, run1('6.500', '6.480', { repeatOf: first })).accepted).toBe(true);
    const d = lastData(run, 'FRIABILITY_RUN');
    expect([d['run'], d['meanOfRuns'], d['result']]).toEqual([3, '0.6', 'PASS']);
    expect(types(run)).toEqual([]);
    expect(rec(run, run1('6.500', '6.480', { repeatOf: first })).refusal?.code).toBe('TB14-NOT-REPEATED');
    expect(rec(run, run1('6.500', '6.495', { broken: true })).accepted).toBe(true);
    expect(lastData(run, 'FRIABILITY_RUN')['result']).toBe('FAIL');
    expect(types(run)).toEqual(['IPC_CHECK_FAILED']);
    const looser = blockMbr(TB14, fixturePhase(TB14, { config: { tabletType: 'UNCOATED', limitPercent: '1.2' } }));
    expect(definitionCodes(looser)).toEqual(['TB14-LOOSER']);
  });
});

describe('TB-15 disintegration', () => {
  const start = (extra: Json = {}): Entry => ({ kind: 'DT_START', instrument: 'TEST-DT-01', capture: 'DEVICE', readings: uuids(1), bathTemperature: '37.0', stage: 'MAIN', ...extra });
  const end = (secs: (string | null)[], extra: Json = {}): Entry => ({
    kind: 'DT_END', capture: 'DEVICE', readings: uuids(secs.length), units: secs.map((s) => (s === null ? { disintegrated: false, seconds: '0' } : { disintegrated: true, seconds: s })), ...extra,
  });

  it('[IN-35][PR-29][DI-29] the bath temperature is verified before the start; the time is measured between the entries, never typed; 1 or 2 units failing ask for 12 more and at least 16 of 18 pass; a first run never replaces a due retest', () => {
    const run = runOf(TB15, { tabletType: 'UNCOATED', timeLimit: { value: '10', unit: 'min' } });
    expect(rec(run, start({ bathTemperature: '39.5' })).refusal?.code).toBe('TB15-BATH-TEMP');
    expect(rec(run, start({ stage: 'ACID' })).refusal?.code).toBe('TB15-STAGE');
    expect(rec(run, start()).accepted).toBe(true);
    expect([lastData(run, 'DT_START')['limitSeconds'], lastData(run, 'DT_START')['units'], lastData(run, 'DT_START')['temperature']]).toEqual(['600', 6, { min: '35', max: '39' }]);
    run.advance(8n * MIN);
    expect(rec(run, end(['100', '200', '300', '400', '500', '490'].map((s, i) => (i === 0 ? '481' : s)))).refusal?.code).toBe('TB15-TIME');
    expect(rec(run, end(['100', '200', '300', '400', '470', null])).accepted).toBe(true);
    expect([lastData(run, 'DT_END')['elapsedSeconds'], lastData(run, 'DT_END')['passed'], lastData(run, 'DT_END')['result']]).toEqual(['480.000000', 5, 'RETEST']);
    const firstEnd = lastId(run, 'DT_END');
    expect(rec(run, start()).refusal?.code).toBe('TB15-RETEST-PENDING');
    expect(rec(run, start({ retestOf: firstEnd })).accepted).toBe(true);
    expect(lastData(run, 'DT_START')['units']).toBe(12);
    run.advance(9n * MIN);
    expect(rec(run, end([...Array.from({ length: 11 }, () => '300'), null])).accepted).toBe(true);
    expect([lastData(run, 'DT_END')['passedInAll'], lastData(run, 'DT_END')['result']]).toEqual([16, 'PASS']);
    expect(types(run)).toEqual([]);
  });

  it('[IN-35][PR-29] units observed by hand count only when the run ended within the limit; gastro-resistant tablets run the full acid stage before the buffer stage', () => {
    const run = runOf(TB15, { tabletType: 'UNCOATED', timeLimit: { value: '10', unit: 'min' } });
    expect(rec(run, start({ capture: 'MANUAL', readings: undefined })).accepted).toBe(true);
    run.advance(11n * MIN);
    expect(rec(run, { kind: 'DT_END', capture: 'MANUAL', units: Array.from({ length: 6 }, () => ({ disintegrated: true })) }).accepted).toBe(true);
    expect([lastData(run, 'DT_END')['passed'], lastData(run, 'DT_END')['result']]).toEqual([0, 'FAIL']);
    expect(types(run)).toEqual(['IPC_CHECK_FAILED', 'IPC_MANUAL_ENTRY', 'IPC_MANUAL_ENTRY']);
    const gr = runOf(TB15, { tabletType: 'GASTRO_RESISTANT', acidTime: { value: '5', unit: 'min' } });
    expect(rec(gr, start()).refusal?.code).toBe('TB15-STAGE');
    expect(rec(gr, start({ stage: 'BUFFER' })).refusal?.code).toBe('TB15-NO-ACID');
    expect(rec(gr, start({ stage: 'ACID' })).accepted).toBe(true);
    gr.advance(4n * MIN);
    const intact = { kind: 'DT_END', capture: 'MANUAL', units: Array.from({ length: 6 }, () => ({ disintegrated: false })) };
    expect(rec(gr, intact).refusal?.code).toBe('TB15-ACID-SHORT');
    gr.advance(1n * MIN);
    expect(rec(gr, intact).accepted).toBe(true);
    expect(lastData(gr, 'DT_END')['result']).toBe('BUFFER');
    expect(rec(gr, start({ stage: 'ACID' })).refusal?.code).toBe('TB15-BUFFER-PENDING');
    expect(rec(gr, start({ stage: 'BUFFER' })).accepted).toBe(true);
    expect(lastData(gr, 'DT_START')['limitSeconds']).toBe('600');
  });
});

describe('TB-11 periodic IPC scheduler', () => {
  const base = {
    streams: [{ id: 'L' }, { id: 'R' }],
    plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'QRM-IPC-07' }],
    grace: { value: '5', unit: 'min' },
    sweep: { stations: 4, weight: { individual: { action: { min: '237.5', max: '262.5' } } } },
    weight: { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20, weighing: 'GROUP', tolerance: { action: '2' } },
  };
  const group = (stream: string, g = '5000.0', extra: Json = {}): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', readings: uuids(1), stream, groupWeight: g, ...extra });
  const sweep = (stream: string, n = 4): Entry => ({
    kind: 'STATION_SWEEP', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream, readings: uuids(n), stations: Array.from({ length: n }, (_, i) => ({ station: i + 1, weight: '250.0' })),
  });
  const mbr = (config: Json) => blockMbr(TB11, fixturePhase(TB11, { config: config as never }));

  it('[IN-35][PR-07][PR-29] a compression plan whose most frequent test plus the grace exceeds 30 min is refused, as is a plan without its QRM reference or a compression run without its station sweep', () => {
    expect(definitionCodes(mbr(base))).toEqual([]);
    expect(definitionCodes(mbr({ ...base, grace: { value: '6', unit: 'min' } }))).toEqual(['TB11-CEILING']);
    expect(definitionCodes(mbr({ ...base, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' } }] }))).toEqual(['TB11-QRM']);
    expect(definitionCodes(mbr({ ...base, sweep: undefined }))).toEqual(['TB11-NO-SWEEP']);
    expect(definitionCodes(mbr({ ...base, process: 'OTHER', sweep: undefined, grace: { value: '60', unit: 'min' } }))).toEqual([]);
    expect(definitionCodes(mbr({ ...base, plan: [...base.plan, { test: 'PHYSICAL', every: { value: '30', unit: 'min' }, qrmRef: 'QRM-IPC-07' }] }))).toEqual(['TB11-TEST-CONFIG']);
  });

  it('[IN-35] catalogue test: on a 4-station press the station sweep cannot be recorded with 3 results; every station once', () => {
    const run = runOf(TB11, base);
    expect(rec(run, group('L')).refusal?.code).toBe('TB11-NOT-STARTED');
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    expect(rec(run, sweep('L', 3)).refusal?.code).toBe('TB11-SWEEP-INCOMPLETE');
    expect(rec(run, { ...sweep('L'), stations: [1, 2, 3, 3].map((s) => ({ station: s, weight: '250.0' })) }).refusal?.code).toBe('TB11-SWEEP-INCOMPLETE');
    expect(rec(run, sweep('X')).refusal?.code).toBe('TB11-STREAM');
    expect(rec(run, sweep('L')).accepted).toBe(true);
    expect(lastData(run, 'STATION_SWEEP')['result']).toBe('PASS');
  });

  it('[IN-35] catalogue test as written: on a 16-station press the start check (station sweep) cannot be recorded with 15 results; with all 16 it passes', () => {
    const run = runOf(TB11, { ...base, sweep: { ...base.sweep, stations: 16 } });
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    expect(rec(run, sweep('L', 15)).refusal?.code).toBe('TB11-SWEEP-INCOMPLETE');
    expect(rec(run, sweep('L', 16)).accepted).toBe(true);
    expect(lastData(run, 'STATION_SWEEP')['result']).toBe('PASS');
  });

  it('[IN-35][PR-29][DI-28] catalogue test: run 45 minutes without an IPC entry; the check is missed at 30 minutes (25 min interval + 5 min grace, at the entry\'s time), and the next entry lists it and raises IPC_CHECK_MISSED, which waits for a deviation', () => {
    const run = runOf(TB11, base);
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    run.entry('p', sweep('L'));
    run.entry('p', sweep('R'));
    const entries = () => Object.values(run.state.entries).filter((e) => e.stepKey === 'p@');
    expect(overdue(entries(), base, T0 + 30n * MIN)).toEqual([]);
    expect(overdue(entries(), base, T0 + 30n * MIN + 1n).map((m) => [m.stream, m.test, m.dueUs])).toEqual([
      ['L', 'WEIGHT', (T0 + 25n * MIN).toString()],
      ['R', 'WEIGHT', (T0 + 25n * MIN).toString()],
    ]);
    run.advance(45n * MIN);
    expect(rec(run, group('L')).accepted).toBe(true);
    const d = lastData(run, 'WEIGHT_CHECK');
    expect(d['missed']).toEqual([
      { stream: 'L', test: 'WEIGHT', by: 'TIME', dueUs: (T0 + 25n * MIN).toString() },
      { stream: 'R', test: 'WEIGHT', by: 'TIME', dueUs: (T0 + 25n * MIN).toString() },
    ]);
    expect(types(run)).toEqual(['IPC_CHECK_MISSED']);
    const ex = run.exceptions('IPC_CHECK_MISSED')[0];
    expect([ex?.severity, ex?.deviationRequired, ex?.block?.until, ex?.category]).toEqual(['ACTION', true, 'DEVIATION', 'TIME_LIMIT']);
    // Marked once: the next entry does not list them again (the slot's clock restarts at the marking).
    run.advance(1n * MIN);
    expect(rec(run, group('R')).accepted).toBe(true);
    expect(lastData(run, 'WEIGHT_CHECK')['missed']).toBeUndefined();
  });

  it('[IN-35][PR-29] a running stoppage suspends the clock; a stoppage longer than the restart threshold makes every check due at the restart; a setting change makes it due at once; a check is missed by press count too', () => {
    const cfg = { ...base, streams: [{ id: 'L' }], plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, everyCount: 10000, qrmRef: 'QRM-IPC-07' }] };
    const run = runOf(TB11, cfg);
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01', counter: 0 });
    run.entry('p', sweep('L'));
    const entries = () => Object.values(run.state.entries).filter((e) => e.stepKey === 'p@');
    run.advance(10n * MIN);
    run.entry('p', { kind: 'STOPPAGE_START' });
    expect(overdue(entries(), cfg, T0 + 60n * MIN)).toEqual([]);
    expect(rec(run, group('L', '5000.0', { counter: 100 })).refusal?.code).toBe('TB11-STOPPED');
    run.advance(20n * MIN);
    run.entry('p', { kind: 'STOPPAGE_END' });
    expect(lastData(run, 'STOPPAGE_END')['long']).toBe(true);
    expect(overdue(entries(), cfg, T0 + 35n * MIN).map((m) => m.dueUs)).toEqual([]);
    expect(overdue(entries(), cfg, T0 + 35n * MIN + 1n).map((m) => m.dueUs)).toEqual([(T0 + 30n * MIN).toString()]);
    expect(rec(run, group('L')).refusal?.code).toBe('TB11-COUNTER');
    expect(rec(run, group('L', '5000.0', { counter: 5000 })).accepted).toBe(true);
    expect(lastData(run, 'WEIGHT_CHECK')['missed']).toBeUndefined();
    run.advance(1n * MIN);
    run.entry('p', { kind: 'CHANGE', change: 'SETTING' });
    expect(overdue(entries(), cfg, T0 + 37n * MIN).map((m) => m.dueUs)).toEqual([(T0 + 31n * MIN).toString()]);
    run.advance(1n * MIN);
    expect(rec(run, group('L', '5000.0', { counter: 4000 })).refusal?.code).toBe('TB11-COUNTER-BACK');
    expect(rec(run, group('L', '5000.0', { counter: 15001 })).accepted).toBe(true);
    expect(lastData(run, 'WEIGHT_CHECK')['missed']).toEqual([{ stream: 'L', test: 'WEIGHT', by: 'COUNT' }]);
    expect(types(run)).toEqual(['IPC_CHECK_MISSED']);
  });

  it('[DI-28][PR-29] the press counter is compared as an exact integer up to the largest safe integer, and a counter above 2^53 is refused, never rounded (exit review MEDIUM)', () => {
    const top = Number.MAX_SAFE_INTEGER;
    expect([counterOf(top), counterOf(2 ** 53), counterOf('9007199254740993'), counterOf(1.5)]).toEqual([9007199254740991n, undefined, undefined, undefined]);
    const cfg = { ...base, streams: [{ id: 'L' }], plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, everyCount: 10000, qrmRef: 'QRM-IPC-07' }] };
    const run = runOf(TB11, cfg);
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01', counter: top - 20000 });
    run.entry('p', sweep('L'));
    run.advance(1n * MIN);
    // One below the start, at the top of the range: a Number comparison there is exact only by luck of the range.
    expect(rec(run, group('L', '5000.0', { counter: top - 20001 })).refusal?.code).toBe('TB11-COUNTER-BACK');
    // 2^53 + 1 has no exact JavaScript number: the schema refuses it before any comparison.
    const beyond = rec(run, group('L', '5000.0', { counter: 2 ** 53 + 1 }));
    expect(beyond.accepted).toBe(false);
    expect(beyond.refusal?.code).not.toBe('TB11-COUNTER-BACK');
    expect(rec(run, group('L', '5000.0', { counter: top })).accepted).toBe(true);
    expect(lastData(run, 'WEIGHT_CHECK')['missed']).toEqual([{ stream: 'L', test: 'WEIGHT', by: 'COUNT' }]);
  });

  it('[PR-29][IN-35][INV-41] the step closes only after the run ended, with an end-of-run check of every stream and the sweeps done; a failing check raises IPC_CHECK_FAILED for its stream', () => {
    const run = runOf(TB11, base);
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    run.entry('p', sweep('L'));
    const perform = () => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
    expect(perform().refusal?.code).toBe('TB11-RUNNING');
    run.advance(10n * MIN);
    expect(rec(run, group('R', '5200.0')).accepted).toBe(true);
    expect(run.exceptions('IPC_CHECK_FAILED')[0]?.source.item ?? run.exceptions('IPC_CHECK_FAILED')[0]?.title).toBeDefined();
    run.entry('p', { kind: 'RUN_END' });
    expect(rec(run, { kind: 'STOPPAGE_START' }).refusal?.code).toBe('TB11-ENDED');
    expect(perform().refusal?.code).toBe('TB11-NO-SWEEP');
    run.entry('p', sweep('R'));
    expect(perform().refusal?.code).toBe('TB11-END-CHECK');
    run.entry('p', group('L'));
    run.entry('p', group('R'));
    expect(perform().accepted).toBe(true);
  });
});

