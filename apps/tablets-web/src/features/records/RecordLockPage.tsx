/**
 * One batch record's lock and its amendments (Phase 4 slice 5c; INV-21, R-04, PR-38; D-5-7, D-5-8), on records.lock:
 *  - the lock state (UNLOCKED, LOCKED, UNDER_AMENDMENT), when and why it locked;
 *  - for a processing or reprocessing record, the bulk reconciliation (records.bulk): produced, issued to each packaging
 *    order, left, the containers past the maximum hold for bright stock, why it cannot close yet, and the head of
 *    production's close, which holds the bulk left over and locks the record;
 *  - QA's AMENDMENT_OPEN of a locked record under a linked open deviation or a change record, with the person's reason;
 *    the released lots it will suspend are listed before it is signed;
 *  - the open amendment's appended entries (records.appendAmendmentEntry: never an edit of the record), and QA's
 *    AMENDMENT_CLOSE with a closing statement, which locks the record again;
 *  - every amendment with its basis, the lots it suspended and the authorised person's market-impact tasks.
 * Every state, gate and meaning is the server's; signed acts go through esig.describe and the ceremony (RECORD_LOCK_ACT).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type AmendmentView, type RecordLockView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { stateTone } from '../release/reads.ts';
import { lockTone, RECORDS_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function RecordLockPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.records.lock, { params: { batchId } });
  const v = q.data;
  return (
    <>
      <h1>Record of batch {v ? v.batchNumber : batchId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <RecordLock view={v} /> : null}
    </>
  );
}

function RecordLock({ view: v }: { view: RecordLockView }) {
  const open = v.amendments.find((a) => a.state === 'OPEN') ?? null;
  return (
    <>
      <p data-testid="record-lock-state" data-state={v.state}>
        {words(v.recordKind)} record <StatusChip tone={lockTone(v.state)} label={words(v.state)} />
        {v.lockedAt ? ` locked ${v.lockedAt.text}` : ' not locked yet'}
        {v.cause ? ` (${words(v.cause).toLowerCase()})` : ''} ·{' '}
        <Link to="/review/$batchId" params={{ batchId: v.batchId }}>
          the record
        </Link>
      </p>
      {v.state === 'LOCKED' ? <Banner tone="info" title="The record is locked">Nothing in it can be written; it changes only through an amendment, which appends entries.</Banner> : null}
      {v.recordKind !== 'PACKAGING' ? <BulkReconciliation batchId={v.batchId} /> : null}
      {v.state === 'LOCKED' ? <OpenAmendment view={v} /> : null}
      {open ? <OpenAmendmentWork view={v} a={open} /> : null}
      <Amendments view={v} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bulk reconciliation (PR-38, D-5-7, D-5-8)
// ---------------------------------------------------------------------------------------------------------------------

function quantities(xs: readonly { quantity: string; unit: string }[]): string {
  return xs.length === 0 ? 'none' : xs.map((x) => `${x.quantity} ${x.unit}`).join(', ');
}

function BulkReconciliation({ batchId }: { batchId: string }) {
  const q = useApiQuery(routes.records.bulk, { params: { batchId } });
  const head = useOffered('PRODUCTION_HEAD');
  const close = useCommand(routes.records.closeBulk, RECORDS_READS, 'closing the bulk reconciliation');
  const [reason, setReason] = useState('');
  const b = q.data;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!b) return <p aria-busy="true">Loading the bulk reconciliation…</p>;
  const anyLeft = b.remaining.some((r) => !/^0(\.0*)?$/.test(r.quantity));
  const held = reason.trim().length >= 10 ? { remainingHeldReason: reason.trim() } : {};
  return (
    <Section title="Bulk reconciliation" testId="bulk-reconciliation">
      <p>
        Produced {quantities(b.produced)}; issued to packaging orders {quantities(b.issued)}; left {quantities(b.remaining)}.
        {b.maxHold ? ` Maximum hold of bright stock: ${b.maxHold.maxHoldHours} hours.` : ' No maximum hold of bright stock is set for the product.'}
      </p>
      <ul aria-label="Packaging orders">
        {b.orders.map((o) => (
          <li key={o.orderBatchId} data-testid={`bulk-order-${o.batchNumber}`}>
            {o.batchNumber} {words(o.status)}
            {o.closed ? ' (closed)' : ''}, issued {quantities(o.issued)} in {o.containers} containers
            {o.holdProblem ? <p>{o.holdProblem}</p> : null}
          </li>
        ))}
      </ul>
      <ul aria-label="Bulk containers">
        {b.containers.map((c) => (
          <li key={c.containerId} data-testid={`bulk-container-${c.label}`}>
            {c.label} {c.quantity ?? '?'} {c.unit} {words(c.disposition).toLowerCase()}
            {c.orderBatchNumber ? ` to ${c.orderBatchNumber}` : ''}
            {c.heldHours !== null ? `, held ${c.heldHours} h` : ''}
            {c.pastMaxHold ? <StatusChip tone="warning" label="Past the maximum hold" /> : null}
          </li>
        ))}
      </ul>
      {b.closure ? (
        <p data-testid="bulk-closure">
          Closed by {b.closure.closedBy.legalName}, {b.closure.closedAt.text}
          {b.closure.remainingHeldReason ? `; the bulk left over is held: ${b.closure.remainingHeldReason}` : ''}.
        </p>
      ) : head ? (
        <>
          {b.closeProblems.length > 0 ? (
            <ul data-testid="bulk-close-problems" aria-label="Why it cannot close yet">
              {b.closeProblems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          {anyLeft ? <Field name="remainingHeldReason" label="Why the bulk left over is held (at least 10 characters)" value={reason} onChange={setReason} /> : null}
          <ActButton
            label="Close the bulk reconciliation and lock the record"
            onPress={() => close.run({ params: { batchId }, body: held })}
            disabled={b.closeProblems.length > 0 || (anyLeft && !('remainingHeldReason' in held)) || close.busy}
          />
          <ActResult error={close.error} done={close.done} label="Closed: the processing record is locked." />
        </>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Amendments (INV-21, R-04)
// ---------------------------------------------------------------------------------------------------------------------

function OpenAmendment({ view: v }: { view: RecordLockView }) {
  const qa = useOffered('QA');
  const deviations = useApiQuery(routes.quality.deviations, { query: { batchId: v.batchId } });
  const [basis, setBasis] = useState<'DEVIATION' | 'CHANGE_RECORD'>('DEVIATION');
  const [basisId, setBasisId] = useState('');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(RECORDS_READS);
  if (!qa) return null;
  const id = UUID.test(basisId.trim()) ? basisId.trim() : null;
  const reason = code.trim() !== '' && text.trim().length >= 10 ? { code: code.trim(), text: text.trim() } : null;
  const list = (deviations.data?.deviations ?? []).filter((d) => d.state !== 'CLOSED' && d.state !== 'CANCELLED');
  return (
    <Section title={`Open amendment ${v.nextAmendmentNumber}`} testId="amendment-open">
      <p>An amendment is opened under an open deviation linked to the record or under a change record. Opening it suspends the release of the lots below and opens the authorised person's market-impact assessments.</p>
      {v.releasedLots.length > 0 ? (
        <Banner tone="warning" title="Released lots this amendment suspends">
          <ul data-testid="amendment-would-suspend">
            {v.releasedLots.map((l) => (
              <li key={l.lotId}>
                <Link to="/release/$lotId" params={{ lotId: l.lotId }} search={{ tab: 'AFTER' }}>
                  {l.lotCode}
                </Link>
              </li>
            ))}
          </ul>
        </Banner>
      ) : (
        <p>No released lot is made from this record yet.</p>
      )}
      <floor.ChoiceGroup
        label="Made under"
        options={[
          { value: 'DEVIATION', label: 'A deviation' },
          { value: 'CHANGE_RECORD', label: 'A change record' },
        ]}
        value={basis}
        onChange={(x) => setBasis(x === 'CHANGE_RECORD' ? 'CHANGE_RECORD' : 'DEVIATION')}
      />
      {basis === 'DEVIATION' && list.length > 0 ? (
        <floor.ChoiceGroup label="Open deviation linked to the batch" options={list.map((x) => ({ value: x.deviationId, label: `${x.ref} ${x.title} (${words(x.state)})` }))} value={basisId} onChange={setBasisId} />
      ) : null}
      <Field name="amendmentBasis" label={basis === 'DEVIATION' ? 'Deviation (id)' : 'Change record (id)'} value={basisId} onChange={setBasisId} />
      <Field name="amendmentReasonCode" label="Reason code" value={code} onChange={setCode} />
      <Field name="amendmentReasonText" label="Reason for the amendment (at least 10 characters)" value={text} onChange={setText} />
      <ActButton
        label={`Sign the opening of amendment ${v.nextAmendmentNumber}`}
        onPress={() =>
          id &&
          reason &&
          signed.sign(
            { kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_OPEN', batchId: v.batchId, input: { ...(basis === 'DEVIATION' ? { deviationId: id } : { changeRecordId: id }), reason } },
            `Open amendment ${v.nextAmendmentNumber} of the record of batch ${v.batchNumber} under ${basis === 'DEVIATION' ? 'deviation' : 'change record'} ${id}: ${reason.text}`,
          )
        }
        disabled={id === null || reason === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

const ENTRY_KINDS = ['LATE_ENTRY', 'CORRECTION', 'NOTE'] as const;

function OpenAmendmentWork({ view: v, a }: { view: RecordLockView; a: AmendmentView }) {
  const qa = useOffered('QA');
  const append = useCommand(routes.records.appendAmendmentEntry, RECORDS_READS, 'an amendment entry');
  const signed = useSignedAct(RECORDS_READS);
  const [kind, setKind] = useState<(typeof ENTRY_KINDS)[number]>('LATE_ENTRY');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [statement, setStatement] = useState('');
  if (!qa) return null;
  const entryOk = target.trim() !== '' && text.trim() !== '' && reason.trim().length >= 10;
  const closing = statement.trim().length >= 10 ? statement.trim() : null;
  return (
    <>
      <Section title={`Append to amendment ${a.number}`} testId="amendment-append">
        <p>An entry is appended to the amendment; the record itself is never edited.</p>
        <floor.ChoiceGroup label="Kind of entry" options={ENTRY_KINDS.map((k) => ({ value: k, label: words(k) }))} value={kind} onChange={(x) => setKind(ENTRY_KINDS.find((k) => k === x) ?? 'LATE_ENTRY')} />
        <Field name="entryTarget" label="What it amends (step, data point or document)" value={target} onChange={setTarget} />
        <Field name="entryText" label="Entry" value={text} onChange={setText} />
        <Field name="entryValue" label="Value (optional)" value={value} onChange={setValue} />
        <Field name="entryReason" label="Reason (at least 10 characters)" value={reason} onChange={setReason} />
        <ActButton
          primary={false}
          label="Append the entry"
          onPress={() =>
            entryOk &&
            append.run({
              params: { batchId: v.batchId, number: String(a.number) },
              body: { kind, target: target.trim(), text: text.trim(), reason: reason.trim(), ...(value.trim() !== '' ? { value: value.trim() } : {}) },
            })
          }
          disabled={!entryOk || append.busy}
        />
        <ActResult error={append.error} done={append.done} label="Appended." />
      </Section>
      <Section title={`Close amendment ${a.number}`} testId="amendment-close">
        <p>Closing the amendment locks the record again. The suspended lots stay suspended until the authorised person decides each market.</p>
        <Field name="closingStatement" label="Closing statement (at least 10 characters)" value={statement} onChange={setStatement} />
        <ActButton
          label={`Sign the close of amendment ${a.number}`}
          onPress={() =>
            closing &&
            signed.sign({ kind: 'RECORD_LOCK_ACT', act: 'AMENDMENT_CLOSE', batchId: v.batchId, input: { statement: closing } }, `Close amendment ${a.number} of the record of batch ${v.batchNumber}: ${closing}`)
          }
          disabled={closing === null || signed.busy}
        />
        <ActResult error={signed.error} outcome={signed.outcome} />
      </Section>
    </>
  );
}

function Amendments({ view: v }: { view: RecordLockView }) {
  if (v.amendments.length === 0) return null;
  return (
    <Section title="Amendments" testId="amendments">
      {v.amendments.map((a) => (
        <div key={a.amendmentId} data-testid={`amendment-${a.number}`} data-state={a.state}>
          <h3>
            Amendment {a.number} <StatusChip tone={stateTone(a.state)} label={words(a.state)} />
          </h3>
          <p>
            Under {a.basis.kind === 'DEVIATION' ? 'deviation' : 'change record'}{' '}
            {a.basis.kind === 'DEVIATION' ? (
              <Link to="/quality/deviations/$deviationId" params={{ deviationId: a.basis.id }}>
                {a.basis.ref}
              </Link>
            ) : (
              a.basis.ref
            )}
            : {a.reason}. Opened by {a.openedBy.legalName} ({words(a.openedBy.role)}), {a.openedAt.text}.
            {a.closedBy && a.closedAt ? ` Closed by ${a.closedBy.legalName} (${words(a.closedBy.role)}), ${a.closedAt.text}: ${a.closingStatement ?? ''}` : ''}
          </p>
          {a.entries.length > 0 ? (
            <ol aria-label={`Entries of amendment ${a.number}`}>
              {a.entries.map((e) => (
                <li key={e.entryId} data-testid={`amendment-${a.number}-entry-${e.seq}`}>
                  {words(e.kind)} on {e.target}: {e.text}
                  {e.value ? ` (value ${e.value})` : ''}, because {e.reason}; {e.by.legalName}, {e.at.text}
                </li>
              ))}
            </ol>
          ) : (
            <p>No entry appended.</p>
          )}
          {a.suspendedLots.length > 0 ? (
            <p data-testid={`amendment-${a.number}-suspended`}>
              Suspended the release of:{' '}
              {a.suspendedLots.map((l, i) => (
                <span key={l.lotId}>
                  {i > 0 ? ', ' : ''}
                  <Link to="/release/$lotId" params={{ lotId: l.lotId }} search={{ tab: 'AFTER' }}>
                    {l.lotCode}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
          {a.tasks.length > 0 ? (
            <ul aria-label={`Market-impact tasks of amendment ${a.number}`}>
              {a.tasks.map((t) => (
                <li key={t.taskId} data-testid={`amendment-task-${t.lotCode}-${t.market}`}>
                  Market-impact assessment of {t.lotCode} for {t.market} (authorised person) <StatusChip tone={stateTone(t.state)} label={words(t.state)} />
                  {t.dispositionNow ? ` now ${words(t.dispositionNow)}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </Section>
  );
}
