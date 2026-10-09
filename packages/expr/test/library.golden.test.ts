/**
 * Golden vectors for every function of the closed library (brief A1 tests), derived from the
 * worked examples of the design specifications. Expected values were computed independently with
 * Python's fractions/decimal modules (exact formula, 34 significant digits, half-even; a nested
 * library result enters the outer formula as its 34-digit value).
 *
 * Sources: docs/design/tablets-edition-process-and-blocks.md section C (C-01..C-16, C-23) and
 * injectables-edition-process-and-blocks.md section C (C-01, C-02, C-05 arithmetic checks).
 */
import { describe, expect, it } from 'vitest';
import { evaluate, tryEvaluate } from '../src/evidence/record.ts';
import { compile } from '../src/lang/compile.ts';
import type { InputValues } from '../src/lang/evaluator.ts';
import type { InputDeclarations, OutputDeclaration } from '../src/lang/types.ts';
import { libraryCatalogue } from '../src/library/index.ts';
import { formatForDisplay, roundToIncrement } from '../src/rounding/rounding.ts';
import type { Tag } from '../src/units/tags.ts';
import { PH_EUR_295_BANDS } from './support/tables.ts';

interface Golden {
  readonly fn: string;
  readonly title: string;
  readonly cite: string;
  readonly source: string;
  readonly inputs: InputDeclarations;
  readonly values: InputValues;
  readonly output?: OutputDeclaration;
  readonly expected: { readonly value: string; readonly unit: string; readonly tag?: Tag } | { readonly error: string; readonly path?: string };
}

const v = (value: string, unit?: string): InputValues[string] => ({ value, ...(unit === undefined ? {} : { unit }), source: 'golden' });
const s = (values: string[], unit?: string): InputValues[string] => ({ values, ...(unit === undefined ? {} : { unit }), source: 'golden' });
const MASS = { unit: 'kg' } as const;
const PCT_WW = { unit: '%', tag: 'w/w' } as const;
const WEIGHTS = { kind: 'series', unit: 'mg', maxLength: 20 } as const;
const C13_WEIGHTS = ['250.1', '249.8', '251.2', '248.9', '250.0'];

const GOLDEN: readonly Golden[] = [
  { fn: 'abs', title: 'absolute value', cite: 'brief A1 item 3', source: 'abs(d)', inputs: { d: { unit: 'mg' } }, values: { d: v('-2.5') }, expected: { value: '2.5', unit: 'mg' } },
  { fn: 'min', title: 'smallest of two values in different units, in the first unit', cite: 'brief A1 item 3', source: 'min(a, b)', inputs: { a: MASS, b: { unit: 'g' } }, values: { a: v('1.2'), b: v('1150') }, expected: { value: '1.15', unit: 'kg' } },
  { fn: 'min', title: 'smallest recorded weight', cite: 'tablets spec C-13 (min)', source: 'min(w)', inputs: { w: WEIGHTS }, values: { w: s(C13_WEIGHTS) }, expected: { value: '248.9', unit: 'mg' } },
  { fn: 'max', title: 'largest recorded weight', cite: 'tablets spec C-13 (max)', source: 'max(w)', inputs: { w: WEIGHTS }, values: { w: s(C13_WEIGHTS) }, expected: { value: '251.2', unit: 'mg' } },
  { fn: 'convert', title: '90 min in hours', cite: 'brief A1 item 2', source: 'convert(t, [h])', inputs: { t: { unit: 'min' } }, values: { t: v('90') }, expected: { value: '1.5', unit: 'h' } },
  { fn: 'convert', title: '5 kp (kgf) in newton', cite: 'tablets spec C-17: F(N) = F(kp) x 9.80665', source: 'convert(f, [N])', inputs: { f: { unit: 'kgf' } }, values: { f: v('5') }, expected: { value: '49.03325', unit: 'N' } },
  { fn: 'convert', title: '121.1 degC in degF (offsets applied explicitly)', cite: 'brief A1 item 2 (temperature offsets)', source: 'convert(t, [[degF]])', inputs: { t: { unit: 'Cel' } }, values: { t: v('121.1') }, expected: { value: '249.98', unit: '[degF]' } },
  { fn: 'minus_percent', title: 'lower group-weight limit, 20 tablets of 250.0 mg, +/- 2 %', cite: 'tablets spec C-11: G = 5,000.0 mg, limits 4,900.0-5,100.0 mg', source: 'minus_percent(n * wt, g)', inputs: { n: { unit: '{tbl}', tag: 'count' }, wt: { unit: 'mg' }, g: { unit: '%' } }, values: { n: v('20'), wt: v('250.0'), g: v('2') }, output: { unit: 'mg' }, expected: { value: '4900', unit: 'mg' } },
  { fn: 'plus_percent', title: 'upper group-weight limit', cite: 'tablets spec C-11', source: 'plus_percent(n * wt, g)', inputs: { n: { unit: '{tbl}', tag: 'count' }, wt: { unit: 'mg' }, g: { unit: '%' } }, values: { n: v('20'), wt: v('250.0'), g: v('2') }, output: { unit: 'mg' }, expected: { value: '5100', unit: 'mg' } },
  { fn: 'sum', title: 'theoretical mass: standard batch plus rework added', cite: 'tablets spec C-07/C-09: 50.000 kg + 1.200 kg = 51.200 kg', source: 'sum(parts)', inputs: { parts: { kind: 'series', unit: 'kg', maxLength: 10 } }, values: { parts: s(['50.000', '1.200']) }, expected: { value: '51.2', unit: 'kg' } },
  { fn: 'count', title: 'number of units weighed', cite: 'tablets spec C-12 (20 units)', source: 'count(w)', inputs: { w: WEIGHTS }, values: { w: s(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '199' : '201'))) }, expected: { value: '20', unit: '1', tag: 'count' } },
  { fn: 'mean', title: 'average weight of 20 tablets', cite: 'tablets spec C-12 example: mean 200.0 mg', source: 'mean(w)', inputs: { w: WEIGHTS }, values: { w: s(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '199' : '201'))) }, expected: { value: '200', unit: 'mg' } },
  { fn: 'mean', title: 'mean of recorded weights', cite: 'tablets spec C-13', source: 'mean(w)', inputs: { w: WEIGHTS }, values: { w: s(C13_WEIGHTS) }, expected: { value: '250', unit: 'mg' } },
  { fn: 'sd', title: 'sample standard deviation of recorded weights', cite: 'tablets spec C-13: s = sqrt(sum (x - mean)^2 / (n - 1))', source: 'sd(w)', inputs: { w: WEIGHTS }, values: { w: s(C13_WEIGHTS) }, expected: { value: '0.8215838362577491701854546742012032', unit: 'mg' } },
  { fn: 'sd', title: 'textbook sample: 2 4 4 4 5 5 7 9 gives sqrt(32/7)', cite: 'tablets spec C-13 (n - 1 denominator)', source: 'sd(w)', inputs: { w: WEIGHTS }, values: { w: s(['2', '4', '4', '4', '5', '5', '7', '9']) }, expected: { value: '2.138089935299395077476427847038028', unit: 'mg' } },
  { fn: 'rsd', title: 'relative standard deviation of recorded weights', cite: 'tablets spec C-13: RSD = s / mean x 100', source: 'rsd(w)', inputs: { w: WEIGHTS }, values: { w: s(C13_WEIGHTS) }, expected: { value: '0.3286335345030996680741818696804813', unit: '%', tag: 'rsd' } },
  { fn: 'yield', title: 'good-output yield', cite: 'tablets spec C-09 example: A = 50.300 kg, T = 51.200 kg, 98.24 %', source: 'yield(a, t)', inputs: { a: MASS, t: MASS }, values: { a: v('50.300'), t: v('51.200') }, expected: { value: '98.2421875', unit: '%', tag: 'yield' } },
  { fn: 'yield', title: 'yield including reusable residue (A + B) / T', cite: 'tablets spec C-09 example: B = 0.350 kg, 98.93 %', source: 'yield(a + b, t)', inputs: { a: MASS, b: MASS, t: MASS }, values: { a: v('50.300'), b: v('0.350'), t: v('51.200') }, expected: { value: '98.92578125', unit: '%', tag: 'yield' } },
  { fn: 'yield', title: 'tablet yield in counts', cite: 'tablets spec C-09 (tablets/tablets)', source: 'yield(good, theo)', inputs: { good: { unit: '{tbl}', tag: 'count' }, theo: { unit: '{tbl}', tag: 'count' } }, values: { good: v('200000'), theo: v('204800') }, expected: { value: '97.65625', unit: '%', tag: 'yield' } },
  {
    fn: 'accountability',
    title: 'mass balance over every accounted category',
    cite: 'tablets spec C-09 (accountability)',
    source: 'accountability(input, good, residue, samples, rejects, dust)',
    inputs: { input: MASS, good: MASS, residue: MASS, samples: { kind: 'series', unit: 'kg', maxLength: 10 }, rejects: MASS, dust: { unit: 'g' } },
    values: { input: v('51.200'), good: v('50.300'), residue: v('0.350'), samples: s(['0.060', '0.060']), rejects: v('0.200'), dust: v('180') },
    expected: { value: '99.90234375', unit: '%' },
  },
  {
    fn: 'unaccounted',
    title: 'unaccounted quantity',
    cite: 'tablets spec C-09: Unaccounted = input - sum accounted',
    source: 'unaccounted(input, good, residue, samples, rejects, dust)',
    inputs: { input: MASS, good: MASS, residue: MASS, samples: { kind: 'series', unit: 'kg', maxLength: 10 }, rejects: MASS, dust: { unit: 'g' } },
    values: { input: v('51.200'), good: v('50.300'), residue: v('0.350'), samples: s(['0.060', '0.060']), rejects: v('0.200'), dust: v('180') },
    expected: { value: '0.05', unit: 'kg' },
  },
  { fn: 'percent_gain', title: 'coating weight gain', cite: 'tablets spec C-16 example: 250.0 mg to 257.5 mg is 3.0 %', source: 'percent_gain(core, coated)', inputs: { core: { unit: 'mg' }, coated: { unit: 'mg' } }, values: { core: v('250.0'), coated: v('257.5') }, expected: { value: '3', unit: '%' } },
  { fn: 'percent_loss', title: 'friability', cite: 'tablets spec C-15 example: 6.512 g to 6.470 g gives 0.645 %', source: 'percent_loss(w1, w2)', inputs: { w1: { unit: 'g' }, w2: { unit: 'g' } }, values: { w1: v('6.512'), w2: v('6.470') }, expected: { value: '0.644963144963144963144963144963145', unit: '%' } },
  { fn: 'assay_as_is_anhydrous', title: 'as-is assay from an anhydrous-basis assay and KF water', cite: 'tablets spec C-01; C-06: 99.2 x (100 - 4.6) / 100 = 94.6368 %', source: 'assay_as_is_anhydrous(a, w)', inputs: { a: PCT_WW, w: PCT_WW }, values: { a: v('99.2'), w: v('4.6') }, expected: { value: '94.6368', unit: '%', tag: 'w/w' } },
  { fn: 'assay_as_is_dried', title: 'as-is assay from a dried-basis assay and LOD', cite: 'tablets spec C-01 (dried basis)', source: 'assay_as_is_dried(a, l)', inputs: { a: PCT_WW, l: { unit: '%', tag: 'lod' } }, values: { a: v('99.5'), l: v('0.8') }, expected: { value: '98.704', unit: '%', tag: 'w/w' } },
  { fn: 'assay_as_is_anhydrous_solvent_free', title: 'as-is assay, anhydrous and solvent-free basis', cite: 'tablets spec C-01 (A x (100 - W - S) / 100)', source: 'assay_as_is_anhydrous_solvent_free(a, w, s)', inputs: { a: PCT_WW, w: PCT_WW, s: PCT_WW }, values: { a: v('99.6'), w: v('0.5'), s: v('0.3') }, expected: { value: '98.8032', unit: '%', tag: 'w/w' } },
  { fn: 'salt_factor', title: 'atorvastatin calcium form factor', cite: 'tablets spec C-02, C-06: 1155.36 / 1117.28 = 1.034083', source: 'salt_factor(salt, base, 1)', inputs: { salt: { unit: 'g/mol' }, base: { unit: 'g/mol' } }, values: { salt: v('1155.36'), base: v('1117.28') }, expected: { value: '1.034082772447372189603322354288988', unit: '1' } },
  { fn: 'salt_factor', title: 'the same factor with two base moieties of the free acid (558.64 g/mol)', cite: 'tablets spec C-02 (nu = 2 for a hemi-calcium salt), C-06', source: 'salt_factor(salt, base, 2)', inputs: { salt: { unit: 'g/mol' }, base: { unit: 'g/mol' } }, values: { salt: v('1155.36'), base: v('558.64') }, expected: { value: '1.034082772447372189603322354288988', unit: '1' } },
  {
    fn: 'standard_quantity',
    title: 'standard quantity of the salt at 100 % as-is',
    cite: 'tablets spec C-03, C-06: 8.000 x 1.034083 = 8.2727 kg',
    source: 'standard_quantity(lc * n, salt_factor(salt, base, 1), 0 [%])',
    inputs: { lc: { unit: 'mg' }, n: { unit: '{tbl}', tag: 'count' }, salt: { unit: 'g/mol' }, base: { unit: 'g/mol' } },
    values: { lc: v('40'), n: v('200000'), salt: v('1155.36'), base: v('1117.28') },
    output: { unit: 'kg' },
    expected: { value: '8.272662179578977516826578834311904', unit: 'kg' },
  },
  {
    fn: 'adjusted_quantity',
    title: 'the error C-06 warns about: anhydrous ratio with the anhydrous assay and no water correction',
    cite: 'tablets spec C-06 "why it matters": 8.2727 x 100 / 99.2 = 8.3394 kg (4.6 % short)',
    source: 'adjusted_quantity(q, a)',
    inputs: { q: MASS, a: PCT_WW },
    values: { q: v('8.272662179578977516826578834311904'), a: v('99.2') },
    expected: { value: '8.339377197156227335510664147491839', unit: 'kg' },
  },
  {
    fn: 'potency_adjusted_quantity',
    title: 'atorvastatin 40 mg x 200,000 tablets, assay 99.2 % anhydrous, water 4.6 %',
    cite: 'tablets spec C-03, C-06: 8.741486 kg full precision',
    source: 'potency_adjusted_quantity(lc * n, salt_factor(salt, base, 1), 0 [%], assay_as_is_anhydrous(a, w))',
    inputs: { lc: { unit: 'mg' }, n: { unit: '{tbl}', tag: 'count' }, salt: { unit: 'g/mol', source: 'MASTER_DATA' }, base: { unit: 'g/mol', source: 'MASTER_DATA' }, a: { ...PCT_WW, source: 'LIMS' }, w: { ...PCT_WW, source: 'LIMS' } },
    values: { lc: v('40'), n: v('200000'), salt: v('1155.36'), base: v('1117.28'), a: v('99.2'), w: v('4.6') },
    output: { unit: 'kg' },
    expected: { value: '8.741485531610301190262750678712619', unit: 'kg' },
  },
  {
    fn: 'potency_adjusted_quantity',
    title: 'the other C-06 error: trihydrate ratio with the water-corrected assay (water counted twice)',
    cite: 'tablets spec C-06: 8.000 x 1.0824 x 100 / 94.6368 = 9.1503 kg (4.7 % too much)',
    source: 'potency_adjusted_quantity(q, salt_factor(salt, base, 1), 0 [%], assay_as_is_anhydrous(a, w))',
    inputs: { q: MASS, salt: { unit: 'g/mol' }, base: { unit: 'g/mol' }, a: PCT_WW, w: PCT_WW },
    values: { q: v('8.000'), salt: v('1209.41'), base: v('1117.30'), a: v('99.2'), w: v('4.6') },
    expected: { value: '9.150265522560942367809838457248994', unit: 'kg' },
  },
  {
    fn: 'potency_adjusted_quantity',
    title: 'solution: 10 mg/mL base in 100,000 mL, F_salt 1.10, assay 98.5 %',
    cite: 'injectables spec C-02 arithmetic check: 1,116.75 g',
    source: 'potency_adjusted_quantity(c * vol, 1.10, 0 [%], a)',
    inputs: { c: { unit: 'mg/mL' }, vol: { unit: 'mL' }, a: PCT_WW },
    values: { c: v('10'), vol: v('100000'), a: v('98.5') },
    output: { unit: 'g' },
    expected: { value: '1116.751269035532994923857868020305', unit: 'g' },
  },
  { fn: 'base_equivalent', title: 'base-equivalent of a lot (exact case)', cite: 'tablets spec C-03 (b_i = Q_act,i x A / (100 x f))', source: 'base_equivalent(q, f, a)', inputs: { q: MASS, f: { unit: '1' }, a: PCT_WW }, values: { q: v('10'), f: v('1.25'), a: v('80') }, expected: { value: '6.4', unit: 'kg' } },
  {
    fn: 'base_equivalent',
    title: 'base-equivalent of a 4.000 kg atorvastatin lot',
    cite: 'tablets spec C-03 multiple lots with the C-06 factor and assay',
    source: 'base_equivalent(q, f, a)',
    inputs: { q: MASS, f: { unit: '1' }, a: PCT_WW },
    values: { q: v('4.000'), f: v('1.034082772447372189603322354288988'), a: v('94.6368') },
    expected: { value: '3.660705023680930619027835479850435', unit: 'kg' },
  },
  { fn: 'quantity_for_base', title: 'lot quantity for a base-equivalent (inverse of base_equivalent)', cite: 'tablets spec C-03 (Q_act,i = b_i x f x 100 / A)', source: 'quantity_for_base(b, f, a)', inputs: { b: MASS, f: { unit: '1' }, a: PCT_WW }, values: { b: v('6.4'), f: v('1.25'), a: v('80') }, expected: { value: '10', unit: 'kg' } },
  {
    fn: 'compensating_excipient',
    title: 'diluent reduced by the extra active',
    cite: 'tablets spec C-04, C-06: diluent reduced by 0.4688 kg',
    source: 'compensating_excipient(dil, std, act)',
    inputs: { dil: MASS, std: MASS, act: MASS },
    values: { dil: v('20.000'), std: v('8.272662179578977516826578834311904'), act: v('8.741485531610301190262750678712619') },
    expected: { value: '19.53117664796867632656382815559928', unit: 'kg' },
  },
  { fn: 'compensating_excipient', title: 'two lots of one active', cite: 'tablets spec C-04 (sum over lots)', source: 'compensating_excipient(dil, std, lots)', inputs: { dil: MASS, std: MASS, lots: { kind: 'series', unit: 'kg', maxLength: 3 } }, values: { dil: v('10.000'), std: v('8.000'), lots: s(['4.100', '4.050']) }, expected: { value: '9.85', unit: 'kg' } },
  { fn: 'compensating_excipient', title: 'a negative compensating excipient is refused', cite: 'tablets spec C-04: blocked if the result is negative', source: 'compensating_excipient(dil, std, act)', inputs: { dil: MASS, std: MASS, act: MASS }, values: { dil: v('0.100'), std: v('8.000'), act: v('8.500') }, expected: { error: 'DOMAIN_ERROR', path: 'dil' } },
  { fn: 'as_is_from_dry', title: 'as-is quantity of a dry-basis excipient, LOD 2.0 %', cite: 'tablets spec C-05: Q_asis = Q_dry x 100 / (100 - LOD)', source: 'as_is_from_dry(q, l)', inputs: { q: MASS, l: { unit: '%', tag: 'lod' } }, values: { q: v('10.000'), l: v('2.0') }, expected: { value: '10.20408163265306122448979591836735', unit: 'kg' } },
  { fn: 'mass_from_volume', title: 'net fill weight from volume and density', cite: 'injectables spec C-01 (m = V x rho) with the C-05 arithmetic check: 10.50 mL x 1.012 g/mL = 10.626 g', source: 'mass_from_volume(vol, rho)', inputs: { vol: { unit: 'mL' }, rho: { unit: 'g/mL' } }, values: { vol: v('10.50'), rho: v('1.012') }, expected: { value: '10.626', unit: 'g' } },
  { fn: 'volume_from_mass', title: 'volume from a measured weight', cite: 'injectables spec C-01 (V = m / rho)', source: 'volume_from_mass(m, rho)', inputs: { m: { unit: 'g' }, rho: { unit: 'g/mL' } }, values: { m: v('10.626'), rho: v('1.012') }, expected: { value: '10.5', unit: 'mL' } },
  {
    fn: 'duration',
    title: 'hold time from completion of the previous stage to the start of use',
    cite: 'tablets spec C-23: Elapsed = t_use,start - t_completion,previous',
    source: 'duration(done, used)',
    inputs: { done: { kind: 'instant' }, used: { kind: 'instant' } },
    values: { done: { instant: '2026-09-28T08:00:00Z', source: 'server' }, used: { instant: '2026-09-30T20:30:00+05:30', source: 'server' } },
    output: { unit: 'h' },
    expected: { value: '55', unit: 'h' },
  },
  { fn: 'table_lookup', title: 'Ph. Eur. 2.9.5 deviation band for an average mass of 200.0 mg', cite: 'tablets spec C-12 example: 7.5 %', source: 'table_lookup("ph-eur-2.9.5-band", mean(w))', inputs: { w: WEIGHTS }, values: { w: s(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '199' : '201'))) }, expected: { value: '7.5', unit: '%' } },
];

const TABLES = { [PH_EUR_295_BANDS.id]: PH_EUR_295_BANDS };

describe('library golden vectors', () => {
  for (const g of GOLDEN) {
    it(`[DI-33] ${g.fn}: ${g.title} (${g.cite})`, () => {
      const c = compile(g.source, { inputs: g.inputs, tables: TABLES, ...(g.output === undefined ? {} : { output: g.output }) });
      if (!c.ok) throw new Error(c.diagnostics.map((d) => d.message).join('; '));
      expect(c.program.functions).toContain(g.fn);
      const r = tryEvaluate(c.program, g.values, { tables: TABLES });
      if ('error' in g.expected) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect({ code: r.error.code, path: r.error.path }).toEqual({ code: g.expected.error, path: g.expected.path });
        return;
      }
      if (!r.ok) throw r.error;
      expect(r.record.output).toEqual({ kind: 'quantity', value: g.expected.value, unit: g.expected.unit, tag: g.expected.tag ?? 'none' });
    });
  }

  it('[DI-33] every library function has at least one golden vector', () => {
    const covered = new Set(GOLDEN.map((g) => g.fn));
    const missing = libraryCatalogue()
      .map((f) => f.name)
      .filter((n) => !covered.has(n));
    expect(missing).toEqual([]);
  });

  it('[DI-33] C-06: the active dispensing target is rounded UP to the 0.001 kg readability (8.742 kg); the diluent change shown is 0.469 kg', () => {
    expect(roundToIncrement('8.741485531610301190262750678712619', '0.001', 'CEILING').toString()).toBe('8.742');
    expect(formatForDisplay('0.4688233520313236734361718444007150', { decimals: 3 })).toBe('0.469');
  });

  it('[DI-33] C-12: tier-1 limits from the band are 185.0-215.0 mg for an average of 200.0 mg', () => {
    const c = compile('minus_percent(mean(w), table_lookup("ph-eur-2.9.5-band", mean(w)))', { inputs: { w: WEIGHTS }, tables: TABLES });
    const h = compile('plus_percent(mean(w), table_lookup("ph-eur-2.9.5-band", mean(w)))', { inputs: { w: WEIGHTS }, tables: TABLES });
    if (!c.ok || !h.ok) throw new Error('compile');
    const w = { w: s(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '199' : '201'))) };
    expect(evaluate(c.program, w, { tables: TABLES }).output.value).toBe('185');
    const hr = evaluate(h.program, w, { tables: TABLES });
    expect(hr.output.value).toBe('215');
    expect(hr.tableLookups).toEqual([{ table: 'ph-eur-2.9.5-band', version: 'test-1', row: 2, key: '200', keyUnit: 'mg', result: '7.5', resultUnit: '%' }]);
  });

  it('[DI-33] C-08 and C-10: theoretical and weighed tablet counts are plain arithmetic with a count output', () => {
    const c = compile('blend / wt', { inputs: { blend: MASS, wt: { unit: 'mg/{tbl}' } }, output: { unit: '{tbl}', tag: 'count' } });
    if (!c.ok) throw new Error(c.diagnostics.map((d) => d.message).join('; '));
    expect(evaluate(c.program, { blend: v('51.200'), wt: v('250.0') }).output).toEqual({ kind: 'quantity', value: '204800', unit: '{tbl}', tag: 'count' });
    expect(evaluate(c.program, { blend: v('50.000'), wt: v('250.0') }).output.value).toBe('200000');
  });
});
