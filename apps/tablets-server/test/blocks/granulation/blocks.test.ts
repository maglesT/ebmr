/**
 * Phase 3 slice 3b (builder B): the granulation blocks TB-02, TB-03, TB-04, TB-05 and TB-07 through the engine with the
 * tablets registry and catalogue: the block contract, each golden fixture, and each block's rules (definition checks,
 * entry refusals, exceptions, computed items, limit tiers, the LOD loop). The database's copy of the rules is proven in
 * db-guards.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { blocks, type flow } from '@ebmr/recipe-core/pure';
import { GRANULATION_BLOCK_VERSIONS, TB02, TB03, TB04, TB05, TB07 } from '../../../src/blocks/granulation/index.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';
import { recordedByAttempt } from '../../../src/features/execution/signable.ts';
import { blockMbr, definitionCodes, fixturePhase, iteration, LOOP, MIN, OP1, phase, Run, runGolden, sig, startRun, T0, VER1, defineFor } from './support.ts';
import { engine } from '@ebmr/recipe-core/pure';

/** An operator without the production-operator role (not authorised for extra fluid). */
const OP9: engine.Actor = { id: 'OP9', kind: 'PERSON', roles: ['OPERATOR'] };

type Json = Record<string, unknown>;
type Entry = Json & { kind: string };
const pct = (value: string) => ({ kind: 'DECIMAL' as const, value, unit: '%' });
const kg = (value: string) => ({ value, unit: 'kg' });

describe('the granulation block versions (contract)', () => {
  it('[DI-10][DI-34] TB-02@1, TB-03@1, TB-04@1, TB-05@1 and TB-07@1 are registered in the tablets registry with every execution part of the block contract, are known to the edition catalogue as significant steps, and declare every exception type their handlers raise', () => {
    const reg = tabletsBlockRegistry();
    const keys = reg.all().map((b) => `${b.type}@${b.version}`);
    expect(keys).toEqual(expect.arrayContaining(['TB-02@1', 'TB-03@1', 'TB-04@1', 'TB-05@1', 'TB-07@1']));
    for (const r of reg.report().filter((x) => GRANULATION_BLOCK_VERSIONS.some((b) => b.type === x.type))) {
      expect(r.missingExecutionParts, r.key).toEqual([]);
      expect([...r.missing].sort(), r.key).toEqual([...blocks.RENDERING_PARTS].sort());
    }
    for (const b of GRANULATION_BLOCK_VERSIONS) {
      const d = tabletsBlockCatalog.describe(b.type);
      expect([d?.edition, d?.significant, d?.phase.allowed], b.type).toEqual(['tablets', true, true]);
      expect(b.edition).toBe('tablets');
    }
    // TB-04, TB-05 and TB-07 take G-06's configuration and entry kinds unchanged (process values through G-06).
    for (const b of [TB04, TB05, TB07]) {
      for (const k of Object.keys(blocks.G06.dataSchema?.entries ?? {})) expect(b.dataSchema?.entries[k], `${b.type} ${k}`).toBe(blocks.G06.dataSchema?.entries[k]);
      for (const k of Object.keys(blocks.G06.configSchema?.fields ?? {})) expect(b.configSchema?.fields[k], `${b.type} ${k}`).toBe(blocks.G06.configSchema?.fields[k]);
    }
  });
});

describe('golden fixtures of the granulation blocks', () => {
  for (const b of GRANULATION_BLOCK_VERSIONS) {
    const f = b.goldenFixture;
    if (!f) continue;
    const tags = [...new Set(['DI-34', ...(f.controls ?? b.controls.slice(0, 1))])].map((c) => `[${c}]`).join('');
    it(`${tags} ${b.type} ${b.title}: ${f.description}`, () => {
      const out = runGolden(b);
      expect(out.performRefusal).toBe(f.expect.performRefusal);
      expect(out.run.exceptions().map((e) => e.type).sort()).toEqual(f.expect.exceptions);
      expect(out.run.status('p', out.frames)).toBe(f.expect.status);
      for (const [item, value] of Object.entries(f.expect.values ?? {})) expect(out.run.value(item, 'p', out.frames), item).toBe(value);
      const declared = new Set([...(b.simulatorModel?.exceptionTypes(out.run.def.steps.get('p')?.node as never) ?? []), ...(b.exceptionRules ?? []).map((r) => r.type)]);
      for (const t of out.run.exceptions().map((e) => e.type)) expect(declared.has(t), `${b.type} raised ${t}`).toBe(true);
    });
  }
});

describe('TB-02 sifting and milling', () => {
  const check = (when: string, result = 'INTACT', value = '425'): Entry => ({ kind: 'SCREEN_CHECK', screen: 'SCR-40', aperture: { value, unit: 'um' }, when, result });
  const pass = (extra: Json = {}): Entry => ({ kind: 'MATERIAL_PASS', screen: 'SCR-40', material: 'BOM-API', quantityIn: kg('10.000'), quantityOut: kg('9.990'), oversize: kg('0.010'), foreignMatter: false, ...extra });

  it('[PR-23][IN-36] the step names its sifter or mill, which a G-09 step of the MBR checks; screens are listed once', () => {
    expect(definitionCodes(blockMbr(TB02))).toEqual([]);
    expect(definitionCodes(blockMbr(TB02, fixturePhase(TB02, { equipment: [] })))).toEqual(['TB02-NO-EQUIPMENT']);
    const unchecked = blockMbr(TB02);
    const seq = ((unchecked.procedure.body as flow.SequenceNode).children[0] as flow.StageNode).body as flow.OperationNode;
    (seq.body as flow.SequenceNode).children = (seq.body as flow.SequenceNode).children.filter((c) => c.id !== 'chk');
    expect(definitionCodes(unchecked)).toEqual(['TB02-EQUIPMENT-UNCHECKED']);
    expect(TB02.checkConfig?.(fixturePhase(TB02), fixturePhase(TB02).config, unchecked).map((p) => p.code)).toEqual(['TB02-EQUIPMENT-UNCHECKED']);
    expect(TB02.checkConfig?.(fixturePhase(TB02, { equipment: [] }), fixturePhase(TB02).config, blockMbr(TB02)).map((p) => p.code)).toEqual(['TB02-NO-EQUIPMENT']);
  });

  it('[IN-36][INV-24] a pass only through a screen checked intact before use; the approved aperture only; the step never closes without the after-use check (IN-36 catalogue test); a damaged screen is never used again', () => {
    const { run } = startRun(TB02);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: pass() }).code).toBe('TB02-NO-PRE-CHECK');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: check('BEFORE', 'INTACT', '500') }).code).toBe('TB02-APERTURE');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: check('AFTER') }).code).toBe('TB02-CHECK-ORDER');
    run.entry('p', check('BEFORE'));
    expect(run.inst('p')?.verificationRequired).toBe(true);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: check('BEFORE') }).code).toBe('TB02-CHECK-ORDER');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: pass({ quantityOut: kg('10.500') }) }).code).toBe('TB02-QUANTITY');
    const noOversize = pass();
    delete noOversize['oversize'];
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: noOversize }).code).toBe('TB02-OVERSIZE');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: pass({ foreignMatter: true }) }).code).toBe('TB02-FOREIGN-MATTER');
    run.entry('p', pass());
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).code).toBe('TB02-AFTER-CHECK-MISSING');
    run.entry('p', check('AFTER', 'DAMAGED'));
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: check('BEFORE') }).code).toBe('TB02-SCREEN-DAMAGED');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: pass() }).code).toBe('TB02-NO-PRE-CHECK');
    run.perform('p');
    expect(run.exceptions().map((e) => e.type)).toEqual(['SCREEN_INTEGRITY_FAILED']);
  });

  it('[IN-36][PR-29] foreign matter in a residue raises FOREIGN_MATTER_FOUND, a deviation that holds the steps after it; a screen found damaged before use is only flagged', () => {
    const { run } = startRun(TB02);
    run.entry('p', check('BEFORE'));
    run.entry('p', pass({ foreignMatter: true, foreignMatterDescription: 'Metal fragment' }));
    run.entry('p', check('AFTER'));
    const [ex] = run.exceptions('FOREIGN_MATTER_FOUND');
    expect([ex?.severity, ex?.deviationRequired, ex?.block?.until, ex?.block?.downstream !== undefined]).toEqual(['ACTION', true, 'DEVIATION', true]);
    const r2 = startRun(TB02).run;
    r2.entry('p', check('BEFORE', 'DAMAGED'));
    expect(r2.exceptions().map((e) => `${e.type}:${e.severity}`)).toEqual(['SCREEN_DAMAGED:ALERT']);
  });
});

describe('TB-03 solutions with use-by', () => {
  it('[IN-36][PR-30] the use-by is mandatory; preparation starts it at the server time (preparedAtUs, useByUs); one preparation; a discard never exceeds the preparation; the step closes only prepared', () => {
    expect(TB03.checkConfig?.(fixturePhase(TB03), { ...fixturePhase(TB03).config, useBy: { value: '0', unit: 'h' } }, blockMbr(TB03)).map((p) => p.code)).toEqual(['TB03-USE-BY']);
    const { run } = startRun(TB03);
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).code).toBe('TB03-NOT-PREPARED');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'DISCARD', quantity: kg('0.1'), method: 'Drain' } }).code).toBe('TB03-NOT-PREPARED');
    run.entry('p', { kind: 'PREPARED', quantity: kg('12.000'), appearance: 'DOES_NOT_COMPLY' });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'PREPARED');
    expect(e?.data).toMatchObject({ preparedAtUs: run.nowUs.toString(), useByUs: (run.nowUs + 4n * 60n * MIN).toString() });
    expect(run.exceptions().map((x) => x.type)).toEqual(['SOLUTION_APPEARANCE']);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'PREPARED', quantity: kg('1.000'), appearance: 'COMPLIES' } }).code).toBe('TB03-TWICE');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'DISCARD', quantity: kg('12.001'), method: 'Drain' } }).code).toBe('TB03-DISCARD');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'DISCARD', quantity: { value: '1', unit: 'L' }, method: 'Drain' } }).code).toBe('TB03-DISCARD');
  });
});

describe('TB-04 wet granulation end point', () => {
  const device = (tag: string, value: string, unit: string, at: bigint, quality = 'GOOD'): Entry => ({
    kind: 'ACTUAL', tag, value, unit, source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000099', quality, receivedAtUs: at.toString(),
  });

  it('[INV-25][PR-08][DI-31] the end point reads a usable collected power value of this step: the end-point item is computed from it (never typed) and judged against its limit tiers; outside the MBR range it raises ENDPOINT_OUT_OF_RANGE', () => {
    const { run } = startRun(TB04);
    expect(run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'p', context: [], item: 'endPower', value: { kind: 'DECIMAL', value: '4.20', unit: 'kW' }, source: { mode: 'MANUAL' } }).code).toBe('ENG-DERIVED-TYPED');
    run.entry('p', { kind: 'RECIPE_CHECK', recipe: 'RCP-GRAN', recipeVersion: '3' });
    run.entry('p', { kind: 'SETPOINT_READBACK', tag: 'granulator.impeller_rpm', value: '150', unit: 'rpm', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000098', quality: 'GOOD', receivedAtUs: run.nowUs.toString() });
    run.entry('p', device('granulator.product_temp_C', '31.5', 'degC', run.nowUs));
    run.entry('p', device('granulator.power_kW', '4.70', 'kW', run.nowUs - 7_200n * 1_000_000n));
    // A stale value (2 h, beyond the 1 h stale age) does not count; nor another tag.
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT', actual: 'EN-4' } }).code).toBe('TB04-ENDPOINT-VALUE');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT', actual: 'EN-3' } }).code).toBe('TB04-ENDPOINT-VALUE');
    run.entry('p', device('granulator.power_kW', '4.70', 'kW', run.nowUs));
    run.entry('p', { kind: 'END_POINT', actual: 'EN-5' });
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT', actual: 'EN-5' } }).code).toBe('TB04-ENDPOINT-TWICE');
    // The action-tier breach of the computed end point stops the step itself until a deviation is linked.
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).accepted).toBe(false);
    expect(run.value('endPower', 'p')).toBe('4.70');
    const point = Object.values(run.state.points).find((x) => x.item === 'endPower');
    expect(point?.source).toEqual({ mode: 'BLOCK', entries: ['EN-6'] });
    expect(run.exceptions().map((e) => `${e.type}${e.tier ? `:${e.tier}` : ''}`).sort()).toEqual(['ENDPOINT_OUT_OF_RANGE', 'LIMIT_BREACH:INTERNAL_ACTION', 'PROCESS_DATA_UNUSABLE']);
  });

  it('[DI-32][IN-36] a manual end-point call (a value keyed under the MBR fallback) needs a reason and makes the step need a second person', () => {
    const p = fixturePhase(TB04, { config: { manualFallback: true } });
    const { run } = startRun(TB04, blockMbr(TB04, p));
    run.entry('p', { kind: 'ACTUAL', tag: 'granulator.power_kW', value: '4.10', unit: 'kW', source: 'MANUAL' });
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT', actual: 'EN-1' } }).code).toBe('TB04-MANUAL-ENDPOINT');
    run.entry('p', { kind: 'END_POINT', actual: 'EN-1', reason: 'Granulator link down; ammeter read at the panel' });
    expect(run.inst('p')?.verificationRequired).toBe(true);
  });

  it('[IN-36][IN-13] a time end point is the massing time measured between MASSING_START and END_POINT (server times): refused before the minimum, a deviation beyond the maximum', () => {
    const cfg = { granulator: 'HIGH_SHEAR', endPoint: { criterion: 'TIME', minTime: { value: '2', unit: 'min' }, maxTime: { value: '4', unit: 'min' } } };
    const mbr = blockMbr(TB04, phase('p', { block: { type: 'TB-04', version: '1' }, config: cfg }), { parameters: [] });
    expect(definitionCodes(mbr)).toEqual([]);
    const { run } = startRun(TB04, mbr);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT' } }).code).toBe('TB04-NO-MASSING-START');
    run.entry('p', { kind: 'MASSING_START' });
    run.minutes(1);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'END_POINT' } }).code).toBe('TB04-ENDPOINT-EARLY');
    run.minutes(4);
    run.entry('p', { kind: 'END_POINT' });
    expect(Object.values(run.state.entries).find((e) => e.kind === 'END_POINT')?.data).toMatchObject({ criterion: 'TIME', value: '300.000000', unit: 's', withinRange: false });
    expect(run.exceptions().map((e) => e.type)).toEqual(['ENDPOINT_OUT_OF_RANGE']);
  });

  it('[IN-36][PR-29][DI-34] extra granulating fluid only at a step of an operator-choice branch (G-19), by a role the MBR names, a deviation beyond its maximum; the binder total outside the MBR range is a deviation at PERFORMED', () => {
    const extra = { granulator: 'HIGH_SHEAR', extraFluid: { max: kg('0.500'), roles: ['PRODUCTION_OPERATOR'] }, binder: { min: '1.000', max: '2.000', unit: 'kg' } };
    const p = phase('p', { block: { type: 'TB-04', version: '1' }, config: extra });
    expect(TB04.checkConfig?.(p, extra, blockMbr(TB04, p, { parameters: [] })).map((x) => x.code)).toEqual(['TB04-EXTRA-NOT-IN-BRANCH']);
    const alt: flow.AlternativeNode = {
      kind: 'alternative', id: 'ALT-IPA', decision: { mode: 'OPERATOR_CHOICE', roles: ['OPERATOR'], reasonRequired: true },
      branches: [{ id: 'yes', name: 'Extra IPA needed', body: p }, { id: 'no', name: 'No extra IPA' }],
    };
    const mbr = blockMbr(TB04, phase('x'), { parameters: [] });
    const ops = ((mbr.procedure.body as flow.SequenceNode).children[0] as flow.StageNode).body as flow.OperationNode;
    (ops.body as flow.SequenceNode).children = [alt, phase('after')];
    expect(definitionCodes(mbr)).toEqual([]);
    const run = Run.issue(defineFor(mbr), {}, T0);
    run.ok({ type: 'CHOOSE_ALTERNATIVE', actor: OP1, construct: 'ALT-IPA', branch: 'yes', reason: 'Granules too dry at the end point' });
    run.start('p');
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP9, step: 'p', context: [], entry: { kind: 'EXTRA_FLUID', quantity: kg('0.300'), reason: 'Mass too dry' } }).code).toBe('TB04-EXTRA-ROLE');
    run.entry('p', { kind: 'EXTRA_FLUID', quantity: kg('0.300'), reason: 'Mass too dry' });
    expect(run.exceptions()).toEqual([]);
    run.entry('p', { kind: 'EXTRA_FLUID', quantity: kg('0.300'), reason: 'Still too dry' });
    expect(run.exceptions().map((e) => e.type)).toEqual(['EXTRA_FLUID_OVER_MAXIMUM']);
    run.entry('p', { kind: 'BINDER_ADDITION', preparation: 'EN-99', quantity: kg('0.500') });
    run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) });
    expect(run.exceptions().map((e) => e.type).sort()).toEqual(['BINDER_QUANTITY_OUT_OF_RANGE', 'EXTRA_FLUID_OVER_MAXIMUM']);
  });
});

describe('TB-05 drying with the LOD loop', () => {
  it('[IN-36][PR-27] review 3b finding 4: a bag check before use states the bag\'s history (the product it was last used for, or a new bag): leaving it out never skips the wash rule; only product-dedicated bags need no history', () => {
    const { run, frames } = startRun(TB05);
    const at = (entry: Entry) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: frames, entry }).refusal?.code;
    expect(at({ kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT' })).toBe('TB05-BAG-HISTORY');
    expect(at({ kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT', newBag: true, lastProduct: 'Q' })).toBe('TB05-BAG-HISTORY');
    expect(at({ kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT', newBag: true })).toBeUndefined();
    const dedicated = startRun(TB05, blockMbr(TB05, fixturePhase(TB05, { config: { dedicatedBags: true } })));
    dedicated.run.entry('p', { kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT', dedicatedTo: 'P' }, dedicated.frames);
  });

  const bagBefore = (extra: Json = {}): Entry => ({ kind: 'BAG_CHECK', bag: 'BAG-07', when: 'BEFORE', result: 'INTACT', ...('lastProduct' in extra ? {} : { newBag: true }), ...extra });

  it('[IN-36][DI-34] the drying step sits in a bounded loop that exits on its LOD (a process end point with an upper limit), of at most 10 iterations', () => {
    expect(definitionCodes(blockMbr(TB05))).toEqual([]);
    const flat = blockMbr(TB02, fixturePhase(TB05), { parameters: TB05.goldenFixture?.parameters ?? [] });
    expect(TB05.checkConfig?.(fixturePhase(TB05), fixturePhase(TB05).config, flat).map((p) => p.code)).toEqual(['TB05-NO-LOOP']);
    const many = blockMbr(TB05);
    (((many.procedure.body as flow.SequenceNode).children[0] as flow.StageNode).body as flow.OperationNode).body = {
      kind: 'sequence', id: 'ops', children: [{ kind: 'loop', id: LOOP, name: 'Dry', body: fixturePhase(TB05), maxIterations: 11, exit: { condition: 'lod <= 3.5 [%]', endpoint: 'lod' } }],
    };
    expect(TB05.checkConfig?.(fixturePhase(TB05), fixturePhase(TB05).config, many).map((p) => p.code)).toEqual(['TB05-ITERATIONS']);
  });

  it('[IN-36][PR-27] a filter bag last used for another product is refused without its wash record (IN-36 catalogue test); a product-dedicated bag where the MBR asks for one; drying only after the bag check; the step closes only with the bag checked after use', () => {
    const { run, frames } = startRun(TB05);
    const at = (entry: Entry) => run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: frames, entry });
    expect(at({ kind: 'DRYING_START' }).refusal?.code).toBe('TB05-BAG-UNCHECKED');
    expect(at(bagBefore({ lastProduct: 'Q' })).refusal?.code).toBe('TB05-BAG-WASH');
    expect(at(bagBefore({ result: 'DAMAGED' })).refusal?.code).toBe('TB05-BAG-DAMAGED');
    run.entry('p', bagBefore({ lastProduct: 'Q', washRecord: 'WASH-0007' }), frames);
    run.entry('p', { kind: 'RECIPE_CHECK', recipe: 'RCP-DRY', recipeVersion: '2' }, frames);
    run.entry('p', { kind: 'SETPOINT_READBACK', tag: 'dryer.inlet_temp_C', value: '60.0', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000031', quality: 'GOOD', receivedAtUs: run.nowUs.toString() }, frames);
    run.entry('p', { kind: 'ACTUAL', tag: 'dryer.bed_temp_C', value: '38.0', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000032', quality: 'GOOD', receivedAtUs: run.nowUs.toString() }, frames);
    expect(at({ kind: 'LOD_SAMPLE', analyser: 'MA-02', sampleMass: { value: '5.0', unit: 'g' } }).refusal?.code).toBe('TB05-SAMPLE-EARLY');
    run.entry('p', { kind: 'DRYING_START' }, frames);
    run.minutes(20);
    run.entry('p', { kind: 'DRYING_END' }, frames);
    expect(Object.values(run.state.entries).find((e) => e.kind === 'DRYING_END')?.data['dryingSeconds']).toBe('1200.000000');
    run.entry('p', { kind: 'LOD_SAMPLE', analyser: 'MA-02', sampleMass: { value: '5.0', unit: 'g' } }, frames);
    run.record('p', 'lod', pct('3.0'), { frames });
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: frames, signature: sig('PERFORMED', OP1) }).refusal?.code).toBe('TB05-BAG-AFTER-MISSING');
    expect(at({ kind: 'BAG_CHECK', bag: 'BAG-08', when: 'AFTER', result: 'INTACT' }).refusal?.code).toBe('TB05-BAG-ORDER');
    run.entry('p', { kind: 'BAG_CHECK', bag: 'BAG-07', when: 'AFTER', result: 'DAMAGED' }, frames);
    expect(run.exceptions().map((e) => e.type)).toEqual(['FILTER_BAG_FAILED']);
    run.perform('p', frames);
    // Product-dedicated bags (highly potent or sensitising products).
    const dedicated = startRun(TB05, blockMbr(TB05, fixturePhase(TB05, { config: { dedicatedBags: true } })));
    const r = dedicated.run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: dedicated.frames, entry: bagBefore({ lastProduct: 'P' }) });
    expect(r.refusal?.code).toBe('TB05-BAG-DEDICATED');
    dedicated.run.entry('p', bagBefore({ lastProduct: 'P', dedicatedTo: 'P' }), dedicated.frames);
  });

  it('[IN-36][PR-29][DI-29][DI-34] every drying iteration is its own step instance kept in order; the loop repeats while the LOD is out of range and exits on it; at its maximum an unmet LOD exhausts the loop (an exception, never more iterations); over-drying is a limit breach', () => {
    const dry = (run: Run, n: number, lod: string): void => {
      const f = iteration(n);
      run.start('p', f);
      run.entry('p', bagBefore(), f);
      run.entry('p', { kind: 'RECIPE_CHECK', recipe: 'RCP-DRY', recipeVersion: '2' }, f);
      run.entry('p', { kind: 'SETPOINT_READBACK', tag: 'dryer.inlet_temp_C', value: '60.0', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000041', quality: 'GOOD', receivedAtUs: run.nowUs.toString() }, f);
      run.entry('p', { kind: 'ACTUAL', tag: 'dryer.bed_temp_C', value: '38.0', unit: 'degC', source: 'EQUIPMENT', readingId: '00000000-0000-4000-8000-000000000042', quality: 'GOOD', receivedAtUs: run.nowUs.toString() }, f);
      run.entry('p', { kind: 'DRYING_START' }, f);
      run.minutes(10);
      run.entry('p', { kind: 'DRYING_END' }, f);
      run.entry('p', { kind: 'LOD_SAMPLE', analyser: 'MA-02', sampleMass: { value: '5.0', unit: 'g' } }, f);
      run.record('p', 'lod', pct(lod), { frames: f });
      run.entry('p', { kind: 'BAG_CHECK', bag: 'BAG-07', when: 'AFTER', result: 'INTACT' }, f);
      run.perform('p', f);
      run.verify('p', f, VER1);
      run.ok({ type: 'COMPLETE_LOOP_ITERATION', actor: OP1, construct: LOOP, context: f });
    };
    const ok = Run.issue(defineFor(blockMbr(TB05)), {}, T0);
    dry(ok, 1, '4.6');
    dry(ok, 2, '3.1');
    expect(Object.values(ok.state.decisions).map((x) => `${x.key}=${x.outcome}`)).toEqual([`${LOOP}@${LOOP}=1=CONTINUE`, `${LOOP}@${LOOP}=2=EXIT`]);
    expect(ok.exceptions()).toEqual([]);
    const exhausted = Run.issue(defineFor(blockMbr(TB05)), {}, T0);
    dry(exhausted, 1, '5.0');
    dry(exhausted, 2, '4.4');
    dry(exhausted, 3, '1.8');
    expect(exhausted.exceptions().map((e) => `${e.type}${e.tier ? `:${e.tier}` : ''}`).sort()).toEqual(['LIMIT_BREACH:VALIDATED', 'LOOP_EXHAUSTED']);
    expect(exhausted.status('p', iteration(4))).toBeUndefined();
  });
});

describe('TB-07 blending, lubrication and blend uniformity', () => {
  it('[IN-36][IN-13][PR-29][INV-25] blend and lubrication times are measured (never typed) and judged against their tiers; the main blend ends no earlier than its minimum and the lubricant is added only after it; beyond a maximum is a deviation', () => {
    const { run } = startRun(TB07);
    expect(run.refused({ type: 'RECORD_DATA', actor: OP1, step: 'p', context: [], item: 'blendTime', value: { kind: 'DECIMAL', value: '600', unit: 's' }, source: { mode: 'MANUAL' } }).code).toBe('ENG-DERIVED-TYPED');
    run.entry('p', { kind: 'BLEND_START' });
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'LUBRICANT_ADDED', quantity: kg('0.250') } }).code).toBe('TB07-LUBRICANT-EARLY');
    run.minutes(5);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'BLEND_END' } }).code).toBe('TB07-BLEND-SHORT');
    run.minutes(15);
    run.entry('p', { kind: 'BLEND_END' });
    expect(run.exceptions().map((e) => e.type)).toEqual(['BLEND_TIME_EXCEEDED']);
    run.entry('p', { kind: 'LUBRICANT_ADDED', quantity: kg('0.250') });
    run.minutes(1);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: { kind: 'LUBRICATION_END' } }).code).toBe('TB07-LUBRICATION-SHORT');
    run.minutes(5);
    run.entry('p', { kind: 'LUBRICATION_END' });
    for (const l of ['L1', 'L2', 'L3', 'L4']) run.entry('p', { kind: 'BU_SAMPLE', location: l, replicate: 1, mass: { value: '500', unit: 'mg' } });
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).accepted).toBe(false);
    expect(run.value('blendTime', 'p')).toBe('1200.000000');
    expect(run.value('lubeTime', 'p')).toBe('360.000000');
    expect(run.exceptions().map((e) => `${e.type}${e.tier ? `:${e.tier}` : ''}`).sort()).toEqual(['BLEND_TIME_EXCEEDED', 'LIMIT_BREACH:INTERNAL_ACTION', 'LUBRICATION_TIME_EXCEEDED']);
  });

  it('[PR-08][IN-36][INV-25] a blend time outside its validated tier reads "outside limits" when blending ends; the signature stays offered, its attempt records the exception, which takes its deviation, and the step is then signed (owner report items 1 and 18)', () => {
    // The demo case: validated 270 to 330 s, the blend ended after 341 s. Before, the breach was raised only inside the
    // PERFORMED attempt, which the action list dry-ran and greyed out, so the exception was never stored.
    const f = fixturePhase(TB07);
    const p = { ...f, records: ['blendTime'], config: { blendTime: { min: { value: '4', unit: 'min' }, max: { value: '15', unit: 'min' }, item: 'blendTime' } } } as flow.PhaseNode;
    const base = blockMbr(TB07, p);
    const validated = { unit: 's', ranges: [{ tier: 'VALIDATED', low: { value: '270', inclusive: true }, high: { value: '330', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] };
    const mbr = { ...base, parameters: base.parameters.map((x) => (x.id === 'blendTime' ? { ...x, limits: validated } : x)) } as flow.MbrContent;
    const { run } = startRun(TB07, mbr);
    const offered = () => engine.availableActions(run.def, run.state, OP1, { nowUs: run.nowUs }, { stepKey: 'p@' }).find((a) => a.action === 'SIGN_PERFORMED');
    run.entry('p', { kind: 'BLEND_START' });
    run.advance(341_000_000n);
    run.entry('p', { kind: 'BLEND_END' });
    expect(Object.values(run.state.entries).find((e) => e.kind === 'BLEND_END')?.data['withinLimits']).toBe(false);
    expect(offered()?.available).toBe(true);
    const known = new Set(Object.keys(run.state.exceptions));
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'p', context: [], signature: sig('PERFORMED', OP1) }).code).toBe('ENG-BLOCKED');
    const [ex] = run.exceptions('LIMIT_BREACH');
    expect(ex).toMatchObject({ tier: 'VALIDATED', registrationRelevant: true, qaOnly: true, status: 'OPEN', source: { stepKey: 'p@' } });
    // What the operator reads at the refused signing (the lead's condition on #170).
    expect(recordedByAttempt(run.def, run.state, known)).toBe(`The main blend time 341 s is outside the validated 270 to 330 s. This is recorded as exception ${ex?.id ?? ''}. Link a deviation to it, then sign again.`);
    expect(recordedByAttempt(run.def, run.state, new Set(Object.keys(run.state.exceptions)))).toBeNull();
    expect(offered()).toMatchObject({ available: false, refusal: { code: 'ENG-BLOCKED' } });
    run.ok({ type: 'ATTACH_DEVIATION', actor: OP1, exception: ex?.id ?? '', deviationRef: 'TEST-DEV-0001' });
    expect(run.perform('p').accepted).toBe(true);
    expect(run.exceptions('LIMIT_BREACH')).toHaveLength(1);
  });

  it('[PR-29][DI-29] blend-uniformity samples only of the sampling plan, after blending is finished, once each, in the unit-dose unit, 1 to 3 unit doses unless a justification is recorded; locations not sampled are flagged at PERFORMED', () => {
    const { run } = startRun(TB07);
    const sample = (location: string, mass: string, extra: Json = {}): Entry => ({ kind: 'BU_SAMPLE', location, replicate: 1, mass: { value: mass, unit: 'mg' }, ...extra });
    const refused = (e: Entry) => run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: e }).code;
    run.entry('p', { kind: 'BLEND_START' });
    run.minutes(10);
    run.entry('p', { kind: 'BLEND_END' });
    expect(refused(sample('L1', '500'))).toBe('TB07-BU-EARLY');
    run.entry('p', { kind: 'LUBRICANT_ADDED', quantity: kg('0.250') });
    run.minutes(3);
    run.entry('p', { kind: 'LUBRICATION_END' });
    expect(refused(sample('L9', '500'))).toBe('TB07-NOT-PLANNED');
    expect(refused({ ...sample('L1', '500'), replicate: 2 })).toBe('TB07-NOT-PLANNED');
    expect(refused(sample('L1', '0.5', { mass: { value: '0.5', unit: 'g' } }))).toBe('TB07-SAMPLE-UNIT');
    expect(refused(sample('L1', '200'))).toBe('TB07-SAMPLE-SIZE');
    expect(refused(sample('L1', '800'))).toBe('TB07-SAMPLE-SIZE');
    run.entry('p', sample('L1', '750'));
    expect(refused(sample('L1', '500'))).toBe('TB07-SAMPLE-TWICE');
    run.entry('p', sample('L2', '800', { justification: 'Larger thief at the discharge' }));
    expect(Object.values(run.state.entries).filter((e) => e.kind === 'BU_SAMPLE').map((e) => e.data['withinDoseRange'])).toEqual([true, false]);
    run.perform('p');
    const [missing] = run.exceptions('BU_LOCATION_MISSING');
    expect(missing?.title).toMatch(/L3 replicate 1, L4 replicate 1/);
  });

  it('[PR-29] the BU results are a readings parameter of the step with limits, one reading per planned sample (C-18 statistics are the MBR\'s calculations)', () => {
    const p = fixturePhase(TB07, { config: { bu: { locations: ['L1', 'L2'], replicates: 3, unitDose: { value: '250', unit: 'mg' }, resultsItem: 'bu' } } });
    const bu = { id: 'bu', name: 'Blend uniformity', valueType: 'DECIMAL' as const, unit: '%', readings: 5, role: 'IPC' as const, criticality: 'CRITICAL' as const, riskClass: 'HIGH', capture: 'LIMS' as const };
    const mbr = blockMbr(TB07, p);
    expect(TB07.checkConfig?.(p, p.config, { ...mbr, parameters: [...mbr.parameters, bu] }).map((x) => x.code)).toEqual(['TB07-BU-RESULTS']);
  });
});
