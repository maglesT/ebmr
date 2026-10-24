/**
 * "Add a coating layer" (Phase 7 slice 7o, R4 second check product, R8 C3; D-7o-2): a seal coat, an enteric coat and a
 * top coat added one after another in the designer, each its own suspension, cores step with its own core item and coating
 * loop with its own weight-gain item and limits; the content stays well formed with unique ids; refusals change nothing.
 */
import { describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import type { CoatingLayer } from '../../src/features/designer/model/coating-layer.ts';
import { applyOp, OpError, treeIds, type Content } from '../../src/features/designer/model/ops.ts';

function parsed(json: unknown): Content {
  const r = flow.parseMbr(json);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.mbr;
}

const SEAL: CoatingLayer = { name: 'Seal coat', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '2.0', maxGain: '3.0', coreLow: '240.0', coreHigh: '260.0', maxIterations: 3 };
const ENTERIC: CoatingLayer = { name: 'Enteric coat', coatingType: 'FC_F', solutionType: 'ENTERIC', targetGain: '9.0', minGain: '8.0', maxGain: '11.0', coreLow: '245.0', coreHigh: '265.0', maxIterations: 4 };
const TOP: CoatingLayer = { name: 'Top coat', coatingType: 'FC', solutionType: 'FILM_COAT', targetGain: '3.0', maxGain: '4.0', coreLow: '270.0', coreHigh: '290.0', maxIterations: 3 };

const phases = (c: Content): flow.PhaseNode[] => {
  const out: flow.PhaseNode[] = [];
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase') out.push(n);
  });
  return out;
};
const wellFormed = (c: Content): void => {
  expect(flow.parseMbr(JSON.parse(JSON.stringify(c))).ok).toBe(true);
  const ids = treeIds(c);
  expect(new Set(ids).size).toBe(ids.length);
};

describe('add a coating layer (slice 7o)', () => {
  const base = parsed(granulation);
  const last = phases(base).at(-1) as flow.PhaseNode;

  it('[IN-37][PR-29][PR-08] three layers in a row: each its own TB-03, its own TB-18 cores step and core item, its own loop to its own gain item with its own limits; the later layers copy the first coating step\'s settings', () => {
    let c = applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: last.id, place: 'AFTER', layer: SEAL });
    wellFormed(c);
    const sealCoat = phases(c).find((p) => p.id === 'p-coat-seal-coat') as flow.PhaseNode;
    // Next to the seal coat's coating step (a loop's body): the enteric layer goes after its loop.
    c = applyOp(c, { kind: 'ADD_COATING_LAYER', stepId: sealCoat.id, place: 'AFTER', layer: ENTERIC });
    c = applyOp(c, { kind: 'ADD_COATING_LAYER', stepId: 'p-coat-enteric-coat', place: 'AFTER', layer: TOP });
    wellFormed(c);
    const tb18 = phases(c).filter((p) => p.block.type === 'TB-18');
    expect(tb18.map((p) => [p.id, p.config['part'], p.config['coreItem'], p.config['gainItem'] ?? null, p.config['coatingType']])).toEqual([
      ['p-cores-seal-coat', 'CORES', 'coreSealCoat', null, 'FC'],
      ['p-coat-seal-coat', 'COATING', 'coreSealCoat', 'gainSealCoat', 'FC'],
      ['p-cores-enteric-coat', 'CORES', 'coreEntericCoat', null, 'FC_F'],
      ['p-coat-enteric-coat', 'COATING', 'coreEntericCoat', 'gainEntericCoat', 'FC_F'],
      ['p-cores-top-coat', 'CORES', 'coreTopCoat', null, 'FC'],
      ['p-coat-top-coat', 'COATING', 'coreTopCoat', 'gainTopCoat', 'FC'],
    ]);
    expect(phases(c).filter((p) => p.block.type === 'TB-03').map((p) => p.config['solutionType'])).toEqual(['FILM_COAT', 'ENTERIC', 'FILM_COAT']);
    // The cores step records its core item; the coating step reads it and records its gain; each in its own bounded loop.
    for (const [cores, coat] of [['p-cores-enteric-coat', 'p-coat-enteric-coat']] as const) {
      const p = phases(c);
      expect(p.find((x) => x.id === cores)?.records).toEqual(['coreEntericCoat']);
      expect([p.find((x) => x.id === coat)?.reads, p.find((x) => x.id === coat)?.records]).toEqual([['coreEntericCoat'], ['gainEntericCoat']]);
    }
    const loops: flow.LoopNode[] = [];
    flow.walk(c.procedure.body, (n) => {
      if (n.kind === 'loop' && n.id.startsWith('L-COAT-')) loops.push(n);
    });
    expect(loops.map((l) => [l.id, l.maxIterations, l.exit.endpoint, l.exit.condition])).toEqual([
      ['L-COAT-SEAL-COAT', 3, 'gainSealCoat', 'gainSealCoat >= 2.0 [%]'],
      ['L-COAT-ENTERIC-COAT', 4, 'gainEntericCoat', 'gainEntericCoat >= 8.0 [%]'],
      ['L-COAT-TOP-COAT', 3, 'gainTopCoat', 'gainTopCoat >= 3.0 [%]'],
    ]);
    const gain = c.parameters.find((p) => p.id === 'gainEntericCoat');
    expect([gain?.role, gain?.unit, gain?.limits?.ranges[0]?.low?.value, gain?.limits?.ranges[0]?.high?.value]).toEqual(['PROCESS_ENDPOINT', '%', '8.0', '11.0']);
    const core = c.parameters.find((p) => p.id === 'coreTopCoat');
    expect([core?.unit, core?.accuracyCheck, core?.limits?.ranges[0]?.low?.value, core?.limits?.ranges[0]?.high?.value]).toEqual(['mg', 'SECOND_PERSON', '270.0', '290.0']);
    // The later layers copy the first coating step's coater values.
    const coats = tb18.filter((p) => p.config['part'] === 'COATING');
    expect(coats[2]?.config['actuals']).toEqual(coats[0]?.config['actuals']);
  });

  it('[IN-37][PR-08] a layer placed before a step goes in front of it; the same name twice gets fresh ids and items', () => {
    let c = applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: last.id, place: 'AFTER', layer: ENTERIC });
    c = applyOp(c, { kind: 'ADD_COATING_LAYER', stepId: 'p-susp-enteric-coat', place: 'BEFORE', layer: SEAL });
    const ids = phases(c).map((p) => p.id);
    expect(ids.indexOf('p-susp-seal-coat')).toBeLessThan(ids.indexOf('p-susp-enteric-coat'));
    c = applyOp(c, { kind: 'ADD_COATING_LAYER', stepId: 'p-coat-enteric-coat', place: 'AFTER', layer: SEAL });
    wellFormed(c);
    expect(c.parameters.filter((p) => p.id.startsWith('coreSealCoat')).map((p) => p.id)).toEqual(['coreSealCoat', 'coreSealCoat2']);
  });

  it('[IN-37][PR-08] refusals change nothing: a functional film without its minimum, a minimum above the maximum, an unknown step, iterations outside 1 to 20', () => {
    const before = JSON.stringify(base);
    const noMin: CoatingLayer = { ...ENTERIC };
    delete noMin.minGain;
    expect(() => applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: last.id, place: 'AFTER', layer: noMin })).toThrow('minimum weight gain');
    expect(() => applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: last.id, place: 'AFTER', layer: { ...ENTERIC, minGain: '12.0' } })).toThrow(OpError);
    expect(() => applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: 'no-such-step', place: 'AFTER', layer: SEAL })).toThrow(OpError);
    expect(() => applyOp(base, { kind: 'ADD_COATING_LAYER', stepId: last.id, place: 'AFTER', layer: { ...SEAL, maxIterations: 21 } })).toThrow('1 to 20');
    expect(JSON.stringify(base)).toBe(before);
  });
});
