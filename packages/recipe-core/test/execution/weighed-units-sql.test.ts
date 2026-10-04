/**
 * The designer's warning about weighed quantities in a unit the database cannot read is given exactly where the database
 * refuses an honest weighing (Phase 2 exit follow-up COMPOUND-UNIT; INV-25, PR-19, DI-30; recipe-core sql/0323;
 * validator rule DATA-WEIGHED-UNITS, flow/weighed-units.ts).
 *
 * Since 0323 the database decides from the MBR which quantity of its step a weighing counts into and does not read a
 * compound unit: it refuses every output container of a G-22 step that records a quantity in such a unit before its first
 * plain mass quantity, and every container a G-07 step weighs into a mass written so (EBMR-EXE-139), although the engine
 * would count them. No shipped MBR does either, but nothing told the author of one that does before approval, and the
 * run then stopped at its first container. The validator now warns with its own reading of the database's rule; were the
 * two to differ, an MBR would be warned about and run, or run into the refusal unwarned. So the validator's reading of a
 * unit is compared with recipe.mass_unit_class unit for unit, and its warning with recipe.weighing_item_problem's answer
 * for the weighing the engine would make, step for step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { massItems } from '../../src/blocks/generic/common.ts';
import type { MbrContent, Parameter } from '../../src/flow/model.ts';
import { databaseMassClass } from '../../src/flow/weighed-units.ts';
import { DATA_RULES } from '../../src/validator/rules-data.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { clone, findPhase, loadFixture, registryOf, validate } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

const RULE = 'DATA-WEIGHED-UNITS';
const rules = registryOf(STRUCTURE_RULES, DATA_RULES);

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.admin.query<{ v: T }>(sql, params);
  return rows[0]?.v as T;
}

const density = (unit: string | undefined, extra: Partial<Parameter> = {}): Parameter => ({
  id: 'density',
  name: 'Bulk density',
  valueType: 'DECIMAL',
  ...(unit === undefined ? {} : { unit }),
  precision: { kind: 'DECIMALS', digits: 2 },
  role: 'OBSERVATION',
  criticality: 'CRITICAL',
  riskClass: 'HIGH',
  capture: 'DEVICE',
  ...extra,
});

/** The granulation master with `step` also recording `density` (in `unit`) at `at` among its records. */
function recording(step: string, unit: string | undefined, at: 'first' | 'last' | 'only', extra: Partial<Parameter> = {}): MbrContent {
  const m = clone(loadFixture('tablet-granulation-compression'));
  m.parameters.push(density(unit, extra));
  const p = findPhase(m, step);
  p.records = at === 'first' ? ['density', ...p.records] : at === 'last' ? [...p.records, 'density'] : ['density'];
  return m;
}

/** The granulation master with parameter `id` written in `unit`. */
function unitOf(id: string, unit: string): MbrContent {
  const m = clone(loadFixture('tablet-granulation-compression'));
  m.parameters = m.parameters.map((x) => (x.id === id ? { ...x, unit } : x));
  return m;
}

/**
 * Whether the validator warns about `step`, and what the database answers for each weighing the engine would store at
 * it: an output container counted into the step's first mass quantity (G-22), or a container weighed into each of its
 * mass quantities (G-07), weighed in kg.
 */
async function warnedAndRefused(m: MbrContent, step: string): Promise<{ warned: boolean; refused: boolean[] }> {
  const warned = validate(m, {}, rules).findings.some((f) => f.rule === RULE && f.key === `${RULE}@${step}`);
  const p = findPhase(m, step);
  const items = massItems(p, m);
  const entries =
    p.block.type === 'G-22'
      ? [{ stepKey: `${step}@`, kind: 'OUTPUT_CONTAINER', data: { intermediate: p.produces[0], container: 'C-1', gross: '12.500', tare: '0.500', net: '12.000', unit: 'kg', status: 'QUARANTINE', item: items[0] ?? null } }]
      : items.map((item) => ({ stepKey: `${step}@`, kind: 'CONTAINER_WEIGHING', data: { item, gross: '12.500', tare: '0.500', net: '12.000', unit: 'kg' } }));
  const refused: boolean[] = [];
  for (const e of entries) refused.push((await one<string | null>('select recipe.weighing_item_problem($1::jsonb, $2::jsonb) as v', [JSON.stringify(e), JSON.stringify(m)])) !== null);
  return { warned, refused };
}

describe('COMPOUND-UNIT: the designer warns where the database refuses an honest weighing (INV-25, PR-19, DI-30; sql 0323)', () => {
  it('[INV-25][PR-19][DI-30] the validator reads every unit as the database does (recipe.mass_unit_class): mass, no mass, or a compound unit it cannot read', async () => {
    const prefixes = ['', 'Y', 'Z', 'E', 'P', 'T', 'G', 'M', 'k', 'h', 'da', 'd', 'c', 'm', 'u', 'n', 'p', 'f', 'a', 'z', 'y'];
    const atoms = ['%', 'Cel', 'K', 'L', 'N', 'Pa', '[CFU]', '[iU]', '[ppm]', 'bar', 'd', 'g', 'gf', 'h', 'm', 'min', 'mol', 's'];
    const strings = [
      ...prefixes.flatMap((p) => atoms.map((a) => `${p}${a}`)),
      ...['g', 'kg', 'mg', 'dag'].flatMap((u) => [`${u}1`, `${u}+1`, `${u}01`, `${u}+001`, `${u}2`, `${u}-1`, `${u}0`, `${u}10`, `${u}{wet}`, `${u}{}`, `${u}{w/w}`, `${u}{a b}`, `${u}{\`}`, `${u}{|}`, `${u}{~}`, `${u}{é}`, `${u}1{dry}`]),
      ...['', ' ', 'kg ', ' kg', 'kg\n', '\nkg', 'k\ng', 'G', 'Kg', 'KG', 'gm', 'k[g]', '[g]', '[lb_av]', 't', 'u', 'mL', '1', '{tbl}', '{}', '{a/b}', 'kgé', 'é', '𝔤', 'g𝔤'],
      // Compound units and two annotations: the database does not read them.
      ...['kg/1', 'kg.1', 'g.%', '%.kg', '(kg)', '/kg', 'g/mL', 'mg/mL', 'kg/h', 'g/(m.m)', 'N.s2/m', 'kg.{x}', 'g{a}{b}', '{wet}kg', 'kg{a}.g', 'g)', '(g', 'k.g', 'g/'],
      // At most 120 characters, counted as characters (code points), not bytes or UTF-16 units.
      `kg{${'x'.repeat(116)}}`,
      `kg{${'x'.repeat(117)}}`,
      `kg{${'é'.repeat(116)}}`,
      `kg{${'𝔤'.repeat(116)}}`,
      `kg{${'𝔤'.repeat(117)}}`,
      `${'k'.repeat(60)}/${'g'.repeat(59)}`,
      `${'k'.repeat(60)}/${'g'.repeat(60)}`,
      `${'𝔤'.repeat(59)}/${'𝔤'.repeat(60)}`,
      `${'𝔤'.repeat(60)}/${'𝔤'.repeat(60)}`,
    ];
    const units: unknown[] = [...new Set(strings), null, 5, true, ['kg'], { unit: 'kg' }];
    const classes = await one<string[]>('select array_agg(recipe.mass_unit_class(u) order by o) as v from jsonb_array_elements($1::jsonb) with ordinality as t(u, o)', [JSON.stringify(units)]);
    const mirror = units.map((u) => databaseMassClass(u));
    const differ = Object.fromEntries(units.flatMap((u, i) => (classes[i] === mirror[i] ? [] : [[JSON.stringify(u), `database ${String(classes[i])}, validator ${String(mirror[i])}`]])));
    expect(differ).toEqual({});
    expect(classes).toHaveLength(units.length);
    // Each answer is given: the corpus is no corpus of one class.
    expect(new Set(classes)).toEqual(new Set(['MASS', 'OTHER', 'UNKNOWN']));
    // A unit absent from the parameter: no mass, in both.
    expect([await one<string>('select recipe.mass_unit_class(null) as v', []), databaseMassClass(undefined)]).toEqual(['OTHER', 'OTHER']);
  }, 120_000);

  it('[INV-25][PR-19][DI-30] the validator warns about a step exactly where the database refuses the weighing the engine would store there: G-22 output containers and G-07 containers, the units and places that matter and those that do not', async () => {
    const cases: Record<string, [MbrContent, string]> = {
      'G-22, a non-mass compound unit before the net': [recording('p-gran-out', 'g/mL', 'first'), 'p-gran-out'],
      'G-22, a mass compound unit before the net (the engine counts the container into it)': [recording('p-gran-out', 'kg/1', 'first'), 'p-gran-out'],
      'G-22, a compound unit and no plain mass quantity': [recording('p-gran-out', 'kg.1', 'only'), 'p-gran-out'],
      'G-22, the net itself in a compound unit': [unitOf('blendNet', 'g.%'), 'p-blend-out'],
      'G-22, a compound unit after the net': [recording('p-gran-out', 'g/mL', 'last'), 'p-gran-out'],
      'G-22, a plain unit before the net': [recording('p-gran-out', 'L', 'first'), 'p-gran-out'],
      'G-22, three readings in a compound unit before the net': [recording('p-gran-out', 'g/mL', 'first', { readings: 3 }), 'p-gran-out'],
      'G-22, a count before the net': [recording('p-gran-out', undefined, 'first', { valueType: 'COUNT', precision: { kind: 'DECIMALS', digits: 0 } }), 'p-gran-out'],
      'G-22, no quantity at all': [loadFixture('tablet-granulation-compression'), 'p-wet-out'],
      'G-22, the master as shipped': [loadFixture('tablet-granulation-compression'), 'p-comp-out'],
      'G-07, the dispensed mass in a compound unit': [unitOf('apiDispensed', 'kg/1'), 'p-disp-api'],
      'G-07, the dispensed mass in a plain unit, a compound non-mass beside it': [recording('p-disp-api', 'g/mL', 'first'), 'p-disp-api'],
      'G-07, the master as shipped': [loadFixture('tablet-granulation-compression'), 'p-disp-exc'],
    };
    const answers: Record<string, string> = {};
    for (const [name, [m, step]] of Object.entries(cases)) {
      const { warned, refused } = await warnedAndRefused(m, step);
      expect(refused.length, `${name}: no weighing to try`).toBeGreaterThan(0);
      answers[name] = `${warned ? 'warned' : 'not warned'}, ${refused.every(Boolean) ? 'refused' : refused.some(Boolean) ? 'partly refused' : 'accepted'}`;
    }
    expect(answers).toEqual({
      'G-22, a non-mass compound unit before the net': 'warned, refused',
      'G-22, a mass compound unit before the net (the engine counts the container into it)': 'warned, refused',
      'G-22, a compound unit and no plain mass quantity': 'warned, refused',
      'G-22, the net itself in a compound unit': 'warned, refused',
      'G-22, a compound unit after the net': 'not warned, accepted',
      'G-22, a plain unit before the net': 'not warned, accepted',
      'G-22, three readings in a compound unit before the net': 'not warned, accepted',
      'G-22, a count before the net': 'not warned, accepted',
      'G-22, no quantity at all': 'not warned, accepted',
      'G-22, the master as shipped': 'not warned, accepted',
      'G-07, the dispensed mass in a compound unit': 'warned, refused',
      'G-07, the dispensed mass in a plain unit, a compound non-mass beside it': 'not warned, accepted',
      'G-07, the master as shipped': 'not warned, accepted',
    });
  }, 120_000);
});
