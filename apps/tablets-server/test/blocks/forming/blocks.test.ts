/**
 * Phase 3 slice 3d (builder B): the forming blocks TB-06 (roller compaction) and TB-16 (bilayer compression) through the
 * engine with the tablets registry and catalogue: the block contract, each golden fixture, and each block's rules
 * (definition checks, entry refusals, exceptions, the schedule at the entries' times, the close). The database's copy of
 * the rules, the container holds and the bypass attempts are proven in db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, engine } from '@ebmr/recipe-core/pure';
import { FORMING_TAGS } from '@ebmr/integration-sdk/process';
import { FORMING_BLOCK_VERSIONS, TB06, TB16 } from '../../../src/blocks/forming/index.ts';
import { layerConfig } from '../../../src/blocks/tb-16.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { blockMbr, definitionCodes, fixturePhase, MIN, OP1, OP2, phase, runGolden, sig, startRun, VER1 } from './support.ts';

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
type R = ReturnType<typeof startRun>;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const perform = (run: R) => run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig(engine.performMeaning(run.def, 'p'), OP1) });
const refusal = (run: R, entry: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry }).code;
const last = (run: R, kind: string): Json => {
  const es = Object.values(run.state.entries).filter((e) => e.kind === kind && e.stepKey === 'p@');
  return (es.sort((a, b) => a.recordedSeq - b.recordedSeq).at(-1)?.data ?? {});
};
const types = (run: R) => run.exceptions().map((e) => e.type).sort();
const kg = (value: string) => ({ value, unit: 'kg' });

describe('the forming block versions (contract)', () => {
  it('[DI-10][DI-34] TB-06@1 and TB-16@1 are registered in the tablets registry with every execution part of the block contract, are significant steps of the edition catalogue, take G-06 unchanged, and the roller compactor and bilayer press tags are process tags of the SDK', () => {
    const reg = tabletsBlockRegistry();
    expect(reg.all().map((b) => `${b.type}@${b.version}`)).toEqual(expect.arrayContaining(['TB-06@1', 'TB-16@1']));
    for (const r of reg.report().filter((x) => FORMING_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of FORMING_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
      for (const k of Object.keys(blocks.G06.dataSchema?.entries ?? {})) expect(b.dataSchema?.entries[k], `${b.type} ${k}`).toBe(blocks.G06.dataSchema?.entries[k]);
      for (const k of Object.keys(blocks.G06.configSchema?.fields ?? {})) expect(b.configSchema?.fields[k], `${b.type} ${k}`).toBe(blocks.G06.configSchema?.fields[k]);
    }
    expect(FORMING_TAGS.map((t) => `${t.tag} ${t.equipment}`)).toEqual(expect.arrayContaining(['roller.force_kN ROLLER_COMPACTOR', 'roller.gap_mm ROLLER_COMPACTOR', 'roller.speed_rpm ROLLER_COMPACTOR', 'layer1.tamp_kN PRESS']));
  });
});

describe('golden fixtures of the forming blocks', () => {
  for (const b of FORMING_BLOCK_VERSIONS) {
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

  it('[DI-34] the simulator model of each block plays a nominal path the engine accepts', () => {
    for (const b of FORMING_BLOCK_VERSIONS) {
      const run = startRun(b);
      const node = run.def.steps.get('p')?.node as never;
      const entries = b.simulatorModel?.nominalEntries({ phase: node, config: fixturePhase(b).config, mbr: blockMbr(b), frames: [], containers: [], target: () => undefined }) ?? [];
      for (const e of entries) {
        const r = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: e });
        expect(r.accepted, `${b.type} ${e.kind}: ${r.refusal?.code ?? ''}`).toBe(true);
      }
    }
  });
});

/** TB-06's fixture phase without G-06 values (no set-points, no collected values, no equipment recipe). */
function plain(): ReturnType<typeof fixturePhase> {
  const p = fixturePhase(TB06);
  const { setpoints: _s, actuals: _a, ...config } = p.config;
  void _s;
  void _a;
  const { system: _y, ...rest } = p;
  void _y;
  return { ...rest, config };
}

describe('TB-06 roller compaction', () => {
  const started = (): R => {
    const run = startRun(TB06);
    run.entry('p', { kind: 'RUN_START', press: 'TEST-RC-01' });
    run.entry('p', { kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: { value: '1.5', unit: 'mm' }, when: 'BEFORE', result: 'INTACT' });
    run.entry('p', { kind: 'FEED', quantity: kg('50.000') });
    return run;
  };
  const ribbon = (thickness: string, appearance = 'COMPLIES'): Entry => ({ kind: 'RIBBON_CHECK', thickness, solidFraction: '68.0', appearance });

  it('[PR-29][PR-07] the MBR names the compactor, a ribbon interval and grace with its risk assessment and at least one ribbon parameter, a sane recycle limit and yield range', () => {
    expect(definitionCodes(blockMbr(TB06))).toEqual([]);
    const cfg = fixturePhase(TB06).config;
    expect(definitionCodes(blockMbr(TB06, fixturePhase(TB06, { equipment: [] })))).toContain('TB06-NO-EQUIPMENT');
    expect(definitionCodes(blockMbr(TB06, fixturePhase(TB06, { config: { ribbon: { every: { value: '30', unit: 'min' }, grace: { value: '5', unit: 'min' } } } })))).toEqual(expect.arrayContaining(['TB06-QRM', 'TB06-RIBBON']));
    expect(definitionCodes(blockMbr(TB06, fixturePhase(TB06, { config: { finesRecycle: { maxPercent: '120' } } })))).toContain('TB06-RECYCLE');
    expect(definitionCodes(blockMbr(TB06, fixturePhase(TB06, { config: { yield: { min: '99', max: '95' } } })))).toContain('TB06-YIELD');
    expect(cfg['screens']).toBeDefined();
  });

  it('[PR-29] ribbon checks are judged against their action and alert limits and the appearance; a failing one raises RIBBON_CHECK_FAILED (a deviation), an alert-limit breach RIBBON_CHECK_ALERT; a check gives exactly the parameters the MBR examines', () => {
    const run = started();
    expect(refusal(run, { kind: 'RIBBON_CHECK', thickness: '3.0', appearance: 'COMPLIES' })).toBe('TB06-RIBBON-PARAMETERS');
    expect(refusal(run, { kind: 'RIBBON_CHECK', thickness: '3.0', density: '1.1', solidFraction: '68', appearance: 'COMPLIES' })).toBe('TB06-RIBBON-PARAMETERS');
    run.entry('p', ribbon('3.40'));
    expect([last(run, 'RIBBON_CHECK')['result'], last(run, 'RIBBON_CHECK')['evaluation']]).toEqual(['ALERT', { thickness: 'ALERT', solidFraction: 'PASS', appearance: 'PASS' }]);
    expect(types(run)).toEqual(['RIBBON_CHECK_ALERT']);
    run.entry('p', ribbon('3.00', 'DOES_NOT_COMPLY'));
    expect(last(run, 'RIBBON_CHECK')['result']).toBe('FAIL');
    run.entry('p', ribbon('3.60'));
    expect(types(run)).toEqual(['RIBBON_CHECK_ALERT', 'RIBBON_CHECK_FAILED', 'RIBBON_CHECK_FAILED']);
    const failed = run.exceptions('RIBBON_CHECK_FAILED')[0];
    expect([failed?.severity, failed?.deviationRequired]).toEqual(['ACTION', true]);
  });

  it('[PR-29] a ribbon check not made within the grace after it fell due (30 min after the start or the last check, at the end of the run) is missed: the next entry lists it at its own time and raises RIBBON_CHECK_MISSED; the marking moves the schedule on', () => {
    const run = started();
    run.advance(34n * MIN);
    run.entry('p', ribbon('3.00'));
    expect(last(run, 'RIBBON_CHECK')['missed']).toBeUndefined();
    run.advance(36n * MIN);
    run.entry('p', { kind: 'FEED', quantity: kg('10.000') });
    const m = (last(run, 'FEED')['missed'] as Json[] | undefined) ?? [];
    expect(m.map((x) => [x['stream'], x['test'], x['by']])).toEqual([['RIBBON', 'RIBBON', 'TIME']]);
    expect(types(run)).toEqual(['RIBBON_CHECK_MISSED']);
    run.entry('p', ribbon('3.00'));
    expect(last(run, 'RIBBON_CHECK')['missed']).toBeUndefined();
    // At the end of the run the check falls due at once: within the grace it is the end-of-run check.
    run.advance(MIN);
    run.entry('p', { kind: 'RUN_END' });
    run.advance(6n * MIN);
    run.entry('p', ribbon('3.00'));
    expect((last(run, 'RIBBON_CHECK')['missed'] as Json[]).length).toBe(1);
  });

  it('[IN-36][INV-24] the mill screen follows TB-02\'s rule: granules only through a screen checked intact before use; an after-use check that finds it damaged holds the granules milled through it since its last intact check (SCREEN_INTEGRITY_FAILED) and the screen is never used again; the step never closes with a screen unchecked after use', () => {
    const run = startRun(TB06, blockMbr(TB06, plain()));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-RC-01' });
    run.entry('p', { kind: 'FEED', quantity: kg('50.000') });
    const out = (g: string): Entry => ({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg(g), fines: kg('0.500') });
    expect(refusal(run, out('20.000'))).toBe('TB06-NO-PRE-CHECK');
    expect(refusal(run, { kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: { value: '2.0', unit: 'mm' }, when: 'BEFORE', result: 'INTACT' })).toBe('TB06-APERTURE');
    expect(refusal(run, { kind: 'SCREEN_CHECK', screen: 'RS-99', aperture: { value: '1.5', unit: 'mm' }, when: 'BEFORE', result: 'INTACT' })).toBe('TB06-SCREEN');
    const check = (when: string, result: string): Entry => ({ kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: { value: '1.5', unit: 'mm' }, when, result });
    run.entry('p', check('BEFORE', 'INTACT'));
    run.entry('p', out('20.000'));
    run.entry('p', check('AFTER', 'INTACT'));
    run.entry('p', check('BEFORE', 'INTACT'));
    run.entry('p', out('21.000'));
    const second = Object.values(run.state.entries).filter((e) => e.kind === 'GRANULE_OUTPUT').at(-1)?.id;
    run.entry('p', { kind: 'RUN_END' });
    run.entry('p', ribbon('3.00'));
    expect(perform(run).refusal?.code).toBe('TB06-AFTER-CHECK-MISSING');
    run.entry('p', check('AFTER', 'DAMAGED'));
    expect(last(run, 'SCREEN_CHECK')['held']).toEqual([second]);
    expect(types(run)).toEqual(['SCREEN_INTEGRITY_FAILED']);
    expect(refusal(run, check('BEFORE', 'INTACT'))).toBe('TB06-SCREEN-DAMAGED');
  });

  it('[IN-36] fines are recycled only where the MBR allows it, never more than were discharged, and in total within the MBR\'s percentage of the pre-blend fed; the yield counts granules and the fines not recycled over the pre-blend fed (C-09), after the run, against the MBR\'s limits', () => {
    const noRecycle = startRun(TB06, blockMbr(TB06, fixturePhase(TB06, { config: { finesRecycle: undefined as never } })));
    noRecycle.entry('p', { kind: 'RUN_START', press: 'TEST-RC-01' });
    noRecycle.entry('p', { kind: 'FEED', quantity: kg('50.000') });
    expect(refusal(noRecycle, { kind: 'FINES_RECYCLED', quantity: kg('1.000') })).toBe('TB06-RECYCLE-NOT-ALLOWED');
    const run = started();
    run.entry('p', { kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('40.000'), fines: kg('8.000') });
    expect(refusal(run, { kind: 'FINES_RECYCLED', quantity: { value: '1', unit: 'g' } })).toBe('TB06-UNIT');
    expect(refusal(run, { kind: 'FINES_RECYCLED', quantity: kg('5.001') })).toBe('TB06-FINES-LIMIT');
    run.entry('p', { kind: 'FINES_RECYCLED', quantity: kg('5.000') });
    expect(last(run, 'FINES_RECYCLED')['recycledPercent']).toBe('10.00');
    expect(refusal(run, { kind: 'FINES_RECYCLED', quantity: kg('0.001') })).toBe('TB06-FINES-LIMIT');
    expect(refusal(run, { kind: 'YIELD' })).toBe('TB06-RUNNING');
    run.entry('p', { kind: 'RUN_END' });
    expect(refusal(run, { kind: 'FEED', quantity: kg('1.000') })).toBe('TB06-ENDED');
    run.entry('p', { kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('1.000'), fines: kg('0.000') });
    run.entry('p', { kind: 'YIELD' });
    // (40 + 1 + 8 - 5) / 50 = 88.00 %, below the 95 % limit: a deviation.
    const y = last(run, 'YIELD');
    expect([y['feed'], y['granules'], y['fines'], y['recycled'], y['net'], y['yieldPercent'], y['withinLimits']]).toEqual(['50', '41', '8', '5', '44', '88.00', false]);
    expect(types(run)).toEqual(['COMPACTION_YIELD_OUT_OF_RANGE']);
    expect(refusal(run, { kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('1.000'), fines: kg('0.000') })).toBe('TB06-AFTER-YIELD');
  });

  it('[PR-08] a roll gap outside its acceptance limits raises PROCESS_VALUE_OUT_OF_LIMITS through G-06 (the steps after it wait for a deviation)', () => {
    const run = startRun(TB06);
    run.entry('p', { kind: 'ACTUAL', tag: 'roller.gap_mm', value: '3.80', unit: 'mm', source: 'EQUIPMENT', readingId: U(77), quality: 'GOOD', receivedAtUs: run.nowUs.toString() });
    expect(last(run, 'ACTUAL')['withinLimits']).toBe(false);
    expect(types(run)).toEqual(['PROCESS_VALUE_OUT_OF_LIMITS']);
  });
});

describe('TB-16 bilayer compression', () => {
  const cfg = fixturePhase(TB16).config;
  const charge = (layer: string, hopper: string, blend: string, n = 1): Entry => ({ kind: 'HOPPER_CHARGE', layer, hopper, blend, chargeId: U(n) });
  const group = (stream: string, g: string): Entry => ({ kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream, readings: [U(900)], groupWeight: g });
  const sweep: Entry = { kind: 'STATION_SWEEP', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'T', readings: [1, 2, 3].map(U), stations: ['399.0', '401.0', '400.0'].map((w, i) => ({ station: i + 1, weight: w })) };
  const phys: Entry = { kind: 'PHYSICAL_CHECK', instrument: 'TEST-HT-01', capture: 'DEVICE', stream: 'T', readings: [4, 5].map(U), tablets: [{ thickness: '5.40' }, { thickness: '5.41' }], defects: [] };

  it('[PR-29][IN-35] the MBR gives two or three layers with their own hoppers and blends; layer-only samples are a weight check with in-house limits; the full tablets are checked for total weight and layer separation (LAMINATION) with the sweep; every layer keeps the 30-min ceiling; no layer shares a stream with an IPC scheduler; a set-up step comes first', () => {
    expect(definitionCodes(blockMbr(TB16))).toEqual([]);
    const layers = cfg['layers'] as Json[];
    const l1 = layers[0] as Json;
    const t = layers[1] as Json;
    const withLayers = (ls: Json[]) => blockMbr(TB16, fixturePhase(TB16, { config: { layers: ls as never } }));
    expect(definitionCodes(withLayers([{ ...l1, hopper: 'H2' }, t]))).toContain('TB16-LAYERS');
    expect(definitionCodes(withLayers([{ ...l1, weight: { mode: 'UNIFORMITY', tabletType: 'UNCOATED' } }, t]))).toContain('TB16-LAYER-ONLY');
    expect(definitionCodes(withLayers([{ ...l1, plan: [{ test: 'WEIGHT', every: { value: '28', unit: 'min' }, qrmRef: 'QRM-BL-01' }] }, t]))).toContain('TB16-CEILING');
    expect(definitionCodes(withLayers([l1, { ...t, physical: { n: 2, thickness: { individual: { action: { min: '5.2', max: '5.6' } } }, defects: ['CAPPING'] } }]))).toContain('TB16-SEPARATION');
    expect(definitionCodes(withLayers([l1, { ...t, sweep: undefined }]))).toContain('TB11-NO-SWEEP');
    const scheduler = phase('ipc', { block: { type: 'TB-11', version: '1' }, config: { process: 'OTHER', streams: [{ id: 'L1' }], plan: [{ test: 'WEIGHT', every: { value: '15', unit: 'min' }, qrmRef: 'Q' }], grace: { value: '5', unit: 'min' }, weight: l1['weight'] as never } });
    expect(definitionCodes(blockMbr(TB16, fixturePhase(TB16), [scheduler]))).toContain('TB16-STREAM-CLASH');
    expect(layerConfig(cfg, 0)).toEqual({ process: 'OTHER', streams: [{ id: 'L1' }], plan: l1['plan'], grace: cfg['grace'], weight: l1['weight'] });
    expect(layerConfig(cfg, 1)['process']).toBe('COMPRESSION');
  });

  it('[PR-21][IN-26] each layer\'s hopper is charged by scan with its own blend: another hopper (a swap) or another blend is refused; every charge needs a second person; the run cannot start while a layer is uncharged', () => {
    const run = startRun(TB16);
    expect(refusal(run, charge('L1', 'H2', 'BLEND_L1'))).toBe('TB16-HOPPER');
    expect(refusal(run, charge('L1', 'H1', 'BLEND_L2'))).toBe('TB16-WRONG-BLEND');
    expect(refusal(run, charge('L9', 'H1', 'BLEND_L1'))).toBe('TB16-LAYER');
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    expect(run.inst('p')?.verificationRequired).toBe(true);
    expect(refusal(run, { kind: 'RUN_START', press: 'TEST-PRESS-01' })).toBe('TB16-LAYER-UNCHARGED');
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
  });

  it('[IN-35][PR-29] each layer is its own TB-11 stream: a layer-only sample is judged against the layer\'s limits and the full tablets against theirs, never mixed; a sample names a layer\'s stream; a check missed on any layer is listed by the next entry with IPC_CHECK_MISSED', () => {
    const run = startRun(TB16);
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    run.entry('p', sweep);
    expect(refusal(run, group('R', '1500.0'))).toBe('TB16-STREAM');
    // 1550 mg for 10 layer-only samples is 3.3 % above 150 mg: outside the layer's 3 % action limit.
    run.entry('p', group('L1', '1550.0'));
    expect(last(run, 'WEIGHT_CHECK')['result']).toBe('FAIL');
    // The same group weight of the full tablets would be nowhere near 400 mg; their own limits judge 4001 mg.
    run.entry('p', group('T', '4001.0'));
    expect([last(run, 'WEIGHT_CHECK')['stream'], last(run, 'WEIGHT_CHECK')['result']]).toEqual(['T', 'PASS']);
    expect(run.exceptions('IPC_CHECK_FAILED').map((e) => /stream L1/.test(e.title))).toEqual([true]);
    run.advance(21n * MIN);
    run.entry('p', group('L1', '1500.0'));
    const m = (last(run, 'WEIGHT_CHECK')['missed'] as Json[]).map((x) => [x['stream'], x['test']]);
    expect(m).toEqual([['L1', 'WEIGHT'], ['T', 'WEIGHT'], ['T', 'PHYSICAL']]);
    expect(run.exceptions('IPC_CHECK_MISSED')).toHaveLength(1);
  });

  it('[IN-35][PR-29][PR-21] the step closes only after the run ended with an end-of-run check of every planned test of every layer, the sweep done and every layer charged; then a second person verifies it', () => {
    const run = startRun(TB16);
    run.entry('p', charge('L1', 'H1', 'BLEND_L1'));
    run.entry('p', charge('T', 'H2', 'BLEND_L2', 2));
    run.entry('p', { kind: 'RUN_START', press: 'TEST-PRESS-01' });
    expect(perform(run).refusal?.code).toBe('TB11-RUNNING');
    run.entry('p', { kind: 'RUN_END' });
    expect(perform(run).refusal?.code).toBe('TB11-END-CHECK');
    run.entry('p', group('L1', '1500.0'));
    run.entry('p', group('T', '4000.0'));
    expect(perform(run).refusal?.code).toBe('TB11-NO-SWEEP');
    run.entry('p', sweep);
    expect(perform(run).refusal?.code).toBe('TB11-END-CHECK');
    run.entry('p', phys);
    expect(perform(run).accepted).toBe(true);
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    expect(run.exec({ type: 'VERIFY', actor: OP1, step: 'p', context: [], signature: sig(engine.checkMeaning(run.def, run.inst('p'), 'p', run.state, run.nowUs), OP1) }).accepted).toBe(false);
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
    void OP2;
  });
});
