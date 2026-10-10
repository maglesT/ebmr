/**
 * TB-01@1 in the engine (pure; the database's own rules are tb-01-db.test.ts): the golden fixture, the configuration
 * checks (basis consistency, designation, the second person, the registered overage), the lot gate with no override
 * (PR-18, IN-23, IN-24), the potency targets stored with every input (PR-19, DI-33), FEFO reasons, manual weighing in
 * two-person mode (PR-20, DI-30) and the tolerance at PERFORMED. Run on the Tablets edition's registry and catalogue.
 */
import { describe, expect, it } from 'vitest';
import { blocks, type engine, type flow } from '@ebmr/recipe-core/pure';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';
import { define, OP1, Run, sig, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { TB01 } from '../../../src/blocks/tb-01.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';

type Json = Record<string, unknown>;
const DISP1: engine.Actor = { id: 'DISP1', kind: 'PERSON', roles: ['DISPENSER'] };
const fixture = TB01.goldenFixture as blocks.BlockGoldenFixture;
const baseConfig = fixture.phase.config as Json;

function mbr(config: Json = baseConfig, extra: Partial<flow.PhaseNode> = {}): flow.MbrContent {
  const p = phase('p', { ...(fixture.phase as Partial<flow.PhaseNode>), config: config as flow.PhaseNode['config'], ...extra });
  return mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    parameters: fixture.parameters ?? [],
    bom: fixture.bom ?? [],
    references: [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }],
  });
}

const definition = (m: flow.MbrContent) => define(m, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog });
const lot = (id: string, material: string, extra: Json = {}): Json => ({ id, material, status: 'RELEASED', identityTested: true, ...extra });
const ASSAY = { resultId: '00000000-0000-4000-8000-0000000000a1', basis: 'ANHYDROUS_WATER', assay: '99.2', water: '4.6' };
const calc = (lots: Json[] = [{ lot: lot('AR-ATV-1', 'MAT-ATV'), assay: ASSAY }]): Json & { kind: string } => ({ kind: 'POTENCY_CALCULATION', lots });
const weigh = (bomLine: string, l: Json, gross: string, extra: Json = {}): Json & { kind: string } => ({
  kind: 'CONTAINER_WEIGHING', item: bomLine === 'BOM-API' ? 'dispApi' : 'dispMcc', bomLine, container: `C-${String(l['id'])}-${gross}`, lot: l, gross, tare: '0.000', unit: 'kg', balance: 'BAL-07', source: 'DEVICE', ...extra,
});

function started(m: flow.MbrContent = mbr()): Run {
  const run = Run.issue(definition(m), {}, T0);
  run.start('p', [], DISP1);
  return run;
}

const code = (run: Run, entry: Json & { kind: string }, who: engine.Actor = DISP1): string | undefined => {
  const r = run.exec({ type: 'RECORD_ENTRY', actor: who, step: 'p', context: [], entry });
  return r.accepted ? undefined : r.refusal?.message;
};

describe('TB-01@1 potency-adjusted dispensing (engine)', () => {
  it('[DI-34][DI-10] TB-01@1 is registered in the Tablets edition with every execution part of the contract, and the catalogue knows it as a significant dispensing and calculation step', () => {
    const r = tabletsBlockRegistry().report().find((x) => x.key === 'TB-01@1');
    expect(r?.missingExecutionParts).toEqual([]);
    expect(r?.controls).toEqual(['PR-04', 'PR-18', 'PR-19', 'PR-20', 'IN-23', 'IN-24', 'DI-30', 'DI-33']);
    expect(tabletsBlockCatalog.describe('TB-01')).toMatchObject({ edition: 'tablets', roles: ['DISPENSING', 'CALCULATION'], significant: true });
    expect(blocks.genericBlockRegistry().get('TB-01', '1')).toBeUndefined();
  });

  it('[PR-19][DI-33] golden fixture: the C-06 lot raises the active to 8.742 kg and lowers the filler to 19.531 kg; both dispensed, the totals computed, performed by the dispenser and checked', () => {
    const run = started();
    run.entry('p', fixture.script[0] && 'entry' in fixture.script[0] ? fixture.script[0].entry : calc(), [], DISP1);
    const stored = Object.values(run.state.entries).find((e) => e.kind === 'POTENCY_CALCULATION')?.data as Json;
    expect(stored['lots']).toEqual([{ lot: lot('AR-ATV-1', 'MAT-ATV'), assay: ASSAY }]);
    expect(stored['results']).toEqual([{ lot: 'AR-ATV-1', asIsAssay: '94.6368', baseEquivalent: '8', calculated: '8.741486', target: '8.742' }]);
    expect(stored).toMatchObject({
      active: { bomLine: 'BOM-API', standardQuantity: '8.000', unit: 'kg', standardIs: 'BASE', overagePercent: '0', factor: '1.034083', standard: '8.272662' },
      excipient: { bomLine: 'BOM-MCC', standard: '20.000', calculated: '19.531177', target: '19.531' },
      total: { standard: '28.272662', target: '28.273' },
      readability: '0.001',
      formula: 'TB-01@1',
    });
    for (const s of fixture.script.slice(1)) if ('entry' in s) run.entry('p', s.entry, [], DISP1);
    run.perform('p', [], DISP1);
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
    expect(run.value('dispApi', 'p')).toBe('8.742');
    expect(run.value('dispMcc', 'p')).toBe('19.531');
    expect(run.exceptions().map((e) => e.type)).toEqual([]);
  });

  it('[PR-19][DI-33][PR-20] the configuration is refused when a hydrate molar mass meets a water-corrected assay, when the step is not performed by the designated dispenser or not checked by a second person, or an overage has no registration reference', () => {
    const codes = (m: flow.MbrContent): string[] => {
      try {
        definition(m);
        return [];
      } catch (e) {
        return [...new Set((e as engine.EngineDefinitionError).problems.map((p) => p.code))].sort();
      }
    };
    const active = baseConfig['active'] as Json;
    expect(codes(mbr())).toEqual([]);
    expect(codes(mbr({ ...baseConfig, active: { ...active, form: { ...(active['form'] as Json), hydrateWaters: 3 } } }))).toEqual(['TB01-BASIS-CONSISTENCY']);
    expect(codes(mbr(baseConfig, { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } }))).toEqual(['TB01-PERFORMER']);
    expect(codes(mbr(baseConfig, { signatures: { perform: { role: 'DISPENSER' } } }))).toEqual(['TB01-NO-CHECK']);
    expect(codes(mbr({ ...baseConfig, active: { ...active, overagePercent: '2' } }))).toEqual(['TB01-OVERAGE']);
    expect(codes(mbr({ ...baseConfig, compensation: { mode: 'NONE' } }))).toEqual(['TB01-NO-COMPENSATION']);
  });

  it('[PR-19] a non-designated user is refused: an operator without the dispenser role can neither start the step nor record its calculation', () => {
    const run = Run.issue(definition(mbr()), {}, T0);
    expect(run.exec({ type: 'START_STEP', actor: OP1, step: 'p', context: [] }).refusal?.code).toBe('ENG-ROLE');
    run.start('p', [], DISP1);
    expect(run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p', context: [], entry: calc() }).accepted).toBe(false);
  });

  it('[PR-18][IN-23][IN-24] a quarantined lot, a lot past its retest date, an expired lot and the wrong material are hard-blocked in the calculation and at the balance, with no override; without an identity result a batch for the US is refused', () => {
    const run = started();
    const past = (T0 - 1n).toString();
    expect(code(run, calc([{ lot: lot('AR-ATV-Q', 'MAT-ATV', { status: 'QUARANTINE' }), assay: ASSAY }]))).toMatch(/TB01-LOT-STATUS/);
    expect(code(run, calc([{ lot: lot('AR-ATV-R', 'MAT-ATV', { retestAtUs: past }), assay: ASSAY }]))).toMatch(/TB01-LOT-RETEST/);
    expect(code(run, calc([{ lot: lot('AR-ATV-E', 'MAT-ATV', { expiresAtUs: past }), assay: ASSAY }]))).toMatch(/TB01-LOT-EXPIRED/);
    expect(code(run, calc([{ lot: lot('AR-MCC-1', 'MAT-MCC'), assay: ASSAY }]))).toMatch(/TB01-WRONG-MATERIAL/);
    run.entry('p', calc(), [], DISP1);
    expect(code(run, weigh('BOM-MCC', lot('AR-MCC-Q', 'MAT-MCC', { status: 'QUARANTINE' }), '19.531'))).toMatch(/TB01-LOT-STATUS/);
    expect(code(run, weigh('BOM-MCC', lot('AR-MCC-R', 'MAT-MCC', { retestAtUs: past }), '19.531'))).toMatch(/TB01-LOT-RETEST/);
    const us = { ...mbr(), header: { ...mbr().header, marketSet: ['IN', 'US'] } };
    const forUs = Run.issue(definition(us), { marketSet: ['IN', 'US'] }, T0);
    forUs.start('p', [], DISP1);
    expect(code(forUs, calc([{ lot: lot('AR-ATV-1', 'MAT-ATV', { identityTested: false }), assay: ASSAY }]))).toMatch(/TB01-LOT-IDENTITY/);
  });

  it('[PR-19][DI-33] the assay must be on the MBR\'s basis and complete; the active is dispensed only from the lots of the calculation, after it; a new calculation once material is dispensed is refused', () => {
    const run = started();
    expect(code(run, weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '8.742'))).toMatch(/TB01-NO-CALCULATION/);
    expect(code(run, calc([{ lot: lot('AR-ATV-1', 'MAT-ATV'), assay: { ...ASSAY, basis: 'AS_IS' } }]))).toMatch(/TB01-BASIS/);
    expect(code(run, calc([{ lot: lot('AR-ATV-1', 'MAT-ATV'), assay: { resultId: ASSAY.resultId, basis: 'ANHYDROUS_WATER', assay: '99.2' } }]))).toMatch(/water result its basis needs is missing.*TB01-ASSAY/);
    run.entry('p', calc(), [], DISP1);
    expect(code(run, weigh('BOM-API', lot('AR-ATV-2', 'MAT-ATV'), '8.742'))).toMatch(/TB01-LOT-NOT-CALCULATED/);
    run.entry('p', weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '8.742'), [], DISP1);
    expect(code(run, calc())).toMatch(/TB01-CALC-AFTER-DISPENSE/);
  });

  it('[PR-18] a lot dispensed with the dispenser\'s FEFO reason raises FEFO_OVERRIDE for the rotation report; a blank reason is refused', () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    expect(code(run, weigh('BOM-MCC', lot('AR-MCC-2', 'MAT-MCC'), '19.531', { fefoReason: '   ' }))).toMatch(/TB01-FEFO-REASON/);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-2', 'MAT-MCC'), '19.531', { fefoReason: 'The older lot is on the high shelf of the cold room, issued tomorrow' }), [], DISP1);
    expect(run.exceptions('FEFO_OVERRIDE').map((e) => e.severity)).toEqual(['ALERT']);
  });

  it('[PR-20][DI-30] a weighing keyed by hand (scale offline) flags the entry, raises MANUAL_ENTRY_FALLBACK and switches the step to two-person mode: the dispenser cannot check their own dispensing', () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    run.entry('p', weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '8.742', { source: 'MANUAL' }), [], DISP1);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-1', 'MAT-MCC'), '19.531'), [], DISP1);
    expect(run.inst('p')?.verificationRequired).toBe(true);
    expect(run.exceptions('MANUAL_ENTRY_FALLBACK')).toHaveLength(1);
    run.perform('p', [], DISP1);
    const self = { ...DISP1, roles: ['DISPENSER', 'PRODUCTION_VERIFIER'] };
    const r = run.exec({ type: 'VERIFY', actor: self, step: 'p', context: [], signature: sig('CONTAINER_CHECKED', self) });
    expect(r.accepted).toBe(false);
    expect(r.refusal?.code).toMatch(/ENG-SEGREGATION|ENG-ROLE|ENG-SELF/);
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
  });

  it('[PR-19] PERFORMED waits for every line and lot of the calculation, and a total outside its tolerance raises DISPENSE_OUT_OF_TOLERANCE', () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    run.entry('p', weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '8.742'), [], DISP1);
    expect(run.exec({ type: 'SIGN_PERFORMED', actor: DISP1, step: 'p', context: [], signature: sig('PERFORMED', DISP1) }).refusal?.message).toMatch(/TB01-INCOMPLETE/);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-1', 'MAT-MCC'), '19.000'), [], DISP1);
    run.perform('p', [], DISP1);
    expect(run.exceptions('DISPENSE_OUT_OF_TOLERANCE').map((e) => e.title)).toEqual([expect.stringMatching(/^BOM-MCC: 19 kg dispensed is outside 1.0 % of its target 19.531 kg/)]);
  });

  it('[PR-19][PR-04] an adjustment beyond the MBR\'s cap raises POTENCY_ADJUSTMENT_CAP; a negative compensating excipient is refused', () => {
    const run = started(mbr({ ...baseConfig, adjustmentCapPercent: '5' }));
    run.entry('p', calc(), [], DISP1);
    expect(run.exceptions('POTENCY_ADJUSTMENT_CAP')).toHaveLength(1);
    const low = started(mbr({ ...baseConfig, compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '19.900', max: '22.000' } }));
    expect(code(low, calc())).toMatch(/TB01-EXCIPIENT-RANGE/);
  });

  it('[DI-34] the simulator\'s nominal path of the fixture phase is accepted by the engine and completes', () => {
    const m = mbr();
    const def = definition(m);
    const run = Run.issue(def, {}, T0);
    run.start('p', [], DISP1);
    const p = def.steps.get('p')?.node as flow.PhaseNode;
    for (const e of TB01.simulatorModel?.nominalEntries({ phase: p, config: p.config, mbr: m, frames: [], containers: [], target: () => undefined }) ?? []) run.entry('p', e, [], DISP1);
    run.perform('p', [], DISP1);
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
    expect(run.exceptions().map((e) => e.type)).toEqual([]);
  });
});
