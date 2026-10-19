/**
 * The incident register (Phase 7 slice 7g-2, decision 0025; DI-12; kernel 0410): every incident with its status,
 * severity and CERT-In deadline, open ones first, and the form to raise one with the records it affects. Most roles may
 * raise an incident (INCIDENT.RAISE where they work); the database refuses anyone else in its own words.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type IncidentSummaryView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { INCIDENT_READS, SEVERITIES, SOURCES, severityTone, statusTone, words } from './reads.ts';

export function IncidentsPage() {
  const [status, setStatus] = useState('');
  const q = useApiQuery(routes.incidents.register, { query: status ? { status: status as IncidentSummaryView['status'] } : {} });
  const pending = q.data?.incidents.filter((i) => i.certIn.reportable && !i.certIn.reportedAt) ?? [];
  return (
    <>
      <h1>Incident register</h1>
      <p>
        Interface failures, lost connections, crashes, repeated signature failures, time-sync faults, print failures, integrity-check failures and incidents raised by a person.
        A record linked to an open incident is blocked for disposition until the incident is closed or assessed for that record.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="CERT-In reports due" testId="cert-in-due">
        <p>
          A cyber incident reportable to CERT-In is reported within {q.data?.certInWindowHours ?? '…'} hours of the incident (the window as configured; confirm it with your
          legal team). The report is made through CERT-In&apos;s own channel; it is recorded here.
        </p>
        {pending.length === 0 ? <p>No CERT-In report is due.</p> : null}
        <ul>
          {pending.map((i) => (
            <li key={i.incidentId} data-testid={`cert-in-due-${i.reference}`} data-overdue={i.certIn.overdue ? 'yes' : 'no'}>
              <Link to="/incidents/$incidentId" params={{ incidentId: i.incidentId }}>
                {i.reference}
              </Link>{' '}
              {i.title}: due {i.certIn.deadlineAt?.text ?? ''} {i.certIn.overdue ? <StatusChip tone="error" label="Overdue" /> : <StatusChip tone="warning" label="Due" />}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Incidents" testId="incident-register">
        <floor.ChoiceGroup
          label="Show"
          options={[
            { value: '', label: 'All' },
            { value: 'OPEN', label: 'Open' },
            { value: 'UNDER_INVESTIGATION', label: 'Under investigation' },
            { value: 'CLOSED', label: 'Closed' },
          ]}
          value={status}
          onChange={setStatus}
        />
        {q.data && q.data.incidents.length === 0 ? <p>No incident.</p> : null}
        <ul>
          {q.data?.incidents.map((i) => (
            <li key={i.incidentId} data-testid={`incident-${i.reference}`} data-status={i.status}>
              <Link to="/incidents/$incidentId" params={{ incidentId: i.incidentId }}>
                {i.reference}
              </Link>{' '}
              {i.title} <StatusChip tone={statusTone(i.status)} label={words(i.status)} /> <StatusChip tone={severityTone(i.severity)} label={words(i.severity)} />
              <br />
              {words(i.source)}, {i.incidentType}; raised {i.detectedBy === 'SYSTEM' ? 'by the system' : `by ${i.raisedBy.legalName}`} {i.recordedAt.text}; {i.links} linked record
              {i.links === 1 ? '' : 's'}
              {i.certIn.reportable ? `; CERT-In ${i.certIn.reportedAt ? `reported ${i.certIn.reportedAt.text} (${i.certIn.reference ?? ''})` : `due ${i.certIn.deadlineAt?.text ?? ''}`}` : ''}
            </li>
          ))}
        </ul>
      </Section>
      <Raise />
    </>
  );
}

function Raise() {
  const raise = useCommand(routes.incidents.raise, INCIDENT_READS);
  const [source, setSource] = useState('OTHER');
  const [type, setType] = useState('');
  const [severity, setSeverity] = useState('MINOR');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [aggregateType, setAggregateType] = useState('');
  const [aggregateId, setAggregateId] = useState('');
  const [certIn, setCertIn] = useState('no');
  const linkOk = (aggregateType.trim() === '') === (aggregateId.trim() === '') && (aggregateType.trim() === '' || /^[a-z][a-z0-9_]{0,63}$/.test(aggregateType.trim()));
  const ok = /^[A-Z][A-Z0-9_]{1,63}$/.test(type.trim()) && title.trim() !== '' && linkOk;
  return (
    <Section title="Raise an incident" testId="incident-raise">
      <floor.ChoiceGroup label="Source" options={SOURCES.map((s) => ({ value: s, label: words(s) }))} value={source} onChange={setSource} />
      <Field name="incidentType" label="Type (an upper-case code, e.g. PRINTER_JAM)" value={type} onChange={setType} />
      <floor.ChoiceGroup label="Severity" options={SEVERITIES.map((s) => ({ value: s, label: words(s) }))} value={severity} onChange={setSeverity} />
      <Field name="incidentTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="incidentDescription" label="What happened" value={description} onChange={setDescription} />
      <Field name="linkType" label="Affected record: type (e.g. batch; empty when none)" value={aggregateType} onChange={setAggregateType} />
      <Field name="linkId" label="Affected record: id" value={aggregateId} onChange={setAggregateId} />
      <floor.ChoiceGroup
        label="Reportable to CERT-In (a cyber incident)"
        options={[
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ]}
        value={certIn}
        onChange={setCertIn}
      />
      <ActButton
        label="Raise the incident"
        onPress={() =>
          ok &&
          raise.run({
            body: {
              source: source as IncidentSummaryView['source'], incidentType: type.trim(), severity: severity as IncidentSummaryView['severity'], title: title.trim(), description: description.trim(),
              links: aggregateType.trim() ? [{ aggregateType: aggregateType.trim(), aggregateId: aggregateId.trim() }] : [], certInReportable: certIn === 'yes',
            },
          })
        }
        disabled={!ok || raise.busy}
      />
      <ActResult error={raise.error} done={raise.done} label={raise.done ? `Incident ${raise.done.reference} is raised.` : 'Raised.'} />
    </Section>
  );
}
