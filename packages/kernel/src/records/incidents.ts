/**
 * DI-12 incident register. Wrappers over the SECURITY DEFINER functions in migration 0410; call them
 * inside withCommand. Automatic incidents (interface failures, lost connections, crashes, repeated
 * signature failures, time-sync faults, print failures, integrity-check failures) are raised by the
 * detecting component under a SYSTEM or INTEGRATION actor.
 */
import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export type IncidentSource =
  | 'INTERFACE_FAILURE'
  | 'CONNECTION_LOSS'
  | 'CRASH'
  | 'SIGNATURE_FAILURE'
  | 'TIME_SYNC'
  | 'PRINT_FAILURE'
  | 'INTEGRITY_CHECK'
  | 'SECURITY'
  | 'DATA_INTEGRITY'
  | 'OTHER';
export type IncidentSeverity = 'MINOR' | 'MAJOR' | 'CRITICAL';
export type TimeTrust = 'DEVICE_SYNCED' | 'DEVICE_UNSYNCED' | 'USER_CLAIMED' | 'PAPER';

export interface IncidentLink {
  aggregateType: string;
  aggregateId: string;
  stepRef?: string;
}

export interface RaiseIncident {
  source: IncidentSource;
  /** Upper-case code of what happened, e.g. BALANCE_INTERFACE_LOST. */
  type: string;
  severity: IncidentSeverity;
  title: string;
  description?: string;
  links?: IncidentLink[];
  /** Claimed time of the event (from the detecting device), with its trust level (outline 5.6). */
  occurredAt?: { at: Date; trust: TimeTrust };
  /** CERT-In reportable (6-hour window from secondary sources; verify). */
  certInReportable?: boolean;
}

export interface IncidentState {
  id: string;
  reference: string;
  status: 'OPEN' | 'UNDER_INVESTIGATION' | 'CLOSED';
  severity: IncidentSeverity;
  peakSeverity: IncidentSeverity;
  certInReportable: boolean;
  certInDeadlineAt: Date | null;
  certInReportedAt: Date | null;
  rootCause: string | null;
  capaRef: string | null;
  closedAt: Date | null;
}

export async function raiseIncident(db: Db, input: RaiseIncident): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'select records.raise_incident($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) as id',
    [
      input.source,
      input.type,
      input.severity,
      input.title,
      input.description ?? '',
      JSON.stringify(input.links ?? []),
      input.occurredAt?.at ?? null,
      input.occurredAt?.trust ?? null,
      input.certInReportable ?? false,
    ],
  );
  return rows[0]?.id ?? '';
}

export async function linkIncident(db: Db, incidentId: string, link: IncidentLink): Promise<void> {
  await db.query('select records.link_incident($1, $2, $3, $4)', [incidentId, link.aggregateType, link.aggregateId, link.stepRef ?? null]);
}

export async function reclassifyIncident(db: Db, incidentId: string, severity: IncidentSeverity, justification: string): Promise<void> {
  await db.query('select records.reclassify_incident($1, $2, $3)', [incidentId, severity, justification]);
}

export async function startIncidentInvestigation(db: Db, incidentId: string, note?: string): Promise<void> {
  await db.query('select records.start_incident_investigation($1, $2)', [incidentId, note ?? null]);
}

export async function markIncidentCertInReportable(db: Db, incidentId: string, justification: string): Promise<void> {
  await db.query('select records.mark_incident_cert_in_reportable($1, $2)', [incidentId, justification]);
}

export async function recordCertInReport(db: Db, incidentId: string, reportedAt: Date, reference: string): Promise<void> {
  await db.query('select records.record_cert_in_report($1, $2, $3)', [incidentId, reportedAt, reference]);
}

export async function assessIncidentImpact(
  db: Db,
  incidentId: string,
  target: { aggregateType: string; aggregateId: string },
  outcome: 'NO_IMPACT' | 'IMPACT_DEVIATION_RAISED',
  rationale: string,
  deviationRef?: string,
): Promise<void> {
  await db.query('select records.assess_incident_impact($1, $2, $3, $4, $5, $6)', [
    incidentId,
    target.aggregateType,
    target.aggregateId,
    outcome,
    rationale,
    deviationRef ?? null,
  ]);
}

/** MAJOR or CRITICAL (at any time) needs rootCause and capaRef; refused otherwise (EBMR-REC-053). */
export async function closeIncident(db: Db, incidentId: string, closure: { summary: string; rootCause?: string; capaRef?: string }): Promise<void> {
  await db.query('select records.close_incident($1, $2, $3, $4)', [incidentId, closure.summary, closure.rootCause ?? null, closure.capaRef ?? null]);
}

export async function incidentState(db: Db, incidentId: string): Promise<IncidentState | undefined> {
  const { rows } = await db.query<{
    id: string;
    reference: string;
    status: IncidentState['status'];
    severity: IncidentSeverity;
    peak_severity: IncidentSeverity;
    cert_in_reportable: boolean;
    cert_in_deadline_at: Date | null;
    cert_in_reported_at: Date | null;
    root_cause: string | null;
    capa_ref: string | null;
    closed_at: Date | null;
  }>('select * from records.incident_current where id = $1', [incidentId]);
  const r = rows[0];
  if (!r) return undefined;
  return {
    id: r.id,
    reference: r.reference,
    status: r.status,
    severity: r.severity,
    peakSeverity: r.peak_severity,
    certInReportable: r.cert_in_reportable,
    certInDeadlineAt: r.cert_in_deadline_at,
    certInReportedAt: r.cert_in_reported_at,
    rootCause: r.root_cause,
    capaRef: r.capa_ref,
    closedAt: r.closed_at,
  };
}
