/**
 * Slice 7s (R8, P3 only; owner, 25 October 2026): the DEMO-ONLY P3 seed (cli/demo-p3.ts) makes the author's designer
 * edits of Rabeprazole 2 on the copied wet-granulation master and adds the seal and top coats with the designer's own
 * layer builder (flow.coatingLayerParts, D-7s-2). Checked here without a database: the edited master defines without an
 * error, its three coats are in the coating stage in order (seal, enteric, top), each with its own suspension, cores
 * step, core item, loop and weight-gain item, and the edits carry the product's values. The seed itself is run by the
 * E2E group p3-demo's set-up and the browser test p3-demo.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { flow } from '@ebmr/recipe-core/pure';
import { rabeprazoleEdits } from '../../src/cli/demo-p3.ts';
import { rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { definitionFindings } from '../../src/features/designer/definition.ts';

type Json = Record<string, unknown>;

const phases = (c: flow.MbrContent): flow.PhaseNode[] => {
  const out: flow.PhaseNode[] = [];
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'phase') out.push(n);
  });
  return out;
};

describe('the P3 demo seed\'s processing master (slice 7s)', () => {
  // Route W's master with the compensating cellulose of the P3 formula (30 mg x 1,50,000 = 4.500 kg); the seed's copy
  // takes its whole bill of materials from the approved formula (designer.createFamily, start COPY).
  const source = rtwProcessingContent('RAB-WG-TEST', ['IN']);
  const mcc = source.bom.find((b) => b.id === 'BOM-MCC');
  if (mcc) mcc.quantity = { ...mcc.quantity, value: '4.500' };
  const edited = rabeprazoleEdits(source);

  it('[IN-37][PR-29] the edited master with the seal, enteric and top coats defines without an error and parses as content', () => {
    expect(definitionFindings(edited).filter((f) => f.severity === 'ERROR').map((f) => `${f.rule} ${f.subject}: ${f.message}`)).toEqual([]);
    expect(flow.parseMbr(JSON.parse(JSON.stringify(edited))).ok).toBe(true);
    const coat = phases(edited).filter((p) => p.block.type === 'TB-18');
    expect(coat.map((p) => [p.id, (p.config as Json)['part'], (p.config as Json)['coreItem']])).toEqual([
      ['p-cores-seal', 'CORES', 'coreSeal'], ['p-coat-seal', 'COATING', 'coreSeal'],
      ['p-cores', 'CORES', 'coreMean'], ['p-coat', 'COATING', 'coreMean'],
      ['p-cores-top', 'CORES', 'coreTop'], ['p-coat-top', 'COATING', 'coreTop'],
    ]);
    const gains = coat.filter((p) => (p.config as Json)['part'] === 'COATING').map((p) => [(p.config as Json)['gainItem'], (p.config as Json)['targetGain'], (p.config as Json)['maxGain']]);
    expect(gains).toEqual([['gainSeal', '2.0', '2.5'], ['gain', '9.0', '10.0'], ['gainTop', '3.0', '3.5']]);
    const susp = phases(edited).filter((p) => p.block.type === 'TB-03').map((p) => p.id);
    expect(susp).toEqual(expect.arrayContaining(['p-susp-seal', 'p-susp', 'p-susp-top']));
    expect(edited.parameters.find((p) => p.id === 'coreSeal')?.limits?.ranges[0]).toMatchObject({ tier: 'VALIDATED', low: { value: '121.3' }, high: { value: '128.8' } });
    expect(edited.parameters.find((p) => p.id === 'coreTop')?.limits?.ranges[0]).toMatchObject({ low: { value: '134.8' }, high: { value: '143.2' } });
  });

  it('[IN-37][PR-29] the edits carry the product\'s values (salt form, compensation, binder, 125 mg core, R20 tooling, enteric gain 8 to 10 %, batch gain 13 to 16.5 %); the source is not changed', () => {
    const byId = (c: flow.MbrContent, id: string): Json => (phases(c).find((p) => p.id === id)?.config ?? {});
    expect(byId(edited, 'p-disp-api')).toMatchObject({ active: { standardIs: 'FORM' }, compensation: { min: '4.000', max: '5.000' } });
    expect(byId(edited, 'p-gran')).toMatchObject({ binder: { min: '1.500', max: '2.200' } });
    expect(byId(edited, 'p-tool')).toMatchObject({ specification: { upperEmbossing: 'R20', shape: 'Round 7.0 mm biconvex' } });
    expect(byId(edited, 'p-run')).toMatchObject({ weight: { targetWeightMg: '125.0' }, sweep: { weight: { individual: { action: { min: '118.8', max: '131.3' } } } } });
    expect(byId(edited, 'p-cores')).toMatchObject({ loadRange: { min: '10', max: '30' } });
    expect(byId(edited, 'p-coat')).toMatchObject({ targetGain: '9.0', minGain: '8.0', maxGain: '10.0' });
    expect(edited.parameters.find((p) => p.id === 'gain')?.limits?.ranges[0]).toMatchObject({ low: { value: '8.0' }, high: { value: '10.0' } });
    expect((edited.yieldCheckpoints.find((y) => y.name === 'Coating weight gain of the batch') as unknown as { limits: flow.LimitSpec }).limits.ranges[0]).toMatchObject({ low: { value: '13.0' }, high: { value: '16.5' } });
    expect(byId(source, 'p-coat')).toMatchObject({ targetGain: '3.0' });
  });

  it('[IN-37][PR-29] the master cites the product\'s own registration and validation report, never route W\'s, and holds no other active\'s declared form (R10 #9, #11)', () => {
    const text = JSON.stringify(edited);
    expect(text).not.toMatch(/"(VR-RTW|REG-RTW)"/);
    const sources = [...edited.parameters, ...edited.calculations, ...edited.yieldCheckpoints].flatMap((x) => (x as { limits?: flow.LimitSpec }).limits?.ranges.map((r) => r.source.ref) ?? []);
    expect(sources).toContain('VR-RAB');
    const own = edited.references.filter((r) => r.id === 'VR-RAB' || r.id === 'REG-RAB');
    expect(own).toHaveLength(2);
    for (const r of own) expect(r.title).toMatch(/rabeprazole sodium/i);
    const disp = (phases(edited).find((p) => p.id === 'p-disp-api')?.config ?? {}) as Json;
    expect(JSON.stringify(disp).toLowerCase()).not.toContain('exemplazine');
    expect(definitionFindings(edited).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });
});
