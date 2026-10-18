/**
 * The incident register's reads (Phase 7 slice 7g-2; contract ns/incidents.ts; kernel 0410). Every value is the
 * database's: the status, severity, peak severity and CERT-In deadline from records.incident_current, the deadline's
 * passing against the database's clock, the window from records.cert_in_reporting_window. Names are read for person ids.
 */
import type pg from 'pg';
import type { IncidentSummaryView, IncidentView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type People = Awaited<ReturnType<typeof peopleOf>>;

const us = (col: string): string => `case when ${col} is null then null else ${usOf(col)} end`;

interface Row {
  id: string; reference: string; source: IncidentSummaryView['source']; incident_type: string; title: string; description: string;
  status: IncidentSummaryView['status']; severity: IncidentSummaryView['severity']; peak_severity: IncidentSummaryView['severity'];
  detected_by: 'SYSTEM' | 'USER'; raised_by_person: string; recorded_us: string; cert_in_reportable: boolean; deadline_us: string | null;
  overdue: boolean; reported_us: string | null; cert_in_reference: string | null; links: number;
  occurred_us: string | null; occurred_at_trust: IncidentView['occurredAtTrust']; started_us: string | null;
  closed_us: string | null; closed_by_person: string | null; closure_summary: string | null; root_cause: string | null; capa_ref: string | null;
}

const SELECT = `
  select i.id, i.reference, i.source, i.incident_type, i.title, i.description, i.status, i.severity, i.peak_severity, i.detected_by,
         i.raised_by_person, ${usOf('i.recorded_at')} as recorded_us, i.cert_in_reportable, ${us('i.cert_in_deadline_at')} as deadline_us,
         (i.cert_in_reportable and i.cert_in_reported_at is null and i.cert_in_deadline_at < clock_timestamp()) as overdue,
         ${us('i.cert_in_reported_at')} as reported_us, i.cert_in_reference,
         (select count(*)::int from records.incident_link l where l.incident_id = i.id) as links,
         ${us('i.occurred_at')} as occurred_us, i.occurred_at_trust, ${us('i.investigation_started_at')} as started_us,
         ${us('i.closed_at')} as closed_us, i.closed_by_person, i.closure_summary, i.root_cause, i.capa_ref
    from records.incident_current i`;

function summary(app: AppContext, r: Row, people: People): IncidentSummaryView {
  return {
    incidentId: r.id, reference: r.reference, source: r.source, incidentType: r.incident_type, title: r.title, status: r.status,
    severity: r.severity, peakSeverity: r.peak_severity, detectedBy: r.detected_by, raisedBy: personRef(people, r.raised_by_person, r.detected_by === 'SYSTEM' ? 'SYSTEM' : 'RAISED_BY'),
    recordedAt: app.formatInstant(r.recorded_us),
    certIn: {
      reportable: r.cert_in_reportable,
      deadlineAt: r.deadline_us === null ? null : app.formatInstant(r.deadline_us),
      overdue: r.overdue,
      reportedAt: r.reported_us === null ? null : app.formatInstant(r.reported_us),
      reference: r.cert_in_reference,
    },
    links: r.links,
  };
}

export async function incidentRegister(app: AppContext, db: Db, status: IncidentSummaryView['status'] | undefined): Promise<{ incidents: IncidentSummaryView[]; certInWindowHours: string }> {
  const { rows } = await db.query<Row>(
    `${SELECT} where ($1::text is null or i.status = $1)
      order by case i.status when 'CLOSED' then 1 else 0 end, i.cert_in_deadline_at nulls last, i.recorded_at desc limit 500`,
    [status ?? null],
  );
  const people = await peopleOf(db, rows.map((r) => r.raised_by_person));
  const w = (await db.query<{ h: string }>("select trim_scale((extract(epoch from records.cert_in_reporting_window()) / 3600)::numeric)::text as h")).rows[0]?.h ?? '0';
  return { incidents: rows.map((r) => summary(app, r, people)), certInWindowHours: w };
}

export async function incidentDetail(app: AppContext, db: Db, incidentId: string): Promise<IncidentView> {
  const r = (await db.query<Row>(`${SELECT} where i.id = $1`, [incidentId])).rows[0];
  if (!r) {
    throw refusal(404, { code: 'EBMR-REC-051', kind: 'INVALID_INPUT', whatHappened: 'There is no incident with this id.', why: `Incident ${incidentId} does not exist.`, whatYouCanDo: ['Open the incident from the register.'], whoCanHelp: ['QA'], controls: ['DI-12'] });
  }
  const links = (await db.query<{ aggregate_type: string; aggregate_id: string; step_ref: string | null; linked_us: string; outcome: 'NO_IMPACT' | 'IMPACT_DEVIATION_RAISED' | null; deviation_ref: string | null; rationale: string | null; assessed_by: string | null; assessed_us: string | null }>(
    `select l.aggregate_type, l.aggregate_id, l.step_ref, ${usOf('l.recorded_at')} as linked_us, a.outcome, a.deviation_ref, a.rationale,
            a.assessed_by_person as assessed_by, ${us('a.recorded_at')} as assessed_us
       from records.incident_link l
       left join records.incident_assessment a on a.incident_id = l.incident_id and a.aggregate_type = l.aggregate_type and a.aggregate_id = l.aggregate_id
      where l.incident_id = $1 order by l.recorded_at, l.id`,
    [incidentId],
  )).rows;
  const events = (await db.query<{ event_type: IncidentView['events'][number]['event']; severity: IncidentView['events'][number]['severity']; note: string | null; report_reference: string | null; actor_person: string; at_us: string }>(
    `select e.event_type, e.severity, coalesce(e.note, e.closure_summary) as note, e.report_reference, e.actor_person, ${usOf('e.recorded_at')} as at_us
       from records.incident_event e where e.incident_id = $1 order by e.id`,
    [incidentId],
  )).rows;
  const people = await peopleOf(db, [r.raised_by_person, r.closed_by_person, ...links.map((l) => l.assessed_by), ...events.map((e) => e.actor_person)]);
  return {
    ...summary(app, r, people),
    description: r.description,
    occurredAt: r.occurred_us === null ? null : app.formatInstant(r.occurred_us),
    occurredAtTrust: r.occurred_at_trust,
    investigationStartedAt: r.started_us === null ? null : app.formatInstant(r.started_us),
    closure: r.closed_us !== null && r.closed_by_person !== null
      ? { at: app.formatInstant(r.closed_us), by: personRef(people, r.closed_by_person, 'CLOSED_BY'), summary: r.closure_summary ?? '', rootCause: r.root_cause, capaRef: r.capa_ref }
      : null,
    linkedRecords: links.map((l) => ({
      aggregateType: l.aggregate_type,
      aggregateId: l.aggregate_id,
      stepRef: l.step_ref,
      linkedAt: app.formatInstant(l.linked_us),
      assessment: l.outcome && l.assessed_by && l.assessed_us
        ? { outcome: l.outcome, deviationRef: l.deviation_ref, rationale: l.rationale ?? '', by: personRef(people, l.assessed_by, 'ASSESSED_BY'), at: app.formatInstant(l.assessed_us) }
        : null,
    })),
    events: events.map((e) => ({
      event: e.event_type,
      severity: e.severity,
      note: e.event_type === 'CERT_IN_REPORTED' ? `Reference ${e.report_reference ?? ''}` : e.note,
      by: personRef(people, e.actor_person, e.event_type),
      at: app.formatInstant(e.at_us),
    })),
  };
}
