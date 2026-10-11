/**
 * TB-01 potency-adjusted dispensing, the database's own arithmetic (SQL mutation group "tablets-dispensing", tablets
 * 0842): the rounding to the balance's readability, the as-is assay a result gives, and the potency calculation's
 * refusals and boundaries (lots 1 to 3 and the MBR's maximum, the one-lot and shared allocations, the compensating
 * excipient at the edges of its approved range and at zero). These functions are immutable and are called directly on
 * the GMP template, with the block's configuration and the MBR content as data.
 *
 * Controls: PR-19, PR-04, DI-33; invariant INV-25.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startServer('GMP');
}, 180_000);
afterAll(async () => {
  await gmp?.close();
});

type Json = Record<string, unknown>;
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await gmp.db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;
async function refusal(sql: string, params: unknown[]): Promise<string> {
  try {
    await gmp.db.admin.query(sql, params);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '(not refused)';
}

describe('tab.tb01_round', () => {
  const round = (n: string, d: string, step: string, mode: string) => one<string>('select tab.tb01_round($1::numeric, $2::numeric, $3::numeric, $4)::text as r', [n, d, step, mode]);

  it('[INV-25][PR-19] UP rounds a remainder up and an exact multiple not at all; HALF_UP rounds half away from zero', async () => {
    expect(await round('7', '1', '1', 'UP')).toBe('7');
    expect(await round('7.2', '1', '1', 'UP')).toBe('8');
    expect(await round('7', '4', '0.5', 'UP')).toBe('2.0');
    expect(await round('7.4', '1', '1', 'HALF_UP')).toBe('7');
    expect(await round('7.5', '1', '1', 'HALF_UP')).toBe('8');
    expect(await round('-7.5', '1', '1', 'HALF_UP')).toBe('-8');
    expect(await round('-7.2', '1', '1', 'UP')).toBe('-8');
  });

  it('[INV-25] a denominator or step that is not positive is refused with its own message', async () => {
    for (const [d, step] of [['0', '1'], ['-1', '1'], ['1', '0'], ['1', '-0.1']]) {
      expect(await refusal("select tab.tb01_round(1, $1::numeric, $2::numeric, 'UP')", [d, step])).toBe('tab.tb01_round: a positive denominator and step');
    }
  });
});

describe('tab.tb01_as_is', () => {
  const asIs = (a: Json) => one<{ p_value: string | null; p_problem: string | null }>('select row_to_json(x) as r from tab.tb01_as_is($1::jsonb) x', [JSON.stringify(a)]);

  it('[PR-19] each basis needs its own results, and with them gives the as-is assay', async () => {
    expect((await asIs({ basis: 'ANHYDROUS_WATER', assay: '99' })).p_problem).toBe('the water result its basis needs is missing');
    expect(Number((await asIs({ basis: 'ANHYDROUS_WATER', assay: '100', water: '2' })).p_value)).toBe(98);
    expect((await asIs({ basis: 'DRIED_LOD', assay: '99' })).p_problem).toBe('the loss on drying result its basis needs is missing');
    expect(Number((await asIs({ basis: 'DRIED_LOD', assay: '100', lod: '1' })).p_value)).toBe(99);
    expect((await asIs({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '99', water: '1' })).p_problem).toBe('the solvents result its basis needs is missing');
    expect(Number((await asIs({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '100', water: '1', solvents: '1' })).p_value)).toBe(98);
  });

  it('[PR-19] a usable as-is assay is above 0 and at most 200 %', async () => {
    expect(Number((await asIs({ basis: 'AS_IS', assay: '200' })).p_value)).toBe(200);
    expect(Number((await asIs({ basis: 'AS_IS', assay: '0.001' })).p_value)).toBe(0.001);
    for (const a of ['200.001', '0', '-1']) expect((await asIs({ basis: 'AS_IS', assay: a })).p_problem).toMatch(/is not a usable assay/);
    expect((await asIs({ basis: 'AS_IS' })).p_problem).toMatch(/is not a usable assay/);
  });
});

describe('tab.tb01_calculation', () => {
  const CONTENT = { bom: [{ id: 'api', quantity: { value: '100', unit: 'g' } }, { id: 'mcc', quantity: { value: '25', unit: 'g' } }] };
  const ACTIVE = { standardIs: 'FORM', basis: 'AS_IS', bomLine: 'api' };
  const cfg = (over: Json = {}, active: Json = {}, comp: Json = { mode: 'NONE' }) => ({ readability: '0.001', active: { ...ACTIVE, ...active }, compensation: comp, ...over });
  const lot = (id: string, assay = '100', extra: Json = {}) => ({ lot: { id }, assay: { basis: 'AS_IS', assay }, ...extra });
  const calc = (c: Json, lots: unknown, content: Json = CONTENT) =>
    one<{ problem?: string; data?: { results: { target: string }[]; excipient?: { target: string } } }>('select tab.tb01_calculation($1::jsonb, $2::jsonb, $3::jsonb) as r', [
      JSON.stringify(c), JSON.stringify(content), JSON.stringify(lots),
    ]);

  it('[PR-19] the configuration states its standard and assay basis, and a complete compensation or none', async () => {
    expect((await calc(cfg({}, { basis: null }), [lot('L1')])).problem).toMatch(/states no standard basis/);
    expect((await calc(cfg({}, { standardIs: 'SALT' }), [lot('L1')])).problem).toMatch(/states no standard basis/);
    expect((await calc(cfg({}, {}, {}), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({}, {}, { mode: 'EXCIPIENT', min: '0', bomLine: 'mcc' }), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({}, {}, { mode: 'EXCIPIENT', min: '0', max: '100' }), [lot('L1')])).problem).toMatch(/TB01-EXCIPIENT-RANGE/);
    expect((await calc(cfg({ readability: '0' }), [lot('L1')])).problem).toMatch(/TB01-READABILITY/);
    expect((await calc(cfg({ readability: null }), [lot('L1')])).problem).toMatch(/TB01-READABILITY/);
  });

  it('[PR-19][INV-25] the salt-to-base factor applies to a base standard with its form only', async () => {
    const form = { molarMassForm: '2', baseMoieties: '1', molarMassBase: '1' };
    expect((await calc(cfg({}, { standardIs: 'BASE', form }), [lot('L1')])).data?.results[0]?.target).toBe('200.000');
    // A FORM standard ignores a form given with it.
    expect((await calc(cfg({}, { form }), [lot('L1')])).data?.results[0]?.target).toBe('100.000');
  });

  it('[PR-19][PR-04] 1 to 3 lots and at most the MBR\'s maximum; a numeric maximum only', async () => {
    expect((await calc(cfg(), [])).problem).toMatch(/across 0 lots/);
    const four = ['A', 'B', 'C', 'D'].map((x) => lot(x, '100', { baseEquivalent: '25' }));
    expect((await calc(cfg(), four)).problem).toMatch(/across 4 lots, where the MBR allows 1 to 3/);
    const three = ['A', 'B', 'C'].map((x, i) => lot(x, '100', { baseEquivalent: ['50', '25', '25'][i] }));
    expect((await calc(cfg(), three)).data).toBeDefined();
    expect((await calc(cfg({}, { maxLots: 3 }), three)).data).toBeDefined();
    expect((await calc(cfg({}, { maxLots: 2 }), three)).problem).toMatch(/across 3 lots, where the MBR allows 1 to 2/);
    expect((await calc(cfg({}, { maxLots: '2' }), three)).data).toBeDefined();
  });

  it('[PR-19][INV-25] one lot carries the whole need; shared lots each a positive share, adding up to the need', async () => {
    expect((await calc(cfg(), [lot('L1', '100', { baseEquivalent: '100' })])).data).toBeDefined();
    expect((await calc(cfg(), [lot('L1', '100', { baseEquivalent: '99' })])).problem).toMatch(/TB01-ALLOCATION/);
    expect((await calc(cfg(), [lot('A'), lot('B', '100', { baseEquivalent: '100' })])).problem).toMatch(/gives lot 1 no positive base-equivalent share/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '0' }), lot('B', '100', { baseEquivalent: '100' })])).problem).toMatch(/gives lot 1 no positive/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '60' }), lot('B', '100', { baseEquivalent: '30' })])).problem).toMatch(/add up to 90, not to the 100/);
    expect((await calc(cfg(), [lot('A', '100', { baseEquivalent: '60' }), lot('B', '100', { baseEquivalent: '40' })])).data).toBeDefined();
  });

  it('[PR-19][INV-25] the compensating excipient: at zero and at the edges of its range accepted, below zero or outside refused', async () => {
    const comp = (min: string, max: string) => ({ mode: 'EXCIPIENT', min, max, bomLine: 'mcc' });
    // Assay 80 %: 125 g of the active for 100 g; the excipient drops by 25 g, from 25 g to exactly 0.
    expect((await calc(cfg({}, {}, comp('0', '100')), [lot('L1', '80')])).data?.excipient?.target).toBe('0.000');
    expect((await calc(cfg({}, {}, comp('-10', '100')), [lot('L1', '50')])).problem).toMatch(/below zero \(TB01-EXCIPIENT-NEGATIVE\)/);
    // Assay 100 %: the excipient stays at its standard 25 g, the edges of a range 25 to 25 included.
    expect((await calc(cfg({}, {}, comp('25', '25')), [lot('L1', '100')])).data?.excipient?.target).toBe('25.000');
    expect((await calc(cfg({}, {}, comp('25.001', '30')), [lot('L1', '100')])).problem).toMatch(/outside its approved range/);
    expect((await calc(cfg({}, {}, comp('20', '24.999')), [lot('L1', '100')])).problem).toMatch(/outside its approved range/);
  });
});
