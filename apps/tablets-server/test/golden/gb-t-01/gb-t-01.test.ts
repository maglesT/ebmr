/**
 * The golden batch GB-T-01 (outline 9.1 "Golden batches"; Phase 3 slice 6d; D-S6-5 to D-S6-7).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { goldenClockAvailable } from '../clock.ts';
import { startGoldenWorld, type GoldenWorld } from './world.ts';
import { setUpPlant } from './plant.ts';
import { planAll, runSource, runVariant, SOURCE_AGE_MINUTES } from './scenario.ts';
import { advanceMinutes } from '../clock.ts';
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

  it('runs the scenario', async () => {
    const p = await planAll(w);
    const { residue } = await runSource(w, p.source);
    advanceMinutes(SOURCE_AGE_MINUTES);
    await runVariant(w, p.happy, 'HAPPY', residue);
    const v = await p.happy.view();
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/claude-0/-home-user-ebmr/069a1e16-0f7a-5192-adea-7d43d4522c15/scratchpad/gb/view.json', JSON.stringify({ header: v.header.status, stages: v.stages.map((s) => ({ k: s.stageKey, st: s.status })), exceptions: v.exceptions.map((e) => `${e.exceptionId} ${e.type} ${e.severity} ${e.status} ${e.blocking}`) }, null, 1));
    await runVariant(w, p.exception, 'EXCEPTION_RICH', residue);
  }, 3_600_000);
});
