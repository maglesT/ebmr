/**
 * Review reproducer F47: the drift decision ignores measurement uncertainty.
 *
 * platform.record_drift_check (kernel 0520) marks a sample within_threshold when
 * abs(offset_s) <= threshold_s; uncertainty_s is stored but never used. The monitor
 * (src/time/drift-monitor.ts measureReference) estimates the offset as the midpoint of two node-clock
 * reads around the reference read, with half the bracket as uncertainty, and the default read timeout
 * is 5 s against a default 1 s threshold. A slow reference read therefore produces a sample whose
 * uncertainty exceeds the threshold (it proves nothing about the offset), yet it counts as healthy:
 * it clears DRIFT_EXCEEDED (ends the fault window) and becomes the node's "last good sample".
 *
 * Scenario (finding's failure scenario, driven through the real monitor path runDriftCheck):
 *   1. Healthy check on node db-uncertain (last good sample).
 *   2. The node clock is truly 1.8 s ahead of both references: the next check raises DRIFT_EXCEEDED.
 *   3. The node is STILL 1.8 s ahead, but both reference reads are slow (~3 s round trip) and each
 *      reference returns its time at the end of the bracket (as a server answering at resolution
 *      does). The monitor measures offset ~0.3 s with uncertainty ~1.5 s for both sources.
 *   4. An operator records an entry after that check.
 *
 * Positive control: the readings of step 3 really are |offset| < threshold and uncertainty > threshold,
 * so the scenario is the one described (and the true offset of 1.8 s is inside offset +/- uncertainty).
 *
 * Safe behaviour asserted (DI-27, outline 5.6 "Drift and monotonicity"): a sample whose uncertainty
 * exceeds the threshold is not evidence that the clock is within tolerance, so
 *   - it is not stored as within_threshold (so it cannot become the last good sample),
 *   - it does not clear the open DRIFT_EXCEEDED alarm (the fault window stays open),
 *   - an entry recorded afterwards, while the clock is still 1.8 s off, is flagged TIME_FAULT_WINDOW
 *     and is listed for review with the DRIFT_EXCEEDED alarm.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { nodeClock, runDriftCheck, type TimeReference } from '../../src/time/drift-monitor.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, registerValidatedTimeSource, testActor } from '../platform/helpers.ts';

let db: TestDatabase;
let system: ActorContext;
let operator: ActorContext;
let npl = '';
let nic = '';

const TRUE_SKEW_MICROS = 1_800_000n; // the node is truly 1.8 s ahead of the references
const SLOW_READ_MS = 3000; // round trip of a slow reference read (below the default 5 s timeout)

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

async function registerSource(name: string, reference: string): Promise<string> {
  // Set-up corrected for the fix of F49: a source is registered by one person and confirmed by the
  // named validator, another person (kernel 0520).
  const registrant = await testActor(db, { roleCode: 'CSV_DI_LEAD' });
  const validator = await testActor(db, { roleCode: 'CSV_DI_LEAD' });
  return registerValidatedTimeSource(db, registrant, validator, name, reference);
}

/** A reference whose clock is `skewMicros` behind the node, answering at once. */
function reference(sourceId: string, skewMicros: bigint): TimeReference {
  return { sourceId, read: async () => (await nodeClock(db.app)).plusMicros(-skewMicros) };
}

/**
 * A reference whose clock is `skewMicros` behind the node, whose answer arrives after `delayMs` and
 * whose timestamp is taken at the end of the round trip (true reference time at that moment).
 */
function slowReference(sourceId: string, skewMicros: bigint, delayMs: number): TimeReference {
  return {
    sourceId,
    read: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return (await nodeClock(db.app)).plusMicros(-skewMicros);
    },
  };
}

async function check(node: string, references: TimeReference[]) {
  // Default monitor timeout (5000 ms), as in production wiring.
  return runDriftCheck(db.app, { node, actor: system, references });
}

async function openAlarms(node: string) {
  return rows<{ id: string; kind: string }>(
    `select a.id, a.kind from platform.alarm a
      where a.subject = $1 and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id) order by a.recorded_at`,
    [node],
  );
}

async function newEntry(batchId: string): Promise<{ id: string; review_flags: string[] }> {
  return withCommand(db.app, operator, async (c) => {
    const step = await c.query<{ id: string }>('insert into platform.stub_step (batch_id) values ($1) returning id', [batchId]);
    const { rows: r } = await c.query<{ id: string; review_flags: string[] }>(
      "insert into platform.stub_step_entry (step_id, item_no, value, unit) values ($1, 1, '12.503', 'kg') returning id, review_flags",
      [step.rows[0]?.id],
    );
    return r[0] as { id: string; review_flags: string[] };
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'CSV_DI_LEAD', 'platform.time_source.manage', 'platform.time_source.validate', 'platform.alarm.clear');
  await grantPermission(db, 'SERVICE_ACCOUNT', 'platform.time_check.record');
  npl = await registerSource('NPL India NTP', 'NPL India, traceable to UTC(NPLI)');
  nic = await registerSource('NIC NTP', 'NIC time service, traceable to NPL India');
  system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'Time monitor' });
  operator = await testActor(db);
});
afterAll(async () => {
  await db.drop();
});

describe('F47 drift decision and measurement uncertainty', () => {
  it('[DI-27] a sample whose uncertainty exceeds the threshold does not clear DRIFT_EXCEEDED nor count as the last good sample', async () => {
    const node = 'db-uncertain';
    const batchId = randomUUID();

    // 1. Healthy check: last good sample.
    const healthy = await check(node, [reference(npl, 20_000n), reference(nic, -30_000n)]);
    expect(healthy.raised).toEqual([]);

    // 2. The node is truly 1.8 s ahead: DRIFT_EXCEEDED is raised.
    const drifted = await check(node, [reference(npl, TRUE_SKEW_MICROS), reference(nic, TRUE_SKEW_MICROS)]);
    expect(drifted.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    const alarmId = drifted.raised[0]?.alarmId ?? '';
    expect((await openAlarms(node)).map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);

    // 3. Still 1.8 s ahead, but both reads are slow and answer at the end of the bracket.
    const uncertain = await check(node, [
      slowReference(npl, TRUE_SKEW_MICROS, SLOW_READ_MS),
      slowReference(nic, TRUE_SKEW_MICROS, SLOW_READ_MS),
    ]);
    const thresholdMicros = BigInt(Math.round(Number(uncertain.thresholdSeconds) * 1_000_000));
    // Positive control: every reading the monitor reports as reachable has |offset| below the
    // threshold, an uncertainty above it, and the true 1.8 s offset inside offset +/- uncertainty.
    // (A monitor that sizes its timeout from the threshold may instead report the reads as
    // unreachable; that is also a safe outcome and is checked by the assertions below.)
    for (const r of uncertain.readings) {
      if (!r.reachable) continue;
      const off = r.offsetMicros ?? 0n;
      const unc = r.uncertaintyMicros ?? 0n;
      const absOff = off < 0n ? -off : off;
      expect(absOff < thresholdMicros).toBe(true);
      expect(unc > thresholdMicros).toBe(true);
      expect(off - unc <= TRUE_SKEW_MICROS && TRUE_SKEW_MICROS <= off + unc).toBe(true);
    }

    const samples = await rows<{ source_id: string; reachable: boolean; offset_s: string | null; uncertainty_s: string | null; within_threshold: boolean }>(
      'select source_id, reachable, offset_s::text, uncertainty_s::text, within_threshold from platform.drift_sample where check_id = $1 order by source_id',
      [uncertain.checkId],
    );
    const [lastGood] = await rows<{ check_id: string }>(
      'select check_id::text from platform.drift_sample where node = $1 and within_threshold order by recorded_at desc limit 1',
      [node],
    );

    // 4. An entry recorded after that check, while the node is still 1.8 s off.
    const after = await newEntry(batchId);
    const listed = await rows<{ record_id: string }>(
      'select record_id from platform.entries_in_time_fault_windows() where alarm_id = $1 and chain_key = $2 and table_name = $3',
      [alarmId, `batch:${batchId}`, 'platform.stub_step_entry'],
    );

    const observed = {
      clearedByUncertainCheck: uncertain.cleared.map((a) => a.kind),
      openAlarms: (await openAlarms(node)).map((a) => a.kind),
      uncertainSamplesWithinThreshold: samples.map((s) => s.within_threshold),
      lastGoodSampleIsUncertainCheck: lastGood?.check_id === uncertain.checkId,
      entryAfterwardFlagged: after.review_flags.includes('TIME_FAULT_WINDOW'),
      entryAfterwardListedForAlarm: listed.map((l) => l.record_id).includes(after.id),
    };
    // Reproducer corrected (see the positive control above): a check whose readings prove nothing
    // leaves no usable reference, so besides keeping DRIFT_EXCEEDED open it raises REFERENCE_LOST,
    // exactly as reads reported unreachable do. The original expectation listed DRIFT_EXCEEDED
    // alone, which even the outcome the comment above calls safe could not meet.
    expect(observed, `uncertain check samples: ${JSON.stringify(samples)}`).toEqual({
      clearedByUncertainCheck: [],
      openAlarms: ['DRIFT_EXCEEDED', 'REFERENCE_LOST'],
      uncertainSamplesWithinThreshold: [false, false],
      lastGoodSampleIsUncertainCheck: false,
      entryAfterwardFlagged: true,
      entryAfterwardListedForAlarm: true,
    });
  });
});
