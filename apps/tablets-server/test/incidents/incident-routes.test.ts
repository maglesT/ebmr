/**
 * The incident register and its CERT-In step over HTTP (Phase 7 slice 7g-2, decision 0025; contract ns/incidents.ts;
 * kernel 0410; DI-12). A batch issuer raises an incident linked to a record; QA investigates it, assesses its impact on
 * the record, marks it reportable to CERT-In, records the report and closes it. The database decides each act: the
 * issuer may raise but not investigate, an administrator may do nothing, a reportable incident does not close before its
 * report, and one that was ever major does not close without a root cause and a CAPA reference.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';

const I = routes.incidents;
let server: TestServer;
let issuer: TestBrowser;
let qa: TestBrowser;

beforeAll(async () => {
  server = await startSigningServer('GMP', { stub: false });
  [issuer, qa] = await Promise.all([server.asPersona('issuer'), server.asPersona('qaInvestigator')]);
}, 300_000);
afterAll(async () => {
  await server?.close();
});

const raiseBody = (over: Partial<Record<string, unknown>> = {}) => ({
  source: 'PRINT_FAILURE' as const, incidentType: 'LABEL_PRINTER_JAM', severity: 'MINOR' as const, title: `Printer jam ${randomUUID().slice(0, 6)}`,
  description: 'The label printer jammed during the run.', links: [{ aggregateType: 'batch', aggregateId: randomUUID() }], certInReportable: false, ...over,
});

describe('the incident register over HTTP (DI-12)', () => {
  it('[DI-12] an incident raised with a linked record is investigated, assessed for the record, reported to CERT-In and closed; the register shows each step', async () => {
    const raised = valueOf(await issuer.call(I.raise, { body: raiseBody({ source: 'SECURITY', incidentType: 'PHISHING_LOGIN', title: `Suspicious login ${randomUUID().slice(0, 6)}` }) }));
    expect(raised).toMatchObject({ status: 'OPEN', severity: 'MINOR', detectedBy: 'USER', links: 1 });
    expect(raised.reference).toMatch(/^INC-\d{6}$/);
    expect(raised.certIn).toMatchObject({ reportable: false, deadlineAt: null });
    const id = raised.incidentId;
    const link = raised.linkedRecords[0];
    if (!link) throw new Error('no linked record');

    // The issuer raises, but does not investigate (INCIDENT.INVESTIGATE).
    expect(refusalOf(await issuer.call(I.startInvestigation, { params: { incidentId: id }, body: {} })).code).toMatch(/^EBMR-IAM-/);
    valueOf(await qa.call(I.startInvestigation, { params: { incidentId: id }, body: { note: 'Account and device checked' } }));
    const assessed = valueOf(await qa.call(I.assessImpact, { params: { incidentId: id }, body: { aggregateType: link.aggregateType, aggregateId: link.aggregateId, outcome: 'NO_IMPACT', rationale: 'No entry was made in the session' } }));
    expect(assessed.linkedRecords[0]?.assessment).toMatchObject({ outcome: 'NO_IMPACT', rationale: 'No entry was made in the session' });

    const marked = valueOf(await qa.call(I.markCertInReportable, { params: { incidentId: id }, body: { justification: 'Unauthorised access attempt: a reportable cyber incident' } }));
    expect(marked.certIn.reportable).toBe(true);
    expect(marked.certIn.deadlineAt).not.toBeNull();
    const reg = valueOf(await qa.call(I.register, { query: {} }));
    expect(reg.certInWindowHours).toBe('6');
    expect(reg.incidents.find((x) => x.incidentId === id)?.certIn).toMatchObject({ reportable: true, reportedAt: null, overdue: false });

    // A reportable incident closes only once its report is recorded (EBMR-REC-055).
    expect(refusalOf(await qa.call(I.close, { params: { incidentId: id }, body: { summary: 'Done' } })).code).toBe('EBMR-REC-055');
    // A report time in the future is refused by the database.
    expect(refusalOf(await qa.call(I.recordCertInReport, { params: { incidentId: id }, body: { reportedAt: '2099-01-01T00:00:00Z', reference: 'CERTIN-ACK-1' } })).code).toBe('EBMR-REC-055');
    const reportedAt = new Date(Number(BigInt(marked.recordedAt.us) / 1000n)).toISOString();
    const reported = valueOf(await qa.call(I.recordCertInReport, { params: { incidentId: id }, body: { reportedAt, reference: 'CERTIN-ACK-1' } }));
    expect(reported.certIn).toMatchObject({ reportable: true, reference: 'CERTIN-ACK-1' });
    expect(reported.events.map((e) => e.event)).toEqual(['INVESTIGATION_STARTED', 'CERT_IN_REPORTABLE', 'CERT_IN_REPORTED']);
    const closed = valueOf(await qa.call(I.close, { params: { incidentId: id }, body: { summary: 'Access blocked; no record affected' } }));
    expect(closed).toMatchObject({ status: 'CLOSED' });
    expect(closed.closure).toMatchObject({ summary: 'Access blocked; no record affected', rootCause: null });
    // A closed incident takes no further link (EBMR-REC-052).
    expect(refusalOf(await issuer.call(I.link, { params: { incidentId: id }, body: { aggregateType: 'batch', aggregateId: randomUUID() } })).code).toBe('EBMR-REC-052');
  });

  it('[DI-12] an incident that was ever major closes only with a root cause and a CAPA reference, even after a downgrade', async () => {
    const raised = valueOf(await issuer.call(I.raise, { body: raiseBody({ severity: 'MAJOR' }) }));
    const id = raised.incidentId;
    valueOf(await qa.call(I.startInvestigation, { params: { incidentId: id }, body: {} }));
    const down = valueOf(await qa.call(I.reclassify, { params: { incidentId: id }, body: { severity: 'MINOR', justification: 'Only one label affected' } }));
    expect(down).toMatchObject({ severity: 'MINOR', peakSeverity: 'MAJOR' });
    expect(refusalOf(await qa.call(I.close, { params: { incidentId: id }, body: { summary: 'Printer cleaned' } })).code).toBe('EBMR-REC-053');
    expect(valueOf(await qa.call(I.close, { params: { incidentId: id }, body: { summary: 'Printer cleaned', rootCause: 'Worn platen roller', capaRef: 'CAPA-2026-017' } })).closure).toMatchObject({ rootCause: 'Worn platen roller', capaRef: 'CAPA-2026-017' });
  });

  it('[DI-12] the register lists open incidents first and filters by status; an unknown incident is a 404', async () => {
    const open = valueOf(await issuer.call(I.raise, { body: raiseBody() }));
    const all = valueOf(await qa.call(I.register, { query: {} })).incidents;
    expect(all.findIndex((x) => x.incidentId === open.incidentId)).toBeLessThan(all.findIndex((x) => x.status === 'CLOSED') === -1 ? Infinity : all.findIndex((x) => x.status === 'CLOSED'));
    expect(valueOf(await qa.call(I.register, { query: { status: 'OPEN' } })).incidents.every((x) => x.status === 'OPEN')).toBe(true);
    expect(refusalOf(await qa.call(I.detail, { params: { incidentId: randomUUID() } })).status).toBe(404);
  });

  it('[DI-18][DI-12] an administrator can neither raise an incident nor act on one', async () => {
    const admin = await loginOf(server, await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ada Administrator'));
    expect(refusalOf(await admin.call(I.raise, { body: raiseBody() })).code).toMatch(/^EBMR-IAM-/);
    const raised = valueOf(await issuer.call(I.raise, { body: raiseBody() }));
    expect(refusalOf(await admin.call(I.startInvestigation, { params: { incidentId: raised.incidentId }, body: {} })).code).toMatch(/^EBMR-IAM-/);
    expect(refusalOf(await admin.call(I.markCertInReportable, { params: { incidentId: raised.incidentId }, body: { justification: 'x' } })).code).toMatch(/^EBMR-IAM-/);
    expect(valueOf(await qa.call(I.detail, { params: { incidentId: raised.incidentId } })).status).toBe('OPEN');
  });
});
