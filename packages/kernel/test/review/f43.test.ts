/**
 * Review reproducer F43: time-fault review windows are bounded by the faulty clock.
 *
 * platform.time_fault_windows (kernel 0520) takes window_start = alarm.window_start (the recorded_at
 * of the node's last within-threshold drift sample, platform.time_window_start) and window_end = the
 * clearance's recorded_at; platform.entries_in_time_fault_windows then selects audit events by
 * kernel.audit_event.recorded_at between the two. All three times come from the same database clock
 * whose fault is under review. When the fault appears or is corrected by a clock STEP, the entries
 * recorded across the step carry times outside [window_start, window_end] and drop out of the DI-27
 * review list.
 *
 * The test database cannot move the server clock, so the step is simulated the way the finding's
 * suggested test does it: the real product path records everything (drift checks through
 * platform.record_drift_check as the time monitor, entries through platform.stub_step_entry as an
 * operator), and a superuser set-up (triggers disabled for that transaction only) then rewrites the
 * recorded_at values that the stepped node clock would have produced for the rows written while the
 * clock was wrong: kernel.audit_event, platform.drift_sample and platform.alarm. Rows recorded before
 * the step (the last good sample) and after the correction (the clearance) keep true times.
 *
 * Scenario A (backward step, finding steps 1-6):
 *   1. A healthy check on node db-step-back (last good sample L).
 *   2. The node clock steps back 1 h.
 *   3. An operator records entry E1 (audit recorded_at ~ L - 1 h).
 *   4. The next check sees offset -3600 s and raises DRIFT_EXCEEDED (window_start = L).
 *   5. The operator records entry E2 during the alarm.
 *   6. The clock is corrected and a healthy check clears the alarm.
 * Scenario B (forward case): node db-step-fwd jumps 30 s ahead after a healthy check; the check sees
 * +30 s and raises DRIFT_EXCEEDED; entry E3 is recorded; NTP steps the clock back and the clearing
 * check runs at once, so window_end is earlier than E3's recorded_at.
 *
 * Positive control: before the step is applied (true times) the same entries are listed for the
 * open alarm, so the set-up is right and only the clock-stamped times make them disappear.
 *
 * Safe behaviour asserted (DI-27: entries made in a time-fault window are flagged for review;
 * INV-16): every entry recorded between the last good sample and the clearance of a time-fault
 * alarm is listed by platform.entries_in_time_fault_windows() for that alarm, whatever the faulty
 * clock stamped on it: E1 and E2 for the backward alarm, E3 for the forward alarm.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, testActor, withTriggersDisabled } from '../platform/helpers.ts';

let db: TestDatabase;
let system: ActorContext;
let operator: ActorContext;
let npl = '';
let nic = '';

async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await db.app.query<T>(text, params)).rows;
}

async function registerSource(name: string, reference: string): Promise<string> {
  const admin = await testActor(db, { roleCode: 'CSV_DI_LEAD' });
  return withCommand(db.app, admin, async (c) => {
    const { rows: r } = await c.query<{ id: string }>(
      "select platform.register_time_source($1, 'NTP', $2, $3, $4, 'VAL-TS-2026-001') as id",
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}.example`, reference, randomUUID()],
    );
    return r[0]?.id ?? '';
  });
}

interface DriftResult {
  check_id: string;
  raised: { kind: string; alarm_id: string }[];
  cleared: { kind: string; alarm_id: string }[];
}

/** One drift check as the time monitor; offsets in seconds (positive: node ahead of the reference). */
async function drift(node: string, nplOffset: string, nicOffset: string): Promise<DriftResult> {
  const samples = [
    { source_id: npl, reachable: true, offset_s: nplOffset, uncertainty_s: '0.000800' },
    { source_id: nic, reachable: true, offset_s: nicOffset, uncertainty_s: '0.000800' },
  ];
  return withCommand(db.app, system, async (c) => {
    const { rows: r } = await c.query<{ r: DriftResult }>('select platform.record_drift_check($1, $2::jsonb) as r', [node, JSON.stringify(samples)]);
    return r[0]?.r as DriftResult;
  });
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

async function dbClock(): Promise<string> {
  const [r] = await rows<{ t: string }>('select clock_timestamp()::text as t');
  return r?.t ?? '';
}

/**
 * Superuser set-up standing in for the stepped node clock: every row the node recorded after
 * `stepAt` (up to now, before the clock is corrected) gets the time the faulty clock would have
 * given it. Only the tables whose times the DI-27 window computation reads are rewritten.
 */
async function applyClockStep(stepAt: string, shift: string): Promise<void> {
  await withTriggersDisabled(db, async (c) => {
    await c.query('update kernel.audit_event set recorded_at = recorded_at + $2::interval where recorded_at > $1::timestamptz', [stepAt, shift]);
    await c.query('update platform.drift_sample set recorded_at = recorded_at + $2::interval where recorded_at > $1::timestamptz', [stepAt, shift]);
    await c.query('update platform.alarm set recorded_at = recorded_at + $2::interval where recorded_at > $1::timestamptz', [stepAt, shift]);
  });
}

async function listedFor(alarmId: string, batchId: string): Promise<string[]> {
  const r = await rows<{ record_id: string }>(
    'select record_id from platform.entries_in_time_fault_windows() where alarm_id = $1 and chain_key = $2 and table_name = $3',
    [alarmId, `batch:${batchId}`, 'platform.stub_step_entry'],
  );
  return r.map((x) => x.record_id).sort();
}

async function windowOf(alarmId: string): Promise<{ window_start: string; window_end: string | null }> {
  const [w] = await rows<{ window_start: string; window_end: string | null }>(
    'select window_start::text, window_end::text from platform.time_fault_windows() where alarm_id = $1',
    [alarmId],
  );
  return w as { window_start: string; window_end: string | null };
}

async function auditTimes(batchId: string): Promise<Record<string, string>> {
  const r = await rows<{ record_id: string; recorded_at: string }>(
    "select record_id, recorded_at::text from kernel.audit_event where chain_key = $1 and table_name = 'platform.stub_step_entry' order by seq",
    [`batch:${batchId}`],
  );
  return Object.fromEntries(r.map((x) => [x.record_id, x.recorded_at]));
}

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'CSV_DI_LEAD', 'platform.time_source.manage', 'platform.alarm.clear');
  await grantPermission(db, 'SERVICE_ACCOUNT', 'platform.time_check.record');
  npl = await registerSource('NPL India NTP', 'NPL India, traceable to UTC(NPLI)');
  nic = await registerSource('NIC NTP', 'NIC time service, traceable to NPL India');
  system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'Time monitor' });
  operator = await testActor(db);
});
afterAll(async () => {
  await db.drop();
});

describe('F43 time-fault review windows across a clock step', () => {
  it('[DI-27][INV-16] entries recorded across a backward or forward clock step are listed for review with their alarm', async () => {
    // ---- Scenario A: backward step of 1 h ----------------------------------------------------
    const nodeA = 'db-step-back';
    const batchA = randomUUID();
    expect((await drift(nodeA, '0.000020', '-0.000030')).raised).toEqual([]); // last good sample L
    const stepA = await dbClock(); // the node clock steps back 1 h here
    const e1 = await newEntry(batchA); // after the step, before the alarm
    const faultA = await drift(nodeA, '-3600.000020', '-3600.000030');
    expect(faultA.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    const alarmA = faultA.raised[0]?.alarm_id ?? '';
    const e2 = await newEntry(batchA); // during the alarm
    // Positive control: with true times (no step) both entries are in the open window's list, so
    // the alarm, the window and the entry filter are set up right; only the stepped times differ.
    expect(await listedFor(alarmA, batchA)).toEqual([e1.id, e2.id].sort());
    await applyClockStep(stepA, '-1 hour');
    // The clock is corrected; the next healthy check clears the alarm.
    expect((await drift(nodeA, '0.000020', '-0.000030')).cleared).toEqual([{ kind: 'DRIFT_EXCEEDED', alarm_id: alarmA }]);

    // ---- Scenario B: forward jump of 30 s, corrected by an NTP step ---------------------------
    const nodeB = 'db-step-fwd';
    const batchB = randomUUID();
    expect((await drift(nodeB, '0.000020', '-0.000030')).raised).toEqual([]); // last good sample
    const stepB = await dbClock(); // the node clock jumps 30 s ahead here
    const faultB = await drift(nodeB, '30.000020', '30.000030');
    expect(faultB.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    const alarmB = faultB.raised[0]?.alarm_id ?? '';
    const e3 = await newEntry(batchB); // during the alarm, recorded with the node 30 s ahead
    expect(await listedFor(alarmB, batchB)).toEqual([e3.id]); // positive control, true times
    await applyClockStep(stepB, '30 seconds');
    // NTP steps the clock back; the clearing check runs at once.
    expect((await drift(nodeB, '0.000020', '-0.000030')).cleared).toEqual([{ kind: 'DRIFT_EXCEEDED', alarm_id: alarmB }]);

    const diagnostics = {
      backward: { window: await windowOf(alarmA), entries: await auditTimes(batchA), e1Flags: e1.review_flags, e2Flags: e2.review_flags },
      forward: { window: await windowOf(alarmB), entries: await auditTimes(batchB), e3Flags: e3.review_flags },
    };

    // Safe behaviour: the DI-27 review list for each alarm holds every entry recorded while the
    // node's time was in doubt (between the last good sample and the clearance).
    const listed = { backward: await listedFor(alarmA, batchA), forward: await listedFor(alarmB, batchB) };
    expect(listed, `DI-27 review list per alarm; windows and entry times: ${JSON.stringify(diagnostics)}`).toEqual({
      backward: [e1.id, e2.id].sort(),
      forward: [e3.id],
    });
  });
});
