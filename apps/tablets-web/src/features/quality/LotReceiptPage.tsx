/**
 * The receipt record of a lot (Phase 6 slice 6a, builder A; PR-17 clause 4, DI-31; site services 0910 to 0913): what was
 * received (exactly as received), from whom, the examination of its containers and who examined them, corrections of
 * values the WMS sent (the original stays beside the correction), where the WMS last put it, and whether it may be issued
 * now as the database decides. Stores record a missing receipt record and the examination; a WMS value is corrected with
 * the person's reason.
 */
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { routes, type LotReceiptView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.quality.lotReceipt.id];
const CODE = /^[!-~]{1,64}$/;
const FIELDS = ['containers', 'supplierLot', 'manufacturerCode', 'deliveryNoteName'] as const;

export function LotReceiptPage() {
  const { lotId } = useParams({ strict: false }) as { lotId: string };
  const q = useApiQuery(routes.quality.lotReceipt, { params: { lotId } });
  const stores = useOffered('STORES');
  const missing = q.error?.error.kind === 'REFUSAL' && q.error.error.envelope.refusal.code === 'NO_RECEIPT_RECORD';
  return (
    <>
      <h1>Receipt record</h1>
      <p>
        <Link to="/quality/lots/$lotId" params={{ lotId }}>
          Back to the lot
        </Link>
      </p>
      {q.error && !missing ? <RefusalMessage error={q.error.error} /> : null}
      {missing ? (
        <>
          <p data-testid="receipt-missing">This lot has no receipt record: it cannot be issued until stores record it and examine its containers.</p>
          {stores ? <RecordReceipt lotId={lotId} /> : null}
        </>
      ) : null}
      {q.data ? <ReceiptBody r={q.data} stores={stores} /> : null}
    </>
  );
}

function ReceiptBody({ r, stores }: { r: LotReceiptView; stores: boolean }) {
  return (
    <>
      <Section title={`Lot ${r.lotCode}`} testId="receipt-record">
        <dl>
          <dt>Issue</dt>
          <dd data-testid="receipt-issue">{r.issueProblem ? <StatusChip tone="error" label={r.issueProblem} /> : <StatusChip tone="ok" label="Free to issue as far as receipt, manufacturer, location and the WMS go" />}</dd>
          <dt>Delivery</dt>
          <dd>
            {r.deliveryId}
            {r.deliveryNoteName ? ` (${r.deliveryNoteName})` : ''}, {r.source === 'INTERFACE' ? 'received from the WMS' : 'received by stores'}
          </dd>
          <dt>Supplier and supplier batch</dt>
          <dd>
            {r.supplierCode}, {r.supplierLot}
          </dd>
          <dt>Manufacturer</dt>
          <dd>
            {r.manufacturerCode} {r.manufacturerApprovedNow ? <StatusChip tone="ok" label="Approved" /> : <StatusChip tone="error" label="Not approved" />}
          </dd>
          <dt>Received</dt>
          <dd>
            {r.received.value} {r.received.unit} in {r.containers} container(s)
          </dd>
          <dt>Location</dt>
          <dd>{r.location ? `${r.location.location} (${r.location.kind})` : 'Not reported by the WMS'}</dd>
          <dt>Examination</dt>
          <dd data-testid="receipt-examination">
            {r.examination
              ? `${r.examination.containersExamined} container(s) examined by ${r.examination.by.legalName} at ${r.examination.at.text}: ${r.examination.outcome === 'ACCEPTABLE' ? 'acceptable' : `defects found (${r.examination.remarks ?? ''})`}`
              : 'Not examined yet'}
          </dd>
        </dl>
      </Section>
      {r.corrections.length > 0 ? (
        <Section title="Corrections of values the WMS sent" testId="receipt-corrections">
          <ul>
            {r.corrections.map((c, i) => (
              <li key={i}>
                {c.field}: {c.originalValue ?? '(none)'} corrected to {c.correctedValue} by {c.by.legalName} at {c.at.text}: {c.reason}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {stores && !r.examination ? <Examine lotId={r.lotId} containers={r.containers} /> : null}
      {stores && r.source === 'INTERFACE' ? <Correct lotId={r.lotId} /> : null}
    </>
  );
}

function Examine({ lotId, containers }: { lotId: string; containers: string }) {
  const examine = useCommand(routes.quality.examineLotReceipt, READS, 'the examination of the containers');
  const [count, setCount] = useState(containers);
  const [outcome, setOutcome] = useState<'ACCEPTABLE' | 'DEFECTS_FOUND'>('ACCEPTABLE');
  const [remarks, setRemarks] = useState('');
  const ok = /^[1-9][0-9]{0,5}$/.test(count.trim()) && (outcome === 'ACCEPTABLE' || remarks.trim() !== '');
  return (
    <Section title="Examine the containers" testId="receipt-examine">
      <p>Labels, damage, seals (including tamper-evident ones) and contamination of every container. You are recorded as the examiner.</p>
      <Field name="examCount" label="Containers examined" value={count} onChange={setCount} />
      <floor.ChoiceGroup
        label="Outcome"
        options={[
          { value: 'ACCEPTABLE', label: 'Acceptable' },
          { value: 'DEFECTS_FOUND', label: 'Defects found' },
        ]}
        value={outcome}
        onChange={(v) => setOutcome(v === 'DEFECTS_FOUND' ? 'DEFECTS_FOUND' : 'ACCEPTABLE')}
      />
      <Field name="examRemarks" label="Remarks (required when defects were found)" value={remarks} onChange={setRemarks} />
      <ActButton
        label="Record the examination"
        disabled={!ok || examine.busy}
        onPress={() => examine.run({ params: { lotId }, body: { containersExamined: count.trim(), outcome, ...(remarks.trim() ? { remarks: remarks.trim() } : {}) } })}
      />
      <ActResult error={examine.error} done={examine.done} label="The examination is recorded." />
    </Section>
  );
}

function Correct({ lotId }: { lotId: string }) {
  const correct = useCommand(routes.quality.correctLotReceipt, READS, 'the correction');
  const [field, setField] = useState<(typeof FIELDS)[number]>('containers');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Section title="Correct a value the WMS sent" testId="receipt-correct">
      <floor.ChoiceGroup label="Value" options={FIELDS.map((f) => ({ value: f, label: f }))} value={field} onChange={(v) => setField(FIELDS.find((f) => f === v) ?? 'containers')} />
      <Field name="correctValue" label="Corrected value" value={value} onChange={setValue} />
      <Field name="correctReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Correct the value"
        disabled={value.trim() === '' || reason.trim().length < 3 || correct.busy}
        onPress={() => correct.run({ params: { lotId }, body: { field, value: value.trim(), reason: reason.trim() } })}
      />
      <ActResult error={correct.error} done={correct.done} label="The correction is recorded; the original value stays." />
    </Section>
  );
}

function RecordReceipt({ lotId }: { lotId: string }) {
  const record = useCommand(routes.quality.recordLotReceipt, READS, 'the receipt record');
  const [d, setD] = useState({ deliveryId: '', supplierCode: '', supplierLot: '', manufacturerCode: '', containers: '' });
  const set = (k: keyof typeof d) => (v: string) => setD((x) => ({ ...x, [k]: v }));
  const ok = CODE.test(d.deliveryId.trim()) && CODE.test(d.supplierCode.trim()) && CODE.test(d.supplierLot.trim()) && CODE.test(d.manufacturerCode.trim()) && /^[1-9][0-9]{0,5}$/.test(d.containers.trim());
  return (
    <Section title="Record the receipt" testId="receipt-record-form">
      <Field name="rrDelivery" label="Delivery (goods receipt note)" value={d.deliveryId} onChange={set('deliveryId')} />
      <Field name="rrSupplier" label="Supplier code" value={d.supplierCode} onChange={set('supplierCode')} />
      <Field name="rrSupplierLot" label="Supplier batch number" value={d.supplierLot} onChange={set('supplierLot')} />
      <Field name="rrManufacturer" label="Manufacturer code (from the label)" value={d.manufacturerCode} onChange={set('manufacturerCode')} />
      <Field name="rrContainers" label="Number of containers" value={d.containers} onChange={set('containers')} />
      <ActButton
        label="Record the receipt"
        disabled={!ok || record.busy}
        onPress={() => record.run({ params: { lotId }, body: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.trim()])) as typeof d })}
      />
      <ActResult error={record.error} done={record.done} label="The receipt record is saved." />
    </Section>
  );
}
