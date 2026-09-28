/**
 * Review reproducer F69: platform.raise_time_incident is callable by the application role with no
 * source or permission check of its own, so any person holding INCIDENT.RAISE (every shop-floor
 * role) can forge a data-integrity time-fault alarm and incident, and - worse - pre-empt the time
 * monitor: record_drift_check raises a fault only "once per open condition" (open_alarm_id), so a
 * user-raised MINOR DRIFT_EXCEEDED alarm for the real node suppresses the monitor's MAJOR alarm and
 * automatic DATA_INTEGRITY incident when a genuine drift is measured (DI-27, DI-17, INV-16).
 *
 * 0520 grants EXECUTE on platform.raise_time_incident to ebmr_app; 0900 redefines it (the live
 * version) to call platform.raise_alarm and records.raise_incident as owner, with no
 * source = 'SYSTEM' check and no platform.authorize('platform.time_check.record', ...) - unlike
 * platform.record_drift_check (0520:204-207), which refuses anyone but the SYSTEM time monitor.
 *
 * Safe behaviour asserted here:
 *   (a) an OPERATOR calling platform.raise_time_incident directly is refused, and no time-fault
 *       alarm or TIME_SYNC incident is attributed to the operator;
 *   (b) after an operator's attempt to pre-raise a MINOR DRIFT_EXCEEDED alarm for the real node,
 *       a genuine 3.5 s drift measured by the time monitor still raises the DRIFT_EXCEEDED alarm
 *       (MAJOR) and its automatic DATA_INTEGRITY / TIME_SYNC incident detected by SYSTEM.
 * Control: on an untouched node the same monitor check raises DRIFT_EXCEEDED with its incident,
 * which proves the test's drift readings do trigger the monitor.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { seedAdministration } from '../identity/seed.ts';

let db: TestDatabase;
let monitor: ActorContext;
let operator: ActorContext;
let npl = '';
let nic = '';

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

const codeOf = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  if (/permission denied/.test(m)) return 'PERMISSION_DENIED';
  return m.match(/EBMR-[A-Z]+-\d+/)?.[0] ?? `UNEXPECTED: ${m}`;
};

// Set-up corrected for the fix of F49: the administrator registers a source naming its validator,
// the CSV / data-integrity lead, who confirms it (kernel 0520, 0900).
async function registerSource(admin: ActorContext, validator: ActorContext, name: string, reference: string): Promise<string> {
  const id = await withCommand(db.app, again(admin), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "select platform.register_time_source($1, 'NTP', $2, $3, $4, 'VAL-TS-F69') as id",
      [name, `${name.toLowerCase().replace(/\W+/g, '-')}.example`, reference, validator.personId],
    );
    return rows[0]?.id ?? '';
  });
  await withCommand(db.app, again(validator), (c) => c.query('select platform.confirm_time_source($1)', [id]));
  return id;
}

/** The time monitor (SYSTEM service identity holding PLATFORM.TIME_CHECK_RECORD) submits a drift check: the node is 3.5 s ahead of both references. */
async function monitorDriftCheck(node: string): Promise<{ raised: { kind: string; alarm_id: string }[] }> {
  const samples = [
    { source_id: npl, reachable: true, offset_s: '3.500000', uncertainty_s: '0.000800' },
    { source_id: nic, reachable: true, offset_s: '3.480000', uncertainty_s: '0.000900' },
  ];
  return withCommand(db.app, again(monitor), async (c) => {
    const { rows } = await c.query<{ r: { raised: { kind: string; alarm_id: string }[] } }>(
      'select platform.record_drift_check($1, $2::jsonb) as r',
      [node, JSON.stringify(samples)],
    );
    return rows[0]?.r ?? { raised: [] };
  });
}

/** An operator calls the time-incident hook directly, as the application role may. */
async function operatorRaises(node: string, severity: string): Promise<{ ok: true; alarmId: string } | { ok: false; code: string }> {
  try {
    const alarmId = await withCommand(db.app, again(operator), async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "select platform.raise_time_incident('DRIFT_EXCEEDED', $1, $2, '{}'::jsonb) as id",
        [node, severity],
      );
      return rows[0]?.id ?? '';
    });
    return { ok: true, alarmId };
  } catch (e) {
    return { ok: false, code: codeOf(e) };
  }
}

/** The DATA_INTEGRITY / TIME_SYNC incident linked to an alarm, if any. */
async function incidentForAlarm(alarmId: string) {
  const { rows } = await db.admin.query<{ source: string; incident_type: string; initial_severity: string; detected_by: string }>(
    `select i.source, i.incident_type, i.initial_severity, i.detected_by
       from records.incident i join records.incident_link l on l.incident_id = i.id
      where l.aggregate_type = 'platform_alarm' and l.aggregate_id = $1`,
    [alarmId],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const { admin } = await seedAdministration(db); // SYSTEM_ADMINISTRATOR holds PLATFORM.TIME_SOURCE_MANAGE
  const csv = await seededTestActor(db, { roleCode: 'CSV_DI_LEAD', legalName: 'F69 CSV lead' }); // PLATFORM.TIME_SOURCE_VALIDATE
  npl = await registerSource(admin, csv, `NPL India NTP ${randomBytes(2).toString('hex')}`, 'NPL India, traceable to UTC(NPLI)');
  nic = await registerSource(admin, csv, `NIC NTP ${randomBytes(2).toString('hex')}`, 'NIC time service, traceable to NPL India');
  monitor = await seededTestActor(db, { source: 'SYSTEM', legalName: 'F69 time monitor' });
  operator = await seededTestActor(db, { roleCode: 'OPERATOR', legalName: 'F69 Operator' });
});

afterAll(async () => {
  await db.drop();
});

describe('F69: only the time monitor raises time-fault alarms and their data-integrity incidents', () => {
  it('[DI-27][DI-17][INV-16] an operator cannot forge a time-fault incident, nor pre-empt the monitor so that a genuine drift raises nothing', async () => {
    const observed: Record<string, unknown> = {};

    // (a) Forgery: an operator raises a MINOR DRIFT_EXCEEDED incident for a node that does not exist.
    const ghost = await operatorRaises('ghost-node', 'MINOR');
    observed['ghostRaise'] = ghost.ok ? 'ACCEPTED' : ghost.code;
    const { rows: forged } = await db.admin.query<{ n: number }>(
      `select count(*)::int as n from records.incident where source = 'TIME_SYNC' and raised_by_person = $1`,
      [operator.personId],
    );
    observed['timeSyncIncidentsRaisedByOperator'] = forged[0]?.n ?? -1;
    const { rows: ghostAlarms } = await db.admin.query<{ n: number }>(
      `select count(*)::int as n from platform.alarm where subject = 'ghost-node'`,
    );
    observed['ghostNodeAlarms'] = ghostAlarms[0]?.n ?? -1;
    const { rows: faultOpen } = await db.admin.query<{ open: boolean }>('select platform.time_fault_open() as open');
    observed['timeFaultOpenAfterOperator'] = faultOpen[0]?.open ?? null;

    // (b) Suppression: the operator pre-raises a MINOR DRIFT_EXCEEDED alarm for the real node, then the
    // monitor measures a genuine 3.5 s drift on it.
    const realNode = 'db-f69-real';
    const preempt = await operatorRaises(realNode, 'MINOR');
    observed['preemptRaise'] = preempt.ok ? 'ACCEPTED' : preempt.code;
    const real = await monitorDriftCheck(realNode);
    observed['monitorRaisedOnRealNode'] = real.raised.map((r) => r.kind);
    const realAlarmId = real.raised.find((r) => r.kind === 'DRIFT_EXCEEDED')?.alarm_id;
    observed['monitorIncidentOnRealNode'] = realAlarmId ? await incidentForAlarm(realAlarmId) : [];
    const { rows: openOnReal } = await db.admin.query<{ kind: string; severity: string; raised_by_person: string }>(
      `select a.kind, a.severity, a.raised_by_person from platform.alarm a
        where a.subject = $1 and not exists (select 1 from platform.alarm_clearance c where c.alarm_id = a.id)
        order by a.recorded_at`,
      [realNode],
    );
    observed['openAlarmsOnRealNode'] = openOnReal.map((a) => ({
      kind: a.kind, severity: a.severity, raisedBy: a.raised_by_person === monitor.personId ? 'MONITOR' : a.raised_by_person === operator.personId ? 'OPERATOR' : a.raised_by_person,
    }));

    // Control: on an untouched node the same monitor check raises the MAJOR alarm and its SYSTEM incident.
    const control = await monitorDriftCheck('db-f69-control');
    expect(control.raised.map((r) => r.kind)).toEqual(['DRIFT_EXCEEDED']);
    expect(await incidentForAlarm(control.raised[0]?.alarm_id ?? '')).toEqual([
      { source: 'TIME_SYNC', incident_type: 'DATA_INTEGRITY', initial_severity: 'MAJOR', detected_by: 'SYSTEM' },
    ]);

    expect(observed).toEqual({
      ghostRaise: expect.stringMatching(/^(PERMISSION_DENIED|EBMR-(PLAT|IAM|REC)-\d+)$/) as unknown,
      timeSyncIncidentsRaisedByOperator: 0,
      ghostNodeAlarms: 0,
      timeFaultOpenAfterOperator: false,
      preemptRaise: expect.stringMatching(/^(PERMISSION_DENIED|EBMR-(PLAT|IAM|REC)-\d+)$/) as unknown,
      monitorRaisedOnRealNode: ['DRIFT_EXCEEDED'],
      monitorIncidentOnRealNode: [{ source: 'TIME_SYNC', incident_type: 'DATA_INTEGRITY', initial_severity: 'MAJOR', detected_by: 'SYSTEM' }],
      openAlarmsOnRealNode: [{ kind: 'DRIFT_EXCEEDED', severity: 'MAJOR', raisedBy: 'MONITOR' }],
    });
  });
});
