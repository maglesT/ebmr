/**
 * The database's check that a weighing counts into the quantity its phase records in the MBR, not into one the entry
 * names (recipe-core sql/0323: recipe.mass_unit_class, recipe.phase_records, recipe.weighing_item_problem; lead TODO T2
 * of the Phase 2 exit, round 3; INV-25, PR-19, DI-30).
 *
 * 0322 checks that a quantity counted from weighings is the sum of every weighing of its step and item, but it read the
 * item from each entry, which the writer controls: the round-2 verification stored a dispensed container without item,
 * and an output container with item null, next to an honest one, and the step's total then left them out. The blocks
 * decide the quantity from the MBR (a G-07 container counts into one of its phase's mass quantities, a G-22 output
 * container into the first, or into none when the phase records none); the database now does the same. Were the check
 * stricter than the blocks, an honest weighing would be refused; so every weighing of the engine's own runs passes it,
 * the database reads a unit as a mass only where the expression language does (and says so where it cannot tell), and it
 * expands a library call's bindings as the engine does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import { isMassUnit } from '../../src/blocks/generic/common.ts';
import { libraryElementHash } from '../../src/flow/canonical.ts';
import { expandLibraryCalls } from '../../src/flow/expand.ts';
import { childrenOf, type FlowNode, type LibraryElement, type PhaseNode } from '../../src/flow/model.ts';
import { autopilot, FIXTURE_INPUTS, fixtureDefinition, GRANULATION_SCENARIO, PACKAGING_SCENARIO, Run } from '../engine/support.ts';
import { clone, loadFixture } from '../flow/support.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await db.admin.query<{ v: T }>(sql, params);
  return rows[0]?.v as T;
}

const itemProblem = async (entry: unknown, content: unknown): Promise<string> =>
  (await one<string | null>('select recipe.weighing_item_problem($1::jsonb, $2::jsonb) as v', [JSON.stringify(entry), JSON.stringify(content)])) ?? 'null';

describe('T2 round 3: a weighing counts into the quantity its phase records, decided by the database (INV-25, PR-19; sql 0323)', () => {
  it('[INV-25][PR-19] the database reads a unit as a mass only where the expression language does, and says where it cannot tell', async () => {
    const prefixes = ['', 'Y', 'Z', 'E', 'P', 'T', 'G', 'M', 'k', 'h', 'da', 'd', 'c', 'm', 'u', 'n', 'p', 'f', 'a', 'z', 'y'];
    const atoms = ['%', 'Cel', 'K', 'L', 'N', 'Ohm', 'P', 'Pa', 'S', '[CFU]', '[degF]', '[iU]', "[in_i'H2O]", '[ppb]', '[ppm]', '[psi]', 'bar', 'd', 'g', 'gf', 'h', 'm', 'm[H2O]', 'm[Hg]', 'min', 'mol', 's'];
    const singles = [
      ...prefixes.flatMap((p) => atoms.map((a) => `${p}${a}`)),
      ...['g', 'kg', 'mg', 'dag'].flatMap((u) => [`${u}1`, `${u}+1`, `${u}01`, `${u}+001`, `${u}2`, `${u}-1`, `${u}0`, `${u}10`, `${u}11`, `${u}{wet}`, `${u}{}`, `${u}{w/w}`, `${u}{a b}`, `${u}1{dry}`]),
      ...['', ' ', 'kg ', ' kg', 'xg', 'G', 'Kg', 'KG', 'gm', 'k g', 'k[g]', 'kg%', 'g%', '[g]', '[lb_av]', '[oz_av]', 't', 'kt', 'u', 'kgf', 'kp', 'mL', '1', '2', '{tbl}', '{}', 'kg-+1', `kg{${'x'.repeat(120)}}`, 'kgé'],
    ];
    // Units the database does not read: compound units, and malformed annotations.
    const compounds = ['kg/1', 'g.m/m', 'kg.{x}', '(kg)', '/kg', '/g-1', 'N.s2/m', 'kg/h', 'mg/mL', 'g/(m.m)', 'kg.1', 'g2/g', 'Pa.m.s2', `${'k'.repeat(60)}/${'g'.repeat(60)}`, 'g{a}{b}', '{wet}kg'];
    const units = [...new Set([...singles, ...compounds])];
    const classes = await one<string[]>('select array_agg(recipe.mass_unit_class(to_jsonb(u)) order by o) as v from unnest($1::text[]) with ordinality as t(u, o)', [units]);
    const wrong: Record<string, string> = {};
    for (const [i, u] of units.entries()) {
      const c = classes[i];
      const ts = isMassUnit(u);
      // MASS only where the expression language reads a mass, OTHER only where it does not, UNKNOWN only for what the
      // database does not read; every single unit the expression language reads as a mass is MASS.
      const bad = (c === 'MASS' && !ts) || (c === 'OTHER' && ts) || (c === 'UNKNOWN' && !compounds.includes(u)) || (singles.includes(u) && ts && c !== 'MASS');
      if (bad) wrong[u] = `${String(c)} (expression language: ${String(ts)})`;
    }
    expect(wrong).toEqual({});
    // Every metric prefix on g, and g, kg, mg and dag with an exponent of 1 written in four ways, and with an annotation.
    expect(units.filter((_, i) => classes[i] === 'MASS')).toHaveLength(prefixes.length + 4 * 8);
    // The compound units that are a mass: the database cannot tell, so a weighing step that records one fails closed.
    expect(units.filter((u, i) => classes[i] === 'UNKNOWN' && isMassUnit(u)).sort()).toEqual(['(kg)', '/g-1', 'N.s2/m', 'Pa.m.s2', 'g.m/m', 'g2/g', 'kg.1', 'kg.{x}', 'kg/1'].sort());
    expect(await one<string[]>(`select array[recipe.mass_unit_class('null'), recipe.mass_unit_class('5'), recipe.mass_unit_class('["kg"]'), recipe.mass_unit_class(null)] as v`, [])).toEqual(['OTHER', 'OTHER', 'OTHER', 'OTHER']);
  }, 120_000);

  it('[INV-25][PR-19] the items a phase records are the MBR items the engine expands it to, through nested library calls', async () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const lod = m.library[0] as LibraryElement;
    const inner = clone(lod.body) as PhaseNode;
    // An element that calls LIB-LOD and holds a phase of its own, called beside c-lod with other bindings.
    const wrap: LibraryElement = {
      ref: 'LIB-WRAP',
      level: 'OPERATION',
      symbols: ['v', 'a', 'out'],
      body: { kind: 'sequence', id: 'wrap-seq', children: [{ kind: 'libraryCall', id: 'inner', element: 'LIB-LOD', bind: { lodValue: 'v', analyser: 'a' } }, { ...inner, id: 'wrap-out', records: ['out', 'v'], equipment: [{ ref: 'a', use: 'USE' }] }] },
    };
    m.library.push(wrap);
    m.references.push({ id: 'LIB-WRAP', kind: 'LIBRARY_ELEMENT', code: 'LIB-WRAP-TEST', version: '1', hash: libraryElementHash(wrap), title: 'Wrapper' });
    const seq = findById(m.procedure.body, 'l-dry-seq');
    if (seq?.kind !== 'sequence') throw new Error('SETUP: fixture changed');
    seq.children.push({ kind: 'libraryCall', id: 'c-wrap', element: 'LIB-WRAP', bind: { v: 'driedNet', a: 'MA', out: 'blendNet' } });
    const expanded = expandLibraryCalls(m);
    expect(expanded.problems).toEqual([]);
    const phases: PhaseNode[] = [];
    const visit = (n: FlowNode): void => {
      if (n.kind === 'phase') phases.push(n);
      childrenOf(n).forEach(visit);
    };
    visit(expanded.root);
    const records = async (step: string): Promise<string[] | null> => one<string[] | null>('select recipe.phase_records($1::jsonb, $2) as v', [JSON.stringify(m), step]);
    const differ: Record<string, unknown> = {};
    for (const p of phases) {
      const got = await records(p.id);
      if (JSON.stringify(got) !== JSON.stringify(p.records)) differ[p.id] = { database: got, engine: p.records };
    }
    expect(differ).toEqual({});
    expect(phases.map((p) => p.id)).toEqual(expect.arrayContaining(['c-lod/lod-test', 'c-wrap/inner/lod-test', 'c-wrap/wrap-out', 'p-disp-api', 'p-gran-out']));
    expect(await records('c-wrap/inner/lod-test')).toEqual(['driedNet']);
    expect(await records('c-wrap/wrap-out')).toEqual(['blendNet', 'driedNet']);
    // No single phase, a hold point, a call that is not one, an unbound or undeclared symbol: no answer (fail closed).
    const unbound = clone(m);
    const call = findById(unbound.procedure.body, 'c-wrap');
    if (call?.kind === 'libraryCall') delete call.bind['out'];
    const undeclared = clone(m);
    const el = undeclared.library.find((e) => e.ref === 'LIB-WRAP') as LibraryElement;
    el.symbols = ['v', 'a'];
    const q = async (content: unknown, step: string) => JSON.stringify(await one<string[] | null>('select recipe.phase_records($1::jsonb, $2) as v', [JSON.stringify(content), step]));
    expect({
      unknown: await q(m, 'p-nowhere'),
      inner: await q(m, 'lod-test'),
      notCall: await q(m, 'p-gran-out/lod-test'),
      unbound: await q(unbound, 'c-wrap/wrap-out'),
      unboundInner: await q(unbound, 'c-wrap/inner/lod-test'),
      undeclared: await q(undeclared, 'c-wrap/wrap-out'),
      noProcedure: await q({ parameters: [] }, 'p-gran-out'),
      empty: await q(m, ''),
    }).toEqual({ unknown: 'null', inner: 'null', notCall: 'null', unbound: 'null', unboundInner: 'null', undeclared: 'null', noProcedure: 'null', empty: 'null' });
  }, 120_000);

  it('[INV-25][PR-19][DI-30] every weighing of the engine\'s own runs passes: dispensed containers, output containers into a quantity and into none', async () => {
    const seen = { weighed: 0, output: 0, outputNone: 0 };
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      const run = Run.issue(fixtureDefinition(name), { inputs: FIXTURE_INPUTS[name], variants: name === 'tablet-blister-packaging' ? { packDestination: 'US-EXPORT' } : {} });
      expect(autopilot(run, name === 'tablet-granulation-compression' ? GRANULATION_SCENARIO : PACKAGING_SCENARIO)).toBe('COMPLETE');
      const out: Record<string, string> = {};
      for (const e of Object.values(run.state.entries)) {
        if (e.kind !== 'CONTAINER_WEIGHING' && e.kind !== 'OUTPUT_CONTAINER') continue;
        const p = await itemProblem({ stepKey: e.stepKey, kind: e.kind, data: e.data }, run.def.mbr);
        if (p !== 'null') out[e.id] = p;
        if (e.kind === 'CONTAINER_WEIGHING') seen.weighed += 1;
        else if (e.data['item'] === null) seen.outputNone += 1;
        else seen.output += 1;
      }
      expect(out, name).toEqual({});
    }
    expect(seen.weighed).toBeGreaterThan(0);
    expect(seen.output).toBeGreaterThan(0);
    expect(seen.outputNone).toBeGreaterThan(0);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] a weighing that counts into another quantity than its phase records is refused: no item, null, another phase\'s or a non-mass quantity, an output container into none or the second, a weighing at another block\'s step', async () => {
    const phase = (id: string, records: string[], block = 'G-07'): Json => ({ kind: 'phase', id, block: { type: block, version: '1' }, records });
    const content = (extra: Json[] = [], parameters: Json[] = []): Json => ({
      procedure: { id: 'proc', body: { kind: 'sequence', id: 'root', children: [phase('d', ['disp', 'temp']), phase('d2', ['disp', 'other']), phase('g', ['temp', 'made', 'more'], 'G-22'), phase('n', ['temp', 'series'], 'G-22'), phase('x', ['disp'], 'G-08'), ...extra] } },
      parameters: [
        { id: 'disp', valueType: 'DECIMAL', unit: 'kg' },
        { id: 'other', valueType: 'DECIMAL', unit: 'g' },
        { id: 'temp', valueType: 'DECIMAL', unit: 'Cel' },
        { id: 'made', valueType: 'DECIMAL', unit: 'kg', readings: null },
        { id: 'more', valueType: 'DECIMAL', unit: 'kg' },
        { id: 'series', valueType: 'DECIMAL', unit: 'mg', readings: 20 },
        { id: 'text', valueType: 'TEXT', unit: 'kg' },
        { id: 'odd', valueType: 'DECIMAL', unit: 'kg/1' },
        { id: 'wet', valueType: 'DECIMAL', unit: 'kg{wet}' },
        ...parameters,
      ],
    });
    const c = content([phase('u', ['odd', 'made'], 'G-22'), phase('ug', ['odd', 'made']), phase('t', ['text', 'made'], 'G-22'), phase('w', ['wet'])]);
    const weighing = (item: unknown, extra: Json = {}, step = 'd@') => ({ stepKey: step, kind: 'CONTAINER_WEIGHING', data: { ...(item === undefined ? {} : { item }), net: '10.000', unit: 'kg', ...extra } });
    const output = (item: unknown, step = 'g@', extra: Json = {}) => ({ stepKey: step, kind: 'OUTPUT_CONTAINER', data: { ...(item === undefined ? {} : { item }), net: '10.000', unit: 'kg', ...extra } });
    const outcomes = {
      honest: await itemProblem(weighing('disp'), c),
      honestInGrams: await itemProblem(weighing('disp', { net: '10000.0', unit: 'g' }), c),
      honestSecondPhase: await itemProblem(weighing('other', {}, 'd2@'), c),
      honestInLoop: await itemProblem(weighing('disp', {}, 'd@L=1/R=2'), c),
      noItem: await itemProblem(weighing(undefined), c),
      nullItem: await itemProblem(weighing(null), c),
      otherPhase: await itemProblem(weighing('other'), c),
      notMass: await itemProblem(weighing('temp', { unit: 'Cel' }), c),
      unknownItem: await itemProblem(weighing('nope'), c),
      numberItem: await itemProblem(weighing(5), c),
      otherUnit: await itemProblem(weighing('disp', { unit: 'kg{wet}' }), c),
      noUnit: await itemProblem(weighing('disp', { unit: undefined }), c),
      sameOddUnit: await itemProblem(weighing('wet', { unit: 'kg{wet}' }, 'w@'), c),
      noData: await itemProblem({ stepKey: 'd@', kind: 'CONTAINER_WEIGHING', data: 'x' }, c),
      noStep: await itemProblem({ kind: 'CONTAINER_WEIGHING', data: { item: 'disp' } }, c),
      noPhase: await itemProblem(weighing('disp', {}, 'p-nowhere@'), c),
      // Only the block that records such a weighing takes it: a dispensed container at an output step or a charge.
      atOutputStep: await itemProblem(weighing('made', {}, 'g@'), c),
      atChargeStep: await itemProblem(weighing('disp', {}, 'x@'), c),
      outputAtDispensing: await itemProblem(output('disp', 'd@'), c),
      outputHonest: await itemProblem(output('made'), c),
      outputNone: await itemProblem(output(null, 'n@'), c),
      outputNullWhereRecorded: await itemProblem(output(null), c),
      outputMissing: await itemProblem(output(undefined), c),
      outputSecond: await itemProblem(output('more'), c),
      outputNotMass: await itemProblem(output('temp', 'g@', { unit: 'Cel' }), c),
      outputNamedWhereNone: await itemProblem(output('series', 'n@', { unit: 'mg' }), c),
      outputAfterUnread: await itemProblem(output('made', 'u@'), c),
      outputNullAfterUnread: await itemProblem(output(null, 'u@'), c),
      outputAfterText: await itemProblem(output('made', 't@'), c),
      outputOtherUnit: await itemProblem(output('made', 'g@', { unit: 'kg{wet}' }), c),
      other: await itemProblem({ stepKey: 'd@', kind: 'CHARGE_CONTAINER', data: {} }, c),
      noKind: await itemProblem({ stepKey: 'd@', data: {} }, c),
    };
    expect(outcomes).toEqual({
      honest: 'null',
      honestInGrams: 'null',
      honestSecondPhase: 'null',
      honestInLoop: 'null',
      noItem: '(CONTAINER_WEIGHING) at d@ counted into (no item), where its phase d records the mass quantities ["disp"]',
      nullItem: '(CONTAINER_WEIGHING) at d@ counted into null, where its phase d records the mass quantities ["disp"]',
      otherPhase: '(CONTAINER_WEIGHING) at d@ counted into "other", where its phase d records the mass quantities ["disp"]',
      notMass: '(CONTAINER_WEIGHING) at d@ counted into "temp", where its phase d records the mass quantities ["disp"]',
      unknownItem: '(CONTAINER_WEIGHING) at d@ counted into "nope", where its phase d records the mass quantities ["disp"]',
      numberItem: '(CONTAINER_WEIGHING) at d@ counted into 5, where its phase d records the mass quantities ["disp"]',
      otherUnit: '(CONTAINER_WEIGHING) at d@ weighed in kg{wet}, which is not counted into disp in kg (the same unit, or both metric mass units)',
      noUnit: '(CONTAINER_WEIGHING) at d@ weighed in (no unit), which is not counted into disp in kg (the same unit, or both metric mass units)',
      sameOddUnit: 'null',
      noData: '(CONTAINER_WEIGHING) at d@ with no data, so no quantity it counts into',
      noStep: "(CONTAINER_WEIGHING) at (no step), whose step is no phase of the batch's MBR the database can read",
      noPhase: "(CONTAINER_WEIGHING) at p-nowhere@, whose step is no phase of the batch's MBR the database can read",
      atOutputStep: '(CONTAINER_WEIGHING) at g@, whose phase g is a G-22 step, which records no such weighing',
      atChargeStep: '(CONTAINER_WEIGHING) at x@, whose phase x is a G-08 step, which records no such weighing',
      outputAtDispensing: '(OUTPUT_CONTAINER) at d@, whose phase d is a G-07 step, which records no such weighing',
      outputHonest: 'null',
      outputNone: 'null',
      outputNullWhereRecorded: '(OUTPUT_CONTAINER) at g@ counted into null, where its phase g counts it into "made"',
      outputMissing: '(OUTPUT_CONTAINER) at g@ counted into (no item), where its phase g counts it into "made"',
      outputSecond: '(OUTPUT_CONTAINER) at g@ counted into "more", where its phase g counts it into "made"',
      outputNotMass: '(OUTPUT_CONTAINER) at g@ counted into "temp", where its phase g counts it into "made"',
      outputNamedWhereNone: '(OUTPUT_CONTAINER) at n@ counted into "series", where its phase n counts it into null',
      outputAfterUnread: '(OUTPUT_CONTAINER) at u@, whose phase u records odd in kg/1, a unit the database cannot tell is a mass or not, so not which quantity the container counts into',
      outputNullAfterUnread: '(OUTPUT_CONTAINER) at u@, whose phase u records odd in kg/1, a unit the database cannot tell is a mass or not, so not which quantity the container counts into',
      outputAfterText: 'null',
      outputOtherUnit: '(OUTPUT_CONTAINER) at g@ weighed in kg{wet}, which is not counted into made in kg (the same unit, or both metric mass units)',
      other: 'null',
      noKind: 'null',
    });
    // A quantity whose unit the database does not read is never one a dispensed container counts into (fail closed),
    // and one after the first mass quantity does not stop an output container.
    expect(await itemProblem(weighing('odd', { unit: 'kg/1' }, 'ug@'), c)).toBe('(CONTAINER_WEIGHING) at ug@ counted into "odd", where its phase ug records the mass quantities ["made"]');
    expect(await itemProblem(output('made', 'v@'), content([phase('v', ['made', 'odd'], 'G-22')]))).toBe('null');
    // A phase with no block at all.
    expect(await itemProblem(weighing('disp', {}, 'b@'), content([{ kind: 'phase', id: 'b', records: ['disp'] }]))).toBe('(CONTAINER_WEIGHING) at b@, whose phase b is a (no block) step, which records no such weighing');
    // The first parameter of an id is the MBR's.
    expect(await itemProblem(weighing('disp'), content([], [{ id: 'disp', valueType: 'DECIMAL', unit: 'Cel' }]))).toBe('null');
  }, 120_000);
});

function findById(n: FlowNode, id: string): FlowNode | undefined {
  if (n.id === id) return n;
  for (const c of childrenOf(n)) {
    const f = findById(c, id);
    if (f) return f;
  }
  return undefined;
}
