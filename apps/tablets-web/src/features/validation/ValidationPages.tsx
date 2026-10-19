/**
 * The validation screens (Phase 7 slice 7g-3; decision 0025): the hub, the approved system description (DI-06, under a
 * change record, DI-09), the validation summary of the running release and QA's signed approval (DI-03), the shipped
 * evidence bundle and the validation pack generated from it, and the IQ of this installation with its stored records.
 * Every value, right and refusal is the server's and the database's.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Choice, Download, VALIDATION_READS, words } from './shared.tsx';

const PAGES: readonly { to: string; title: string; what: string }[] = [
  { to: '/validation/summary', title: 'Validation summary', what: 'The running release, its validation summary and QA\'s signed approval.' },
  { to: '/validation/system-description', title: 'System description', what: 'Every interface of the installation, described under a change record.' },
  { to: '/validation/evidence', title: 'Evidence bundle and validation pack', what: 'The release\'s evidence as shipped and the documents generated from it.' },
  { to: '/validation/iq', title: 'Installation qualification', what: 'The IQ checks of this installation and their records.' },
  { to: '/validation/full-export', title: 'Full export', what: 'Every closed record with its audit trail and signatures, for the stand-alone viewer.' },
  { to: '/validation/evaluation-packs', title: 'Periodic evaluation', what: 'The evaluation pack of a period and QA\'s sign-off.' },
  { to: '/validation/record-types', title: 'Record types', what: 'The record-type register: define and approve.' },
  { to: '/validation/retention', title: 'Retention, holds and disposal', what: 'A record\'s retention, legal holds and the approval of its disposal.' },
  { to: '/validation/di-investigations', title: 'Data-integrity investigations', what: 'Open, link, refresh and close.' },
  { to: '/validation/meaning-types', title: 'Signature catalogue', what: 'The meaning types of electronic signatures and customer signature points.' },
  { to: '/validation/seal-keys', title: 'Record-seal keys', what: 'The keys that seal signatures, and their retirement.' },
];

export function ValidationHubPage() {
  return (
    <>
      <h1>Validation and records</h1>
      <p>The validation of this installation and the records register, each act on its own screen.</p>
      <ul data-testid="validation-pages">
        {PAGES.map((p) => (
          <li key={p.to}>
            <Link to={p.to}>{p.title}</Link>: {p.what}
          </li>
        ))}
      </ul>
    </>
  );
}

const SOURCES = ['ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3'] as const;

export function SystemDescriptionPage() {
  const q = useApiQuery(routes.validation.systemDescription);
  const describe = useCommand(routes.validation.describeInterface, VALIDATION_READS);
  const [adapterCode, setAdapterCode] = useState('');
  const [sourceSystem, setSourceSystem] = useState<(typeof SOURCES)[number]>('ERP_WMS');
  const [endpointHost, setEndpointHost] = useState('');
  const [transport, setTransport] = useState<'LOOPBACK' | 'MTLS'>('MTLS');
  const [signedFeed, setSignedFeed] = useState(false);
  const [status, setStatus] = useState<'DESCRIBED' | 'WITHDRAWN'>('DESCRIBED');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const ok = /^[A-Z][A-Z0-9_-]{1,63}$/.test(adapterCode) && endpointHost.trim() !== '' && changeRecord.trim() !== '' && reason.trim() !== '';
  return (
    <>
      <h1>System description</h1>
      <p>The approved description of every interface: its source system, endpoint, transport and whether its feed is signed. An adapter it does not describe may not start.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.undescribed.length > 0 ? (
        <Banner tone="warning" title="Active adapters the description does not describe">
          <p data-testid="undescribed">{q.data.undescribed.join(', ')}</p>
        </Banner>
      ) : null}
      <Section title="Interfaces" testId="system-interfaces">
        {q.data && q.data.interfaces.length === 0 ? <p>No interface is described.</p> : null}
        <ul>
          {q.data?.interfaces.map((i) => (
            <li key={i.adapterCode} data-testid={`interface-${i.adapterCode}`} data-status={i.status}>
              <strong>{i.adapterCode}</strong> {words(i.sourceSystem)} at {i.endpointHost} over {i.transport === 'MTLS' ? 'mutual TLS' : 'loopback'},{' '}
              {i.signedFeed ? 'signed feed' : 'unsigned feed'} <StatusChip tone={i.status === 'DESCRIBED' ? 'ok' : 'neutral'} label={words(i.status)} /> since {i.validFrom.text}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Describe an interface" testId="describe-interface">
        <Field name="adapterCode" label="Adapter code" value={adapterCode} onChange={setAdapterCode} />
        <Choice name="sourceSystem" label="Source system" value={sourceSystem} options={SOURCES} onChange={setSourceSystem} />
        <Field name="endpointHost" label="Endpoint host" value={endpointHost} onChange={setEndpointHost} />
        <Choice name="transport" label="Transport" value={transport} options={['MTLS', 'LOOPBACK'] as const} onChange={setTransport} />
        <label style={{ display: 'block' }}>
          <input type="checkbox" name="signedFeed" checked={signedFeed} onChange={(e) => setSignedFeed(e.target.checked)} /> The feed is signed
        </label>
        <Choice name="status" label="Status" value={status} options={['DESCRIBED', 'WITHDRAWN'] as const} onChange={setStatus} />
        <Field name="changeRecord" label="Approved change record (number)" value={changeRecord} onChange={setChangeRecord} />
        <Field name="reason" label="Reason" value={reason} onChange={setReason} />
        <ActButton
          label="Record the interface"
          disabled={!ok || describe.busy}
          onPress={() => describe.run({ body: { adapterCode, sourceSystem, endpointHost: endpointHost.trim(), transport, signedFeed, status, changeRecord: changeRecord.trim(), reason: reason.trim() } })}
        />
        <ActResult error={describe.error} done={describe.done} label="Recorded in the system description." />
      </Section>
    </>
  );
}

export function ValidationSummaryPage() {
  const q = useApiQuery(routes.validation.summary);
  const signed = useSignedAct(VALIDATION_READS);
  const v = q.data;
  const d = v?.document ?? null;
  const approved = d ? v?.approvals.some((a) => a.schemaRelease === d.schemaRelease && a.summarySha256 === d.sha256) : false;
  return (
    <>
      <h1>Validation summary</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <p data-testid="running-release">
          This database runs release <code>{v.runningRelease}</code>.
        </p>
      ) : null}
      {v?.problem ? (
        <Banner tone="warning" title="No approved validation summary">
          <p data-testid="summary-problem">{v.problem}</p>
        </Banner>
      ) : v ? (
        <Banner tone="ok" title="The running release has an approved validation summary." />
      ) : null}
      <Section title="The summary document" testId="summary-document">
        {v?.documentProblem ? <p data-testid="summary-document-problem">{v.documentProblem}</p> : null}
        {d ? (
          <>
            <p>
              {d.title}, SHA-256 <code data-testid="summary-sha256">{d.sha256}</code>
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '28rem', overflow: 'auto' }}>{d.markdown}</pre>
            {d.forRunningRelease && !approved ? (
              <>
                <ActButton
                  label="Approve the validation summary (signature)"
                  disabled={signed.busy}
                  onPress={() => signed.sign({ kind: 'VALIDATION_SUMMARY_APPROVE', schemaRelease: d.schemaRelease, summarySha256: d.sha256, title: d.title }, 'Approve the validation summary')}
                />
                <ActResult error={signed.error} outcome={signed.outcome} />
              </>
            ) : null}
          </>
        ) : null}
      </Section>
      <Section title="Approvals" testId="summary-approvals">
        {v && v.approvals.length === 0 ? <p>No validation summary is approved.</p> : null}
        <ul>
          {v?.approvals.map((a) => (
            <li key={a.signatureId}>
              {a.title}: approved by {a.approvedBy} at {a.approvedAt.text} (release <code>{a.schemaRelease.slice(0, 12)}</code>, summary <code>{a.summarySha256.slice(0, 12)}</code>)
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function EvidencePage() {
  const q = useApiQuery(routes.validation.evidence);
  const v = q.data;
  return (
    <>
      <h1>Evidence bundle and validation pack</h1>
      <p>The evidence bundle shipped with the release, and every document of the validation pack generated from it (the same bytes as the release build).</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v && !v.configured ? (
        <Banner tone="warning" title="No evidence bundle on this server">
          <p data-testid="evidence-problem">{v.problem}</p>
        </Banner>
      ) : null}
      {v?.release ? (
        <Section title="Evidence bundle" testId="evidence-bundle">
          <p>
            {v.release.product} {v.release.version} ({v.release.edition}), commit {v.release.commit}; bundle SHA-256 <code data-testid="bundle-sha256">{v.bundleSha256}</code>
          </p>
          {v.release.schemaRelease !== v.runningRelease ? <p data-testid="bundle-other-release">The bundle is for another schema release than this database runs.</p> : null}
          <Download label="Download the evidence bundle" route={routes.validation.evidenceFile} input={{ query: { path: 'bundle.json' } }} pick={(f) => ({ name: f.path, text: f.content, mediaType: f.mediaType })} testId="download-bundle" />
        </Section>
      ) : null}
      <Section title="Validation pack" testId="validation-pack">
        <ul>
          {v?.documents.map((d) => (
            <li key={d.id} data-testid={`pack-doc-${d.id}`}>
              {d.title} <StatusChip tone="info" label={d.status} />{' '}
              {d.files.map((f) => (
                <Download key={f.path} label={`Download ${f.path}`} route={routes.validation.evidenceFile} input={{ query: { path: f.path } }} pick={(x) => ({ name: x.path, text: x.content, mediaType: x.mediaType })} testId={`download-${f.path}`} />
              ))}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function IqPage() {
  const q = useApiQuery(routes.validation.iqRecords);
  const run = useCommand(routes.validation.runIq, VALIDATION_READS);
  const [reason, setReason] = useState('');
  const v = q.data;
  return (
    <>
      <h1>Installation qualification</h1>
      <p>The IQ checks this installation against the release&apos;s evidence bundle (migrations, triggers, constraints, privileges, roles, settings, keys, interfaces) and stores the record.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v && !v.configured ? (
        <Banner tone="warning" title="No evidence bundle on this server">
          <p>{v.problem}</p>
        </Banner>
      ) : null}
      <Section title="Run the IQ" testId="iq-run">
        <Field name="iq-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
        <ActButton label="Run the IQ checks" disabled={reason.trim() === '' || run.busy || v?.configured === false} onPress={() => run.run({ body: { reason: reason.trim() } })} />
        {run.busy ? <p>Checking the installation…</p> : null}
        <ActResult error={run.error} done={run.done} label={run.done ? run.done.summary : 'Done.'} />
      </Section>
      <Section title="IQ records" testId="iq-records">
        {v && v.records.length === 0 ? <p>No IQ has been run here.</p> : null}
        {v?.records.map((r) => (
          <article key={r.iqId} data-testid={`iq-${r.iqId}`} data-passed={String(r.passed)}>
            <h3>
              <StatusChip tone={r.passed ? 'ok' : 'error'} label={r.passed ? 'Passed' : 'Failed'} /> {r.at.text}, by {r.by}
            </h3>
            <p>
              {r.summary}. Record SHA-256 <code>{r.recordSha256}</code>
            </p>
            <ul>
              {r.checks.map((c) => (
                <li key={c.id} data-testid={`iq-${r.iqId}-${c.id}`}>
                  {c.passed ? 'Passed' : 'Failed'}: {c.id} {c.name} ({c.actual}){c.problems.length > 0 ? `: ${c.problems.join('; ')}` : ''}
                </li>
              ))}
            </ul>
            <Download label="Download the record" route={routes.validation.iqRecordFile} input={{ params: { iqId: r.iqId } }} pick={(f) => ({ name: `iq-record-${f.iqId}.json`, text: f.content, mediaType: 'application/json' })} testId={`iq-download-${r.iqId}`} />
          </article>
        ))}
      </Section>
    </>
  );
}
