/**
 * Phase 7 slice 7q (requirement R8, capability C10): branches merging into one blend. A processing master with two
 * granulation branches that run in parallel, a wet one (TB-03 binder, TB-04 granulation, TB-05 drying loop, TB-02
 * milling, G-22 granules) and a dry one (TB-06 roller compaction, TB-02 milling, G-22 granules), whose two granules and
 * the directly weighed extragranular materials (dispensed at G-07, added at the blend) are blended in one TB-07 step.
 * The designer's validator finds no error, the execution definition nothing to refuse, and the simulation passes and
 * reaches every step of both branches. The container-level trace (each container from the step that made it to the
 * step it went into) is proven in the engine by recipe-core's test of the same shape (test/blocks/material.test.ts,
 * "branches merging into one blend"); a browser proof comes with product P1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flow, simulator } from '@ebmr/recipe-core/pure';
import { startSigningServer } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { seedReferenceDocuments } from '../../src/features/designer/seed.ts';
import { analyse } from '../../src/features/designer/validation.ts';
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { phase, pinned } from '../../src/cli/golden-packaging.ts';
import { TB06 } from '../../src/blocks/tb-06.ts';
import { publishTables, stewardActor } from './support.ts';

type Json = Record<string, unknown>;
let gmp: TestServer;

function look(n: unknown, id: string): Json | undefined {
  if (Array.isArray(n)) {
    for (const x of n) {
      const r = look(x, id);
      if (r) return r;
    }
  } else if (n && typeof n === 'object') {
    const o = n as Json;
    if (o['id'] === id) return o;
    for (const v of Object.values(o)) {
      const r = look(v, id);
      if (r) return r;
    }
  }
  return undefined;
}
const must = (n: unknown, id: string): Json => {
  const r = look(n, id);
  if (!r) throw new Error(`no node ${id}`);
  return r;
};

/** Route W's processing master with its granulation split into a wet and a dry branch that merge at the blend. */
export function mergingBranchesContent(): flow.MbrContent {
  const m = structuredClone(rtwProcessingContent('C10-MERGE')) as unknown as Json;
  m['references'] = [...(m['references'] as Json[]), ...pinned(['EQC-RC', 'SYS-RC', 'QRM-RC-01'])];
  const gran = must(m['procedure'], 'S-GRAN');
  // The dry branch has its own compactor and mill: branches that run at the same time never share equipment (DATA-PARALLEL).
  ((gran['binding'] as Json)['equipment'] as Json[]).push({ ref: 'COMPACTOR', equipmentClass: 'EQC-RC', kind: 'PROCESS' }, { ref: 'MILL-D', equipmentClass: 'EQC-MILL', kind: 'PROCESS' });
  (must(gran, 'p-gran-status')['equipment'] as Json[]).push({ ref: 'COMPACTOR', use: 'STATUS_CHECK' }, { ref: 'MILL-D', use: 'STATUS_CHECK' });
  const op = must(gran, 'O-GRAN');
  const steps = (op['body'] as Json)['children'] as Json[];
  const at = steps.findIndex((n) => n['id'] === 'p-gran-yield');
  const wet = steps.slice(0, at);
  const golden = TB06.goldenFixture?.phase as unknown as Json;
  const dry = [
    phase('p-compact', 'Roller compaction of the moisture-sensitive pre-blend', 'TB-06', '1', structuredClone(golden['config'] as Json), {
      equipment: [{ ref: 'COMPACTOR', use: 'USE' }],
      system: structuredClone(golden['system'] as Json),
    }),
    phase('p-mill-d', 'Compacted ribbons milled through the checked screen', 'TB-02', '1', { equipmentClass: 'CO_MILL', screens: [{ id: 'SCR-RW-11', aperture: { value: '1.2', unit: 'mm' } }] }, {
      equipment: [{ ref: 'MILL-D', use: 'USE' }],
    }),
    { ...structuredClone(must(gran, 'p-gran-out')), id: 'p-gran-out-d', name: 'Compacted granules into containers', records: ['granNetD'], produces: ['I-GRAN-D'] },
  ];
  (op['body'] as Json)['children'] = [
    {
      kind: 'parallel',
      id: 'PAR-GRAN',
      branches: [
        { id: 'BR-WET', name: 'Wet granulation (minerals)', body: { kind: 'sequence', id: 'SEQ-WET', children: wet } },
        { id: 'BR-DRY', name: 'Dry granulation (moisture-sensitive vitamins)', body: { kind: 'sequence', id: 'SEQ-DRY', children: dry } },
      ],
    },
    ...steps.slice(at),
  ];
  const params = m['parameters'] as Json[];
  params.push({ ...structuredClone(params.find((p) => p['id'] === 'granNet') as Json), id: 'granNetD', name: 'Compacted granules (net)' });
  for (const c of m['calculations'] as Json[]) if (c['id'] === 'granOut') Object.assign(c, { name: 'Wet and compacted granules', expression: 'granNet + granNetD' });
  for (const g of m['goldenCases'] as Json[]) {
    const inputs = g['inputs'] as Json;
    if (inputs['granNet']) Object.assign(inputs, { granNet: { value: '40.000', unit: 'kg' }, granNetD: { value: '37.150', unit: 'kg' } });
  }
  const inter = m['intermediates'] as Json[];
  inter.push({ ...structuredClone(inter.find((i) => i['id'] === 'I-GRAN') as Json), id: 'I-GRAN-D', name: 'Compacted granules' });
  must(m['procedure'], 'p-blend')['uses'] = ['I-GRAN', 'I-GRAN-D'];
  const parsed = flow.parseMbr(m);
  if (!parsed.ok) throw new Error(`does not parse: ${parsed.problems.slice(0, 5).map((p) => `${p.path}: ${p.message}`).join('; ')}`);
  return parsed.mbr;
}

beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  await seedReferenceDocuments(gmp.db.app, await stewardActor(gmp));
  await publishTables(gmp);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

describe('branches merging into one blend (slice 7q, R8 C10)', () => {
  it('[PR-03][IN-13][PR-21] a wet branch (TB-03, TB-04, TB-05, TB-02) and a dry branch (TB-06, TB-02) in parallel, and the directly weighed materials, blend in one TB-07: the validator, the execution definition and the simulation accept it', async () => {
    const mbr = mergingBranchesContent();
    expect(definitionFindings(mbr).filter((f) => f.severity === 'ERROR').map((f) => f.message)).toEqual([]);
    const a = await analyse(gmp.db.app, mbr, []);
    expect(a.report.findings.filter((f) => f.severity === 'ERROR').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    const sim = simulator.simulate(mbr, a.loaded.context);
    expect(sim.problems).toEqual([]);
    expect(sim.passed).toBe(true);
    // Every step of both branches is reached (the join waits for every branch before the blend).
    expect(sim.coverage.steps.missing).toEqual([]);
    // The blend uses both granules; the extragranular materials are dispensed and added there, so every BOM line is consumed.
    const blend = must(mbr.procedure, 'p-blend') as unknown as flow.PhaseNode;
    expect([blend.block.type, blend.uses]).toEqual(['TB-07', ['I-GRAN', 'I-GRAN-D']]);
    const types = JSON.stringify(mbr.procedure);
    for (const t of ['"TB-03"', '"TB-04"', '"TB-05"', '"TB-02"', '"TB-06"', '"TB-07"']) expect(types).toContain(t);
  }, 120_000);
});
