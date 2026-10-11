/**
 * The golden batch GB-T-01 (outline 9.1 "Golden batches"; Phase 3 slice 6d; D-S6-5 to D-S6-7).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { routes } from '@ebmr/api-contract';
import { goldenClockAvailable } from '../clock.ts';
import { startGoldenWorld, type GoldenWorld } from './world.ts';
import { setUpPlant } from './plant.ts';
import { planAll, runSource, runVariant, SOURCE_AGE_MINUTES } from './scenario.ts';
import { advanceMinutes, FAKETIME_FILE, freezeAt } from '../clock.ts';
import { resultsOf } from './results.ts';
import { masterNegatives } from './negatives.ts';
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
    // The next run starts on a running clock again (this cluster's databases are dropped with the run).
    writeFileSync(FAKETIME_FILE, '+0s\n');
  });

  it('the approved master is effective for the seeded ERP orders in planning', async () => {
    const orders = valueOf(await w.b['issuer']!.call(routes.planning.orders)).orders.filter((o) => o.productCode === 'GBT01-250');
    expect(orders.map((o) => [o.orderNo, o.match?.versionId ?? o.noMatch])).toEqual([
      ['PO-GBT01-0001', w.versionId],
      ['PO-GBT01-0002', w.versionId],
    ]);
  });

  it('sample data negatives', async () => {
    const n = await masterNegatives(w);
    const { writeFileSync: wf } = await import('node:fs');
    wf('/tmp/claude-0/-home-user-ebmr/069a1e16-0f7a-5192-adea-7d43d4522c15/scratchpad/gb/negatives.json', JSON.stringify({ n, checks: w.masterChecks }, null, 1));
  }, 600_000);

  it('runs the scenario', async () => {
    const p = await planAll(w);
    const start = BigInt(Math.floor(Date.now() / 1000 / 3600) + 2) * 3600n;
    freezeAt(start);
    const { residue } = await runSource(w, p.source);
    advanceMinutes(SOURCE_AGE_MINUTES);
    await runVariant(w, p.happy, 'HAPPY', residue);
    await runVariant(w, p.exception, 'EXCEPTION_RICH', residue);
    const numbers = [p.happy.batchNumber, p.exception.batchNumber, p.source.batchNumber];
    const notes = { happy: p.happy.notes, exception: p.exception.notes };
    const out = { notes, happy: await resultsOf(w, p.happy.batchId, numbers), exception: await resultsOf(w, p.exception.batchId, numbers), source: await resultsOf(w, p.source.batchId, numbers) };
    const { writeFileSync } = await import('node:fs');
    writeFileSync('/tmp/claude-0/-home-user-ebmr/069a1e16-0f7a-5192-adea-7d43d4522c15/scratchpad/gb/results.json', JSON.stringify(out, null, 1));
  }, 3_600_000);
});
