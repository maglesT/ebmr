/**
 * The golden batch GB-T-02 (outline 9.1 "Golden batches"; Phase 4 slice 7b; D-P4-15, D-S6-7): an invented direct
 * compression product (decision 0006 part 3) dispensed, blended and compressed into bulk containers on a frozen database
 * clock, packed in HDPE bottles, reviewed, tested, sampled and released by the AP for India; then the US added to the
 * released lot after its batch consumed a cellulose lot released on the India-only vendor-history route: the market-add
 * evaluation, signed and stored with the addition, is UNMET_FINAL on the recorded evidence (INELIGIBLE) and the US
 * disposition is refused. Every output must equal expected.json: the hand worksheet's quantities and yields (README.md,
 * never changed to make a run pass), and the states, exceptions, genealogy, signature counts and the hashes of the
 * normalised true copies recorded from the first reviewed run.
 *
 * Set EBMR_GOLDEN_DUMP to a file path to write the run's outputs there (for a review of a changed run).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Dec } from '@ebmr/expr';
import { FAKETIME_FILE, freezeAt, goldenClockAvailable } from '../clock.ts';
import { setUpPlant } from '../gb-t-01/plant.ts';
import { resultsOf, type BatchResults } from '../gb-t-01/results.ts';
import { startGoldenWorld, type GoldenWorld } from '../gb-t-01/world.ts';
import { lotFacts, orderFacts, type LotFacts, type OrderFacts } from '../gb-t-01/release-results.ts';
import { BLEND, BOTTLE_PLAN, COMPRESSION, packAndRelease, runBatch, setUpGbt02, type Gbt02Release } from './scenario.ts';

type Json = Record<string, unknown>;
const expected = JSON.parse(readFileSync(new URL('./expected.json', import.meta.url), 'utf8')) as Json & {
  worksheet: Json & { dispensing: Record<string, string>; blending: Record<string, string>; compression: Record<string, string>; bottling: Record<string, string> };
  fromTheRun: { batch: Json; order: Json; lot: Json; usAdd: Json };
};

describe.runIf(goldenClockAvailable)('GB-T-02, direct compression in HDPE bottles, and the US added after vendor history', () => {
  let w: GoldenWorld;
  const run: { batch?: BatchResults; order?: BatchResults; orderFacts?: OrderFacts; lot?: LotFacts; rel?: Gbt02Release } = {};
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    w = await startGoldenWorld();
    await setUpPlant(w);
  }, 1_800_000);
  afterAll(async () => {
    vi.useRealTimers();
    await w?.close();
    writeFileSync(FAKETIME_FILE, '+0s\n');
  });

  it('runs the batch, the bottle order and the release, then adds the US to the released lot', async () => {
    const masters = await setUpGbt02(w);
    // The next midnight UTC, or EBMR_GOLDEN_LATER_DAYS whole days after it (to show the hashes do not depend on the day).
    const later = Number(/^\d{1,4}$/.test(process.env['EBMR_GOLDEN_LATER_DAYS'] ?? '') ? process.env['EBMR_GOLDEN_LATER_DAYS'] : '0');
    const start = BigInt(Math.floor(Date.now() / 1000 / 86_400) + 1 + later) * 86_400n;
    freezeAt(start);
    const { batch, bulk } = await runBatch(w, masters);
    const rel = await packAndRelease(w, masters, batch, bulk);
    const numbers = [batch.batchNumber, rel.order.batchNumber];
    run.batch = await resultsOf(w, batch.batchId, numbers, start * 1_000_000n);
    run.order = await resultsOf(w, rel.order.batchId, numbers, start * 1_000_000n);
    run.orderFacts = await orderFacts(w, rel.order.batchId);
    run.lot = await lotFacts(w, rel.lot.lotId, numbers);
    run.rel = rel;
    const dump = process.env['EBMR_GOLDEN_DUMP'];
    if (dump) writeFileSync(dump, JSON.stringify({ batch: run.batch, order: run.order, orderFacts: run.orderFacts, lot: run.lot, rel: { ...rel, order: rel.order.batchNumber } }, null, 1));
    expect(run.batch.states.batch).toBe('EXECUTION_COMPLETE');
    expect(run.order.states.batch).toBe('EXECUTION_COMPLETE');
  }, 3_600_000);

  const r = (k: 'batch' | 'order'): BatchResults => {
    const x = run[k];
    if (!x) throw new Error('the scenario did not run');
    return x;
  };
  const same = (a: string | string[] | undefined, b: string): boolean => Dec.parse(String(a)).eq(Dec.parse(b));
  const asShown = (v: string | string[] | undefined, shown: string): string => Dec.parse(String(v)).toFixed(shown.includes('.') ? shown.length - shown.indexOf('.') - 1 : 0, 'HALF_UP');

  it('[IN-17][PR-31] dispenses, blends and compresses the worksheet\'s quantities, with its yields', () => {
    const v = r('batch').values;
    const ws = expected.worksheet;
    for (const [item, net] of Object.entries(ws.dispensing)) expect(same(v[`${item}@p-disp-exc@`], net), item).toBe(true);
    expect(same(v['blendNet@p-blend-out@'], BLEND)).toBe(true);
    expect(asShown(v['dispRecon@p-disp-recon@'], ws.blending['dispRecon'] ?? '')).toBe(ws.blending['dispRecon']);
    expect(asShown(v['blendYield@p-blend-yield@'], ws.blending['blendYield'] ?? '')).toBe(ws.blending['blendYield']);
    const c = ws.compression;
    expect([v['compGood@p-comp-yield@'], v['compResidue@p-comp-yield@'], v['compRejects@p-comp-yield@']].map((x, i) => same(x, [COMPRESSION.good, COMPRESSION.residue, COMPRESSION.rejects][i] ?? ''))).toEqual([true, true, true]);
    for (const k of ['compT', 'compYield', 'compYieldAB', 'compAcc', 'coresNet']) {
      const key = k === 'coresNet' ? 'coresNet@p-comp-out@' : `${k}@p-comp-yield@`;
      expect(k === 'compT' || k === 'coresNet' ? same(v[key], c[k] ?? '') : asShown(v[key], c[k] ?? '') === c[k], k).toBe(true);
    }
  });

  it('[IN-17][PR-39][PR-37][PR-38] packs the worksheet\'s bottles: labels and cartons reconciled with nothing unexplained, the packaging yield, the shippers', () => {
    const v = r('order').values;
    const b = expected.worksheet.bottling;
    expect(asShown(v['packYield@p-pk-yield@'], b['packYield'] ?? '')).toBe(b['packYield']);
    expect(same(v['tabletsIssued@p-pk-count@'], BOTTLE_PLAN.tabletsIssued)).toBe(true);
    expect(same(v['tabletsPacked@p-pk-count@'], BOTTLE_PLAN.tabletsPacked)).toBe(true);
    expect(run.orderFacts?.shipperPacks).toBe(b['packs']);
    expect(Array.isArray(run.orderFacts?.bulkIssued)).toBe(true);
  });

  it('[PR-45][IN-05][INV-05] the finished lot is released for India through G-REL green and the AP\'s signed release', () => {
    expect(run.rel?.decision).toBe('RELEASED');
    expect(run.lot).toEqual(expected.fromTheRun.lot);
  });

  it('[INV-43][IN-24][PR-56] the US added after the vendor-history lot was consumed is INELIGIBLE on the recorded evidence, and the US disposition is refused', () => {
    expect({ evaluation: run.rel?.usAdd, disposition: run.rel?.usDisposition, usDispose: run.rel?.usDispose }).toEqual(expected.fromTheRun.usAdd);
  });

  it.each(['batch', 'order'] as const)('the %s ends in the expected states, exceptions, genealogy, signatures and true-copy hash', (k) => {
    const x = r(k);
    const want = expected.fromTheRun[k];
    const notCompleted = Object.entries(x.states.steps).filter(([, s]) => s !== 'COMPLETED').map(([s, st]) => `${s} ${st}`);
    expect({ batch: x.states.batch, stages: x.states.stages, containers: x.states.containers, notCompleted }).toEqual(want['states']);
    expect(x.genealogy.consumptions).toEqual(want['consumptions']);
    expect(x.genealogy.containers).toEqual(want['containers']);
    expect(x.exceptions.map((e) => `${e.type} ${e.severity} ${e.disposition ?? e.status}`)).toEqual(want['exceptions']);
    expect(x.signatures).toBe(want['signatures']);
    expect(x.trueCopy.sha256).toBe(want['normalisedTrueCopySha256']);
  });
});
