/**
 * The golden batch GB-T-01 (outline 9.1 "Golden batches"; Phase 3 slice 6d; D-S6-5 to D-S6-7).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { goldenClockAvailable } from '../clock.ts';
import { startGoldenWorld, type GoldenWorld } from './world.ts';
import { setUpPlant } from './plant.ts';
import { dispensing, GoldenBatch, granulation } from './driver.ts';
import { blending, coating, compression, inspection } from './stages.ts';
import { valueOf } from '../../esig/support.ts';

describe.runIf(goldenClockAvailable)('GB-T-01, the tablets golden batch', () => {
  let w: GoldenWorld;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    w = await startGoldenWorld();
    await setUpPlant(w);
  }, 1_800_000);
  afterAll(async () => {
    vi.useRealTimers();
    await w?.close();
  });

  it('the approved master is effective for the seeded ERP orders in planning', async () => {
    const orders = valueOf(await w.b['issuer']!.call(routes.planning.orders)).orders.filter((o) => o.productCode === 'GBT01-250');
    expect(orders.map((o) => [o.orderNo, o.match?.versionId ?? o.noMatch])).toEqual([
      ['PO-GBT01-0001', w.versionId],
      ['PO-GBT01-0002', w.versionId],
    ]);
  });

  it('runs a batch', async () => {
    const g = await GoldenBatch.plan(w);
    await g.issue();
    await g.reserveLots({ 'MAT-EXZ-NA': '55.000', 'MAT-MCC-101': '8.000', 'MAT-LAC-MH': '14.000', 'MAT-PVP-K30': '2.400', 'MAT-IPA': '3.000', 'MAT-CCS': '2.400', 'MAT-SIO2': '0.400', 'MAT-MGST': '0.800', 'MAT-FCS-W': '2.450' });
    await dispensing(g);
    await granulation(g, { granules: ['38.600', '38.550'], lods: [['2.8'], ['4.1', '2.9']], extraIpa: [null, '0.300'] });
    const { blendLabel } = await blending(g, { addition: null, blend: '80.300' });
    await compression(g, { blendLabel, checks: { L: ['8205.0', '8198.0', '8201.0'], R: ['8202.0', '8196.0', '8204.0'] }, containers: { L: ['13.000', '13.000', '13.000'], R: ['13.000', '13.000', '13.000'] }, good: '78.000', residue: '0.600', rejects: '0.400' });
    await coating(g, { coreTotal: '8.2000', iterations: [{ total: '8.4401', minutes: 60 }], coated: '80.300' });
    await inspection(g, { inspected: { count: '190150', mass: '80.300' }, accepted: { count: '179000', mass: '75.600' }, destroyed: { count: '426', mass: '0.180' }, residue: { count: '10724', mass: '4.520' }, defects: [{ code: 'CHIPPED', count: '6000' }, { code: 'COLOUR-SPOT', count: '5150' }], aql: { MAJOR: '2', MINOR: '5' } });
    const v = await g.view();
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/claude-0/-home-user-ebmr/069a1e16-0f7a-5192-adea-7d43d4522c15/scratchpad/gb/view.json', JSON.stringify({ header: v.header.status, stages: v.stages.map((s) => ({ k: s.stageKey, st: s.status, steps: s.steps.map((x) => `${x.stepKey}:${x.status}`) })), exceptions: v.exceptions.map((e) => `${e.exceptionId} ${e.type} ${e.severity} ${e.status} ${e.blocking}`), actions: v.actions.map((a) => `${a.action}:${String(a.available)}`) }, null, 1));
  }, 1_800_000);
});
