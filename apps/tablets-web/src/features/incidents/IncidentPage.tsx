/**
 * One incident (Phase 7 slice 7g-2, decision 0025; DI-12; kernel 0410): its linked records with their impact
 * assessments, its events and its closure, and the acts on it: link a further record (INCIDENT.RAISE), start the
 * investigation, change the severity, assess the impact on a linked record (INCIDENT.INVESTIGATE), mark it reportable to
 * CERT-In and record the report made (INCIDENT.CERT_IN_REPORT), close it (INCIDENT.CLOSE: a root cause and a CAPA
 * reference when it was ever major or critical; a reportable one only once reported). Every act is offered; the database
 * decides and its refusal is shown in its own words.
 */
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type IncidentView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { claimedTime, INCIDENT_READS, SEVERITIES, severityTone, statusTone, words } from './reads.ts';

export function IncidentPage() {
  const params: { incidentId?: string } = useParams({ strict: false });
  const q = useApiQuery(routes.incidents.detail, { params: { incidentId: params.incidentId ?? '' } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading…</p>;
  const i = q.data;
  const open = i.status !== 'CLOSED';
  return (
    <>
      <nav aria-label="Breadcrumb">
        <Link to="/incidents">Incident register</Link> / {i.reference}
      </nav>
      <h1>
        {i.reference}: {i.title}
      </h1>
      <p data-testid="incident-state" data-status={i.status}>
        <StatusChip tone={statusTone(i.status)} label={words(i.status)} /> <StatusChip tone={severityTone(i.severity)} label={words(i.severity)} />
        {i.peakSeverity !== i.severity ? ` (it was ${words(i.peakSeverity).toLowerCase()}: that still counts at closure)` : ''}
        <br />
        {words(i.source)}, {i.incidentType}; raised {i.detectedBy === 'SYSTEM' ? 'by the system' : `by ${i.raisedBy.legalName}`} {i.recordedAt.text}
        {i.occurredAt ? `; occurred ${i.occurredAt.text} (${words(i.occurredAtTrust ?? '').toLowerCase()})` : ''}
        {i.investigationStartedAt ? `; investigation started ${i.investigationStartedAt.text}` : ''}
      </p>
      {i.description ? <p>{i.description}</p> : null}
      <Linked i={i} />
      <CertIn i={i} />
      <Section title="History" testId="incident-events">
        {i.events.length === 0 ? <p>No event yet.</p> : null}
        <ul>
          {i.events.map((e, n) => (
            <li key={n}>
              {words(e.event)}
              {e.severity ? ` to ${words(e.severity).toLowerCase()}` : ''} by {e.by.legalName} {e.at.text}
              {e.note ? `: ${e.note}` : ''}
            </li>
          ))}
        </ul>
        {i.closure ? (
          <p data-testid="incident-closure">
            Closed by {i.closure.by.legalName} {i.closure.at.text}: {i.closure.summary}
            {i.closure.rootCause ? ` Root cause: ${i.closure.rootCause}.` : ''}
            {i.closure.capaRef ? ` CAPA ${i.closure.capaRef}.` : ''}
          </p>
        ) : null}
      </Section>
      {open ? <Investigation i={i} /> : null}
    </>
  );
}

function Linked({ i }: { i: IncidentView }) {
  const link = useCommand(routes.incidents.link, INCIDENT_READS);
  const [type, setType] = useState('');
  const [id, setId] = useState('');
  const ok = /^[a-z][a-z0-9_]{0,63}$/.test(type.trim()) && id.trim() !== '';
  return (
    <Section title="Linked records" testId="incident-links">
      <p>Each linked record stays blocked for disposition until the incident is closed or its impact on that record is assessed.</p>
      {i.linkedRecords.length === 0 ? <p>No record is linked.</p> : null}
      <ul>
        {i.linkedRecords.map((l) => (
          <Linkedrecord key={`${l.aggregateType}:${l.aggregateId}:${l.stepRef ?? ''}`} i={i} l={l} />
        ))}
      </ul>
      {i.status !== 'CLOSED' ? (
        <>
          <Field name="linkType" label="Record type (e.g. batch)" value={type} onChange={setType} />
          <Field name="linkId" label="Record id" value={id} onChange={setId} />
          <ActButton primary={false} label="Link the record" onPress={() => ok && link.run({ params: { incidentId: i.incidentId }, body: { aggregateType: type.trim(), aggregateId: id.trim() } })} disabled={!ok || link.busy} />
          <ActResult error={link.error} done={link.done} label="The record is linked." />
        </>
      ) : null}
    </Section>
  );
}

function Linkedrecord({ i, l }: { i: IncidentView; l: IncidentView['linkedRecords'][number] }) {
  const assess = useCommand(routes.incidents.assessImpact, INCIDENT_READS);
  const [outcome, setOutcome] = useState('NO_IMPACT');
  const [rationale, setRationale] = useState('');
  const [deviation, setDeviation] = useState('');
  const key = `${l.aggregateType}:${l.aggregateId}`;
  const ok = rationale.trim() !== '' && (outcome === 'NO_IMPACT' || deviation.trim() !== '');
  return (
    <li data-testid={`link-${key}`} data-assessed={l.assessment ? 'yes' : 'no'}>
      {key}
      {l.stepRef ? ` step ${l.stepRef}` : ''}, linked {l.linkedAt.text}
      {l.assessment ? `: assessed ${words(l.assessment.outcome).toLowerCase()} by ${l.assessment.by.legalName} ${l.assessment.at.text}: ${l.assessment.rationale}${l.assessment.deviationRef ? ` (deviation ${l.assessment.deviationRef})` : ''}` : ': not assessed'}
      {!l.assessment && i.status !== 'CLOSED' ? (
        <div>
          <floor.ChoiceGroup
            label={`Impact on ${key}`}
            options={[
              { value: 'NO_IMPACT', label: 'No impact' },
              { value: 'IMPACT_DEVIATION_RAISED', label: 'Impact: a deviation is raised' },
            ]}
            value={outcome}
            onChange={setOutcome}
          />
          <Field name={`rationale-${key}`} label={`Rationale for ${key}`} value={rationale} onChange={setRationale} />
          {outcome === 'IMPACT_DEVIATION_RAISED' ? <Field name={`deviation-${key}`} label="Deviation reference" value={deviation} onChange={setDeviation} /> : null}
          <ActButton
            primary={false}
            label={`Record the impact on ${key}`}
            onPress={() =>
              ok &&
              assess.run({
                params: { incidentId: i.incidentId },
                body: { aggregateType: l.aggregateType, aggregateId: l.aggregateId, outcome: outcome === 'NO_IMPACT' ? 'NO_IMPACT' : 'IMPACT_DEVIATION_RAISED', rationale: rationale.trim(), ...(deviation.trim() ? { deviationRef: deviation.trim() } : {}) },
              })
            }
            disabled={!ok || assess.busy}
          />
          <ActResult error={assess.error} done={assess.done} label="The impact is recorded." />
        </div>
      ) : null}
    </li>
  );
}

function CertIn({ i }: { i: IncidentView }) {
  const mark = useCommand(routes.incidents.markCertInReportable, INCIDENT_READS);
  const report = useCommand(routes.incidents.recordCertInReport, INCIDENT_READS);
  const [justification, setJustification] = useState('');
  const [at, setAt] = useState('');
  const [reference, setReference] = useState('');
  const reportedAt = claimedTime(at);
  const c = i.certIn;
  return (
    <Section title="CERT-In reporting" testId="incident-cert-in">
      {c.reportable ? (
        <p data-testid="cert-in-status" data-reported={c.reportedAt ? 'yes' : 'no'}>
          Reportable to CERT-In: due {c.deadlineAt?.text ?? ''} {c.overdue ? <StatusChip tone="error" label="Overdue" /> : null}
          {c.reportedAt ? `; reported ${c.reportedAt.text}, acknowledgement ${c.reference ?? ''}` : '; not reported yet.'}
        </p>
      ) : (
        <p data-testid="cert-in-status" data-reported="no">
          Not marked reportable to CERT-In.
        </p>
      )}
      {i.status !== 'CLOSED' && !c.reportable ? (
        <>
          <Field name="certInJustification" label="Why it is reportable to CERT-In" value={justification} onChange={setJustification} />
          <ActButton
            primary={false}
            label="Mark reportable to CERT-In"
            onPress={() => justification.trim() && mark.run({ params: { incidentId: i.incidentId }, body: { justification: justification.trim() } })}
            disabled={!justification.trim() || mark.busy}
          />
          <ActResult error={mark.error} done={mark.done} label="Marked reportable: the deadline runs from the incident." />
        </>
      ) : null}
      {c.reportable && !c.reportedAt ? (
        <>
          <Field name="certInReportedAt" label="When the report was made (e.g. 2026-10-18T10:15+05:30)" value={at} onChange={setAt} />
          <Field name="certInReference" label="CERT-In acknowledgement reference" value={reference} onChange={setReference} />
          <ActButton
            label="Record the CERT-In report"
            onPress={() => reportedAt && reference.trim() && report.run({ params: { incidentId: i.incidentId }, body: { reportedAt, reference: reference.trim() } })}
            disabled={!reportedAt || !reference.trim() || report.busy}
          />
          <ActResult error={report.error} done={report.done} label="The CERT-In report is recorded." />
        </>
      ) : null}
    </Section>
  );
}

function Investigation({ i }: { i: IncidentView }) {
  const start = useCommand(routes.incidents.startInvestigation, INCIDENT_READS);
  const reclassify = useCommand(routes.incidents.reclassify, INCIDENT_READS);
  const close = useCommand(routes.incidents.close, INCIDENT_READS);
  const [note, setNote] = useState('');
  const [severity, setSeverity] = useState<string>(i.severity);
  const [justification, setJustification] = useState('');
  const [summary, setSummary] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [capa, setCapa] = useState('');
  return (
    <Section title="Investigation and closure" testId="incident-investigation">
      {i.status === 'OPEN' ? (
        <>
          <Field name="investigationNote" label="Note (optional)" value={note} onChange={setNote} />
          <ActButton label="Start the investigation" onPress={() => start.run({ params: { incidentId: i.incidentId }, body: note.trim() ? { note: note.trim() } : {} })} disabled={start.busy} />
          <ActResult error={start.error} done={start.done} label="The investigation is started." />
        </>
      ) : null}
      <floor.ChoiceGroup label="Severity" options={SEVERITIES.map((s) => ({ value: s, label: words(s) }))} value={severity} onChange={setSeverity} />
      <Field name="severityJustification" label="Justification of the new severity" value={justification} onChange={setJustification} />
      <ActButton
        primary={false}
        label="Change the severity"
        onPress={() => justification.trim() && reclassify.run({ params: { incidentId: i.incidentId }, body: { severity: severity as IncidentView['severity'], justification: justification.trim() } })}
        disabled={!justification.trim() || reclassify.busy}
      />
      <ActResult error={reclassify.error} done={reclassify.done} label="The severity is changed." />
      <h3>Close</h3>
      <p>
        An incident is closed once under investigation. If it was ever major or critical it needs a root cause and a CAPA reference; one reportable to CERT-In is closed only once
        its report is recorded.
      </p>
      <Field name="closureSummary" label="Closure summary" value={summary} onChange={setSummary} />
      <Field name="rootCause" label="Root cause" value={rootCause} onChange={setRootCause} />
      <Field name="capaRef" label="CAPA reference" value={capa} onChange={setCapa} />
      <ActButton
        label="Close the incident"
        onPress={() =>
          summary.trim() &&
          close.run({ params: { incidentId: i.incidentId }, body: { summary: summary.trim(), ...(rootCause.trim() ? { rootCause: rootCause.trim() } : {}), ...(capa.trim() ? { capaRef: capa.trim() } : {}) } })
        }
        disabled={!summary.trim() || close.busy}
      />
      <ActResult error={close.error} done={close.done} label="The incident is closed." />
    </Section>
  );
}
