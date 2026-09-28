import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { signatureState } from '../../src/esig/signing.ts';
import {
  closeDiInvestigation,
  investigationScope,
  linkDiInvestigation,
  openDiInvestigation,
  personActivity,
  refreshDiInvestigationScope,
} from '../../src/records/investigations.ts';
import { approvePurge, createRetentionSchedule, openBlockers, purge, releaseLegalHold } from '../../src/records/retention-store.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import {
  again,
  approveDisposal,
  correctEntry,
  createStubTables,
  inSecondRole,
  insertEntry,
  insertReading,
  recordType,
  registerType,
  scalar,
  signerActor,
  signFor,
  testActor,
  withReason,
} from './helpers.ts';

let db: TestDatabase;
let subject: ActorContext;
let colleague: ActorContext;
let investigator: ActorContext;
let approver: SeededActor;
/** Keeps retention schedules; the disposal approver must be someone else (EBMR-REC-035, F33). */
let retentionKeeper: ActorContext;
let retentionJob: ActorContext;
// The same persons in a second role that holds the permission, to reach the per-person rules.
let investigatorAsQa: ActorContext;
let subjectAsQa: ActorContext;
let subjectAsDiLead: ActorContext;

/** The approver's DI_INVESTIGATION_CLOSED signature of the investigation (DI-37). */
const signClosure = (id: string) => signFor(db, approver, { type: 'di_investigation', id }, 'DI_INVESTIGATION_CLOSED', 'OPEN');
const now = async (): Promise<Date> => (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]?.t as Date;
const plusHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  await registerType(db, recordType('BATCH_PROCESSING_RECORD'));
  subject = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Operator under investigation' });
  colleague = await testActor(db, { roleCode: 'OPERATOR' });
  // Opening, linking and refreshing need VALIDATION.MANAGE (CSV / DI lead); approving the closure
  // needs DI_INVESTIGATION.APPROVE_CLOSURE (QA reviewer); purging needs RECORD.PURGE (retention job).
  investigator = await testActor(db, { roleCode: 'CSV_DI_LEAD', legalName: 'DI investigator' });
  approver = await signerActor(db, 'QA_REVIEWER', 'Head of QA');
  retentionKeeper = await testActor(db, { roleCode: 'QA_REVIEWER', legalName: 'QA reviewer keeping retention' });
  retentionJob = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'retention job' });
  investigatorAsQa = await inSecondRole(db, investigator, 'QA_REVIEWER');
  subjectAsQa = await inSecondRole(db, subject, 'QA_REVIEWER');
  subjectAsDiLead = await inSecondRole(db, subject, 'CSV_DI_LEAD');
});
afterAll(async () => {
  await db.drop();
});

describe('DI-50 data-integrity investigation', () => {
  it('[DI-50] an investigation for a user and date range lists every record the user created or changed; linked batches cannot be disposed of until it closes', async () => {
    const before = randomUUID();
    const batchA = randomUUID();
    const batchB = randomUUID();
    const batchD = randomUUID();
    const lot = randomUUID();
    await insertEntry(db, subject, before, '1.00');
    const from = await now();
    const entryA = await insertEntry(db, subject, batchA, '12.503');
    await correctEntry(db, subject, entryA, '12.530');
    await insertReading(db, subject, batchB, '7.10');
    await withCommand(db.app, again(subject), (c) => c.query("insert into stub_b4.lot_record (lot_id, note) values ($1, 'label checked')", [lot]));
    await insertEntry(db, colleague, batchD, '3.30');
    // Batch A's retention has ended, so only the investigation can stop its disposal.
    await withCommand(db.app, again(retentionKeeper), (c) =>
      createRetentionSchedule(c, 'batch', batchA, 'BATCH_PROCESSING_RECORD', { markets: ['IN'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' }),
    );
    const to = plusHours(from, 1);

    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: to, concern: 'values entered before the balance printed', qmsReference: 'QMS-INV-88' }),
    );

    // Scoping report: every record the person created or changed in the window, with aggregate ids.
    const scope = await investigationScope(db.app, id);
    expect(scope.map((s) => [s.aggregateType, s.aggregateId, s.tableName, s.actions]).sort()).toEqual(
      [
        ['batch', batchA, 'stub_b4.batch_entry', ['INSERT', 'UPDATE']],
        ['batch', batchB, 'stub_b4.batch_reading', ['INSERT']],
        ['component_lot', lot, 'stub_b4.lot_record', ['INSERT']],
      ].sort(),
    );
    expect(scope.find((s) => s.aggregateId === batchA)?.recordId).toBe(entryA);
    expect(scope.some((s) => s.aggregateId === before || s.aggregateId === batchD)).toBe(false);

    // Linked batches are blocked for disposition and held against disposal.
    for (const b of [batchA, batchB]) {
      const blockers = await openBlockers(db.app, 'batch', b);
      expect(blockers.filter((x) => x.blocksDisposition).map((x) => x.kind).sort()).toEqual(['DI_INVESTIGATION', 'HOLD']);
    }
    expect(await openBlockers(db.app, 'batch', before)).toEqual([]);
    expect(await openBlockers(db.app, 'batch', batchD)).toEqual([]);
    const holds = await db.app.query<{ record_key: string; kind: string }>('select record_key, kind from records.active_hold where investigation_id = $1 order by record_key', [id]);
    expect(holds.rows.map((h) => h.record_key).sort()).toEqual([`batch:${batchA}`, `batch:${batchB}`, `component_lot:${lot}`].sort());
    await expect(withCommand(db.app, again(approver), (c) => approvePurge(c, `batch:${batchA}`, randomUUID(), 'retention ended'))).rejects.toThrow('EBMR-REC-032');

    // Closing: conclusion and remediation required; approver must be neither the investigator nor the person investigated.
    const closure = { conclusion: 'entries matched the printouts; no falsification', remediation: 'refresher training on contemporaneous entry', approvalSignatureId: randomUUID() };
    // In their own roles neither holds the closure permission (DI-17); even holding it, neither may approve (EBMR-REC-063).
    await expect(withCommand(db.app, again(investigator), (c) => closeDiInvestigation(c, id, closure))).rejects.toThrow('EBMR-IAM-040');
    await expect(withCommand(db.app, again(subject), (c) => closeDiInvestigation(c, id, closure))).rejects.toThrow('EBMR-IAM-040');
    await expect(withCommand(db.app, again(investigatorAsQa), (c) => closeDiInvestigation(c, id, closure))).rejects.toThrow('EBMR-REC-063');
    await expect(withCommand(db.app, again(subjectAsQa), (c) => closeDiInvestigation(c, id, closure))).rejects.toThrow('EBMR-REC-063');
    await expect(withCommand(db.app, again(approver), (c) => closeDiInvestigation(c, id, { ...closure, remediation: '' }))).rejects.toThrow('EBMR-REC-062');
    expect((await openBlockers(db.app, 'batch', batchA)).some((b) => b.kind === 'DI_INVESTIGATION')).toBe(true);
    const signed = { ...closure, approvalSignatureId: await signClosure(id) };
    await withCommand(db.app, again(approver), (c) => closeDiInvestigation(c, id, signed));

    expect(await openBlockers(db.app, 'batch', batchA)).toEqual([]);
    expect(await openBlockers(db.app, 'batch', batchB)).toEqual([]);
    expect(await scalar<string>(db.app, 'select count(*)::text as v from records.active_hold where investigation_id = $1', [id])).toBe('0');
    expect(await scalar<string>(db.app, 'select status as v from records.di_investigation_current where id = $1', [id])).toBe('CLOSED');
    // Disposal is possible again once the investigation is closed.
    await approveDisposal(db, approver, `batch:${batchA}`, 'retention ended');
    await expect(withCommand(db.app, withReason(retentionJob, 'RETENTION_ENDED', 'approved disposal after the investigation closed'), (c) => purge(c, `batch:${batchA}`))).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('[DI-50] records the person touches inside the window after opening are blocked at once and linked on refresh and at closure', async () => {
    const from = await now();
    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 2), concern: 'suspected back-dating' }),
    );
    const batchE = randomUUID();
    await insertEntry(db, subject, batchE, '5.55');
    expect((await openBlockers(db.app, 'batch', batchE)).map((b) => b.kind)).toEqual(['DI_INVESTIGATION']);
    expect(await withCommand(db.app, again(investigator), (c) => refreshDiInvestigationScope(c, id))).toBe(1);
    expect((await openBlockers(db.app, 'batch', batchE)).map((b) => b.kind).sort()).toEqual(['DI_INVESTIGATION', 'HOLD']);
    const batchF = randomUUID();
    await insertEntry(db, subject, batchF, '6.66');
    const signature = await signClosure(id);
    await withCommand(db.app, again(approver), (c) =>
      closeDiInvestigation(c, id, { conclusion: 'not substantiated', remediation: 'none required', approvalSignatureId: signature }),
    );
    const linked = await db.app.query<{ record_key: string }>('select record_key from records.di_investigation_link where investigation_id = $1', [id]);
    expect(linked.rows.map((r) => r.record_key)).toContain(`batch:${batchF}`);
  });

  it('[DI-50] other records can be linked with a note; the person investigated cannot open or lead it; a machine cannot open it', async () => {
    const from = await now();
    const extra = randomUUID();
    await expect(
      withCommand(db.app, again(subject), (c) => openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'x' })),
    ).rejects.toThrow('EBMR-IAM-040');
    await expect(
      withCommand(db.app, again(subjectAsDiLead), (c) =>
        openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'x' }),
      ),
    ).rejects.toThrow('EBMR-REC-064');
    await expect(
      withCommand(db.app, again(investigator), (c) =>
        openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'x', investigatorPersonId: subject.personId }),
      ),
    ).rejects.toThrow('EBMR-REC-064');
    const system = await testActor(db, { source: 'SYSTEM', roleCode: 'SYSTEM' });
    await expect(
      withCommand(db.app, system, (c) => openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'x' })),
    ).rejects.toThrow('EBMR-REC-060');
    await expect(
      withCommand(db.app, again(investigator), (c) => openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: from, concern: 'x' })),
    ).rejects.toThrow('EBMR-REC-060');

    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, {
        subjectPersonId: colleague.personId,
        windowFrom: from,
        windowTo: plusHours(from, 1),
        concern: 'tip received through the QMS',
        links: [{ aggregateType: 'batch', aggregateId: extra, note: 'batch verified by the person' }],
      }),
    );
    expect((await openBlockers(db.app, 'batch', extra)).map((b) => b.kind).sort()).toEqual(['DI_INVESTIGATION', 'HOLD']);
    const other = randomUUID();
    await expect(withCommand(db.app, again(investigator), (c) => linkDiInvestigation(c, id, 'batch', other, ' '))).rejects.toThrow('EBMR-REC-060');
    await withCommand(db.app, again(investigator), (c) => linkDiInvestigation(c, id, 'batch', other, 'reviewed by the person'));
    const signature = await signClosure(id);
    await withCommand(db.app, again(approver), (c) => closeDiInvestigation(c, id, { conclusion: 'no issue', remediation: 'none', approvalSignatureId: signature }));
    await expect(withCommand(db.app, again(investigator), (c) => linkDiInvestigation(c, id, 'batch', randomUUID(), 'late'))).rejects.toThrow('EBMR-REC-061');
    await expect(withCommand(db.app, again(approver), (c) => closeDiInvestigation(c, id, { conclusion: 'x', remediation: 'y', approvalSignatureId: randomUUID() }))).rejects.toThrow(
      'EBMR-REC-061',
    );
  });

  it('[DI-50][DI-37] closing a DI investigation needs the approver\'s own DI_INVESTIGATION_CLOSED signature of that investigation', async () => {
    const from = await now();
    const open = () =>
      withCommand(db.app, again(investigator), (c) =>
        openDiInvestigation(c, { subjectPersonId: colleague.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'entries made after the fact' }),
      );
    const a = await open();
    const b = await open();
    const close = (ctx: ActorContext, id: string, approvalSignatureId: string) =>
      withCommand(db.app, again(ctx), (c) => closeDiInvestigation(c, id, { conclusion: 'no falsification', remediation: 'refresher training', approvalSignatureId }));
    await expect(close(approver, a, randomUUID())).rejects.toThrow(/EBMR-ESIG-070 .*does not exist/);
    const ofB = await signClosure(b);
    await expect(close(approver, a, ofB)).rejects.toThrow(/EBMR-ESIG-070 .*never transferred/);
    const ofA = await signClosure(a);
    const deputy = await signerActor(db, 'QA_REVIEWER', 'Deputy head of QA');
    await expect(close(deputy, a, ofA)).rejects.toThrow('EBMR-REC-065');
    await close(approver, a, ofA);
    await close(approver, b, ofB);
    // The investigation as opened is what was signed: closing it leaves the signature valid.
    expect(await signatureState(db.app, ofA)).toMatchObject({ valid: true, status: 'VALID', meaningCode: 'DI_INVESTIGATION_CLOSED' });
  });

  it('[DI-50] the scoping report works for any person and period, across batches', async () => {
    const from = await now();
    const b1 = randomUUID();
    const b2 = randomUUID();
    await insertEntry(db, colleague, b1, '1.1');
    await insertEntry(db, colleague, b2, '2.2');
    const report = await personActivity(db.app, colleague.personId, from, plusHours(from, 1));
    expect(report.map((r) => r.aggregateId).sort()).toEqual([b1, b2].sort());
    expect(report.every((r) => r.eventCount === 1 && r.actions.join() === 'INSERT')).toBe(true);
  });

  it('[DI-50] investigation holds cannot be lifted except by closing the investigation, and its records cannot be written directly', async () => {
    const from = await now();
    const batch = randomUUID();
    await insertEntry(db, subject, batch, '9.99');
    const id = await withCommand(db.app, again(investigator), (c) =>
      openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: from, windowTo: plusHours(from, 1), concern: 'audit trail gap' }),
    );
    const holdId = await scalar<string>(db.app, 'select id::text as v from records.active_hold where investigation_id = $1 limit 1', [id]);
    await expect(withCommand(db.app, again(approver), (c) => releaseLegalHold(c, holdId, 'not needed'))).rejects.toThrow('EBMR-REC-040');
    const attempts = [
      "insert into records.di_investigation_closure (investigation_id, conclusion, remediation, approved_by_person, approval_signature_id) values ($1, 'x', 'y', gen_random_uuid(), gen_random_uuid())",
      "insert into records.retention_hold_release (hold_id, record_key, reason, released_by_person) select h.id, h.record_key, 'x', gen_random_uuid() from records.retention_hold h where h.investigation_id = $1",
      'delete from records.di_investigation_link where investigation_id = $1',
      "update records.di_investigation set window_to = window_from + interval '1 second' where id = $1",
    ];
    for (const sql of attempts) {
      await expect(withCommand(db.app, withReason(approver, 'ATTACK'), (c) => c.query(sql, [id])), sql).rejects.toThrow(/permission denied/);
    }
    await expect(withCommand(db.app, withReason(approver, 'ATTACK'), (c) => c.query('select records.end_hold(h, $2) from records.retention_hold h where h.investigation_id = $1', [id, 'x']))).rejects.toThrow(
      /permission denied/,
    );
    expect((await openBlockers(db.app, 'batch', batch)).map((b) => b.kind).sort()).toEqual(['DI_INVESTIGATION', 'HOLD']);
  });
});
