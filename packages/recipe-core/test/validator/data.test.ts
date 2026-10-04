import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMbr } from '../../src/flow/parse.ts';
import type { AlternativeBranch, Calculation, FlowNode, MbrContent, Parameter } from '../../src/flow/model.ts';
import { analyseGuards } from '../../src/validator/guards.ts';
import { DATA_RULES } from '../../src/validator/rules-data.ts';
import { STRUCTURE_RULES } from '../../src/validator/rules-structure.ts';
import { clone, findNode, findPhase, loadFixture, mbrWith, phase, registryOf, validate } from '../flow/support.ts';

const dataRules = registryOf(STRUCTURE_RULES, DATA_RULES);
const seq = (id: string, children: FlowNode[]): FlowNode => ({ kind: 'sequence', id, children });

const weight = (id: string): Parameter => ({ id, name: `Weight ${id}`, valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 2 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
const calc = (id: string, expression: string, unit = 'kg'): Calculation => ({ id, name: `Calc ${id}`, expression, output: { valueType: 'DECIMAL', unit }, criticality: 'CRITICAL', riskClass: 'HIGH' });

function found(mbr: MbrContent, rule: string): string[] {
  return validate(mbr, {}, dataRules)
    .findings.filter((f) => f.rule === rule)
    .map((f) => `${f.severity}: ${f.message}`);
}

describe('data gates', () => {
  it('[DI-34] both fixtures pass every data gate', () => {
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) {
      expect(validate(loadFixture(name), {}, dataRules).findings).toEqual([]);
    }
  });

  it('[DI-34][DI-04] DATA-WRITTEN-BEFORE-READ: a value read before it is recorded is refused', () => {
    const m = mbrWith(seq('ops', [phase('use', { computes: ['total'] }), phase('rec', { records: ['a'] })]), { parameters: [weight('a')], calculations: [calc('total', 'a * 2')] });
    expect(found(m, 'DATA-WRITTEN-BEFORE-READ')).toEqual([expect.stringMatching(/Calculation "Calc total" \(total\) in "Step use" \(use\) reads "Weight a" \(a\) before it is recorded on every path/)]);
  });

  it('[DI-34] DATA-WRITTEN-BEFORE-READ: a value recorded in only one branch of an alternative is not available after it', () => {
    const alt: FlowNode = {
      kind: 'alternative',
      id: 'A',
      decision: { mode: 'OPERATOR_CHOICE', roles: ['SUP'], reasonRequired: true },
      branches: [
        { id: 'x', name: 'X', body: phase('rec', { records: ['a'] }) },
        { id: 'y', name: 'Y', body: phase('other') },
      ],
    };
    const m = mbrWith(seq('ops', [alt, phase('use', { reads: ['a'] })]), { parameters: [weight('a')] });
    expect(found(m, 'DATA-WRITTEN-BEFORE-READ')).toHaveLength(1);
    // Recorded in every branch: available.
    const both = clone(m);
    const a = findNode(both, 'A');
    if (a.kind === 'alternative') (a.branches[1] as AlternativeBranch).body = phase('rec2', { records: ['a'] });
    expect(found(both, 'DATA-WRITTEN-BEFORE-READ')).toEqual([]);
  });

  it('[DI-34] DATA-WRITTEN-BEFORE-READ: a parallel branch cannot read what a sibling branch writes (unsequenced)', () => {
    const m = mbrWith(
      {
        kind: 'parallel',
        id: 'P',
        branches: [
          { id: 'x', name: 'X', body: phase('rec', { records: ['a'] }) },
          { id: 'y', name: 'Y', body: phase('use', { reads: ['a'] }) },
        ],
      },
      { parameters: [weight('a')] },
    );
    expect(found(m, 'DATA-WRITTEN-BEFORE-READ')).toHaveLength(1);
  });

  it('[DI-34] DATA-WRITTEN-BEFORE-READ: after a parallel join, every branch has run, so all their values are available', () => {
    const m = mbrWith(
      seq('ops', [
        {
          kind: 'parallel',
          id: 'P',
          branches: [
            { id: 'x', name: 'X', body: phase('rx', { records: ['a'] }) },
            { id: 'y', name: 'Y', body: phase('ry', { records: ['b'] }) },
          ],
        },
        phase('use', { computes: ['total'] }),
      ]),
      { parameters: [weight('a'), weight('b')], calculations: [calc('total', 'a + b')] },
    );
    expect(found(m, 'DATA-WRITTEN-BEFORE-READ')).toEqual([]);
  });

  it('[DI-04] DATA-SINGLE-WRITER: a value written by two steps on one path is refused', () => {
    const m = mbrWith(seq('ops', [phase('r1', { records: ['a'] }), phase('r2', { records: ['a'] })]), { parameters: [weight('a')] });
    expect(found(m, 'DATA-SINGLE-WRITER')).toEqual([expect.stringMatching(/is written by both/)]);
  });

  it('[DI-04][DI-33] DATA-EXPRESSIONS: a unit error in a calculation is refused with the expression language rule and control', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const c = m.calculations.find((x) => x.id === 'blendTheoretical');
    if (c) c.expression = 'sum(driedNet) + egCharged + targetWeight / 1 [mg]';
    const f = found(m, 'DATA-EXPRESSIONS');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]).toMatch(/^ERROR: Calculation "Theoretical blend mass" \(blendTheoretical\): .*\(EXPR-[A-Z0-9-]+, DI-33\) \(DATA-EXPRESSIONS; DI-04, DI-33\)$/);
  });

  it('[DI-04] DATA-EXPRESSIONS: a loop exit condition must give true or false', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const loop = findNode(m, 'L-DRY');
    if (loop.kind === 'loop') loop.exit.condition = 'lod';
    expect(found(m, 'DATA-EXPRESSIONS').join(' ')).toMatch(/exit condition of loop/);
  });

  it('[DI-04][DI-33] DATA-CALC-CYCLES: calculations depending on each other in a cycle are refused', () => {
    const m = mbrWith(phase('c', { computes: ['x', 'y'] }), { calculations: [calc('x', 'y * 2'), calc('y', 'x / 2')] });
    expect(found(m, 'DATA-CALC-CYCLES')).toEqual([expect.stringMatching(/Calculations x, y depend on each other in a cycle/)]);
  });

  it('[DI-34] DATA-PARALLEL: parallel branches may not write the same value, use the same process equipment or consume the same BOM line', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const prep = findPhase(m, 'p-binder-prep');
    prep.equipment = [...prep.equipment, { ref: 'RMG', use: 'USE' }];
    prep.records = [...prep.records, 'kitCharged'];
    const f = found(m, 'DATA-PARALLEL').join(' ');
    expect(f).toMatch(/both write "Granulation kit charged \(sub-lot\)"/);
    expect(f).toMatch(/both use equipment RMG at the same time/);
  });

  it('[DI-34] DATA-PARALLEL: concurrent replicate instances cannot share process equipment', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const rep = findNode(m, 'R-SUBLOT');
    if (rep.kind === 'replicate') rep.instances = 'CONCURRENT';
    expect(found(m, 'DATA-PARALLEL').join(' ')).toMatch(/run concurrently, but .* uses process equipment RMG/);
  });

  it('[PR-08] DATA-UNITS: a limit in another dimension than its parameter is refused', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    const p = m.parameters.find((x) => x.id === 'inletTemp');
    if (p?.limits) p.limits.unit = 'kg';
    expect(found(m, 'DATA-UNITS').join(' ')).toMatch(/limits of "Inlet air temperature \(drying\)" \(inletTemp\) are in another dimension/);
  });
});

describe('weighed quantities in a unit the database cannot read (COMPOUND-UNIT; recipe-core sql 0323)', () => {
  /** The granulation master with the dried-granules output step (G-22) also recording `density` in `unit`, before or after its net. */
  function withDensity(unit: string, where: 'before' | 'after' | 'alone', extra: Partial<Parameter> = {}): MbrContent {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.parameters.push({ ...weight('density'), name: 'Bulk density', unit, role: 'OBSERVATION', ...extra });
    const out = findPhase(m, 'p-gran-out');
    out.records = where === 'before' ? ['density', ...out.records] : where === 'after' ? [...out.records, 'density'] : ['density'];
    if (where === 'alone') m.parameters = m.parameters.map((x) => (x.id === 'driedNet' ? { ...x, unit: 'L' } : x));
    return m;
  }
  /** `m` with the density counted, without a unit. */
  function counted(m: MbrContent): MbrContent {
    for (const x of m.parameters) if (x.id === 'density') delete x.unit;
    return m;
  }
  const RULE = 'DATA-WEIGHED-UNITS';

  it('[INV-25][PR-19][DI-30] an output step (G-22) recording a quantity in a compound unit before its first plain mass quantity, or with none, is warned about with its code: the database refuses every output container of such a step', () => {
    expect(found(withDensity('g/mL', 'before'), RULE)).toEqual([
      'WARNING: "Weigh dried granules into labelled containers" (p-gran-out) registers output containers (G-22) and records "Bulk density" (density) in g/mL before its first plain mass quantity. In this release the database cannot tell whether a compound unit (written with ".", "/" or parentheses) is a mass, so it refuses every output container of this step (EBMR-EXE-139), although the engine would count it. Record the produced quantity first, or write the unit plainly (kg, g, mg) (DATA-WEIGHED-UNITS; INV-25, PR-19, DI-30)',
    ]);
    expect(found(withDensity('kg/1', 'alone'), RULE)).toEqual([expect.stringMatching(/^WARNING: .*records "Bulk density" \(density\) in kg\/1 and no plain mass quantity\. In this release the database cannot tell/)]);
    // After the plain mass quantity, in a plain unit, or not a single decimal reading: nothing to warn about.
    expect({
      after: found(withDensity('g/mL', 'after'), RULE),
      plain: found(withDensity('L', 'before'), RULE),
      readings: found(withDensity('g/mL', 'before', { readings: 3 }), RULE),
      count: found(counted(withDensity('g/mL', 'before', { valueType: 'COUNT', precision: { kind: 'DECIMALS', digits: 0 } })), RULE),
    }).toEqual({ after: [], plain: [], readings: [], count: [] });
  });

  it('[INV-25][PR-19][DI-30] a dispensing step (G-07) counting into a mass written as a compound unit is warned about too: the database refuses every container weighed into it; the fixtures and dc-mini are warned about nowhere', () => {
    const m = clone(loadFixture('tablet-granulation-compression'));
    m.parameters = m.parameters.map((x) => (x.id === 'apiDispensed' ? { ...x, unit: 'kg/1' } : x));
    expect(found(m, RULE)).toEqual([
      'WARNING: "Dispense atorvastatin calcium" (p-disp-api) dispenses into "API dispensed (net)" (apiDispensed), a mass written as a compound unit (kg/1). In this release the database cannot read it as a mass, so it refuses every container weighed into it (EBMR-EXE-139). Write the unit plainly (kg, g, mg) (DATA-WEIGHED-UNITS; INV-25, PR-19, DI-30)',
    ]);
    for (const name of ['tablet-granulation-compression', 'tablet-blister-packaging'] as const) expect(found(loadFixture(name), RULE), name).toEqual([]);
    const dcMini = parseMbr(JSON.parse(readFileSync(new URL('../fixtures/dc-mini.mbr.json', import.meta.url), 'utf8')));
    expect(dcMini.ok && found(dcMini.mbr, RULE)).toEqual([]);
    // A warning: the author justifies it or changes the MBR before verification can start.
    expect(validate(withDensity('g/mL', 'before'), {}, dataRules).findings.filter((f) => f.rule === RULE).map((f) => [f.severity, f.key])).toEqual([['WARNING', 'DATA-WEIGHED-UNITS@p-gran-out']]);
  });
});

describe('branch conditions: exhaustive, non-overlapping, reachable', () => {
  const guarded = (guards: (string | undefined)[]): MbrContent =>
    mbrWith(
      seq('ops', [
        phase('measure', { records: ['lod'] }),
        {
          kind: 'alternative',
          id: 'A',
          decision: { mode: 'DATA' },
          branches: guards.map((g, i): AlternativeBranch => (g === undefined ? { id: `b${i}`, name: 'Otherwise', otherwise: true, body: phase(`s${i}`) } : { id: `b${i}`, name: `B${i}`, guard: g, body: phase(`s${i}`) })),
        },
      ]),
      { parameters: [{ ...weight('lod'), unit: '%', semanticTag: 'lod' }] },
    );

  it('[DI-34] conditions that cover every case exactly once pass', () => {
    expect(found(guarded(['lod < 2.0 [%]', 'lod >= 2.0 [%] && lod <= 3.5 [%]', 'lod > 3.5 [%]']), 'DATA-GUARDS')).toEqual([]);
    expect(found(guarded(['lod < 2.0 [%]', undefined]), 'DATA-GUARDS')).toEqual([]);
  });

  it('[DI-34] a gap is refused and names a value no branch covers', () => {
    expect(found(guarded(['lod < 2.0 [%]', 'lod > 2.0 [%]']), 'DATA-GUARDS')).toEqual([expect.stringMatching(/^ERROR: No branch of alternative A applies when lod = 2(\.0)?;/)]);
  });

  it('[DI-34] an overlap is refused and names a value both branches accept', () => {
    expect(found(guarded(['lod <= 3.5 [%]', 'lod >= 3.5 [%]']), 'DATA-GUARDS')).toEqual([expect.stringMatching(/Branches b0 and b1 of alternative A both apply when lod = 3\.5/)]);
  });

  it('[DI-34] a branch that can never be taken is refused', () => {
    expect(found(guarded(['lod < 2.0 [%]', 'lod >= 2.0 [%]', undefined]), 'DATA-GUARDS')).toEqual([expect.stringMatching(/Branch b2 of alternative A can never be taken/)]);
  });

  it('[DI-34] conditions outside the decidable form need a justification (warning), never a silent pass', () => {
    const f = found(guarded(['lod * 2 < 4 [%]', 'lod * 2 >= 4 [%]']), 'DATA-GUARDS');
    expect(f).toEqual([expect.stringMatching(/^WARNING: It cannot be proven that the conditions of alternative A cover every case exactly once/)]);
  });

  it('[DI-34] the decision procedure is exact on counts and categories', () => {
    const count = new Map([['n', { kind: 'COUNT' as const }]]);
    const r = analyseGuards(
      [
        { id: 'a', formula: { op: 'cmp', variable: 'n', cmp: '<=', constant: '2' } },
        { id: 'b', formula: { op: 'cmp', variable: 'n', cmp: '>=', constant: '3' } },
      ],
      count,
      1000,
    );
    expect(r).toMatchObject({ decided: true, overlaps: [], dead: [] });
    expect(r.uncovered).toBeUndefined();
    const cat = new Map([['c', { kind: 'CATEGORY' as const, values: ['A', 'B', 'C'] }]]);
    const r2 = analyseGuards(
      [
        { id: 'a', formula: { op: 'is', variable: 'c', value: 'A' } },
        { id: 'b', formula: { op: 'is', variable: 'c', value: 'B' } },
      ],
      cat,
      1000,
    );
    expect(r2.uncovered?.get('c')).toBe('C');
  });
});
