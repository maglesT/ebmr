/**
 * TB-01@2, potency adjustment in enzyme activity units (Phase 7 slice 7q, requirement R8 capability C2; tablets 1662), in
 * the engine (pure): the exact arithmetic (standard x declared activity / the lot's activity, UP to the readability; the
 * compensating excipient; the label claim in units), the configuration checks, the golden fixture through PERFORMED
 * and the check, and the registry. The database's recomputation, the lot register and the GMP LIMS source are in
 * tb-01-db.test.ts and tb-01-gmp.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { blocks, engine, flow } from '@ebmr/recipe-core/pure';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';
import { define, Run, T0, VER1 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { TB01, TB01_V2 } from '../../../src/blocks/tb-01.ts';
import { potencyTargets, type PotencyInput } from '../../../src/blocks/dispensing/potency.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';

type Json = Record<string, unknown>;
const DISP1: engine.Actor = { id: 'DISP1', kind: 'PERSON', roles: ['DISPENSER'] };
const fixture = TB01_V2.goldenFixture as blocks.BlockGoldenFixture;
const baseConfig = fixture.phase.config as Json;
const activeOf = (c: Json) => c['active'] as Json;

function mbr(config: Json = baseConfig): flow.MbrContent {
  const p = phase('p', { ...(fixture.phase as Partial<flow.PhaseNode>), config: config as flow.PhaseNode['config'] });
  return mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    parameters: fixture.parameters ?? [],
    bom: fixture.bom ?? [],
    references: [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }],
  });
}
const definition = (m: flow.MbrContent) => define(m, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog });
const checks = (config: Json): string[] => {
  const m = mbr(config);
  const look = (n: unknown): flow.PhaseNode | undefined => {
    if (Array.isArray(n)) return n.map(look).find(Boolean);
    if (n && typeof n === 'object') return (n as Json)['id'] === 'p' && (n as Json)['kind'] === 'phase' ? (n as flow.PhaseNode) : look(Object.values(n));
    return undefined;
  };
  const p = look(m.procedure);
  if (!p) throw new Error('no phase');
  return (TB01_V2.checkConfig?.(p, p.config, m) ?? []).filter((x) => x.code === 'TB01-ACTIVITY').map((x) => x.message);
};

const full = (over: object): Record<string, unknown> => ({
  standardQuantity: '2.000',
  standardIs: 'FORM',
  overagePercent: '0',
  lots: [{ assay: { basis: 'ACTIVITY', assay: '125' } }],
  excipient: { standard: '10.000', min: '9.000', max: '11.000' },
  readability: '0.001',
  activity: { declared: '100', mgPerUnit: '1000000' },
  ...over,
});

/** The fixture's input with `over` applied; a member set to undefined is left out (exact optional properties). */
const input = (over: { [K in keyof PotencyInput]?: PotencyInput[K] | undefined } = {}): PotencyInput =>
  Object.fromEntries(Object.entries(full(over)).filter(([, v]) => v !== undefined)) as unknown as PotencyInput;

describe('TB-01@2 potency adjustment in activity units (slice 7q, C2)', () => {
  it('[PR-19][DI-33] a lot of 125 U/mg against a declared 100 U/mg takes 1.600 kg of the 2.000 kg standard; the excipient rises to 10.400 kg; the label claim is 200,000,000 U', () => {
    const r = potencyTargets(input());
    expect(r).toEqual({
      ok: true,
      result: {
        factor: '1.000000',
        standard: '2.000000',
        lots: [{ asIsAssay: '125.000000', activity: '125', baseEquivalent: '2', calculated: '1.600000', target: '1.600' }],
        excipient: { standard: '10.000', calculated: '10.400000', target: '10.400' },
        total: { standard: '12.000000', target: '12.000' },
        adjustmentPercent: '20.000000',
        activity: { declared: '100', unit: 'U/mg', labelClaimUnits: '200000000' },
      },
    });
  });

  it('[PR-19][DI-33][PR-04] exact, never a binary fraction: a lot of 3 U/mg against 100 U/mg (a quotient that does not terminate) is rounded UP, so the batch never holds fewer units than its label claim; the overage counts into the claim', () => {
    const r = potencyTargets(input({ lots: [{ assay: { basis: 'ACTIVITY', assay: '3' } }], excipient: undefined, overagePercent: '5' }));
    if (!r.ok) throw new Error(r.message);
    // 2.000 x 1.05 x 100 / 3 = 70 kg exactly; at 7 U/mg: 30 kg = 29.999999.. never truncated below.
    expect(r.result.lots[0]).toEqual({ asIsAssay: '3.000000', activity: '3', baseEquivalent: '2.1', calculated: '70.000000', target: '70.000' });
    expect(r.result.activity?.labelClaimUnits).toBe('210000000');
    const seven = potencyTargets(input({ lots: [{ assay: { basis: 'ACTIVITY', assay: '7' } }], excipient: undefined, readability: '0.001' }));
    if (!seven.ok) throw new Error(seven.message);
    // 2 x 100 / 7 = 28.571428571...: shown at six decimals, the target UP to the gram.
    expect(seven.result.lots[0]).toMatchObject({ calculated: '28.571429', target: '28.572', asIsAssay: '7.000000' });
    // Two lots share the units by their base-equivalent shares, each at its own activity.
    const two = potencyTargets(input({ lots: [{ assay: { basis: 'ACTIVITY', assay: '80' }, baseEquivalent: '1.2' }, { assay: { basis: 'ACTIVITY', assay: '160' }, baseEquivalent: '0.8' }], excipient: undefined }));
    if (!two.ok) throw new Error(two.message);
    expect(two.result.lots.map((l) => [l.activity, l.target])).toEqual([['80', '1.500'], ['160', '0.500']]);
  });

  it('[PR-19] an activity lot needs the declared activity, and a usable (positive) activity; a percent lot still calculates as before', () => {
    expect(potencyTargets(input({ activity: undefined }))).toMatchObject({ ok: false, code: 'TB01-ACTIVITY' });
    expect(potencyTargets(input({ lots: [{ assay: { basis: 'ACTIVITY', assay: '0' } }] }))).toMatchObject({ ok: false, code: 'TB01-ASSAY' });
    const pct = potencyTargets(input({ lots: [{ assay: { basis: 'AS_IS', assay: '98.5' } }], activity: undefined, excipient: undefined }));
    expect(pct.ok && pct.result.lots[0]?.asIsAssay).toBe('98.5');
    expect(pct.ok && pct.result.activity).toBeUndefined();
  });

  it('[PR-19][DI-33] the configuration: the ACTIVITY basis states its declared activity on a FORM standard in a mass unit; a declared activity only with that basis', () => {
    expect(checks(baseConfig)).toEqual([]);
    const without = { ...baseConfig, active: { ...activeOf(baseConfig), declaredActivity: undefined } };
    expect(checks(without)).toEqual(['an active judged by its activity states the activity (U/mg) its standard quantity is at (TB01-ACTIVITY)']);
    const base = { ...baseConfig, active: { ...activeOf(baseConfig), standardIs: 'BASE', form: { name: 'x', molarMassForm: '2', molarMassBase: '1', baseMoieties: 1, hydrateWaters: 0, source: 's' } } };
    expect(checks(base)).toContain('an active judged by its activity states its standard on the material itself (FORM), without a salt form (TB01-ACTIVITY)');
    const stray = { ...baseConfig, active: { ...activeOf(baseConfig), basis: 'AS_IS' } };
    expect(checks(stray)).toEqual(['a declared activity is stated only with the ACTIVITY basis, not AS_IS (TB01-ACTIVITY)']);
    // TB-01@1 is unchanged: its schemas know no ACTIVITY basis and no declared activity.
    const v1Basis = ((TB01.configSchema?.fields['active'] as blocks.ObjectSchema).fields['basis'] as unknown as { enum: string[] }).enum;
    expect(v1Basis).not.toContain('ACTIVITY');
    expect((TB01.configSchema?.fields['active'] as blocks.ObjectSchema).fields['declaredActivity']).toBeUndefined();
  });

  it('[PR-19][DI-33][PR-20] golden fixture: the lot of 125 U/mg is calculated, dispensed into labelled containers with the excipient, performed by the dispenser and checked', () => {
    const run = Run.issue(definition(mbr()), {}, T0);
    run.start('p', [], DISP1);
    for (const s of fixture.script) if ('entry' in s) run.entry('p', s.entry, [], DISP1);
    const stored = Object.values(run.state.entries).find((e) => e.kind === 'POTENCY_CALCULATION')?.data as Json;
    expect(stored).toMatchObject({
      results: [{ lot: 'AR-FDS-1', asIsAssay: '125.000000', activity: '125', baseEquivalent: '2', calculated: '1.600000', target: '1.600' }],
      active: { bomLine: 'BOM-FDS', standardIs: 'FORM', activity: { declared: '100', unit: 'U/mg', labelClaimUnits: '200000000' } },
      excipient: { bomLine: 'BOM-LAC', target: '10.400' },
      formula: 'TB-01@2',
    });
    run.perform('p', [], DISP1);
    run.verify('p', [], VER1);
    expect(run.status('p')).toBe('COMPLETED');
    expect([run.value('dispFds', 'p'), run.value('dispLac', 'p')]).toEqual(['1.600', '10.400']);
  });

  it('[DI-34][DI-10] TB-01@2 is registered beside TB-01@1 with every execution part of the contract', () => {
    const report = tabletsBlockRegistry().report();
    expect(report.find((x) => x.key === 'TB-01@2')?.missingExecutionParts).toEqual([]);
    expect(report.find((x) => x.key === 'TB-01@1')?.missingExecutionParts).toEqual([]);
    expect(tabletsBlockCatalog.describe('TB-01')?.versions).toEqual(['1', '2']);
  });
});
