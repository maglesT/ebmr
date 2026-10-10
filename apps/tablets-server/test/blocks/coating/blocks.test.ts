/**
 * Phase 3 slice 3d (builder A): the coating and finishing blocks TB-18, TB-19 and TB-20 through the engine with the
 * tablets registry and catalogue: the block contract, each golden fixture, and each block's rules (definition checks,
 * entry refusals, exceptions, computed items, the weight-gain loop, the QC gate, the close). The database's copy of the
 * rules is proven in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, engine } from '@ebmr/recipe-core/pure';
import type { flow } from '@ebmr/recipe-core/pure';
import { COATING_BLOCK_VERSIONS, TB18, TB19, TB20 } from '../../../src/blocks/coating/index.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, mbrWithChildren, coatingMbr, RECIPE_CHECK, DESTROY, definitionCodes, fixturePhase, iteration, LOOP, OP1, phase, QA1, QC_GATE, Run, runGolden, SUP1, sig, startRun, T0, VER1, defineFor } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const perform = (run: Run, step = 'p', frames: flow.Frame[] = []) => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step, context: frames, signature: sig(engine.performMeaning(run.def, step), OP1) });
const refusal = (run: Run, entry: Entry, frames: flow.Frame[] = [], step = 'p') => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step, context: frames, entry }).code;

describe('the coating block versions (contract)', () => {
  it('[DI-10][DI-34] TB-18@1, TB-19@1 and TB-20@1 are registered in the tablets registry with every execution part of the block contract, are known to the edition catalogue as significant steps, and declare every exception type their handlers raise; TB-18 takes G-06 unchanged', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-18@1', 'TB-19@1', 'TB-20@1']));
    for (const r of reg.report().filter((x) => COATING_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of COATING_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
    }
    for (const k of Object.keys(blocks.G06.dataSchema?.entries ?? {})) expect(TB18.dataSchema?.entries[k], k).toBe(blocks.G06.dataSchema?.entries[k]);
    for (const k of Object.keys(blocks.G06.configSchema?.fields ?? {})) expect(TB18.configSchema?.fields[k], k).toBe(blocks.G06.configSchema?.fields[k]);
  });
});

describe('golden fixtures of the coating blocks', () => {
  for (const b of COATING_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p')).toBe(f.expect.status);
      for (const [item, v] of Object.entries(f.expect.values ?? {})) expect(out.run.value(item, 'p'), item).toBe(v);
      const declared = new Set([...(b.simulatorModel?.exceptionTypes(out.run.def.steps.get('p')?.node as never) ?? []), ...(b.exceptionRules ?? []).map((r) => r.type)]);
      for (const t of out.run.exceptions().map((e) => e.type)) expect(declared.has(t), `${b.type} raised ${t}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// TB-18

const actual = (tag: string, value: string, n: number, receivedAtUs: bigint): Entry => ({
  kind: 'ACTUAL', tag, value, unit: { 'inlet.temp_C': 'degC', 'exhaust.temp_C': 'degC', 'bed.temp_C': 'degC', 'spray.rate_g_min': 'g/min', 'pan.speed_rpm': 'rpm' }[tag] ?? '1',
  source: 'EQUIPMENT', readingId: U(n), quality: 'GOOD', receivedAtUs: receivedAtUs.toString(),
});
const NOMINAL: Record<string, string> = { 'inlet.temp_C': '52.0', 'exhaust.temp_C': '32.0', 'bed.temp_C': '41.0', 'spray.rate_g_min': '120.0', 'pan.speed_rpm': '3.0' };
let reading = 100;
function logAll(run: Run, frames: flow.Frame[], over: Record<string, string> = {}): void {
  for (const [tag, v] of Object.entries(NOMINAL)) run.entry('p', actual(tag, over[tag] ?? v, (reading += 1), run.nowUs), frames);
}
const coated = (total: string): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'BAL-01', weighing: 'GROUP', count: '20', total, unit: 'mg' });

/** The cores step done (core mean 250.060000 mg), the run at the first coating iteration, started. */
function coatingRun(opts: Parameters<typeof coatingMbr>[0] = {}): Run {
  const run = Run.issue(defineFor(coatingMbr(opts)), {}, T0);
  run.ok({ type: 'START_STEP', actor: OP1, step: 'cores', context: [] });
  for (const s of TB18.goldenFixture?.script ?? []) if ('entry' in s) run.entry('cores', s.entry);
  run.perform('cores');
  run.verify('cores');
  run.ok({ type: 'START_STEP', actor: OP1, step: 'p', context: iteration(1) });
  return run;
}

/** One coating iteration: spray with every parameter logged, the suspension, the check, performed and verified. */
function iterate(run: Run, n: number, total: string): void {
  const f = iteration(n);
  if (run.status('p', f) === 'ENABLED') run.ok({ type: 'START_STEP', actor: OP1, step: 'p', context: f });
  run.entry('p', RECIPE_CHECK, f);
  run.entry('p', { kind: 'SPRAY_START' }, f);
  logAll(run, f);
  run.advance(600_000_000n);
  logAll(run, f);
  run.entry('p', { kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '6.000', unit: 'kg' } }, f);
  run.entry('p', { kind: 'SPRAY_END' }, f);
  run.entry('p', coated(total), f);
  perform(run, 'p', f);
  run.verify('p', f, VER1);
  run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: LOOP, context: f });
}

describe('TB-18 coating to weight gain', () => {
  it('[IN-37][PR-08][DI-34] a coating step collects the inlet, exhaust and bed temperatures, spray rate and pan speed with limits, computes the weight gain into a process end point with limits, and sits in a bounded loop on it (1 to 20); a functional film sets its minimum; the cores step sets the room limits', () => {
    expect(definitionCodes(coatingMbr())).toEqual([]);
    expect(definitionCodes(coatingMbr({ config: { actuals: [{ tag: 'inlet.temp_C', unit: 'degC', min: '50.0', max: '55.0' }] } }))).toContain('TB18-PARAMETERS');
    expect(definitionCodes(coatingMbr({ config: { coatingType: 'FC_F' } }))).toContain('TB18-MIN-GAIN');
    expect(definitionCodes(coatingMbr({ config: { coatingType: 'FC_F', minGain: '2.5' } }))).toEqual([]);
    expect(definitionCodes(coatingMbr({ without: ['maxGain'] }))).toContain('TB18-MAX-GAIN');
    expect(definitionCodes(coatingMbr({ maxIterations: 21 }))).toContain('TB18-ITERATIONS');
    const flat = coatingMbr();
    const seq = flat.procedure.body as flow.SequenceNode;
    const ops = ((seq.children[0] as flow.StageNode).body as flow.OperationNode).body as flow.SequenceNode;
    ops.children[1] = (ops.children[1] as flow.LoopNode).body;
    expect(definitionCodes(flat)).toContain('TB18-NO-LOOP');
    expect(definitionCodes(blockMbr(TB18, fixturePhase(TB18, { config: { room: undefined } as never })))).toContain('TB18-ROOM');
    expect(definitionCodes(blockMbr(TB18, fixturePhase(TB18, { config: { gainItem: 'gain' } })))).toContain('TB18-PART');
  });

  it('[IN-37][DI-29][INV-25] cores: the pan air is filtered, the room and the load are judged against the MBR, the core sample is the MBR\'s count and its mean is the block\'s; one by one keeps every weight; manual weights need a second person', () => {
    const run = startRun(blockMbr(TB18));
    expect(refusal(run, { kind: 'ROOM_CHECK', filteredAir: false, temperature: '24.0', humidity: '45' })).toBe('TB18-AIR');
    run.entry('p', { kind: 'ROOM_CHECK', filteredAir: true, temperature: '26.0', humidity: '45' });
    expect(run.exceptions().map((e) => e.type)).toEqual(['ROOM_CONDITIONS_OUT_OF_LIMITS']);
    run.entry('p', { kind: 'PAN_LOAD', quantity: { value: '90.000', unit: 'kg' } });
    expect(run.exceptions().map((e) => e.type).sort()).toEqual(['LOAD_OUT_OF_RANGE', 'ROOM_CONDITIONS_OUT_OF_LIMITS']);
    expect(refusal(run, { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'GROUP', count: '10', total: '2500', unit: 'mg' })).toBe('TB18-SAMPLE');
    expect(refusal(run, { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'INDIVIDUAL', count: '20', weights: ['250.0'], unit: 'mg' })).toBe('TB18-SAMPLE');
    expect(perform(run).refusal?.code).toBe('TB18-NO-SAMPLE');
    const weights = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '250.1' : '249.9'));
    run.entry('p', { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'INDIVIDUAL', count: '20', weights, unit: 'mg' });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'CORE_SAMPLE');
    expect([e?.data['weights'], e?.data['totalMg'], e?.data['meanMg']]).toEqual([weights, '5000', '250.000000']);
    expect(refusal(run, { kind: 'CORE_SAMPLE', instrument: 'BAL-01', weighing: 'GROUP', count: '20', total: '5000', unit: 'mg' })).toBe('TB18-SAMPLE-TWICE');
    expect(perform(run).accepted).toBe(true);
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    run.verify('p', [], VER1);
    expect(run.value('coreMean', 'p')).toBe('250.000000');
    // The core mean is the block's: typing it is refused (INV-25).
    const again = startRun(blockMbr(TB18));
    expect(again.refused({ type: 'RECORD_DATA', actor: OP1, step: 'p', context: [], item: 'coreMean', value: { kind: 'DECIMAL', value: '250.0', unit: 'mg' }, source: { mode: 'MANUAL' } }).code).toMatch(/^ENG-/);
  });

  it('[IN-37][PR-08][PR-29][DI-29][DI-34] coating: spraying is measured, every parameter logged at the interval or PARAMETER_LOG_GAP, the check comes after spraying and once per iteration, the weight gain against the core mean is the block\'s; continued coating is the next loop iteration until the end point is reached', () => {
    const run = coatingRun();
    const f1 = iteration(1);
    expect(refusal(run, coated('5100'), f1)).toBe('TB18-CHECK-EARLY');
    expect(refusal(run, { kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '1', unit: 'kg' } }, f1)).toBe('TB18-NOT-SPRAYING');
    expect(refusal(run, { kind: 'APPLICATION', phase: 'SEAL' }, f1)).toBe('TB18-NOT-SUGAR');
    run.entry('p', RECIPE_CHECK, f1);
    run.entry('p', { kind: 'SPRAY_START' }, f1);
    logAll(run, f1);
    run.advance(1_200_000_000n); // 20 min: beyond the 15 min interval with no value in between
    logAll(run, f1, { 'inlet.temp_C': '57.0' });
    expect(run.exceptions().map((e) => e.type)).toEqual(['PROCESS_VALUE_OUT_OF_LIMITS']);
    run.entry('p', { kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '5.000', unit: 'kg' } }, f1);
    run.entry('p', { kind: 'SPRAY_END' }, f1);
    const end = Object.values(run.state.entries).find((x) => x.kind === 'SPRAY_END');
    expect([end?.data['sprayingSeconds'], end?.data['logGaps']]).toEqual(['1200.000000', ['inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'pan.speed_rpm']]);
    expect(run.exceptions().map((e) => e.type).sort()).toEqual(['PARAMETER_LOG_GAP', 'PROCESS_VALUE_OUT_OF_LIMITS']);
    expect(perform(run, 'p', f1).refusal?.code).toBe('TB18-NO-CHECK');
    run.entry('p', coated('5100.0'), f1); // 255.0 mg against 250.06: 1.9755 %
    const chk = Object.values(run.state.entries).find((x) => x.kind === 'WEIGHT_CHECK');
    expect([chk?.data['coreMeanMg'], chk?.data['weightGain'], chk?.data['aboveMaximum']]).toEqual(['250.060000', '1.9755', false]);
    expect(refusal(run, coated('5150.0'), f1)).toBe('TB18-CHECK-TWICE');
    expect(perform(run, 'p', f1).accepted).toBe(true);
    run.verify('p', f1, VER1);
    expect(run.value('gain', 'p', f1)).toBe('1.9755');
    run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: LOOP, context: f1 });
    expect(run.status('p', iteration(2))).toBe('ENABLED');
    for (const ex of run.exceptions()) run.ok({ type: 'ATTACH_DEVIATION', actor: SUP1, exception: ex.id, deviationRef: `DEV-${ex.id}` });
    iterate(run, 2, '5150.0'); // 257.5 mg: 2.9753 %
    expect(run.status('p', iteration(3))).toBe('ENABLED');
    iterate(run, 3, '5154.0'); // 257.7 mg: 3.0553 %
    expect(run.value('gain', 'p', iteration(3))).toBe('3.0553');
    const outcomes = Object.values(run.state.decisions).map((d) => `${d.key}=${d.outcome}`);
    expect(outcomes).toEqual([`${LOOP}@${LOOP}=1=CONTINUE`, `${LOOP}@${LOOP}=2=CONTINUE`, `${LOOP}@${LOOP}=3=EXIT`]);
    expect(run.status('after')).toBe('ENABLED');
  });

  it('[IN-37][PR-08] a weight gain above the maximum waits for QA; the loop at its maximum without the end point is exhausted (an exception, never rework)', () => {
    const run = coatingRun({ maxIterations: 1 });
    iterate(run, 1, '5200.0'); // 260.0 mg: 3.9750 %, above 3.5
    const types = run.exceptions().map((e) => e.type).sort();
    expect(types).toContain('WEIGHT_GAIN_ABOVE_MAXIMUM');
    const ex = run.exceptions('WEIGHT_GAIN_ABOVE_MAXIMUM')[0];
    expect([ex?.qaOnly, ex?.severity]).toEqual([true, 'ACTION']);
    const low = coatingRun({ maxIterations: 1 });
    iterate(low, 1, '5100.0');
    expect(low.exceptions('LOOP_EXHAUSTED')).toHaveLength(1);
    expect(low.status('p', iteration(2))).toBeUndefined();
  });

  it('[IN-37] sugar coating: each iteration records one application by phase', () => {
    const run = coatingRun({ config: { coatingType: 'SC' } });
    const f = iteration(1);
    run.entry('p', RECIPE_CHECK, f);
    run.entry('p', { kind: 'SPRAY_START' }, f);
    run.entry('p', { kind: 'APPLICATION', phase: 'SEAL' }, f);
    logAll(run, f);
    expect(refusal(run, { kind: 'APPLICATION', phase: 'SUBCOAT' }, f)).toBe('TB18-APPLICATION-TWICE');
    run.entry('p', { kind: 'SPRAY_END' }, f);
    run.entry('p', coated('5100.0'), f);
    expect(perform(run, 'p', f).refusal?.code).toBe('TB18-NO-SUSPENSION');
  });
});

// ---------------------------------------------------------------------------------------------
// TB-19

describe('TB-19 printing with the QC gate', () => {
  const setup = (extra: Json = {}): Entry => ({ kind: 'PRINT_SETUP', printer: 'PRINTER-01', inkLot: 'INK-1', inkEdibleGrade: true, otherProductsPrinting: false, ...extra });
  const check = (extra: Json = {}): Entry => ({ kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects: {}, ...extra });

  it('[IN-37][PR-29] the MBR places a QA hold point right after the printing step, signed by the gate role, that can reject; the mark content comes from the master', () => {
    expect(definitionCodes(blockMbr(TB19))).toEqual([]);
    expect(definitionCodes(blockMbr(TB19, fixturePhase(TB19), []))).toContain('TB19-NO-GATE');
    expect(definitionCodes(blockMbr(TB19, fixturePhase(TB19), [phase('x'), QC_GATE]))).toContain('TB19-NO-GATE');
    expect(definitionCodes(blockMbr(TB19, fixturePhase(TB19), [{ ...QC_GATE, dispositions: ['APPROVED'] } as flow.FlowNode]))).toContain('TB19-NO-GATE');
    expect(definitionCodes(blockMbr(TB19, fixturePhase(TB19, { config: { gateRole: 'QA_REVIEWER' } })))).toContain('TB19-NO-GATE');
    expect(definitionCodes(blockMbr(TB19, fixturePhase(TB19, { config: { content: ' ' } })))).toContain('TB19-CONTENT');
  });

  it('[IN-37][PR-29] edible ink only; simultaneous printing only with a segregation record; checks of the MBR sample after the set-up; a failed check waits for a deviation and the step closes only after a passing check', () => {
    const run = startRun(blockMbr(TB19));
    expect(refusal(run, check())).toBe('TB19-NO-SETUP');
    expect(refusal(run, setup({ inkEdibleGrade: false }))).toBe('TB19-INK');
    expect(refusal(run, setup({ otherProductsPrinting: true }))).toBe('TB19-SEGREGATION');
    expect(refusal(run, setup({ segregationRecord: 'SEG-1' }))).toBe('TB19-SEGREGATION');
    run.entry('p', setup({ otherProductsPrinting: true, segregationRecord: 'SEG-2026-014' }));
    expect(refusal(run, check({ examined: '40' }))).toBe('TB19-SAMPLE');
    expect(refusal(run, check({ defects: { SMUDGED: '51' } }))).toBe('TB19-DEFECTS');
    run.entry('p', check({ contentMatches: false }));
    const e = Object.values(run.state.entries).find((x) => x.kind === 'PRINT_CHECK');
    expect([e?.data['result'], e?.data['content']]).toEqual(['FAIL', 'C3']);
    expect(run.exceptions().map((x) => x.type)).toEqual(['PRINT_CHECK_FAILED']);
    expect(perform(run).refusal?.code).toBe('TB19-LAST-CHECK');
    run.entry('p', check());
    expect(perform(run).accepted).toBe(true);
  });

  it('[IN-37][PR-45] nothing after printing runs until the QC hold point is signed; it is not released while a failed check is open; not approved rejects the printed tablets and holds the batch', () => {
    const run = startRun(blockMbr(TB19));
    run.entry('p', { kind: 'PRINT_SETUP', printer: 'PRINTER-01', inkLot: 'INK-1', inkEdibleGrade: true, otherProductsPrinting: false });
    run.entry('p', { kind: 'PRINT_CHECK', examined: '50', legible: false, contentMatches: true, defects: {} });
    run.entry('p', { kind: 'PRINT_CHECK', examined: '50', legible: true, contentMatches: true, defects: {} });
    perform(run);
    run.verify('p', [], VER1);
    expect(run.refused({ type: 'START_STEP', actor: OP1, step: 'after', context: [] }).code).toMatch(/^ENG-/);
    const hold = (d: string) => run.exec({ type: 'DISPOSITION_HOLD_POINT', actor: QA1, step: 'H-PRINT', context: [], disposition: d, signature: sig(engine.holdPointMeaning(d), QA1) });
    expect(hold('APPROVED').refusal?.code).toBe('ENG-HOLD-OPEN-EXCEPTIONS');
    expect(hold('NOT_APPROVED').accepted).toBe(true);
    expect(run.exceptions('HOLD_POINT_NOT_APPROVED')).toHaveLength(1);
    expect(run.state.status).toBe('ON_HOLD');
  });
});

// ---------------------------------------------------------------------------------------------
// TB-20

describe('TB-20 inspection, sorting and AQL', () => {
  const sort = (extra: Json = {}): Entry => ({
    kind: 'SORT_RESULT',
    inspected: { count: '200000', mass: { value: '50.000', unit: 'kg' } },
    accepted: { count: '199680', mass: { value: '49.915', unit: 'kg' } },
    defects: [{ code: 'CHIPPED', count: '300' }, { code: 'BLACK-SPOT', count: '20' }],
    rejects: [{ category: 'DESTRUCTION', container: '00000000-0000-4000-8000-000000000001', count: '320', mass: { value: '0.080', unit: 'kg' } }],
    ...extra,
  });
  const sorted = (): Run => {
    const run = startRun(blockMbr(TB20));
    run.entry('p', { kind: 'INSPECTION_START' });
    run.advance(3_600_000_000n);
    run.entry('p', { kind: 'INSPECTION_END' });
    return run;
  };

  it('[PR-46][IN-35] the MBR has a defect catalogue (a foreign tablet is critical), an AQL plan and a witnessed G-23 destruction step; reusable residue only with a recovery step', () => {
    expect(definitionCodes(blockMbr(TB20))).toEqual([]);
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20), []))).toContain('TB20-DESTRUCTION');
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20), [{ ...DESTROY, signatures: { perform: { role: 'OPERATOR' }, check: { meaning: 'VERIFIED', role: 'VERIFIER' } } }]))).toContain('TB20-DESTRUCTION');
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20, { config: { defects: [{ code: 'FOREIGN', class: 'MAJOR', foreign: true }] } })))).toContain('TB20-CATALOGUE');
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20, { config: { reusableResidue: true } })))).toContain('TB20-RESIDUE');
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20, { config: { mode: 'VISION' } })))).toContain('TB20-VISION');
    // Review 3d finding 2: the destruction step is a later step of the inspection's sequence and never skippable.
    const before = mbrWithChildren([DESTROY, fixturePhase(TB20), phase('after')]);
    expect(definitionCodes(before)).toContain('TB20-DESTRUCTION');
    expect(definitionCodes(blockMbr(TB20, fixturePhase(TB20), [{ ...DESTROY, config: { skippable: true } }]))).toContain('TB20-DESTRUCTION');
  });

  it('[PR-46][IN-35] the sort result is reconciled exactly: inspected = accepted + rejects, one defect code per reject, masses without a negative remainder; rejects are for destruction in identified containers', () => {
    const run = sorted();
    expect(refusal(run, sort({ accepted: { count: '199681', mass: { value: '49.915', unit: 'kg' } } }))).toBe('TB20-RECONCILE');
    expect(refusal(run, sort({ defects: [{ code: 'CHIPPED', count: '300' }] }))).toBe('TB20-RECONCILE');
    expect(refusal(run, sort({ accepted: { count: '199680', mass: { value: '49.925', unit: 'kg' } } }))).toBe('TB20-RECONCILE');
    expect(refusal(run, sort({ defects: [{ code: 'CRACKED', count: '320' }] }))).toBe('TB20-DEFECT');
    expect(refusal(run, sort({ rejects: [{ category: 'REUSABLE_RESIDUE', container: '00000000-0000-4000-8000-000000000001', count: '320', mass: { value: '0.080', unit: 'kg' } }] }))).toBe('TB20-RESIDUE');
    expect(refusal(run, sort({ rejects: [{ category: 'DESTRUCTION', container: '00000000-0000-4000-8000-000000000001', count: '320', mass: { value: '80', unit: 'g' } }] }))).toBe('TB20-UNIT');
    run.entry('p', sort());
    const e = Object.values(run.state.entries).find((x) => x.kind === 'SORT_RESULT');
    expect([e?.data['rejectCount'], e?.data['unaccountedMass'], e?.data['defectsByClass']]).toEqual(['320', { value: '0.005', unit: 'kg' }, { CRITICAL: '0', MAJOR: '300', MINOR: '20' }]);
  });

  it('[PR-50][PR-46] a foreign tablet found in sorting is critical: QA decides, release is blocked, a deviation is required', () => {
    const run = sorted();
    run.entry('p', sort({ defects: [{ code: 'CHIPPED', count: '299' }, { code: 'BLACK-SPOT', count: '20' }, { code: 'FOREIGN', count: '1' }] }));
    const ex = run.exceptions('FOREIGN_TABLET_FOUND')[0];
    expect([ex?.severity, ex?.qaOnly, ex?.releaseBlocking, ex?.deviationRequired]).toEqual(['CRITICAL', true, true, true]);
  });

  it('[PR-29][PR-46][PR-47][INV-41][DI-10] the AQL plan is the scheme\'s for the sorted lot (letter, sample, accept and reject numbers per class, critical at zero); a rejected lot waits for QA and is never sampled again in the block', () => {
    const run = sorted();
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', found: {} })).toBe('TB20-AQL-EARLY');
    run.entry('p', sort());
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', found: { MAJOR: '801' } })).toBe('TB20-FOUND');
    run.entry('p', { kind: 'AQL_RESULT', severity: 'TIGHTENED', found: { MAJOR: '9' } });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'AQL_RESULT');
    expect([e?.data['letter'], e?.data['sampleSize'], e?.data['result'], e?.data['scheme']]).toEqual(['P', '800', 'REJECTED', 'AQL-SINGLE-SAMPLING']);
    expect((e?.data['classes'] as Json)['MAJOR']).toEqual({ aql: '0.65', letter: 'P', n: '800', ac: '8', re: '9', found: '9', accepted: false });
    const ex = run.exceptions('AQL_REJECTED')[0];
    expect([ex?.qaOnly, ex?.releaseBlocking, ex?.block?.until]).toEqual([true, true, 'DISPOSITION']);
    expect(refusal(run, { kind: 'AQL_RESULT', severity: 'NORMAL', found: {} })).toBe('TB20-AQL-TWICE');
    const crit = sorted();
    crit.entry('p', sort());
    crit.entry('p', { kind: 'AQL_RESULT', severity: 'NORMAL', found: { CRITICAL: '1' } });
    expect(crit.exceptions('AQL_REJECTED')).toHaveLength(1);
  });
});

describe('TB-18 simulator model', () => {
  it('[IN-37][PR-29] a nominal coating iteration sprays, logs every collected tag and weighs the coated sample at the target gain over the core mean the step reads', () => {
    const run = coatingRun();
    const node = run.def.steps.get('p')?.node as flow.PhaseNode;
    const nominal = TB18.simulatorModel?.nominalEntries({ phase: node, config: node.config, mbr: run.def.mbr, frames: iteration(1), containers: [], target: () => ({ kind: 'DECIMAL', value: '250.060000', unit: 'mg' }), nowUs: run.nowUs }) ?? [];
    expect(nominal.map((e) => e.kind)).toEqual(['SPRAY_START', 'RECIPE_CHECK', 'ACTUAL', 'ACTUAL', 'ACTUAL', 'ACTUAL', 'ACTUAL', 'SPRAY_END', 'WEIGHT_CHECK']);
    expect(nominal.at(-1)).toMatchObject({ count: '20', total: '5151.236000', unit: 'mg' });
  });
});
