/**
 * Namespace `incidents` (Phase 7 slice 7g-2, decision 0025; GMP): the incident register (DI-12; kernel 0410) and its
 * CERT-In reporting step. Every rule is the database's: the routes call records.raise_incident, link_incident,
 * start_incident_investigation, reclassify_incident, assess_incident_impact, mark_incident_cert_in_reportable,
 * record_cert_in_report and close_incident, each as the person's own command (never an administrator, then
 * INCIDENT.RAISE, INCIDENT.INVESTIGATE, INCIDENT.CERT_IN_REPORT or INCIDENT.CLOSE); a refusal carries its EBMR-REC-05x
 * code. The status, the peak severity, the CERT-In deadline and whether it has passed are read from
 * records.incident_current and records.pending_cert_in_reports (the window lives in records.cert_in_reporting_window).
 */
import { z } from 'zod';
import { Instant, PersonRef, Uuid, withAttribution } from '../common.ts';
import { defineRoute } from '../route.ts';

const Text = (max: number) => z.string().trim().min(1).max(max);

export const IncidentSource = z.enum(['INTERFACE_FAILURE', 'CONNECTION_LOSS', 'CRASH', 'SIGNATURE_FAILURE', 'TIME_SYNC', 'PRINT_FAILURE', 'INTEGRITY_CHECK', 'SECURITY', 'DATA_INTEGRITY', 'OTHER']);
export const IncidentSeverity = z.enum(['MINOR', 'MAJOR', 'CRITICAL']);
export const IncidentStatus = z.enum(['OPEN', 'UNDER_INVESTIGATION', 'CLOSED']);
export const TimeTrust = z.enum(['DEVICE_SYNCED', 'DEVICE_UNSYNCED', 'USER_CLAIMED', 'PAPER']);
/** A linked record: its aggregate type and id as the audit trail names them (e.g. batch, mbr_version). */
const AggregateType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const AggregateId = z.string().trim().min(1).max(200);

export const IncidentSummaryView = z.strictObject({
  incidentId: Uuid,
  /** INC-000123. */
  reference: z.string().min(1),
  source: IncidentSource,
  incidentType: z.string().min(1),
  title: z.string().min(1),
  status: IncidentStatus,
  severity: IncidentSeverity,
  /** The highest severity it ever held: MAJOR or CRITICAL needs a root cause and a CAPA reference to close. */
  peakSeverity: IncidentSeverity,
  detectedBy: z.enum(['SYSTEM', 'USER']),
  raisedBy: PersonRef,
  recordedAt: Instant,
  certIn: z.strictObject({
    reportable: z.boolean(),
    /** The incident's recording plus the reporting window (records.cert_in_reporting_window). */
    deadlineAt: Instant.nullable(),
    overdue: z.boolean(),
    reportedAt: Instant.nullable(),
    reference: z.string().nullable(),
  }),
  links: z.number().int().min(0),
});
export type IncidentSummaryView = z.infer<typeof IncidentSummaryView>;

export const IncidentView = IncidentSummaryView.extend({
  description: z.string(),
  occurredAt: Instant.nullable(),
  occurredAtTrust: TimeTrust.nullable(),
  investigationStartedAt: Instant.nullable(),
  closure: z.strictObject({ at: Instant, by: PersonRef, summary: z.string(), rootCause: z.string().nullable(), capaRef: z.string().nullable() }).nullable(),
  linkedRecords: z.array(
    z.strictObject({
      aggregateType: z.string().min(1),
      aggregateId: z.string().min(1),
      stepRef: z.string().nullable(),
      linkedAt: Instant,
      /** The impact assessment for this record (it lifts the record's disposition block), null while none. */
      assessment: z.strictObject({ outcome: z.enum(['NO_IMPACT', 'IMPACT_DEVIATION_RAISED']), deviationRef: z.string().nullable(), rationale: z.string(), by: PersonRef, at: Instant }).nullable(),
    }),
  ),
  events: z.array(
    z.strictObject({
      event: z.enum(['INVESTIGATION_STARTED', 'SEVERITY_CHANGED', 'CERT_IN_REPORTABLE', 'CERT_IN_REPORTED', 'CLOSED']),
      severity: IncidentSeverity.nullable(),
      note: z.string().nullable(),
      by: PersonRef,
      at: Instant,
    }),
  ),
});
export type IncidentView = z.infer<typeof IncidentView>;

const incidentParams = z.strictObject({ incidentId: Uuid });
const Link = z.strictObject({ aggregateType: AggregateType, aggregateId: AggregateId, stepRef: Text(200).optional() });

export const incidents = {
  register: defineRoute({
    id: 'incidents.register',
    method: 'GET',
    path: '/api/incidents',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The incident register, open incidents first, with each CERT-In deadline and whether it has passed (DI-12)',
    query: z.strictObject({ status: IncidentStatus.optional() }),
    response: z.strictObject({ incidents: z.array(IncidentSummaryView), certInWindowHours: z.string().regex(/^[0-9]+(\.[0-9]+)?$/) }),
  }),
  detail: defineRoute({
    id: 'incidents.detail',
    method: 'GET',
    path: '/api/incidents/:incidentId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One incident with its linked records and their impact assessments, its events and its closure (DI-12)',
    params: incidentParams,
    response: IncidentView,
  }),
  raise: defineRoute({
    id: 'incidents.raise',
    method: 'POST',
    path: '/api/incidents',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Raise an incident with its severity and the records it affects (DI-12; INCIDENT.RAISE where the person works)',
    body: withAttribution({
      source: IncidentSource,
      incidentType: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      severity: IncidentSeverity,
      title: Text(200),
      description: z.string().trim().max(4000),
      links: z.array(Link).max(20),
      /** When it happened, if known, with how far that time is trusted (a person's claim is USER_CLAIMED). */
      occurredAt: z.iso.datetime({ offset: true }).optional(),
      occurredAtTrust: TimeTrust.optional(),
      certInReportable: z.boolean(),
    }),
    response: IncidentView,
  }),
  link: defineRoute({
    id: 'incidents.link',
    method: 'POST',
    path: '/api/incidents/:incidentId/links',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Link a further record to an incident that is not closed (DI-12; INCIDENT.RAISE)',
    params: incidentParams,
    body: withAttribution({ aggregateType: AggregateType, aggregateId: AggregateId, stepRef: Text(200).optional() }),
    response: IncidentView,
  }),
  startInvestigation: defineRoute({
    id: 'incidents.startInvestigation',
    method: 'POST',
    path: '/api/incidents/:incidentId/investigation',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Start the investigation of an OPEN incident (DI-12; INCIDENT.INVESTIGATE)',
    params: incidentParams,
    body: withAttribution({ note: Text(2000).optional() }),
    response: IncidentView,
  }),
  reclassify: defineRoute({
    id: 'incidents.reclassify',
    method: 'POST',
    path: '/api/incidents/:incidentId/severity',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Change an incident's severity with the justification; the peak severity still counts at closure (DI-12; INCIDENT.INVESTIGATE)",
    params: incidentParams,
    body: withAttribution({ severity: IncidentSeverity, justification: Text(2000) }),
    response: IncidentView,
  }),
  assessImpact: defineRoute({
    id: 'incidents.assessImpact',
    method: 'POST',
    path: '/api/incidents/:incidentId/assessments',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Assess the impact of an incident on one linked record; lifts that record\'s disposition block (DI-12; INCIDENT.INVESTIGATE, a person)',
    params: incidentParams,
    body: withAttribution({ aggregateType: AggregateType, aggregateId: AggregateId, outcome: z.enum(['NO_IMPACT', 'IMPACT_DEVIATION_RAISED']), rationale: Text(4000), deviationRef: Text(128).optional() }),
    response: IncidentView,
  }),
  markCertInReportable: defineRoute({
    id: 'incidents.markCertInReportable',
    method: 'POST',
    path: '/api/incidents/:incidentId/cert-in/reportable',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Mark an incident as reportable to CERT-In with the justification; its deadline starts from the incident (INCIDENT.CERT_IN_REPORT)',
    params: incidentParams,
    body: withAttribution({ justification: Text(2000) }),
    response: IncidentView,
  }),
  recordCertInReport: defineRoute({
    id: 'incidents.recordCertInReport',
    method: 'POST',
    path: '/api/incidents/:incidentId/cert-in/report',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: "Record the CERT-In report made through CERT-In's own channel: when (a claimed time) and the acknowledgement reference (INCIDENT.CERT_IN_REPORT)",
    params: incidentParams,
    body: withAttribution({ reportedAt: z.iso.datetime({ offset: true }), reference: Text(128) }),
    response: IncidentView,
  }),
  close: defineRoute({
    id: 'incidents.close',
    method: 'POST',
    path: '/api/incidents/:incidentId/close',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: true,
    attribution: 'FRESH_ON_SHARED',
    summary: 'Close an incident under investigation: a summary, and a root cause and CAPA reference when it was ever major or critical; a CERT-In reportable one only once reported (INCIDENT.CLOSE)',
    params: incidentParams,
    body: withAttribution({ summary: Text(4000), rootCause: Text(4000).optional(), capaRef: Text(128).optional() }),
    response: IncidentView,
  }),
};
