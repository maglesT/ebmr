import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import {
  assessIncidentImpact,
  closeIncident,
  incidentState,
  linkIncident,
  raiseIncident,
  reclassifyIncident,
  recordCertInReport,
  startIncidentInvestigation,
} from '../../src/records/incidents.ts';
import { lockBlockerEpoch, openBlockers } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, createStubTables, scalar, testActor, withReason } from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let gateway: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA' });
  gateway = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'site gateway (balance adapter)' });
});
afterAll(async () => {
  await db.drop();
});

/** Operator starts a weighing on a step; the balance reading has not arrived yet. */
async function startWeighing(batchId: string, stepRef: string): Promise<string> {
  return withCommand(db.app, again(operator), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "insert into stub_b4.batch_entry (batch_id, step_ref, value, status) values ($1, $2, 0, 'IN_PROGRESS') returning id",
      [batchId, stepRef],
    );
    return rows[0]?.id ?? '';
  });
}

/**
 * What the site gateway does when the balance interface drops during a weighing: it raises an
 * incident under its SYSTEM account, linked to the batch and step, with the last heartbeat as the
 * claimed occurrence time (device clock synchronised).
 */
async function balanceInterfaceKilled(batchId: string, stepRef: string, lastHeartbeat: Date): Promise<string> {
  return withCommand(db.app, again(gateway), (c) =>
    raiseIncident(c, {
      source: 'INTERFACE_FAILURE',
      type: 'BALANCE_INTERFACE_LOST',
      severity: 'MAJOR',
      title: 'Balance B-17 interface lost during weighing',
      description: 'No heartbeat from the balance adapter for 30 s while a weighing was open.',
      links: [{ aggregateType: 'batch', aggregateId: batchId, stepRef }],
      occurredAt: { at: lastHeartbeat, trust: 'DEVICE_SYNCED' },
    }),
  );
}

describe('DI-12 incident raised by an interface failure', () => {
  it('[DI-12] killing the balance interface mid-weighing creates an incident linked to the batch, open on the disposition screen; closing it as critical without root cause and CAPA is blocked', async () => {
    const batch = randomUUID();
    await startWeighing(batch, 'DISPENSE-2');
    const heartbeat = (await db.app.query<{ t: Date }>("select clock_timestamp() - interval '30 seconds' as t")).rows[0]?.t as Date;
    const id = await balanceInterfaceKilled(batch, 'DISPENSE-2', heartbeat);

    const { rows } = await db.app.query<{ detected_by: string; source: string; status: string; occurred_at_trust: string; reference: string }>(
      'select detected_by, source, status, occurred_at_trust, reference from records.incident_current where id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ detected_by: 'SYSTEM', source: 'INTERFACE_FAILURE', status: 'OPEN', occurred_at_trust: 'DEVICE_SYNCED' });
    const links = await db.app.query<{ aggregate_type: string; aggregate_id: string; step_ref: string }>(
      'select aggregate_type, aggregate_id, step_ref from records.incident_link where incident_id = $1',
      [id],
    );
    expect(links.rows).toEqual([{ aggregate_type: 'batch', aggregate_id: batch, step_ref: 'DISPENSE-2' }]);

    // Shown as open on the disposition screen (the release module reads records.open_blockers).
    const blockers = await openBlockers(db.app, 'batch', batch);
    expect(blockers.map((b) => [b.kind, b.reference, b.status, b.blocksDisposition])).toEqual([['INCIDENT', rows[0]?.reference, 'OPEN', true]]);
    expect(await scalar<boolean>(db.app, "select records.has_disposition_blockers('batch', $1) as v", [batch])).toBe(true);
    // And it is in the batch's own audit trail, next to the weighing (DI-25 review scope).
    const trail = await db.app.query<{ action: string; message: string | null }>(
      "select action, payload -> 'body' ->> 'message' as message from kernel.audit_event where chain_key = $1 order by seq",
      [`batch:${batch}`],
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['INSERT', 'BUSINESS']);
    expect(trail.rows[1]?.message).toContain(`incident ${rows[0]?.reference} (INTERFACE_FAILURE, MAJOR) linked to step DISPENSE-2`);

    // QA rates it CRITICAL and investigates; closing without root cause and CAPA is refused.
    await withCommand(db.app, again(qa), (c) => reclassifyIncident(c, id, 'CRITICAL', 'weighing value of an active ingredient lost'));
    await withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id));
    await expect(withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'adapter restarted' }))).rejects.toThrow('EBMR-REC-053');
    await expect(
      withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'adapter restarted', rootCause: 'USB hub power failure' })),
    ).rejects.toThrow('EBMR-REC-053');
    await expect(withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'adapter restarted', capaRef: 'CAPA-2026-031' }))).rejects.toThrow(
      'EBMR-REC-053',
    );
    expect((await incidentState(db.app, id))?.status).toBe('UNDER_INVESTIGATION');
    expect(await scalar<boolean>(db.app, "select records.has_disposition_blockers('batch', $1) as v", [batch])).toBe(true);

    await withCommand(db.app, again(qa), (c) =>
      closeIncident(c, id, { summary: 'weighing repeated after restart', rootCause: 'USB hub power failure', capaRef: 'CAPA-2026-031' }),
    );
    expect(await incidentState(db.app, id)).toMatchObject({ status: 'CLOSED', rootCause: 'USB hub power failure', capaRef: 'CAPA-2026-031' });
    expect(await openBlockers(db.app, 'batch', batch)).toEqual([]);
  });

  it('[DI-12] lowering the severity does not remove the root-cause and CAPA requirement of a critical incident', async () => {
    const batch = randomUUID();
    const id = await withCommand(db.app, again(gateway), (c) =>
      raiseIncident(c, { source: 'INTEGRITY_CHECK', type: 'CHAIN_VERIFICATION_FAILED', severity: 'CRITICAL', title: 'nightly chain verification failed', links: [{ aggregateType: 'batch', aggregateId: batch }] }),
    );
    await withCommand(db.app, again(qa), (c) => reclassifyIncident(c, id, 'MINOR', 'false alarm suspected'));
    expect(await incidentState(db.app, id)).toMatchObject({ severity: 'MINOR', peakSeverity: 'CRITICAL' });
    await withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id));
    await expect(withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'false alarm' }))).rejects.toThrow(/EBMR-REC-053 .* was CRITICAL/);
    await expect(withCommand(db.app, again(qa), (c) => reclassifyIncident(c, id, 'MINOR', 'again'))).rejects.toThrow('EBMR-REC-052');
  });

  it('[DI-12] a minor incident closes with a summary, only from UNDER_INVESTIGATION and only by a person', async () => {
    const id = await withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'PRINT_FAILURE', type: 'LABEL_PRINTER_OFFLINE', severity: 'MINOR', title: 'label printer offline' }));
    await expect(withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'printer restarted' }))).rejects.toThrow('EBMR-REC-052');
    await withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id));
    await expect(withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id))).rejects.toThrow('EBMR-REC-052');
    await expect(withCommand(db.app, again(gateway), (c) => closeIncident(c, id, { summary: 'auto' }))).rejects.toThrow('EBMR-REC-052');
    await expect(withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: ' ' }))).rejects.toThrow('EBMR-REC-054');
    await withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'printer restarted; no labels printed in the gap' }));
    expect((await incidentState(db.app, id))?.status).toBe('CLOSED');
    await expect(withCommand(db.app, again(qa), (c) => linkIncident(c, id, { aggregateType: 'batch', aggregateId: randomUUID() }))).rejects.toThrow('EBMR-REC-052');
  });

  it('[DI-12] a user raises an incident manually; an impact assessment lifts the disposition block for that batch only', async () => {
    const b1 = randomUUID();
    const b2 = randomUUID();
    const id = await withCommand(db.app, again(operator), (c) =>
      raiseIncident(c, { source: 'CONNECTION_LOSS', type: 'TERMINAL_OFFLINE', severity: 'MAJOR', title: 'terminal lost connection during a step', links: [{ aggregateType: 'batch', aggregateId: b1 }] }),
    );
    expect(await scalar<string>(db.app, 'select detected_by as v from records.incident where id = $1', [id])).toBe('USER');
    await withCommand(db.app, again(qa), (c) => linkIncident(c, id, { aggregateType: 'batch', aggregateId: b2, stepRef: 'COMPRESSION-1' }));
    await expect(withCommand(db.app, again(gateway), (c) => assessIncidentImpact(c, id, { aggregateType: 'batch', aggregateId: b1 }, 'NO_IMPACT', 'x'))).rejects.toThrow(
      'EBMR-REC-056',
    );
    await expect(
      withCommand(db.app, again(qa), (c) => assessIncidentImpact(c, id, { aggregateType: 'batch', aggregateId: b1 }, 'IMPACT_DEVIATION_RAISED', 'entries lost')),
    ).rejects.toThrow('EBMR-REC-056');
    await withCommand(db.app, again(qa), (c) =>
      assessIncidentImpact(c, id, { aggregateType: 'batch', aggregateId: b1 }, 'NO_IMPACT', 'entry re-sent with its idempotency key; nothing lost'),
    );
    const b1Blockers = await openBlockers(db.app, 'batch', b1);
    expect(b1Blockers.map((b) => [b.kind, b.blocksDisposition, b.blocksDisposal])).toEqual([['INCIDENT', false, true]]);
    expect((await openBlockers(db.app, 'batch', b2)).map((b) => [b.kind, b.blocksDisposition])).toEqual([['INCIDENT', true]]);
    await expect(
      withCommand(db.app, again(qa), (c) => assessIncidentImpact(c, id, { aggregateType: 'batch', aggregateId: randomUUID() }, 'NO_IMPACT', 'not linked')),
    ).rejects.toThrow('EBMR-REC-056');
  });

  it('[DI-12] every change to an incident moves the blocker epoch the release module locks', async () => {
    const batch = randomUUID();
    const epoch = () => withCommand(db.app, again(qa), (c) => lockBlockerEpoch(c, 'batch', batch));
    const e0 = await epoch();
    const id = await withCommand(db.app, again(gateway), (c) =>
      raiseIncident(c, { source: 'TIME_SYNC', type: 'CLOCK_DRIFT', severity: 'MINOR', title: 'drift above 1 s', links: [{ aggregateType: 'batch', aggregateId: batch }] }),
    );
    const e1 = await epoch();
    await withCommand(db.app, again(qa), (c) => assessIncidentImpact(c, id, { aggregateType: 'batch', aggregateId: batch }, 'NO_IMPACT', 'no entries in the drift window'));
    const e2 = await epoch();
    expect(e1).toBeGreaterThan(e0);
    expect(e2).toBeGreaterThan(e1);
  });

  it('[DI-12] incident input is validated; a claimed occurrence time needs a trust level and cannot lie in the future', async () => {
    const future = new Date('2999-01-01T00:00:00Z');
    await expect(
      withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'CRASH', type: 'SERVER_RESTART', severity: 'MAJOR', title: 'crash', occurredAt: { at: future, trust: 'DEVICE_SYNCED' } })),
    ).rejects.toThrow('EBMR-REC-050');
    await expect(withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'SOMETHING' as 'CRASH', type: 'X_Y', severity: 'MAJOR', title: 'x' }))).rejects.toThrow('EBMR-REC-050');
    await expect(withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'CRASH', type: 'lower', severity: 'MAJOR', title: 'x' }))).rejects.toThrow('EBMR-REC-050');
    await expect(withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'CRASH', type: 'X_Y', severity: 'SEVERE' as 'MAJOR', title: 'x' }))).rejects.toThrow('EBMR-REC-050');
  });
});

describe('DI-12 CERT-In reporting step (6 hours; rule from secondary sources, to verify)', () => {
  it('[DI-12] a reportable security incident carries a 6-hour deadline and cannot be closed before the report is recorded', async () => {
    const id = await withCommand(db.app, again(gateway), (c) =>
      raiseIncident(c, { source: 'SECURITY', type: 'BRUTE_FORCE_LOGIN', severity: 'CRITICAL', title: 'repeated failed logins from one device', certInReportable: true }),
    );
    const { rows } = await db.app.query<{ gap: string; recorded_at: Date }>(
      "select (cert_in_deadline_at - recorded_at)::text as gap, recorded_at from records.incident_current where id = $1",
      [id],
    );
    expect(rows[0]?.gap).toBe('06:00:00');
    const pending = await db.app.query<{ incident_id: string; overdue: boolean }>('select incident_id, overdue from records.pending_cert_in_reports()');
    expect(pending.rows).toContainEqual({ incident_id: id, overdue: false });
    await withCommand(db.app, again(qa), (c) => startIncidentInvestigation(c, id));
    await expect(
      withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'blocked device', rootCause: 'shared password', capaRef: 'CAPA-1' })),
    ).rejects.toThrow('EBMR-REC-055');
    await expect(withCommand(db.app, again(qa), (c) => recordCertInReport(c, id, new Date('2999-01-01T00:00:00Z'), 'CERTIN-ACK-1'))).rejects.toThrow('EBMR-REC-055');
    await withCommand(db.app, again(qa), (c) => recordCertInReport(c, id, rows[0]?.recorded_at as Date, 'CERTIN-ACK-1'));
    await withCommand(db.app, again(qa), (c) => closeIncident(c, id, { summary: 'device blocked, passwords reset', rootCause: 'shared password', capaRef: 'CAPA-1' }));
    expect(await incidentState(db.app, id)).toMatchObject({ status: 'CLOSED', certInReportable: true });
    expect((await incidentState(db.app, id))?.certInReportedAt).toBeInstanceOf(Date);
  });
});

describe('DI-12 bypass attempts', () => {
  it('[DI-12] the application role cannot write incident rows directly, and incident rows are insert-only for everyone', async () => {
    const id = await withCommand(db.app, again(gateway), (c) => raiseIncident(c, { source: 'CRASH', type: 'CLIENT_CRASH', severity: 'CRITICAL', title: 'client crash' }));
    const attempts = [
      "insert into records.incident_event (incident_id, event_type, closure_summary, actor_person, actor_account) values ($1, 'CLOSED', 'x', gen_random_uuid(), gen_random_uuid())",
      "update records.incident set initial_severity = 'MINOR' where id = $1",
      'delete from records.incident_link where incident_id = $1',
      "insert into records.incident_assessment (incident_id, aggregate_type, aggregate_id, outcome, rationale, assessed_by_person) values ($1, 'batch', 'x', 'NO_IMPACT', 'x', gen_random_uuid())",
    ];
    for (const sql of attempts) {
      await expect(withCommand(db.app, withReason(qa, 'ATTACK'), (c) => c.query(sql, [id])), sql).rejects.toThrow(/permission denied/);
    }
    await expect(withCommand(db.app, withReason(qa, 'ATTACK'), (c) => c.query('select records.add_incident_link(i, $2, $3, null) from records.incident_current i where i.id = $1', [id, 'batch', 'x']))).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.admin.query("update records.incident set initial_severity = 'MINOR' where id = $1", [id])).rejects.toThrow('EBMR-AUDIT-004');
    expect((await incidentState(db.app, id))?.status).toBe('OPEN');
  });
});
