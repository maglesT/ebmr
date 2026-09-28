/**
 * Review reproducer F48: platform.record_drift_check aborts instead of alarming for extreme
 * offsets and for thresholds with more than 3 decimals (kernel 0520; control DI-27).
 *
 * platform.drift_sample stores offset_s as numeric(14,6) (|value| < 1e8 s) and threshold_s as
 * numeric(6,3), while record_drift_check computes within_threshold / the exceedance count from the
 * unrounded values, and the table check
 *   within_threshold = (reachable and abs(offset_s) <= threshold_s)
 * is evaluated on the rounded stored values. When the insert fails the whole check rolls back:
 * no sample, no DRIFT_EXCEEDED alarm, no data-integrity incident request.
 *
 * Scenarios (safe behaviour asserted, DI-27 "an offset above the threshold raises an alarm and an
 * incident"):
 *   (a) The node clock is reset to 1970 (RTC fault): the monitor measures an offset of about
 *       -1.79e9 s against both references and submits it as a normal 6-decimal string. The check
 *       must be recorded and must raise DRIFT_EXCEEDED with an incident request.
 *   (b) A PROCESS_OWNER sets time.drift_alarm_threshold_s to '0.1235' (accepted DECIMAL within
 *       0.1-5). Either the setting is refused (limited to 3 decimals), or a reading of 0.123800 s
 *       (above the configured 0.1235 s) is recorded as outside the threshold and raises
 *       DRIFT_EXCEEDED.
 *   (c) An offset with more than 6 decimals just above the threshold (1.0000004 s vs 1 s) is either
 *       refused with a coded validation error, or recorded as exceeded with an alarm - never a raw
 *       check-constraint abort.
 * Positive controls show the harness raises DRIFT_EXCEEDED for storable offsets.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { nodeClock, runDriftCheck, type TimeReference } from '../../src/time/drift-monitor.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, registerValidatedTimeSource, testActor } from '../platform/helpers.ts';

let db: TestDatabase;
let system: ActorContext;
let npl = '';
let nic = '';

const SECOND = 1_000_000n;

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

/** A reference whose clock is `skewMicros` behind the database node (the node is ahead by that much). */
function reference(sourceId: string, skewMicros: bigint): TimeReference {
  return { sourceId, read: async () => (await nodeClock(db.app)).plusMicros(-skewMicros) };
}

async function check(node: string, references: TimeReference[]) {
  return runDriftCheck(db.app, { node, actor: system, references, timeoutMs: 2000 });
}

interface Summary {
  check_id: string;
  threshold_s: string;
  sources_over_threshold: number;
  raised: { kind: string; alarm_id: string }[];
}

/** Submits exact readings, as the monitor does (decimal strings), through the SYSTEM identity. */
async function submit(node: string, samples: unknown[]): Promise<Summary> {
  return withCommand(db.app, system, async (c) => {
    const { rows: r } = await c.query<{ summary: Summary }>('select platform.record_drift_check($1, $2::jsonb) as summary', [
      node,
      JSON.stringify(samples),
    ]);
    return r[0]?.summary as Summary;
  });
}

async function openAlarmKinds(node: string): Promise<string[]> {
  return (
    await rows<{ kind: string }>(
      `select a.kind from platform.alarm a
        where a.subject = $1 and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id) order by a.recorded_at`,
      [node],
    )
  ).map((a) => a.kind);
}

async function incidentRequests(node: string): Promise<number> {
  const [r] = await rows<{ n: string }>(
    "select count(*)::text as n from platform.outbox where topic = 'incident.requested' and payload ->> 'node' = $1 and payload ->> 'alarm_kind' = 'DRIFT_EXCEEDED'",
    [node],
  );
  return Number(r?.n ?? '0');
}

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'CSV_DI_LEAD', 'platform.time_source.manage', 'platform.time_source.validate', 'platform.alarm.clear');
  await grantPermission(db, 'PROCESS_OWNER', 'platform.settings.change');
  await grantPermission(db, 'SERVICE_ACCOUNT', 'platform.time_check.record');
  npl = await registerSource('NPL India NTP', 'NPL India, traceable to UTC(NPLI)');
  nic = await registerSource('NIC NTP', 'NIC time service, traceable to NPL India');
  system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'Time monitor' });
});
afterAll(async () => {
  await db.drop();
});

describe('F48 drift checks that cannot be recorded', () => {
  it('[DI-27] (a) a node clock reset to 1970 is recorded and raises DRIFT_EXCEEDED with an incident request', async () => {
    // Positive control: a large but storable offset (node 10 000 000 s behind) alarms normally.
    const control = await check('db-far-control', [reference(npl, -10_000_000n * SECOND), reference(nic, -10_000_000n * SECOND)]);
    expect(control.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);

    const node = 'db-rtc-reset';
    expect((await check(node, [reference(npl, 20_000n), reference(nic, -30_000n)])).raised).toEqual([]);

    // The node's RTC resets it to 1970: it is ~1.79e9 s behind both references.
    const skew = -1_790_000_000n * SECOND;
    let outcome: Awaited<ReturnType<typeof check>> | Error;
    try {
      outcome = await check(node, [reference(npl, skew), reference(nic, skew)]);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
    }
    // The monitor produced ordinary, well-formed readings (6-decimal strings) - the defect is in the database.
    expect(outcome instanceof Error ? `check aborted: ${outcome.message}` : 'recorded').toBe('recorded');
    const result = outcome as Awaited<ReturnType<typeof check>>;
    expect(result.sourcesOverThreshold).toBe(2);
    expect(result.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    expect(await openAlarmKinds(node)).toEqual(['DRIFT_EXCEEDED']);
    expect(await incidentRequests(node)).toBe(1);
    const samples = await rows<{ within_threshold: boolean }>('select within_threshold from platform.drift_sample where check_id = $1', [result.checkId]);
    expect(samples.map((s) => s.within_threshold)).toEqual([false, false]);
  });

  it('[DI-27] (b) a threshold of 0.1235 s is either refused or enforced: a 0.1238 s offset raises DRIFT_EXCEEDED', async () => {
    const owner = await testActor(db, { roleCode: 'PROCESS_OWNER', reasonCode: 'CHANGE_CONTROL', reasonText: 'CC-0048 tighter clock tolerance' });
    const set = (v: string) => withCommand(db.app, owner, (c) => c.query("select platform.set_setting('time.drift_alarm_threshold_s', $1)", [v]));
    let refused: Error | null = null;
    try {
      await set('0.1235');
    } catch (error) {
      refused = error instanceof Error ? error : new Error(String(error));
    }
    if (refused) {
      // Safe fix: the setting is limited to the precision the samples store.
      expect(refused.message).toContain('EBMR-PLAT-021');
      return;
    }
    try {
      // Positive control: an offset above both 0.1235 and its rounded 0.124 alarms normally.
      const control = await submit('db-band-control', [
        { source_id: npl, reachable: true, offset_s: '0.125000', uncertainty_s: '0.000100' },
        { source_id: nic, reachable: true, offset_s: '0.000000', uncertainty_s: '0.000100' },
      ]);
      expect(control.threshold_s).toBe('0.1235');
      expect(control.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);

      // 0.1238 s is above the configured 0.1235 s threshold.
      const node = 'db-band';
      let outcome: Summary | Error;
      try {
        outcome = await submit(node, [
          { source_id: npl, reachable: true, offset_s: '0.123800', uncertainty_s: '0.000100' },
          { source_id: nic, reachable: true, offset_s: '0.000000', uncertainty_s: '0.000100' },
        ]);
      } catch (error) {
        outcome = error instanceof Error ? error : new Error(String(error));
      }
      expect(outcome instanceof Error ? `check aborted: ${outcome.message}` : 'recorded').toBe('recorded');
      const result = outcome as Summary;
      expect(result.sources_over_threshold).toBe(1);
      expect(result.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
      expect(await openAlarmKinds(node)).toEqual(['DRIFT_EXCEEDED']);
      expect(await incidentRequests(node)).toBe(1);
      const [sample] = await rows<{ within_threshold: boolean }>(
        'select within_threshold from platform.drift_sample where check_id = $1 and source_id = $2',
        [result.check_id, npl],
      );
      expect(sample?.within_threshold).toBe(false);
    } finally {
      await set('1');
    }
  });

  it('[DI-27] (c) an offset with more than 6 decimals just above the threshold is refused with a coded error or alarmed, never a raw abort', async () => {
    const node = 'db-fine-offset';
    let outcome: Summary | Error;
    try {
      outcome = await submit(node, [
        { source_id: npl, reachable: true, offset_s: '1.0000004', uncertainty_s: '0.000100' },
        { source_id: nic, reachable: true, offset_s: '0.000000', uncertainty_s: '0.000100' },
      ]);
    } catch (error) {
      outcome = error instanceof Error ? error : new Error(String(error));
    }
    if (outcome instanceof Error) {
      // A coded validation refusal of the monitor's contract is acceptable; a check-constraint abort is not.
      expect(outcome.message).toContain('EBMR-PLAT-031');
      return;
    }
    expect(outcome.sources_over_threshold).toBe(1);
    expect(outcome.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    const [sample] = await rows<{ within_threshold: boolean }>(
      'select within_threshold from platform.drift_sample where check_id = $1 and source_id = $2',
      [outcome.check_id, npl],
    );
    expect(sample?.within_threshold).toBe(false);
  });
});
