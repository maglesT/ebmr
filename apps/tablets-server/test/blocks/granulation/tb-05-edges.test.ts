/**
 * TB-05@1 drying with the LOD loop and the filter bag (IN-36, PR-27, PR-29) at its edges, through its handler on a
 * minimal view: the bag's history (new, last product with its wash record, dedicated), its checks before and after use
 * of the same bag, drying start and end, the LOD sample once after drying, PERFORMED and every definition check.
 * Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { lodLoopOf, TB05, TB05_MAX_ITERATIONS } from '../../../src/blocks/tb-05.ts';
import { blockMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T = 1_800_000_000_000_000n;
const CFG = fixturePhase(TB05).config as Json;

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return {
      phase: { id: 'p', block: { type: 'TB-05', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1' },
      batch: { productCode: 'PROD-A' },
      parameter: () => undefined,
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB05.handler?.acceptEntry?.bind(TB05.handler) as unknown as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
}
const bag = (when: string, extra: Json = {}) => ({ kind: 'BAG_CHECK', bag: 'BAG-1', when, result: 'INTACT', ...extra });

describe('TB-05 filter bag', () => {
  it('[IN-36][PR-27] before use the bag states its history: new, or the product last dried (another product only with its wash record); never both; a damaged bag is replaced', () => {
    const r = (extra: Json, cfg: Json = CFG) => new World(cfg).rec(bag('BEFORE', extra));
    expect(r({ newBag: true, lastProduct: 'PROD-A' }).refused).toBe('Filter bag BAG-1 is either new or was last used for a product, not both (TB05-BAG-HISTORY; IN-36, PR-27)');
    expect(r({}).refused).toBe('State the product filter bag BAG-1 was last used for, or that it is new (TB05-BAG-HISTORY; IN-36, PR-27)');
    expect(r({ newBag: false }).refused).toMatch(/TB05-BAG-HISTORY/);
    expect(r({ lastProduct: 'PROD-B' }).refused).toBe('Filter bag BAG-1 was last used for PROD-B; it is used for PROD-A only with its wash record (TB05-BAG-WASH; IN-36, PR-27)');
    expect(r({ lastProduct: 'PROD-B', washRecord: 'WR-7' }).data).toStrictEqual({ bag: 'BAG-1', when: 'BEFORE', result: 'INTACT', lastProduct: 'PROD-B', washRecord: 'WR-7', checkedBy: 'OP1' });
    expect(r({ lastProduct: 'PROD-A' }).data).toStrictEqual({ bag: 'BAG-1', when: 'BEFORE', result: 'INTACT', lastProduct: 'PROD-A', checkedBy: 'OP1' });
    expect(r({ newBag: true }).data).toStrictEqual({ bag: 'BAG-1', when: 'BEFORE', result: 'INTACT', newBag: true, checkedBy: 'OP1' });
    expect(r({ newBag: true, result: 'DAMAGED' }).refused).toBe('Filter bag BAG-1 is damaged; fit another bag (TB05-BAG-DAMAGED; IN-36)');
    expect(r({ newBag: true }, { ...CFG, dryer: 'TRAY' }).refused).toBe('p is not a fluid-bed drying (TB05-NO-BAG; IN-36)');
  });

  it('[IN-36][PR-27] where the MBR asks for dedicated bags, the bag is dedicated to this product (its history then optional)', () => {
    const ded = { ...CFG, dedicatedBags: true };
    const r = (extra: Json) => new World(ded).rec(bag('BEFORE', extra));
    expect(r({}).refused).toBe('The MBR asks for a filter bag dedicated to PROD-A; BAG-1 is not dedicated (TB05-BAG-DEDICATED; IN-36, PR-27)');
    expect(r({ dedicatedTo: 'PROD-B' }).refused).toBe('The MBR asks for a filter bag dedicated to PROD-A; BAG-1 is dedicated to PROD-B (TB05-BAG-DEDICATED; IN-36, PR-27)');
    expect(r({ dedicatedTo: 'PROD-A' }).data).toStrictEqual({ bag: 'BAG-1', when: 'BEFORE', result: 'INTACT', dedicatedTo: 'PROD-A', checkedBy: 'OP1' });
    expect(new World().rec(bag('BEFORE', { newBag: true, dedicatedTo: 'PROD-Z' })).data).toMatchObject({ dedicatedTo: 'PROD-Z' });
  });

  it('[IN-36][PR-27] after use: the same bag, once, naming only what was found; damaged holds with its title', () => {
    const w = new World();
    expect(w.rec(bag('AFTER')).refused).toBe('Check the filter bag of p@ before use first (TB05-BAG-ORDER; IN-36)');
    w.rec(bag('BEFORE', { newBag: true }));
    expect(w.rec(bag('BEFORE', { newBag: true })).refused).toBe('p@ already checked its filter bag before use (TB05-BAG-TWICE; IN-36)');
    expect(w.rec(bag('AFTER', { bag: 'BAG-2' })).refused).toBe('The bag checked after use is the one checked before use (BAG-1) (TB05-BAG-ORDER; IN-36)');
    for (const extra of [{ lastProduct: 'X' }, { newBag: true }, { washRecord: 'W' }, { dedicatedTo: 'X' }]) expect(w.rec(bag('AFTER', extra)).refused, JSON.stringify(extra)).toBe('The check after use names only the bag and what was found (TB05-BAG-ORDER; IN-36)');
    const d = w.rec(bag('AFTER', { result: 'DAMAGED' }));
    expect(d.data).toStrictEqual({ bag: 'BAG-1', when: 'AFTER', result: 'DAMAGED', checkedBy: 'OP1' });
    expect(d.exceptions).toEqual([
      { type: 'FILTER_BAG_FAILED', title: 'Filter bag BAG-1 of p@ was found damaged after use: the steps after it wait for a deviation', controls: ['IN-36', 'PR-27'], severity: 'ACTION', category: 'DEVIATION_OR_OVERRIDE', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true, item: 'BAG-1' },
    ]);
    expect(w.rec(bag('AFTER')).refused).toBe('p@ already checked its filter bag after use (TB05-BAG-TWICE; IN-36)');
    const intact = new World();
    intact.rec(bag('BEFORE', { newBag: true }));
    expect(intact.rec(bag('AFTER')).exceptions).toBeUndefined();
  });
});

describe('TB-05 drying and the LOD sample', () => {
  it('[IN-36][PR-29][DI-29] drying starts once (after the bag check of a fluid bed) and ends once with its time; the LOD sample once, after drying', () => {
    const w = new World();
    expect(w.rec({ kind: 'DRYING_END' }).refused).toBe('p@ has not started drying (TB05-NOT-STARTED; IN-36)');
    expect(w.rec({ kind: 'DRYING_START' }).refused).toBe('Check the filter bag of p@ before drying (TB05-BAG-UNCHECKED; IN-36, PR-27)');
    w.rec(bag('BEFORE', { newBag: true }));
    expect(w.rec({ kind: 'DRYING_START' }).data).toStrictEqual({ startedBy: 'OP1' });
    expect(w.rec({ kind: 'DRYING_START' }).refused).toBe('p@ already started drying (TB05-DRYING-TWICE; IN-36)');
    expect(w.rec({ kind: 'LOD_SAMPLE', analyser: 'MA-1', sampleMass: { value: '5', unit: 'g' } }).refused).toBe('The LOD sample of p@ is taken after drying (TB05-SAMPLE-EARLY; IN-36, PR-29)');
    w.now = T + 1_500_000n;
    expect(w.rec({ kind: 'DRYING_END' }).data).toStrictEqual({ dryingSeconds: '1.500000', endedBy: 'OP1' });
    expect(w.rec({ kind: 'DRYING_END' }).refused).toBe('p@ already ended drying (TB05-DRYING-TWICE; IN-36)');
    expect(w.rec({ kind: 'LOD_SAMPLE', analyser: 'MA-1', sampleMass: { value: '5', unit: 'g' } }).data).toStrictEqual({ analyser: 'MA-1', sampleMass: { value: '5', unit: 'g' }, sampledBy: 'OP1' });
    expect(w.rec({ kind: 'LOD_SAMPLE', analyser: 'MA-1' }).refused).toBe('p@ already records its LOD sample; a new iteration takes the next (TB05-SAMPLE-TWICE; DI-29)');
    expect(new World({ ...CFG, dryer: 'TRAY' }).rec({ kind: 'DRYING_START' }).data).toStrictEqual({ startedBy: 'OP1' });
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a drying step (TB05-ENTRY; IN-36)');
  });

  it('[IN-36][PR-27][PR-29] PERFORMED: dried, sampled, and the bag checked after use (fluid bed only)', () => {
    const before = (x: World) => (TB05.handler?.beforePerform?.bind(TB05.handler) as unknown as (v: blocks.HandlerView) => { message: string }[])(x.view()).map((p) => p.message).filter((m) => m.includes('TB05-'));
    const w = new World();
    expect(before(w)).toEqual(['p@ has not finished drying (TB05-NOT-DRIED; IN-36)', 'p@ has no LOD sample (TB05-NO-SAMPLE; IN-36, PR-29)', 'Check the filter bag of p@ after use (TB05-BAG-AFTER-MISSING; IN-36, PR-27)']);
    expect(before(new World({ ...CFG, dryer: 'TRAY' }))).toEqual(['p@ has not finished drying (TB05-NOT-DRIED; IN-36)', 'p@ has no LOD sample (TB05-NO-SAMPLE; IN-36, PR-29)']);
    w.rec(bag('BEFORE', { newBag: true }));
    w.rec({ kind: 'DRYING_START' });
    w.rec({ kind: 'DRYING_END' });
    w.rec({ kind: 'LOD_SAMPLE', analyser: 'MA-1' });
    w.rec(bag('AFTER'));
    expect(before(w)).toEqual([]);
  });
});

describe('TB-05 definition checks', () => {
  const P = (mbr: flow.MbrContent): string[] => {
    const find = (n: flow.FlowNode): flow.PhaseNode | undefined => (n.kind === 'phase' ? (n.id === 'p' ? n : undefined) : 'children' in n ? n.children.map(find).find(Boolean) : 'body' in n && n.body ? find(n.body) : undefined);
    const p = find(mbr.procedure.body) as flow.PhaseNode;
    const chk = TB05.checkConfig?.bind(TB05) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return chk(p, p.config as Json, mbr).filter((x) => x.code.startsWith('TB05')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  const withLoop = (max: number, config: Json = CFG, records = ['lod']) => {
    const m = blockMbr(TB05, fixturePhase(TB05, { records, config: config as never }));
    return JSON.parse(JSON.stringify(m).replace('"maxIterations":3', `"maxIterations":${max}`)) as flow.MbrContent;
  };
  it('[IN-36][PR-29][PR-08][DI-34] the LOD a decimal process end point the step records with an upper limit; a bounded loop on it (1 to 10); dedicated bags only on a fluid bed', () => {
    expect(P(withLoop(3))).toEqual([]);
    const lodItem = 'TB05-LOD-ITEM [IN-36,PR-29] Drying step p records its LOD as a decimal process end point (lodItem)';
    expect(P(withLoop(3, { ...CFG, lodItem: undefined }))).toEqual([lodItem, 'TB05-NO-LOOP [IN-36,DI-34] Drying step p sits in a bounded loop that exits on its LOD']);
    expect(P(withLoop(3, CFG, []))).toEqual([lodItem]);
    const param = (over: Json) => {
      const m = withLoop(3);
      return P({ ...m, parameters: m.parameters.map((x) => (x.id === 'lod' ? ({ ...x, ...over }) : x)) });
    };
    expect(param({ valueType: 'INTEGER' })).toEqual([lodItem]);
    expect(param({ role: 'PROCESS_PARAMETER' })).toEqual([lodItem]);
    expect(param({ limits: undefined })).toEqual(['TB05-LOD-LIMITS [IN-36,PR-08] The LOD of drying step p has no upper limit']);
    expect(param({ limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '1', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } })).toEqual(['TB05-LOD-LIMITS [IN-36,PR-08] The LOD of drying step p has no upper limit']);
    expect(P(withLoop(TB05_MAX_ITERATIONS))).toEqual([]);
    expect(P(withLoop(11))).toEqual(['TB05-ITERATIONS [IN-36,DI-34] The drying loop of p allows 11 iterations; the block allows 1 to 10']);
    expect(P(withLoop(0))).toEqual(['TB05-ITERATIONS [IN-36,DI-34] The drying loop of p allows 0 iterations; the block allows 1 to 10']);
    expect(P(withLoop(3, { ...CFG, dryer: 'TRAY', dedicatedBags: true }))).toEqual(['TB05-NO-BAG [IN-36] Tray drying step p has no filter bag to dedicate']);
    expect(P(withLoop(3, { ...CFG, dedicatedBags: true }))).toEqual([]);
    expect(lodLoopOf(withLoop(3), 'p', 'other')).toBeUndefined();
  });
});
