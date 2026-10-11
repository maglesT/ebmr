/**
 * The in-process checks' verdict arithmetic held by the database (SQL mutation group "tablets-ipc", tablets 0891): the
 * statistics, the bounds and verdicts, the weight-uniformity band and count outside it, the content-uniformity
 * reference value and acceptance value, the subdivision count and the friability sample rule. These functions are
 * immutable and are called directly on the GMP template with the rule sets' parameters as data.
 *
 * Controls: PR-29, IN-34, DI-33; invariant INV-25.
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

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await gmp.db.admin.query<{ r: T }>(sql, params)).rows[0]?.r as T;
const j = (x: unknown): string => JSON.stringify(x);

describe('statistics, bounds and verdicts', () => {
  it('[PR-29][DI-33] the statistics of the values', async () => {
    expect(await one('select tab.ipc_stats($1::numeric[]) as r', [['1', '2', '3']])).toEqual({
      n: 3, sum: '6', mean: '2.0000', min: '1', max: '3', minDeviation: '-50.00', maxDeviation: '50.00', sd: '1.0000', rsd: '50.00',
    });
    expect(await one('select tab.ipc_stats($1::numeric[]) as r', [['5']])).not.toHaveProperty('sd');
  });

  it('[PR-29] a value on a bound is inside it; beyond a bound is outside; the verdict is the worst tier crossed', async () => {
    const beyond = (v: string, b: unknown) => one<boolean>('select tab.ipc_beyond($1::numeric, $2::jsonb) as r', [v, j(b)]);
    expect(await beyond('10', { min: '10', max: '20' })).toBe(false);
    expect(await beyond('20', { min: '10', max: '20' })).toBe(false);
    expect(await beyond('9.99', { min: '10', max: '20' })).toBe(true);
    expect(await beyond('20.01', { min: '10', max: '20' })).toBe(true);
    expect(await beyond('5', { max: '20' })).toBeFalsy();
    expect(await beyond('25', { min: '10' })).toBeFalsy();
    expect(await beyond('25', null)).toBe(false);
    const judge = (v: string) => one<string>('select tab.ipc_judge($1::numeric, $2::jsonb) as r', [v, j({ action: { min: '90', max: '110' }, alert: { min: '95', max: '105' } })]);
    expect([await judge('100'), await judge('95'), await judge('94'), await judge('110'), await judge('111')]).toEqual(['PASS', 'PASS', 'ALERT', 'ALERT', 'FAIL']);
    const worst = (p: string[]) => one<string>('select tab.ipc_worst($1::text[]) as r', [p]);
    expect([await worst(['PASS', 'ALERT']), await worst(['ALERT', 'FAIL', 'PASS']), await worst(['PASS'])]).toEqual(['ALERT', 'FAIL', 'PASS']);
    expect(await one('select tab.ipc_relative_tiers(200, $1::jsonb) as r', [j({ action: '5', alert: '2.5' })])).toEqual({
      action: { min: '190', max: '210' }, alert: { min: '195', max: '205' },
    });
    expect(await one('select tab.ipc_relative_tiers(200, $1::jsonb) as r', [j({ action: '5' })])).toEqual({ action: { min: '190', max: '210' } });
  });
});

describe('weight uniformity and subdivision', () => {
  const PARAMS = { bands: [{ upToMg: '80', percent: '10', inclusive: true }, { upToMg: '250', percent: '7.5' }, { percent: '5' }], maxOutside: 2, maxOutsideDouble: 0 };

  it('[PR-29][IN-34] the band by the average weight: an inclusive limit takes its average, an exclusive one does not', async () => {
    const band = (sum: string, n: string) => one<string | null>('select tab.ipc_band($1::jsonb, $2::numeric, $3::numeric) as r', [j(PARAMS), sum, n]);
    expect(await band('1600', '20')).toBe('10');
    expect(await band('1600.02', '20')).toBe('7.5');
    expect(await band('4999.8', '20')).toBe('7.5');
    expect(await band('5000', '20')).toBe('5');
    expect(await one('select tab.ipc_band($1::jsonb, 100, 1) as r', [j({ bands: [{ upToMg: '80', percent: '10' }] })])).toBeNull();
  });

  it('[PR-29][IN-34] a unit exactly at the band is inside it; the counts against the rule set\'s maxima decide the pass', async () => {
    // Twenty units averaging 300 mg (band 5 %): 315 is exactly +5 %, 316 is outside, 331 is outside twice the band.
    const ws = (extra: string[]) => [...Array.from({ length: 20 - extra.length }, () => '300'), ...extra];
    const outside = (w: string[], p: string) => one<number>('select tab.ipc_outside($1::numeric[], (select sum(x) from unnest($1::numeric[]) x), $2::numeric) as r', [w, p]);
    expect(await outside(['315', '285', '300', '300'], '5')).toBe(0);
    expect(await outside(['316', '284', '300', '300'], '5')).toBe(2);
    const uniformity = (w: string[]) =>
      one<{ outside: number; outsideDouble: number; pass: boolean; percent: string }[]>('select tab.ipc_uniformity($1::numeric[], $2::jsonb) as r', [w, j([{ code: 'PH-EUR', version: 1, params: PARAMS }])]);
    expect((await uniformity(ws(['316', '284']))).at(0)).toMatchObject({ percent: '5', outside: 2, outsideDouble: 0, pass: true });
    expect((await uniformity(ws(['316', '284', '316', '284']))).at(0)).toMatchObject({ outside: 4, pass: false });
    expect((await uniformity(ws(['331', '269']))).at(0)).toMatchObject({ outsideDouble: 2, pass: false });
    const sub = (w: string[]) =>
      one<{ outsideInner: number; outsideOuter: number; pass: boolean }[]>('select tab.ipc_subdivision($1::numeric[], $2::jsonb) as r', [
        w, j([{ code: 'SUB', version: 1, params: { innerPercent: '10', outerPercent: '20', maxOutsideInner: 1, maxOutsideOuter: 0 } }]),
      ]);
    expect((await sub(['100', '100', '100', '100', '111', '89'])).at(0)).toMatchObject({ outsideInner: 2, outsideOuter: 0, pass: false });
    expect((await sub(['100', '100', '100', '100', '110', '90'])).at(0)).toMatchObject({ outsideInner: 0, pass: true });
    expect((await sub(['100', '100', '100', '100', '111', '89', '100'])).at(0)).toMatchObject({ outsideInner: 2 });
  });
});

describe('content uniformity and friability', () => {
  const P = { referenceLow: '98.5', referenceHigh: '101.5', firstK: '2.4', secondK: '2.0', avDecimals: 1, acceptanceLimit: '15.0', unitLimitPercent: '25' };

  it('[PR-29][INV-25] the reference value M: the low limit below it, the high limit (or the target above it) above it, else the mean', async () => {
    const ref = (x: string, t: string) => one<string>('select tab.ipc_reference($1::jsonb, $2::numeric, $3::numeric)::text as r', [j(P), x, t]);
    expect(await ref('97', '100')).toBe('98.5');
    expect(await ref('98.5', '100')).toBe('98.5');
    expect(await ref('100', '100')).toBe('100');
    expect(await ref('101.5', '100')).toBe('101.5');
    expect(await ref('103', '100')).toBe('101.5');
    expect(await ref('103', '102')).toBe('102');
    expect(await ref('101.8', '102')).toBe('101.8');
  });

  it('[PR-29][INV-25] the acceptance value and its limit; at the second stage no unit outside the unit limit', async () => {
    const av = (ws: string[], assay: string, second = false, set = P) =>
      one<{ av: string; pass: boolean; reference: string; k: string; outsideUnitLimit?: number }>('select tab.ipc_av($1::numeric[], $2::numeric, 100, $3::jsonb, $4) as r', [
        ws, assay, j({ code: 'USP-905', version: 1, params: set }), second,
      ]);
    expect(await av(['100', '100', '100'], '100')).toMatchObject({ av: '0.0', pass: true, reference: '100', k: '2.4' });
    expect(await av(['100', '100', '100'], '83.5')).toMatchObject({ av: '15.0', pass: true, reference: '98.5' });
    expect(await av(['100', '100', '100'], '83.4')).toMatchObject({ av: '15.1', pass: false });
    expect(await av(['100', '100', '100'], '100', true)).toMatchObject({ k: '2.0', outsideUnitLimit: 0, pass: true });
    // One unit 60 % above the mean of the others, its content outside M x (1 +/- 25 %).
    const r = await av(['100', '100', '160'], '100', true, { ...P, acceptanceLimit: '99.0' });
    expect(r.outsideUnitLimit).toBe(1);
    expect(r.pass).toBe(false);
  });

  it('[PR-29] a friability sample: heavy tablets by count, light ones by the whole number nearest to the target mass', async () => {
    const PF = { heavyUnitMg: '650', heavyUnitCount: '10', targetSampleGrams: '6.5' };
    const problem = (tablets: string, grams: string) => one<string | null>('select tab.ipc_friability_sample_problem($1::jsonb, $2::numeric, $3::numeric) as r', [j(PF), tablets, grams]);
    expect(await problem('10', '7.0')).toBeNull();
    expect(await problem('12', '8.4')).toMatch(/tablets above 650 mg are tested 10 at a time, not 12/);
    expect(await problem('10', '6.5')).toBeNull();
    expect(await problem('20', '6.5')).toBeNull();
    expect(await problem('20', '9')).toMatch(/not the whole number of tablets nearest to 6.5 g/);
  });
});
