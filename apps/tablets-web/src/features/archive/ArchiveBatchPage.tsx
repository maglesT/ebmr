/**
 * One batch in the archive (Phase 4 slice 6b): its retention (computed by the database from the record; a deletion
 * request is answered and logged, never carried out), its contingency packs and their reconciliation (DI-43, PR-16), its
 * PDF/A-3 true copy (DI-41) and its evidence exports, certified by QA (IN-11). The acts offered are display only; the
 * server and the database decide each one.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type ArchiveBatchView, type ContingencyFormView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { ARCHIVE_READS, formTone, saveFile, words } from './reads.ts';

export function ArchiveBatchPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.archive.batch, { params: { batchId } });
  return (
    <>
      <p>
        <Link to="/archive">Archive</Link>
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          <h1>Batch {q.data.batchNumber}</h1>
          <p>Status: {words(q.data.status)}</p>
          <Retention v={q.data} />
          <Forms v={q.data} />
          <TrueCopy v={q.data} />
          <Exports v={q.data} />
        </>
      ) : null}
    </>
  );
}

function Retention({ v }: { v: ArchiveBatchView }) {
  const r = v.retention;
  const qa = useOffered('QA');
  const sync = useCommand(routes.archive.syncRetention, ARCHIVE_READS);
  const ask = useCommand(routes.archive.requestDisposal, ARCHIVE_READS);
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 10;
  return (
    <Section title="Retention" testId="archive-retention">
      <p data-testid="retention-date" data-status={r.status}>
        {r.status === 'DATED' ? `Kept at least until ${r.retainUntil ?? ''}` : 'Kept: no end date yet'}
        {r.governingRules.length > 0 ? ` (rules: ${r.governingRules.join(', ')})` : ''}
        {r.scheduled ? '' : ' (preview: no schedule stored yet)'}
      </p>
      {r.openBecause.length > 0 ? (
        <ul data-testid="retention-open">
          {r.openBecause.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      ) : null}
      <p>
        Markets {r.inputs.markets.join(', ')}; made {r.inputs.manufactureDate}; expiry {r.inputs.expiryDate ?? 'not set yet'}; EU {words(r.inputs.eu)}
        {r.inputs.euDate ? ` ${r.inputs.euDate}` : ''}; {words(r.inputs.outcome).toLowerCase()}
        {r.inputs.abortCancelDate ? ` ${r.inputs.abortCancelDate}` : ''}; licence {r.inputs.licenceForm ?? 'none'}.
      </p>
      {r.drift.length > 0 ? (
        <Banner tone="warning" title="The stored inputs differ from the record">
          <ul>
            {r.drift.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {r.disposalRequests.length > 0 ? (
        <ul data-testid="disposal-requests">
          {r.disposalRequests.map((d) => (
            <li key={`${d.at.us}-${d.by.personId}`}>
              {words(d.outcome)}: {d.reason} ({d.by.legalName}, {d.at.text})
            </li>
          ))}
        </ul>
      ) : null}
      {qa ? (
        <>
          <Field name="retentionReason" label="Reason (at least 10 characters)" value={reason} onChange={setReason} />
          <ActButton primary={false} label="Store the retention inputs" onPress={() => ok && sync.run({ params: { batchId: v.batchId }, body: { reason: reason.trim() } })} disabled={!ok || sync.busy} />
          <ActButton primary={false} label="Request deletion" onPress={() => ok && ask.run({ params: { batchId: v.batchId }, body: { reason: reason.trim() } })} disabled={!ok || ask.busy} />
          <ActResult error={sync.error ?? ask.error} done={sync.done} label="Retention inputs stored." />
          {ask.done ? (
            <Banner tone={ask.done.outcome === 'REFUSED' ? 'warning' : 'ok'} title={ask.done.outcome === 'REFUSED' ? 'Deletion refused (logged)' : 'Eligible for the QA disposal approval (logged)'}>
              <ul data-testid="disposal-answer">
                {ask.done.refusals.map((x) => (
                  <li key={x.code + x.detail}>
                    {x.code}: {x.detail}
                  </li>
                ))}
              </ul>
            </Banner>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

const NEXT: Readonly<Record<ContingencyFormView['state'], readonly ('RETURNED' | 'TRANSCRIBED' | 'VERIFIED' | 'VOIDED' | 'REPORTED_MISSING')[]>> = {
  ISSUED: ['RETURNED', 'VOIDED', 'REPORTED_MISSING'],
  RETURNED: ['TRANSCRIBED'],
  TRANSCRIBED: ['VERIFIED'],
  MISSING: ['VOIDED'],
  VERIFIED: [],
  VOIDED: [],
};

function Forms({ v }: { v: ArchiveBatchView }) {
  const f = v.forms;
  const qa = useOffered('QA');
  const floorOffered = useOffered('PRODUCTION_FLOOR');
  const head = useOffered('PRODUCTION_HEAD');
  const floorRole = floorOffered || head;
  const issue = useCommand(routes.archive.issuePack, ARCHIVE_READS, 'issuing a contingency pack');
  const event = useCommand(routes.archive.formEvent, ARCHIVE_READS, 'a contingency form');
  const signed = useSignedAct(ARCHIVE_READS);
  const [moment, setMoment] = useState<'ISSUE' | 'STAGE_START'>('ISSUE');
  const [stage, setStage] = useState('');
  const [template, setTemplate] = useState('');
  const [destination, setDestination] = useState('');
  const [pages, setPages] = useState('1');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const n = Number.parseInt(pages, 10);
  const ok = template.trim() !== '' && destination.trim() !== '' && n >= 1 && n <= 50 && reason.trim().length >= 10 && (moment === 'ISSUE' || stage.trim() !== '');
  return (
    <Section title="Contingency paper forms" testId="archive-forms">
      <p data-testid="forms-state" data-state={f.state}>
        Paper forms: <StatusChip tone={formTone(f.state)} label={words(f.state)} />
        {f.signedBy ? ` signed by ${f.signedBy.legalName} ${f.signedAt?.text ?? ''}` : ''}
      </p>
      {f.completionProblem ? <Banner tone="warning" title={f.completionProblem} /> : null}
      <ul data-testid="contingency-forms">
        {f.forms.map((x) => (
          <li key={x.formId} data-testid={`form-${x.serial}`} data-state={x.state}>
            {x.serial} (page {x.page}, {x.moment === 'STAGE_START' ? `stage ${x.stageRef ?? ''}` : 'batch issue'}, {x.templateRef}, to {x.destination}) <StatusChip tone={formTone(x.state)} label={words(x.state)} />
            {x.events.length > 0 ? ` ${x.events.map((e) => `${words(e.event)} by ${e.by.legalName}${e.reference ? ` (${e.reference})` : ''}`).join('; ')}` : ''}
            {qa || floorRole
              ? NEXT[x.state].map((ev) => (
                  <ActButton
                    key={ev}
                    primary={false}
                    label={`${words(ev)} ${x.serial}`}
                    onPress={() => event.run({ params: { formId: x.formId }, body: { event: ev, ...(note.trim() ? { reason: note.trim() } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) } })}
                    disabled={event.busy}
                  />
                ))
              : null}
          </li>
        ))}
      </ul>
      {qa || floorRole ? (
        <>
          <Field name="formReason" label="Reason (a void or a missing form)" value={note} onChange={setNote} />
          <Field name="formReference" label="Reference (where the entries were back-entered, or the deviation of a missing form)" value={reference} onChange={setReference} />
          <ActResult error={event.error} />
        </>
      ) : null}
      {qa && f.state === 'RECONCILED' ? (
        <>
          <ActButton
            label="Sign the reconciliation of the paper forms"
            onPress={() => signed.sign({ kind: 'ARCHIVE_ACT', act: 'SIGN_FORMS', subjectId: v.batchId }, `Every paper form issued for batch ${v.batchNumber} is accounted for`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
      {(qa || head) && !['EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED'].includes(v.status) && f.state !== 'SIGNED' ? (
        <>
          <h3>Issue a contingency pack</h3>
          <floor.ChoiceGroup
            label="Issued at"
            options={[
              { value: 'ISSUE', label: 'The batch issue' },
              { value: 'STAGE_START', label: 'A stage start' },
            ]}
            value={moment}
            onChange={(x) => setMoment(x === 'STAGE_START' ? 'STAGE_START' : 'ISSUE')}
          />
          {moment === 'STAGE_START' ? <Field name="packStage" label="Stage" value={stage} onChange={setStage} /> : null}
          <Field name="packTemplate" label="Form template and version" value={template} onChange={setTemplate} />
          <Field name="packDestination" label="Destination" value={destination} onChange={setDestination} />
          <Field name="packPages" label="Numbered forms (1 to 50)" value={pages} onChange={setPages} />
          <Field name="packReason" label="Reason (at least 10 characters)" value={reason} onChange={setReason} />
          <ActButton
            label="Issue the pack"
            onPress={() =>
              ok &&
              issue.run({
                params: { batchId: v.batchId },
                body: { moment, ...(moment === 'STAGE_START' ? { stageRef: stage.trim() } : {}), templateRef: template.trim(), destination: destination.trim(), pages: n, reason: reason.trim() },
              })
            }
            disabled={!ok || issue.busy}
          />
          <ActResult error={issue.error} done={issue.done} label="Pack issued." />
        </>
      ) : null}
    </Section>
  );
}

function TrueCopy({ v }: { v: ArchiveBatchView }) {
  const pdf = useCommand(routes.archive.pdf, []);
  return (
    <Section title="PDF/A-3 true copy" testId="archive-pdf">
      <p>The record as stored, with its changes after entry and its audit trail; the record's data is embedded. The same record content always gives the same file.</p>
      <ActButton
        primary={false}
        label="Download the PDF/A-3 true copy"
        onPress={async () => {
          const r = await pdf.run({ params: { batchId: v.batchId } });
          if (r) saveFile(r.fileName, { base64: r.pdfBase64, type: 'application/pdf' });
        }}
        disabled={pdf.busy}
      />
      {pdf.done ? (
        <p data-testid="pdf-hash">
          PDF SHA-256 {pdf.done.pdfSha256}; content SHA-256 {pdf.done.contentSha256}
        </p>
      ) : null}
      <ActResult error={pdf.error} />
    </Section>
  );
}

function Exports({ v }: { v: ArchiveBatchView }) {
  const qa = useOffered('QA');
  const assemble = useCommand(routes.archive.assembleExport, ARCHIVE_READS);
  const signed = useSignedAct(ARCHIVE_READS);
  return (
    <Section title="Evidence exports" testId="archive-exports">
      <ul>
        {v.exports.map((e) => (
          <li key={e.exportId} data-testid={`export-${e.exportId}`} data-state={e.state}>
            {e.label}: <StatusChip tone={e.state === 'CERTIFIED' ? 'ok' : 'neutral'} label={words(e.state)} /> SHA-256 {e.exportSha256}, {e.sections.length} sections, assembled by {e.assembledBy.legalName}{' '}
            {e.assembledAt.text}
            {e.certifiedBy ? `, certified by ${e.certifiedBy.legalName} ${e.certifiedAt?.text ?? ''}` : ''}, read {e.reads} time(s)
            {qa && e.state === 'ASSEMBLED' ? (
              <ActButton
                primary={false}
                label="Certify this export"
                onPress={() => signed.sign({ kind: 'ARCHIVE_ACT', act: 'CERTIFY_EXPORT', subjectId: e.exportId }, `Certify the evidence export of ${e.label}`)}
                disabled={signed.busy}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
      {qa ? (
        <>
          <ActButton label="Assemble an evidence export" onPress={() => assemble.run({ params: { batchId: v.batchId } })} disabled={assemble.busy} />
          <ActResult error={assemble.error} done={assemble.done} label="Export assembled and registered." />
        </>
      ) : null}
    </Section>
  );
}
