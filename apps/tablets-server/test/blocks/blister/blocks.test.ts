/**
 * Phase 3 slice 4b (builder A): the blister blocks TB-21 (line set-up, independent check and sealing) and TB-22 (leak
 * test) through the engine with the tablets registry and catalogue: the block contract, each golden fixture, and each
 * block's rules (definition checks, entry refusals, exceptions, the schedule at the entries' times, the close). The
 * database's copy of the rules, the line, the holds and the bypass attempts are proven in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, engine } from '@ebmr/recipe-core/pure';
import { BLISTER_TAGS } from '@ebmr/integration-sdk/process';
import { BLISTER_BLOCK_VERSIONS, TB21, TB22 } from '../../../src/blocks/blister/index.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { DUAL1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { blockMbr, defineFor, definitionCodes, fixturePhase, MIN, OP1, phase, Run, runGolden, sig, startRun, T0, VER1 } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
type R = ReturnType<typeof startRun>;
const perform = (run: R, who = OP1) => run.exec({ type: 'SIGN_PERFORMED', actor: who, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), who) });
const refusal = (run: R, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).code;
const last = (run: R, kind: string): Json => {
  const es = Object.values(run.state.entries).filter((e) => e.kind === kind && e.stepKey === 'p@');
  return es.sort((a, b) => a.recordedSeq - b.recordedSeq).at(-1)?.data ?? {};
};
const types = (run: R) => run.exceptions().map((e) => e.type).sort();

const RUN_CONFIG = (TB21.goldenFixture?.phase.config ?? {}) as Json;
const CHECK_CONFIG: Json = { part: 'LINE_CHECK', packFormat: RUN_CONFIG['packFormat'], materials: RUN_CONFIG['materials'], product: RUN_CONFIG['product'] };
const checkPhase = (extra: Json = {}) => phase('p', { block: { type: 'TB-21', version: '1' }, config: { ...CHECK_CONFIG, ...extra } as never, equipment: [{ ref: 'LINE', use: 'USE' }] });
const setup = (over: Json = {}): Entry => ({
  kind: 'LINE_SETUP', machine: 'TEST-BLISTER-01', artworkSet: 'FOIL:ART-1', changeParts: ['SEAL-PLATE-10', 'FORM-TOOL-10'],
  materials: [{ role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L-ALU-1' }, { role: 'FORMING_FILM', material: 'PVC-250', lot: 'L-PVC-1' }], ...over,
});
const runOf = (config: Json = {}) => startRun(blockMbr(fixturePhase(TB21, { config: config as never })));
const temp = (value: string): Entry => ({ kind: 'ACTUAL', tag: 'blister.seal_temp_C', value, unit: 'degC', source: 'MANUAL' });
/** The recipe check and an in-range value of every collected tag (G-06's completeness). */
const sealed = (run: R): void => {
  run.entry('p', { kind: 'RECIPE_CHECK', recipe: 'RCP-BL-10', recipeVersion: '3' });
  for (const [tag, value, unit] of [['blister.form_temp_C', '130.0', 'degC'], ['blister.seal_pressure_bar', '4.00', 'bar'], ['blister.seal_dwell_s', '1.00', 's']]) run.entry('p', { kind: 'ACTUAL', tag, value, unit, source: 'MANUAL' });
};
const leak = (track: string, leaking = '0', over: Json = {}): Entry => ({ kind: 'LEAK_TEST', track, tested: '10', vacuum: '70', holdSeconds: '45', leaking, ...over });
const leakRun = (config: Json = {}) => startRun(blockMbr(fixturePhase(TB22, { config: config as never })));

describe('the blister block versions (contract)', () => {
  it('[DI-10][DI-34] TB-21@1 and TB-22@1 are registered in the tablets registry with every execution part of the block contract, are significant steps of the edition catalogue, TB-21 takes G-06 unchanged, and the blister machine tags are process tags of the SDK', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-21@1', 'TB-22@1']));
    for (const r of reg.report().filter((x) => BLISTER_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of BLISTER_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
    }
    for (const k of Object.keys(blocks.G06.dataSchema?.entries ?? {})) expect(TB21.dataSchema?.entries[k], k).toBe(blocks.G06.dataSchema?.entries[k]);
    for (const k of Object.keys(blocks.G06.configSchema?.fields ?? {})) expect(TB21.configSchema?.fields[k], k).toBe(blocks.G06.configSchema?.fields[k]);
    expect(BLISTER_TAGS.map((t) => `${t.tag} ${t.equipment}`)).toEqual(expect.arrayContaining(['blister.seal_temp_C BLISTER_MACHINE', 'blister.seal_pressure_bar BLISTER_MACHINE', 'blister.seal_dwell_s BLISTER_MACHINE', 'blister.form_temp_C BLISTER_MACHINE']));
  });
});

describe('golden fixtures of the blister blocks', () => {
  for (const b of BLISTER_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p')).toBe(f.expect.status);
    });
  }

  it('[DI-34] the simulator model of each block (both TB-21 parts) plays a nominal path the engine accepts', () => {
    const cases: [blocks.BlockVersion, ReturnType<typeof fixturePhase>][] = [[TB21, fixturePhase(TB21)], [TB21, checkPhase()], [TB22, fixturePhase(TB22)]];
    for (const [b, p] of cases) {
      const mbr = blockMbr(p);
      const run = startRun(mbr);
      const entries = b.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr, frames: [], containers: [], target: () => undefined }) ?? [];
      for (const e of entries) {
        const r = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: e });
        expect(r.accepted, `${b.type} ${e.kind}: ${r.refusal?.code ?? ''}`).toBe(true);
      }
    }
  });
});

describe('TB-21 line check (engine)', () => {
  it('[IN-38] the independent line check has a verifier in the MBR (TB21-INDEPENDENT), and the engine never lets the person who performed it verify it: performer and a different verifier', () => {
    expect(definitionCodes(blockMbr(checkPhase(), []))).toEqual([]);
    expect(definitionCodes(blockMbr({ ...checkPhase(), signatures: { perform: { role: 'OPERATOR' } } }))).toContain('TB21-INDEPENDENT');
    const run = Run.issue(defineFor(blockMbr(checkPhase())), {}, T0);
    run.start('p', [], DUAL1);
    run.entry('p', setup(), [], DUAL1);
    run.entry('p', { kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS' }, [], DUAL1);
    expect(run.inst('p')?.verificationRequired).toBe(true);
    // DUAL1 holds both the operator's and the verifier's roles: the refusal is the segregation, never a missing role.
    expect(perform(run, DUAL1).accepted).toBe(true);
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    const self = run.exec({ type: 'VERIFY', actor: DUAL1, step: 'p', context: [], signature: sig('VERIFIED', DUAL1) });
    expect([self.accepted, self.refusal?.code, self.refusal?.message]).toEqual([false, 'ENG-SEGREGATION', expect.any(String)]);
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
  });

  it('[IN-38][PR-33] change parts and webs are scanned against the pack format: a missing or foreign change part, a wrong material, a web missing or scanned twice are refused; the stored set-up keeps what was scanned and adds the reels in the format\'s order; a failing equipment check leaves the step unperformable', () => {
    const run = startRun(blockMbr(checkPhase()));
    expect(refusal(run, setup({ changeParts: ['FORM-TOOL-10'] }))).toBe('TB21-CHANGE-PART');
    expect(refusal(run, setup({ changeParts: ['FORM-TOOL-10', 'SEAL-PLATE-12'] }))).toBe('TB21-CHANGE-PART');
    expect(refusal(run, setup({ materials: [{ role: 'LIDDING_FOIL', material: 'ALU-25', lot: 'L1' }, { role: 'FORMING_FILM', material: 'PVC-250', lot: 'L2' }] }))).toBe('TB21-MATERIAL');
    expect(refusal(run, setup({ materials: [{ role: 'FORMING_FILM', material: 'PVC-250', lot: 'L2' }] }))).toBe('TB21-MATERIAL');
    expect(refusal(run, setup({ materials: [{ role: 'FORMING_FILM', material: 'PVC-250', lot: 'L2' }, { role: 'FORMING_FILM', material: 'PVC-250', lot: 'L3' }, { role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L1' }] }))).toBe('TB21-MATERIAL');
    expect(refusal(run, { kind: 'EQUIPMENT_CHECK', rogueRemoved: true, changePartsFitted: true, emptyPocketDetector: 'PASS' })).toBe('TB21-NO-SETUP');
    run.entry('p', setup());
    expect(last(run, 'LINE_SETUP')).toMatchObject({ changeParts: ['SEAL-PLATE-10', 'FORM-TOOL-10'], reels: [{ role: 'FORMING_FILM', lot: 'L-PVC-1' }, { role: 'LIDDING_FOIL', lot: 'L-ALU-1' }] });
    expect(refusal(run, setup())).toBe('TB21-SETUP-TWICE');
    expect(refusal(run, temp('175.0'))).toBe('TB21-PART');
    run.entry('p', { kind: 'EQUIPMENT_CHECK', rogueRemoved: false, changePartsFitted: true, emptyPocketDetector: 'PASS' });
    expect(last(run, 'EQUIPMENT_CHECK')['result']).toBe('FAIL');
    expect(perform(run).refusal?.code).toBe('TB21-CHECK');
  });

  it('[PR-33] a printed web names an item of a G-21 step of the MBR with the same material (TB21-PRINTED); a strip pack takes one strip foil (TB21-MATERIALS)', () => {
    const g21 = phase('g21', { block: { type: 'G-21', version: '1' }, config: { items: [{ id: 'FOIL', material: 'ALU-20', artwork: { IN: 'ART-1' }, unit: '1', issue: { need: '100', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' } }] } });
    const printed = (material: string, printedStep?: string) =>
      checkPhase({ materials: [{ role: 'FORMING_FILM', material: 'PVC-250' }, { role: 'LIDDING_FOIL', material, item: 'FOIL' }], ...(printedStep ? { printedStep } : {}) });
    expect(definitionCodes(blockMbr(printed('ALU-20', 'g21'), [g21]))).toEqual([]);
    expect(definitionCodes(blockMbr(printed('ALU-20'), [g21]))).toContain('TB21-PRINTED');
    expect(definitionCodes(blockMbr(printed('ALU-25', 'g21'), [g21]))).toContain('TB21-PRINTED');
    expect(definitionCodes(blockMbr(checkPhase({ packFormat: { form: 'STRIP', unitsPerBlister: '10', changeParts: ['X'] } })))).toContain('TB21-MATERIALS');
  });
});

describe('TB-21 run (engine)', () => {
  it('[PR-37] the run collects the sealing temperature, pressure and dwell with their validated ranges (TB21-SEALING), a thermoform pack the forming temperature (TB21-FORMING), and sets its defect-check sample', () => {
    const actuals = (RUN_CONFIG['actuals'] as Json[]).filter((a) => a['tag'] !== 'blister.seal_dwell_s');
    expect(definitionCodes(blockMbr(fixturePhase(TB21, { config: { actuals } as never })))).toContain('TB21-SEALING');
    const open = (RUN_CONFIG['actuals'] as Json[]).map((a) => (a['tag'] === 'blister.form_temp_C' ? { tag: a['tag'], unit: a['unit'], min: a['min'] } : a));
    expect(definitionCodes(blockMbr(fixturePhase(TB21, { config: { actuals: open } as never })))).toContain('TB21-FORMING');
    expect(definitionCodes(blockMbr(fixturePhase(TB21, { config: { defectCheck: undefined } as never })))).toContain('TB21-SAMPLE');
  });

  it('[PR-37][PR-08] nothing is recorded before the run starts; a sealing value outside its validated range raises PROCESS_VALUE_OUT_OF_LIMITS; a failing defect check raises DEFECT_CHECK_FAILED and the step closes only after a passing one, the run\'s end and its count', () => {
    const run = runOf();
    expect(refusal(run, temp('175.0'))).toBe('TB21-NOT-STARTED');
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    sealed(run);
    run.entry('p', temp('169.9'));
    expect(last(run, 'ACTUAL')['withinLimits']).toBe(false);
    expect(types(run)).toContain('PROCESS_VALUE_OUT_OF_LIMITS');
    expect(refusal(run, { kind: 'DEFECT_CHECK', examined: '25', defects: {} })).toBe('TB21-SAMPLE');
    expect(refusal(run, { kind: 'DEFECT_CHECK', examined: '20', defects: { MISPRINT: '15', FOIL_CUT: '6' } })).toBe('TB21-DEFECTS');
    run.entry('p', { kind: 'DEFECT_CHECK', examined: '20', defects: { MISSING_TABLET: '1' } });
    expect(last(run, 'DEFECT_CHECK')).toMatchObject({ defectTotal: '1', result: 'FAIL', defectCounts: { MISPRINT: '0', FOIL_CUT: '0', MISSING_TABLET: '1', IMPROPER_SEAL: '0' } });
    expect(types(run)).toContain('DEFECT_CHECK_FAILED');
    expect(refusal(run, { kind: 'COUNT', formed: '1', good: '1', setupWaste: '0', samples: '0' })).toBe('TB21-RUNNING');
    run.entry('p', { kind: 'RUN_END' });
    expect(refusal(run, { kind: 'REJECTS', emptyPocket: '1' })).toBe('TB21-ENDED');
    expect(perform(run).refusal?.code).toBeDefined();
    run.entry('p', { kind: 'COUNT', formed: '500', good: '500', setupWaste: '0', samples: '0' });
    expect(refusal(run, { kind: 'COUNT', formed: '500', good: '500', setupWaste: '0', samples: '0' })).toBe('TB21-COUNT-TWICE');
    expect(perform(run).refusal?.code).toBe('TB21-LAST-CHECK');
  });

  it('[DI-28][PR-11][PR-37][DI-26] R10 #3: a recipe check missing at the run\'s end is warned of before RUN_END, and after it is still recorded as a late entry with the person\'s reason (RUN_ENTRY_LATE for QA), so the step can close', () => {
    const run = runOf();
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    for (const [tag, value, unit] of [['blister.form_temp_C', '130.0', 'degC'], ['blister.seal_temp_C', '175.0', 'degC'], ['blister.seal_pressure_bar', '4.00', 'bar'], ['blister.seal_dwell_s', '1.00', 's']]) run.entry('p', { kind: 'ACTUAL', tag, value, unit, source: 'MANUAL' });
    run.entry('p', { kind: 'DEFECT_CHECK', examined: '20', defects: {} });
    // Before RUN_END the step screen warns that the recipe check is missing (advisory: RUN_END stays possible).
    const warned = engine.entryWarnings(run.def, run.state, 'p@', { nowUs: run.nowUs });
    expect(warned['RUN_END']).toMatch(/Check the recipe the equipment runs first.*late entry with a reason/s);
    expect(warned['LATE_REASON']).toBeUndefined();
    run.entry('p', { kind: 'RUN_END' });
    expect(engine.entryWarnings(run.def, run.state, 'p@', { nowUs: run.nowUs })['RUN_END']).toBeUndefined();
    run.entry('p', { kind: 'COUNT', formed: '500', good: '500', setupWaste: '0', samples: '0' });
    expect(perform(run).refusal?.code).toBe('G06-RECIPE-UNCHECKED');
    // The way out: a late entry with a reason; without one, the check stays refused after the run's end.
    expect(refusal(run, { kind: 'RECIPE_CHECK', recipe: 'RCP-BL-10', recipeVersion: '3' })).toBe('TB21-ENDED');
    expect(refusal(run, { kind: 'LATE_REASON', reason: '   ' })).toBe('TB21-LATE-REASON');
    run.entry('p', { kind: 'LATE_REASON', reason: 'Recipe screen checked at start but not recorded' });
    expect(last(run, 'LATE_REASON')).toStrictEqual({ reason: 'Recipe screen checked at start but not recorded', recordedBy: OP1.id });
    const late = run.exceptions('RUN_ENTRY_LATE');
    expect(late.map((e) => [e.category, e.severity, e.qaOnly, e.status])).toEqual([['LATE_ENTRY', 'ALERT', true, 'OPEN']]);
    expect(late[0]?.title).toMatch(/Recipe screen checked at start but not recorded/);
    expect(refusal(run, { kind: 'ALARM', tag: 'blister.seal_temp_C', value: '1', unit: 'degC', source: 'MANUAL' })).toBe('TB21-ENDED');
    expect(refusal(run, { kind: 'REJECTS', emptyPocket: '1' })).toBe('TB21-ENDED');
    run.entry('p', { kind: 'RECIPE_CHECK', recipe: 'RCP-BL-10', recipeVersion: '3' });
    // One reason covers one late entry.
    expect(refusal(run, { kind: 'RECIPE_CHECK', recipe: 'RCP-BL-10', recipeVersion: '3' })).toBe('TB21-ENDED');
    expect(perform(run).accepted).toBe(true);
  });

  it('[PR-37] pocket and vision rejects feed the count reconciliation: unexplained = formed - (good + rejects + set-up waste + samples), any difference BLISTER_COUNT_UNEXPLAINED; the good units are good blisters times tablets per blister', () => {
    const run = runOf();
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    run.entry('p', { kind: 'REJECTS', emptyPocket: '12', vision: '3' });
    run.entry('p', { kind: 'REJECTS', brokenPocket: '5' });
    expect(last(run, 'REJECTS')).toMatchObject({ emptyPocket: '0', brokenPocket: '5', vision: '0', total: '5' });
    run.entry('p', { kind: 'RUN_END' });
    run.entry('p', { kind: 'COUNT', formed: '1000', good: '950', setupWaste: '20', samples: '4' });
    expect(last(run, 'COUNT')).toMatchObject({ rejects: '20', unexplained: '6', goodUnits: '9500' });
    expect(types(run)).toEqual(['BLISTER_COUNT_UNEXPLAINED']);
  });

  it('[PR-33] a reel change takes a web of the pack format only and needs a second person', () => {
    const run = runOf();
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    expect(refusal(run, { kind: 'REEL_CHANGE', role: 'LIDDING_FOIL', material: 'ALU-25', lot: 'L9' })).toBe('TB21-MATERIAL');
    expect(refusal(run, { kind: 'REEL_CHANGE', role: 'STRIP_FOIL', material: 'ALU-20', lot: 'L9' })).toBe('TB21-MATERIAL');
    run.entry('p', { kind: 'REEL_CHANGE', role: 'LIDDING_FOIL', material: 'ALU-20', lot: 'L9' });
    expect(run.inst('p')?.verificationRequired).toBe(true);
  });
});

describe('TB-22 leak test (engine)', () => {
  it('[IN-38][PR-29] the schedule is defined with an interval, a grace, a risk assessment and validated vacuum and hold ranges', () => {
    expect(definitionCodes(blockMbr(fixturePhase(TB22)))).toEqual([]);
    expect(definitionCodes(blockMbr(fixturePhase(TB22, { config: { qrmRef: undefined } as never })))).toContain('TB22-QRM');
    expect(definitionCodes(blockMbr(fixturePhase(TB22, { config: { hold: { min: '60', max: '30' } } })))).toContain('TB22-METHOD');
    expect(definitionCodes(blockMbr(fixturePhase(TB22, { config: { tracks: ['T1', 'T1'] } })))).toContain('TB22-TRACKS');
    expect(definitionCodes(blockMbr(fixturePhase(TB22, { config: { tracks: ['LINE'] } })))).toContain('TB22-TRACKS');
  });

  it('[IN-38][PR-29] any leaking pocket fails the test (LEAK_TEST_FAILED); a test outside the validated vacuum or hold time is no test; the units and the track are the MBR\'s; the keyed parameters need a second person', () => {
    const run = leakRun();
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    expect(refusal(run, leak('T1', '0', { vacuum: '55' }))).toBe('TB22-PARAMETERS');
    expect(refusal(run, leak('T1', '0', { holdSeconds: '61' }))).toBe('TB22-PARAMETERS');
    expect(refusal(run, leak('T1', '0', { tested: '9' }))).toBe('TB22-SAMPLE');
    expect(refusal(run, leak('T3'))).toBe('TB22-TRACK');
    expect(refusal(run, leak('T1', '11'))).toBe('TB22-LEAKING');
    run.entry('p', leak('T1', '1'));
    expect(last(run, 'LEAK_TEST')).toMatchObject({ track: 'T1', leaking: '1', result: 'FAIL' });
    expect(types(run)).toEqual(['LEAK_TEST_FAILED']);
    expect(run.inst('p')?.verificationRequired).toBe(true);
  });

  it('[IN-38][PR-29] a test is due at the start, one interval after the track\'s last test, at once after a reel change and at the end; one not made within the grace is missed and the next entry lists it with LEAK_TEST_MISSED (IN-38 (c))', () => {
    const run = leakRun();
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01' });
    run.advance(6n * MIN);
    run.entry('p', leak('T1'));
    const started = Object.values(run.state.entries).find((e) => e.kind === 'RUN_START')?.recordedAt.toString();
    expect(last(run, 'LEAK_TEST')['missed']).toEqual([
      { stream: 'T1', test: 'LEAK', by: 'TIME', dueUs: started },
      { stream: 'T2', test: 'LEAK', by: 'TIME', dueUs: started },
    ]);
    expect(types(run)).toEqual(['LEAK_TEST_MISSED']);
    run.entry('p', leak('T2'));
    expect(last(run, 'LEAK_TEST')['missed']).toBeUndefined();
    run.advance(10n * MIN);
    run.entry('p', { kind: 'EVENT', event: 'REEL_CHANGE' });
    run.advance(4n * MIN);
    run.entry('p', leak('T1'));
    expect(last(run, 'LEAK_TEST')['missed']).toBeUndefined();
    run.advance(2n * MIN);
    run.entry('p', leak('T1'));
    expect((last(run, 'LEAK_TEST')['missed'] as Json[]).map((m) => m['stream'])).toEqual(['T2']);
    run.entry('p', { kind: 'RUN_END' });
    expect(perform(run).refusal?.code).toBe('TB22-END-TEST');
    run.entry('p', leak('T1'));
    run.entry('p', leak('T2'));
    expect(perform(run).accepted).toBe(true);
  });

  it('[PR-29] with a count interval every test gives the machine counter; a test whose counter advanced more than the interval since the track\'s last test is missed by count; the counter never goes back', () => {
    const run = leakRun({ everyCount: '5000', tracks: undefined });
    run.entry('p', { kind: 'RUN_START', machine: 'TEST-BLISTER-01', counter: 100 });
    expect(refusal(run, leak('LEAK'))).toBe('TB22-COUNTER');
    run.entry('p', leak('LEAK', '0', { counter: 200 }));
    expect(refusal(run, leak('LEAK', '0', { counter: 150 }))).toBe('TB22-COUNTER-BACK');
    run.entry('p', leak('LEAK', '0', { counter: 5201 }));
    expect(last(run, 'LEAK_TEST')['missed']).toEqual([{ stream: 'LEAK', test: 'LEAK', by: 'COUNT' }]);
    expect(types(run)).toEqual(['LEAK_TEST_MISSED']);
  });
});
