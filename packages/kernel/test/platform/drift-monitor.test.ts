/**
 * Trusted time sources and the drift monitor (outline 5.6 "Drift and monotonicity"; control
 * DI-27 catalog test "Simulate loss of the time reference. An alarm and an incident are raised").
 * References are injected; no real NTP server is contacted.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainOutbox, type OutboxMessage } from '../../src/commands/outbox.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { nodeClock, runDriftCheck, type TimeReference } from '../../src/time/drift-monitor.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { grantPermission, installStubHooks, testActor } from './helpers.ts';

let db: TestDatabase;
let system: ActorContext;
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

beforeAll(async () => {
  db = await createTestDatabase();
  await installStubHooks(db);
  await grantPermission(db, 'CSV_DI_LEAD', 'platform.time_source.manage', 'platform.alarm.clear');
  await grantPermission(db, 'PROCESS_OWNER', 'platform.settings.change');
  npl = await registerSource('NPL India NTP', 'NPL India, traceable to UTC(NPLI)');
  nic = await registerSource('NIC NTP', 'NIC time service, traceable to NPL India');
  system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'Time monitor' });
});
afterAll(async () => {
  await db.drop();
});

/** A reference whose clock is `skewMicros` behind the database node (the node is ahead by that much). */
function reference(sourceId: string, skewMicros: bigint): TimeReference {
  return { sourceId, read: async () => (await nodeClock(db.app)).plusMicros(-skewMicros) };
}
function unreachable(sourceId: string): TimeReference {
  return { sourceId, read: () => Promise.reject(new Error('NTP request timed out')) };
}
const healthy = () => [reference(npl, 20_000n), reference(nic, -30_000n)];
const lost = () => [unreachable(npl), unreachable(nic)];

async function check(node: string, references: TimeReference[]) {
  return runDriftCheck(db.app, { node, actor: system, references, timeoutMs: 2000 });
}

async function openAlarms(node: string) {
  return rows<{ id: string; kind: string; severity: string; incident_requested: boolean }>(
    `select a.id, a.kind, a.severity, a.incident_requested from platform.alarm a
      where a.subject = $1 and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id) order by a.recorded_at`,
    [node],
  );
}

async function newEntry(batchId: string): Promise<{ id: string; review_flags: string[] }> {
  return withCommand(db.app, await testActor(db), async (c) => {
    const step = await c.query<{ id: string }>('insert into platform.stub_step (batch_id) values ($1) returning id', [batchId]);
    const { rows: r } = await c.query<{ id: string; review_flags: string[] }>(
      "insert into platform.stub_step_entry (step_id, item_no, value, unit) values ($1, 1, '12.503', 'kg') returning id, review_flags",
      [step.rows[0]?.id],
    );
    return r[0] as { id: string; review_flags: string[] };
  });
}

describe('time sources', () => {
  it('[DI-27] a time source is a validated configuration item, registered with its reference and validation', async () => {
    const [src] = await rows<{ kind: string; reference: string; validation_ref: string; active: boolean }>(
      'select kind, reference, validation_ref, active from platform.time_source where id = $1',
      [npl],
    );
    expect(src).toEqual({ kind: 'NTP', reference: 'NPL India, traceable to UTC(NPLI)', validation_ref: 'VAL-TS-2026-001', active: true });
    const audit = await rows<{ action: string }>('select action from kernel.audit_event where chain_key = $1', [`time_source:${npl}`]);
    expect(audit.map((a) => a.action)).toEqual(['INSERT']);
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    await expect(
      withCommand(db.app, operator, (c) => c.query("select platform.register_time_source('Rogue', 'NTP', 'x', 'y', gen_random_uuid(), 'z')")),
    ).rejects.toThrow('EBMR-PLAT-006');
    await expect(db.app.query("insert into platform.time_source (name, kind, endpoint, reference, validated_by, validation_ref, registered_by) values ('R', 'NTP', 'x', 'y', gen_random_uuid(), 'z', 'me')")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('drift checks', () => {
  it('[DI-27] a healthy check stores one sample per active source against the policy threshold and raises nothing', async () => {
    const result = await check('db-healthy', healthy());
    expect(result.raised).toEqual([]);
    expect(result.activeSources).toBe(2);
    expect(result.reachableSources).toBe(2);
    expect(result.thresholdSeconds).toBe('1');
    const samples = await rows<{ source_id: string; reachable: boolean; within_threshold: boolean; offset_s: string; threshold_s: string }>(
      'select source_id, reachable, within_threshold, offset_s::text, threshold_s::text from platform.drift_sample where check_id = $1 order by source_id',
      [result.checkId],
    );
    expect(samples).toHaveLength(2);
    for (const s of samples) {
      expect(s.reachable && s.within_threshold).toBe(true);
      expect(Math.abs(Number(s.offset_s))).toBeLessThan(0.1);
      expect(s.threshold_s).toBe('1.000');
    }
    const offset = result.readings.find((r) => r.sourceId === npl)?.offsetMicros ?? 0n;
    expect(offset > 0n && offset < 100_000n).toBe(true);
  });

  it('[DI-27] simulate loss of the time reference: an alarm and a data-integrity incident are raised', async () => {
    const node = 'db-lost';
    await check(node, healthy());
    const lastGood = (await rows<{ t: string }>('select max(recorded_at)::text as t from platform.drift_sample where node = $1 and within_threshold', [node]))[0]?.t;

    const result = await check(node, lost());
    expect(result.reachableSources).toBe(0);
    expect(result.readings.map((r) => r.error)).toEqual(['NTP request timed out', 'NTP request timed out']);
    expect(result.raised.map((a) => a.kind)).toEqual(['REFERENCE_LOST']);
    const alarmId = result.raised[0]?.alarmId;
    const [alarm] = await rows<{ kind: string; severity: string; incident_requested: boolean; window_start: string }>(
      'select kind, severity, incident_requested, window_start::text from platform.alarm where id = $1',
      [alarmId],
    );
    expect(alarm).toEqual({ kind: 'REFERENCE_LOST', severity: 'MAJOR', incident_requested: true, window_start: lastGood });

    // The incident request travels through the outbox to the incident register.
    const [msg] = await rows<{ topic: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
      "select topic, aggregate_type, aggregate_id, payload from platform.outbox where topic = 'incident.requested' and payload ->> 'alarm_id' = $1",
      [alarmId],
    );
    expect(msg?.aggregate_type).toBe('time_node');
    expect(msg?.aggregate_id).toBe(node);
    expect(msg?.payload).toMatchObject({ incident_type: 'DATA_INTEGRITY', incident_source: 'TIME_SYNC', severity: 'MAJOR', alarm_kind: 'REFERENCE_LOST', node });
    const delivered: OutboxMessage[] = [];
    await drainOutbox(db.app, {
      relayId: 'test-relay',
      handler: (m) => {
        if (m.topic === 'incident.requested') delivered.push(m);
        return Promise.resolve();
      },
    });
    expect(delivered.map((m) => m.payload['alarm_id'])).toContain(alarmId);

    // The alarm is part of the node's audit chain.
    const audit = await rows<{ table_name: string }>("select table_name from kernel.audit_event where chain_key = $1 and table_name = 'platform.alarm'", [`time_node:${node}`]);
    expect(audit).toHaveLength(1);

    // While the fault lasts, repeated checks do not raise duplicate alarms.
    expect((await check(node, lost())).raised).toEqual([]);
    expect((await openAlarms(node)).map((a) => a.kind)).toEqual(['REFERENCE_LOST']);

    // Recovery clears the alarm and closes the fault window; the incident stays with QA.
    const recovered = await check(node, healthy());
    expect(recovered.cleared).toEqual([{ kind: 'REFERENCE_LOST', alarmId }]);
    expect(await openAlarms(node)).toEqual([]);
    const [window] = await rows<{ window_end: string | null }>('select window_end::text from platform.time_fault_windows() where alarm_id = $1', [alarmId]);
    expect(window?.window_end).not.toBeNull();
  });

  it('[DI-27] an offset above the threshold raises an alarm and an incident; back within it, the alarm clears', async () => {
    const node = 'db-drift';
    await check(node, healthy());
    const drifted = await check(node, [reference(npl, 1_500_000n), reference(nic, 10_000n)]);
    expect(drifted.sourcesOverThreshold).toBe(1);
    expect(drifted.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    const [sample] = await rows<{ within_threshold: boolean; offset_s: string }>(
      'select within_threshold, offset_s::text from platform.drift_sample where check_id = $1 and source_id = $2',
      [drifted.checkId, npl],
    );
    expect(sample?.within_threshold).toBe(false);
    expect(Number(sample?.offset_s)).toBeGreaterThan(1.4);
    const incidents = await rows<{ n: string }>(
      "select count(*)::text as n from platform.outbox where topic = 'incident.requested' and payload ->> 'alarm_id' = $1",
      [drifted.raised[0]?.alarmId],
    );
    expect(incidents[0]?.n).toBe('1');
    // A clock behind its reference counts the same as one ahead.
    expect((await check(node, [reference(npl, -2_000_000n), reference(nic, -2_100_000n)])).raised).toEqual([]);
    expect((await openAlarms(node)).map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    expect((await check(node, healthy())).cleared.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
  });

  it('[DI-27] the alarm threshold is a policy value: default 1 s, allowed 0.1-5 s', async () => {
    const [def] = await rows<{ default_value: string; min_value: string; max_value: string }>(
      "select default_value, min_value::text, max_value::text from platform.setting_definition where key = 'time.drift_alarm_threshold_s'",
    );
    expect(def).toEqual({ default_value: '1', min_value: '0.1', max_value: '5' });
    const qa = await testActor(db, { roleCode: 'PROCESS_OWNER', reasonCode: 'CHANGE_CONTROL', reasonText: 'CC-0042 tighter clock tolerance' });
    const set = (v: string) => withCommand(db.app, qa, (c) => c.query("select platform.set_setting('time.drift_alarm_threshold_s', $1)", [v]));
    await expect(set('0.05')).rejects.toThrow('EBMR-PLAT-021');
    await expect(set('5.1')).rejects.toThrow('EBMR-PLAT-021');
    await expect(set('abc')).rejects.toThrow('EBMR-PLAT-021');
    await set('0.2');
    try {
      const node = 'db-tight';
      const result = await check(node, [reference(npl, 300_000n), reference(nic, 0n)]);
      expect(result.thresholdSeconds).toBe('0.2');
      expect(result.raised.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
      expect((await check(node, healthy())).cleared.map((a) => a.kind)).toEqual(['DRIFT_EXCEEDED']);
    } finally {
      await set('1');
    }
    const history = await rows<{ value: string; reason_code: string }>(
      "select value, reason_code from platform.setting_value where key = 'time.drift_alarm_threshold_s' order by id",
    );
    expect(history).toEqual([
      { value: '0.2', reason_code: 'CHANGE_CONTROL' },
      { value: '1', reason_code: 'CHANGE_CONTROL' },
    ]);
  });

  it('[DI-27] a single reachable reference raises a degraded-reference alarm without an incident', async () => {
    const node = 'db-degraded';
    const result = await check(node, [reference(npl, 0n), unreachable(nic)]);
    expect(result.raised.map((a) => a.kind)).toEqual(['REFERENCE_DEGRADED']);
    const [alarm] = await openAlarms(node);
    expect(alarm).toMatchObject({ kind: 'REFERENCE_DEGRADED', severity: 'MINOR', incident_requested: false });
    const msgs = await rows<{ n: string }>("select count(*)::text as n from platform.outbox where payload ->> 'alarm_id' = $1", [alarm?.id]);
    expect(msgs[0]?.n).toBe('0');
    expect((await check(node, healthy())).cleared.map((a) => a.kind)).toEqual(['REFERENCE_DEGRADED']);
  });

  it('[DI-27] entries recorded in a fault window are flagged for review, and capture is never blocked', async () => {
    const node = 'db-window';
    const batchId = randomUUID();
    await check(node, healthy());
    const before = await newEntry(batchId); // after the last good sample, before the fault is detected
    const fault = await check(node, lost());
    const alarmId = fault.raised[0]?.alarmId;
    const during = await newEntry(batchId); // capture continues during the fault
    expect(during.review_flags).toContain('TIME_FAULT_WINDOW');
    expect(before.review_flags).not.toContain('TIME_FAULT_WINDOW');
    await check(node, healthy());
    const afterRecovery = await newEntry(batchId);
    expect(afterRecovery.review_flags).not.toContain('TIME_FAULT_WINDOW');

    const flagged = await rows<{ record_id: string; alarm_kind: string }>(
      'select record_id, alarm_kind from platform.entries_in_time_fault_windows() where alarm_id = $1 and chain_key = $2 and table_name = $3',
      [alarmId, `batch:${batchId}`, 'platform.stub_step_entry'],
    );
    expect(flagged.map((f) => f.record_id).sort()).toEqual([before.id, during.id].sort());
    expect(new Set(flagged.map((f) => f.alarm_kind))).toEqual(new Set(['REFERENCE_LOST']));
    // The monitor's own records are not listed as entries to review.
    const own = await rows<{ n: string }>(
      "select count(*)::text as n from platform.entries_in_time_fault_windows() where table_name like 'platform.drift%' or table_name = 'platform.alarm'",
    );
    expect(own[0]?.n).toBe('0');
  });

  it('[DI-27] with no active time source configured, an alarm and an incident are raised', async () => {
    const admin = await testActor(db, { roleCode: 'CSV_DI_LEAD', reasonCode: 'SOURCE_MAINTENANCE' });
    const setActive = (id: string, active: boolean) => withCommand(db.app, admin, (c) => c.query('select platform.set_time_source_active($1, $2)', [id, active]));
    await setActive(npl, false);
    await setActive(nic, false);
    try {
      const result = await check('db-nosource', []);
      expect(result.activeSources).toBe(0);
      expect(result.raised.map((a) => a.kind)).toEqual(['NO_TIME_SOURCE']);
      // A reading for an inactive source is refused.
      await expect(check('db-nosource', [reference(npl, 0n)])).rejects.toThrow('EBMR-PLAT-030');
    } finally {
      await setActive(npl, true);
      await setActive(nic, true);
    }
    expect((await check('db-nosource', healthy())).cleared.map((a) => a.kind)).toEqual(['NO_TIME_SOURCE']);
    // Deactivation is a change: it is audited with its reason.
    const audit = await rows<{ reason: string }>(
      "select payload ->> 'reason_code' as reason from kernel.audit_event where chain_key = $1 and action = 'UPDATE' order by seq",
      [`time_source:${npl}`],
    );
    expect(audit.map((a) => a.reason)).toEqual(['SOURCE_MAINTENANCE', 'SOURCE_MAINTENANCE']);
  });
});

describe('monitor records are protected', () => {
  it('[DI-27] the application role cannot write samples or alarms, and malformed readings are refused', async () => {
    await expect(db.app.query("insert into platform.drift_sample (check_id, node, source_id, reachable, threshold_s, within_threshold) values (gen_random_uuid(), 'x', $1, false, 1, false)", [npl])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("insert into platform.alarm (kind, subject, severity, incident_requested, window_start, raised_by_person) values ('REFERENCE_LOST', 'x', 'MAJOR', true, now(), 'x')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('delete from platform.alarm')).rejects.toThrow(/permission denied/);
    await expect(db.app.query("update platform.drift_sample set offset_s = 0")).rejects.toThrow(/permission denied/);
    await expect(
      withCommand(db.app, system, (c) => c.query("select platform.raise_alarm('REFERENCE_LOST', 'x', 'MAJOR', false, '{}')")),
    ).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('delete from platform.drift_sample')).rejects.toThrow('EBMR-AUDIT-004');
    const malformed = (samples: unknown) => withCommand(db.app, system, (c) => c.query('select platform.record_drift_check($1, $2::jsonb)', ['db-x', JSON.stringify(samples)]));
    await expect(malformed([{ source_id: randomUUID(), reachable: true, offset_s: '0.1' }])).rejects.toThrow('EBMR-PLAT-030');
    await expect(malformed([{ source_id: npl, reachable: true }])).rejects.toThrow('EBMR-PLAT-031');
    await expect(malformed([{ source_id: npl, reachable: true, offset_s: '1e3' }])).rejects.toThrow('EBMR-PLAT-031');
    await expect(malformed([{ source_id: npl, reachable: false }, { source_id: npl, reachable: false }])).rejects.toThrow('EBMR-PLAT-031');
    await expect(malformed({})).rejects.toThrow('EBMR-PLAT-031');
  });

  it('[DI-27] clearing an alarm by hand needs a reason, a note and the permission', async () => {
    const alarmId = await withCommand(db.app, system, async (c) => {
      const { rows: r } = await c.query<{ id: string }>("select platform.raise_time_incident('CLOCK_REGRESSION', 'db-manual', 'MAJOR', '{}') as id");
      return r[0]?.id ?? '';
    });
    const clear = (ctx: ActorContext, note: string) => withCommand(db.app, ctx, (c) => c.query('select platform.clear_alarm($1, $2)', [alarmId, note]));
    await expect(clear(await testActor(db, { roleCode: 'CSV_DI_LEAD' }), 'checked')).rejects.toThrow('EBMR-PLAT-032');
    await expect(clear(await testActor(db, { roleCode: 'OPERATOR', reasonCode: 'X' }), 'checked')).rejects.toThrow('EBMR-PLAT-006');
    await clear(await testActor(db, { roleCode: 'CSV_DI_LEAD', reasonCode: 'INVESTIGATED' }), 'clock stepped back during failover test; see incident');
    expect(await openAlarms('db-manual')).toEqual([]);
  });
});
