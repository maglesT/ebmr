/**
 * The golden batch GB-T-01 (outline 9.1 "Golden batches"; Phase 3 slice 6d; D-S6-5 to D-S6-7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { goldenClockAvailable } from '../clock.ts';
import { startGoldenWorld, type GoldenWorld } from './world.ts';
import { valueOf } from '../../esig/support.ts';

describe.runIf(goldenClockAvailable)('GB-T-01, the tablets golden batch', () => {
  let w: GoldenWorld;
  beforeAll(async () => {
    w = await startGoldenWorld();
  }, 1_800_000);
  afterAll(async () => {
    await w?.close();
  });

  it('the approved master is effective for the seeded ERP orders in planning', async () => {
    const orders = valueOf(await w.b['issuer']!.call(routes.planning.orders)).orders.filter((o) => o.productCode === 'GBT01-250');
    expect(orders.map((o) => [o.orderNo, o.match?.versionId ?? o.noMatch])).toEqual([
      ['PO-GBT01-0001', w.versionId],
      ['PO-GBT01-0002', w.versionId],
    ]);
  });
});
