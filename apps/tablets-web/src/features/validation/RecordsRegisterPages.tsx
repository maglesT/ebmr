/**
 * The records register (Phase 7 slice 7g-3; kernel 0400 to 0440): record types defined and approved by another person
 * with a signature (DI-01); a record's retention as the database computes it, its legal holds placed and released with
 * the reason, and the signed approval of its disposal once its retention has ended (DI-47); data-integrity
 * investigations opened, linked, read again and closed with QA's signature (DI-50). Every rule is the database's.
 */
import { useState } from 'react';
import { routes, type RouteBodyInput, type RouteResponse } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Choice, VALIDATION_READS, words } from './shared.tsx';

type Definition = RouteBodyInput<typeof routes.validation.defineRecordType>['definition'];

export function RecordTypesPage() {
  const q = useApiQuery(routes.validation.recordTypes);
  const define = useCommand(routes.validation.defineRecordType, VALIDATION_READS);
  const signed = useSignedAct(VALIDATION_READS);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dataClass, setDataClass] = useState<Definition['dataClass']>('RAW');
  const [criticality, setCriticality] = useState<Definition['gmpCriticality']>('HIGH');
  const [medium, setMedium] = useState<Definition['officialMedium']>('ELECTRONIC');
  const [retentionKey, setRetentionKey] = useState<Definition['retentionKey']>('SUPPORTING_RECORD');
  const [copies, setCopies] = useState('');
  const [hybrid, setHybrid] = useState('');
  const [storage, setStorage] = useState('');
  const [module, setModule] = useState('');
  const [ownerRole, setOwnerRole] = useState('');
  const [reviewRule, setReviewRule] = useState('');
  const [official, setOfficial] = useState(true);
  const [feeds, setFeeds] = useState(false);
  const [reason, setReason] = useState('');
  const filled = [title, description, copies, storage, module, ownerRole, reviewRule, reason].every((x) => x.trim() !== '');
  const ok = /^[A-Z][A-Z0-9_]{1,63}$/.test(code) && filled && (medium !== 'HYBRID' || hybrid.trim() !== '');
  const definition = (): Definition => ({
    code, title: title.trim(), description: description.trim(), officialRecord: official, dataClass, gmpCriticality: criticality, officialMedium: medium,
    originalAndCopies: copies.trim(), ...(hybrid.trim() ? { hybridLinkage: hybrid.trim() } : {}), storageLocation: storage.trim(), owningModule: module.trim(),
    ownerRole: ownerRole.trim(), retentionKey, reviewRule: reviewRule.trim(), feedsAcceptanceLimit: feeds,
  });
  return (
    <>
      <h1>Record types</h1>
      <p>Each record type says what the record is, whether it is raw data, its official medium, where it is kept, who owns it and how long it is retained. A version becomes current when another person approves it with a signature.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Record types" testId="record-types">
        <ul>
          {q.data?.recordTypes.map((t) => (
            <li key={`${t.code}:${t.version}`} data-testid={`record-type-${t.code}-${t.version}`} data-state={t.state}>
              <strong>
                {t.code} v{t.version}
              </strong>{' '}
              {t.title} <StatusChip tone={t.state === 'APPROVED' ? 'ok' : 'warning'} label={words(t.state)} /> ({words(t.dataClass)}, {words(t.officialMedium)}, kept as {words(t.retentionKey)});
              defined by {t.definedBy} at {t.definedAt.text}
              {t.approvedBy ? `; approved by ${t.approvedBy}` : ''}
              {t.state === 'DEFINED' ? (
                <ActButton
                  label={`Approve ${t.code} v${t.version} (signature)`}
                  primary={false}
                  disabled={signed.busy}
                  onPress={() => signed.sign({ kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: t.code, version: t.version } }, `Approve record type ${t.code} version ${t.version}`)}
                />
              ) : null}
            </li>
          ))}
        </ul>
        <ActResult error={signed.error} outcome={signed.outcome} />
      </Section>
      <Section title="Define a record type (a new version)" testId="define-record-type">
        <Field name="code" label="Code (e.g. CLEANING_LOG)" value={code} onChange={setCode} />
        <Field name="title" label="Title" value={title} onChange={setTitle} />
        <Field name="description" label="Description" value={description} onChange={setDescription} />
        <label style={{ display: 'block' }}>
          <input type="checkbox" name="official" checked={official} onChange={(e) => setOfficial(e.target.checked)} /> An official record
        </label>
        <Choice name="dataClass" label="Data class" value={dataClass} options={['RAW', 'DERIVED', 'INFORMATIONAL'] as const} onChange={setDataClass} />
        <label style={{ display: 'block' }}>
          <input type="checkbox" name="feeds" checked={feeds} onChange={(e) => setFeeds(e.target.checked)} /> It feeds an acceptance limit (raw data only)
        </label>
        <Choice name="criticality" label="GMP criticality" value={criticality} options={['HIGH', 'MEDIUM', 'LOW'] as const} onChange={setCriticality} />
        <Choice name="medium" label="Official medium" value={medium} options={['ELECTRONIC', 'PAPER', 'HYBRID'] as const} onChange={setMedium} />
        {medium === 'HYBRID' ? <Field name="hybrid" label="How the paper and electronic parts are linked" value={hybrid} onChange={setHybrid} /> : null}
        <Field name="copies" label="Original and copies" value={copies} onChange={setCopies} />
        <Field name="storage" label="Storage location" value={storage} onChange={setStorage} />
        <Field name="module" label="Owning module" value={module} onChange={setModule} />
        <Field name="ownerRole" label="Owner role" value={ownerRole} onChange={setOwnerRole} />
        <Choice name="retentionKey" label="Retention" value={retentionKey} options={['BATCH_RECORD', 'SUPPORTING_RECORD', 'DSCSA_RECORD', 'VALIDATION_RAW_DATA', 'PERMANENT'] as const} onChange={setRetentionKey} />
        <Field name="reviewRule" label="Review rule" value={reviewRule} onChange={setReviewRule} />
        <Field name="rt-reason" label="Reason" value={reason} onChange={setReason} />
        <ActButton label="Define the record type" disabled={!ok || define.busy} onPress={() => define.run({ body: { definition: definition(), reason: reason.trim() } })} />
        <ActResult error={define.error} done={define.done} label={define.done ? `Version ${define.done.version} of ${define.done.code} is defined; another person approves it.` : 'Defined.'} />
      </Section>
    </>
  );
}

export function RetentionPage() {
  const [aggregateType, setAggregateType] = useState('');
  const [aggregateId, setAggregateId] = useState('');
  const [asked, setAsked] = useState<{ aggregateType: string; aggregateId: string } | null>(null);
  const lookup = useApiQuery(routes.validation.retention, { query: asked ?? { aggregateType: 'none', aggregateId: 'none' } }, { enabled: asked !== null });
  const holds = useApiQuery(routes.validation.legalHolds);
  const place = useCommand(routes.validation.placeLegalHold, VALIDATION_READS);
  const signed = useSignedAct(VALIDATION_READS);
  const [holdReason, setHoldReason] = useState('');
  const [reference, setReference] = useState('');
  const [disposalReason, setDisposalReason] = useState('');
  const r = lookup.data;
  return (
    <>
      <h1>Retention, holds and disposal</h1>
      <p>A record is kept until the date its retention rules give; a legal hold keeps it longer. Its disposal is approved with a signature by a person who did not decide its retention, once nothing holds it.</p>
      <Section title="Find a record" testId="retention-lookup">
        <Field name="aggregateType" label="Record type (e.g. batch)" value={aggregateType} onChange={setAggregateType} />
        <Field name="aggregateId" label="Record id" value={aggregateId} onChange={setAggregateId} />
        <ActButton label="Show its retention" disabled={!/^[a-z][a-z0-9_]{1,63}$/.test(aggregateType) || aggregateId.trim() === ''} onPress={() => setAsked({ aggregateType, aggregateId: aggregateId.trim() })} />
      </Section>
      {lookup.error ? <RefusalMessage error={lookup.error.error} /> : null}
      {r ? (
        <Section title={`Record ${r.recordKey}`} testId="retention-record">
          <p data-testid="retention-status">
            {r.scheduled ? (r.retainUntil ? `Kept until ${r.retainUntil}.` : 'No retention date yet.') : 'No retention schedule is held for this record.'}
            {r.onHold ? ' On hold.' : ''}
            {r.purged ? ' Purged.' : ''}
          </p>
          {r.refusals.length > 0 ? (
            <ul data-testid="retention-refusals">
              {r.refusals.map((x) => (
                <li key={x.code + x.detail}>
                  {x.code}: {x.detail}
                </li>
              ))}
            </ul>
          ) : null}
          {r.blockers.length > 0 ? (
            <ul data-testid="retention-blockers">
              {r.blockers.map((b) => (
                <li key={b.id}>
                  {words(b.kind)} {b.reference} ({b.status}): {b.detail}
                </li>
              ))}
            </ul>
          ) : null}
          <h3>Place a legal hold</h3>
          <Field name="hold-reason" label="Reason for the hold" value={holdReason} onChange={setHoldReason} />
          <Field name="hold-reference" label="Reference (optional, e.g. the legal case)" value={reference} onChange={setReference} />
          <ActButton
            label="Place the legal hold"
            disabled={holdReason.trim() === '' || place.busy}
            onPress={() => place.run({ body: { aggregateType: r.aggregateType, aggregateId: r.aggregateId, reason: holdReason.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) } })}
          />
          <ActResult error={place.error} done={place.done} label="The hold is placed." />
          {r.scheduled ? (
            <>
              <h3>Approve the disposal</h3>
              <Field name="disposal-reason" label="Reason for the disposal (at least 10 characters)" value={disposalReason} onChange={setDisposalReason} />
              <ActButton
                label="Approve the disposal (signature)"
                disabled={disposalReason.trim().length < 10 || signed.busy}
                onPress={() => signed.sign({ kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: r.recordKey, reason: disposalReason.trim() } }, `Approve the disposal of ${r.recordKey}`)}
              />
              <ActResult error={signed.error} outcome={signed.outcome} />
            </>
          ) : null}
        </Section>
      ) : null}
      <Section title="Holds in force" testId="legal-holds">
        {holds.error ? <RefusalMessage error={holds.error.error} /> : null}
        {holds.data && holds.data.holds.length === 0 ? <p>No hold is in force.</p> : null}
        {holds.data?.holds.map((h) => <HoldRow key={h.holdId} h={h} />)}
      </Section>
    </>
  );
}

function HoldRow({ h }: { h: { holdId: string; recordKey: string; kind: string; reason: string; reference: string | null; placedBy: string; at: { text: string } } }) {
  const release = useCommand(routes.validation.releaseLegalHold, VALIDATION_READS);
  const [reason, setReason] = useState('');
  return (
    <article data-testid={`hold-${h.holdId}`}>
      <p>
        {words(h.kind)} hold on {h.recordKey}: {h.reason}
        {h.reference ? ` (${h.reference})` : ''}, placed by {h.placedBy} at {h.at.text}
      </p>
      {h.kind === 'LEGAL' ? (
        <>
          <Field name={`release-${h.holdId}`} label="Reason for the release" value={reason} onChange={setReason} />
          <ActButton label="Release the hold" primary={false} disabled={reason.trim() === '' || release.busy} onPress={() => release.run({ params: { holdId: h.holdId }, body: { reason: reason.trim() } })} />
          <ActResult error={release.error} done={release.done} label="Released." />
        </>
      ) : null}
    </article>
  );
}

export function DiInvestigationsPage() {
  const q = useApiQuery(routes.validation.diInvestigations);
  const open = useCommand(routes.validation.openDiInvestigation, VALIDATION_READS);
  const [subject, setSubject] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [concern, setConcern] = useState('');
  const [investigator, setInvestigator] = useState('');
  const [qms, setQms] = useState('');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
  const ok = UUID.test(subject) && AT.test(from) && AT.test(to) && concern.trim().length >= 10 && (investigator === '' || UUID.test(investigator));
  return (
    <>
      <h1>Data-integrity investigations</h1>
      <p>An investigation of a person&apos;s records in a time window: the records in scope are linked and held until QA closes it with a signature (never the investigator or the person investigated).</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Open an investigation" testId="di-open">
        <Field name="subject" label="Person investigated (person id)" value={subject} onChange={setSubject} />
        <Field name="from" label="Window from (e.g. 2026-09-01T00:00+05:30)" value={from} onChange={setFrom} />
        <Field name="to" label="Window to (e.g. 2026-09-30T00:00+05:30)" value={to} onChange={setTo} />
        <Field name="concern" label="Concern (at least 10 characters)" value={concern} onChange={setConcern} />
        <Field name="investigator" label="Investigator (person id; yourself when empty)" value={investigator} onChange={setInvestigator} />
        <Field name="qms" label="QMS reference (optional)" value={qms} onChange={setQms} />
        <ActButton
          label="Open the investigation"
          disabled={!ok || open.busy}
          onPress={() =>
            open.run({ body: { subjectPersonId: subject, windowFrom: from, windowTo: to, concern: concern.trim(), ...(investigator ? { investigatorPersonId: investigator } : {}), ...(qms.trim() ? { qmsReference: qms.trim() } : {}) } })
          }
        />
        <ActResult error={open.error} done={open.done} label={open.done ? `Investigation ${open.done.reference} is open.` : 'Opened.'} />
      </Section>
      <Section title="Investigations" testId="di-investigations">
        {q.data && q.data.investigations.length === 0 ? <p>No investigation.</p> : null}
        {q.data?.investigations.map((i) => <Investigation key={i.investigationId} i={i} />)}
      </Section>
    </>
  );
}

type InvestigationView = RouteResponse<typeof routes.validation.diInvestigations>['investigations'][number];

function Investigation({ i }: { i: InvestigationView }) {
  const link = useCommand(routes.validation.linkDiInvestigation, VALIDATION_READS);
  const refresh = useCommand(routes.validation.refreshDiInvestigationScope, VALIDATION_READS);
  const signed = useSignedAct(VALIDATION_READS);
  const [type, setType] = useState('');
  const [id, setId] = useState('');
  const [note, setNote] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [remediation, setRemediation] = useState('');
  return (
    <article data-testid={`di-${i.reference}`} data-state={i.status}>
      <h3>
        {i.reference} <StatusChip tone={i.status === 'OPEN' ? 'warning' : 'ok'} label={words(i.status)} />
      </h3>
      <p>
        {i.subject}, {i.windowFrom.text} to {i.windowTo.text}: {i.concern}. Investigator {i.investigator}; opened by {i.openedBy}
        {i.qmsReference ? `; QMS ${i.qmsReference}` : ''}.
      </p>
      <ul data-testid={`di-${i.reference}-links`}>
        {i.links.map((l) => (
          <li key={l.recordKey}>
            {l.recordKey} ({l.source === 'SCOPE' ? 'in scope' : `linked: ${l.note ?? ''}`})
          </li>
        ))}
      </ul>
      {i.status === 'CLOSED' ? (
        <p>
          Closed by {i.approvedBy}: {i.conclusion} Remediation: {i.remediation}
        </p>
      ) : (
        <>
          <Field name={`type-${i.reference}`} label="Record type to link" value={type} onChange={setType} />
          <Field name={`id-${i.reference}`} label="Record id to link" value={id} onChange={setId} />
          <Field name={`note-${i.reference}`} label="Why it is linked" value={note} onChange={setNote} />
          <ActButton
            label="Link the record"
            primary={false}
            disabled={type.trim() === '' || id.trim() === '' || note.trim() === '' || link.busy}
            onPress={() => link.run({ params: { investigationId: i.investigationId }, body: { aggregateType: type.trim(), aggregateId: id.trim(), note: note.trim() } })}
          />
          <ActResult error={link.error} done={link.done} label="Linked." />
          <ActButton label="Read the scope again" primary={false} disabled={refresh.busy} onPress={() => refresh.run({ params: { investigationId: i.investigationId } })} />
          <ActResult error={refresh.error} done={refresh.done} label={refresh.done ? `${refresh.done.linked} records newly linked.` : 'Done.'} />
          <Field name={`conclusion-${i.reference}`} label="Conclusion (at least 10 characters)" value={conclusion} onChange={setConclusion} />
          <Field name={`remediation-${i.reference}`} label="Remediation (at least 10 characters)" value={remediation} onChange={setRemediation} />
          <ActButton
            label={`Close ${i.reference} (signature)`}
            disabled={conclusion.trim().length < 10 || remediation.trim().length < 10 || signed.busy}
            onPress={() =>
              signed.sign({ kind: 'RECORDS_ACT', act: 'DI_INVESTIGATION_CLOSE', input: { investigationId: i.investigationId, conclusion: conclusion.trim(), remediation: remediation.trim() } }, `Close investigation ${i.reference}`)
            }
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      )}
    </article>
  );
}
