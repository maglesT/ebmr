/**
 * The batch-number register of the site (Phase 7 slice 7g, WP4; decision 0025; IN-18): every number given, registered
 * from outside or recovered after a restore, with its status; a voided number stays listed and is never given again.
 * The issuer registers a number issued outside the system, voids a number with a reason code and text, and re-enters a
 * number issued in the window a completed restore skipped, with its evidence. Every right and rule is the database's.
 */
import { useState } from 'react';
import { routes, type BatchNumberView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { DefineForm, type FormField } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const READS = [routes.planning.batchNumbers.id];

const IDENTITY: readonly FormField[] = [
  { name: 'productCode', label: 'Product code', kind: 'text' },
  { name: 'productName', label: 'Product name', kind: 'text' },
  { name: 'edition', label: 'Edition', kind: 'choice', options: ['TABLETS', 'INJECTABLES'] },
  { name: 'batchSize', label: 'Batch size', kind: 'decimal' },
  { name: 'batchSizeUnit', label: 'Batch size unit (e.g. {tbl}, kg)', kind: 'text' },
  { name: 'parentBatchNumber', label: 'Processing batch number (a packaging number only)', kind: 'text', optional: true },
];

export function BatchNumbersPage() {
  const q = useApiQuery(routes.planning.batchNumbers);
  const issuer = useOffered('PLANNING');
  return (
    <>
      <h1>Batch-number register</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.numbers.length === 0 ? <p>No batch number yet.</p> : null}
      <table aria-label="Batch numbers">
        <thead>
          <tr>
            <th scope="col">Batch number</th>
            <th scope="col">Date</th>
            <th scope="col">Product</th>
            <th scope="col">Size</th>
            <th scope="col">Source</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.numbers.map((n) => (
            <NumberRow key={n.allocationId} n={n} issuer={issuer} />
          ))}
        </tbody>
      </table>
      {issuer ? (
        <>
          <Section title="Register a number issued outside the system" testId="register-external">
            <DefineForm
              title="External batch number"
              route={routes.planning.registerExternalBatchNumber}
              refresh={READS}
              submitLabel="Register the number"
              fields={[
                { name: 'batchNumber', label: 'Batch number', kind: 'text' },
                { name: 'batchKind', label: 'Kind', kind: 'choice', options: ['PROCESSING', 'PACKAGING'] },
                { name: 'externalReference', label: 'External reference (e.g. the ERP order)', kind: 'text' },
                ...IDENTITY,
              ]}
            />
          </Section>
          <Section title="Recover a number after a restore" testId="recover-number">
            <DefineForm
              title="Recovered batch number"
              route={routes.planning.recoverBatchNumber}
              refresh={READS}
              submitLabel="Recover the number"
              fields={[
                { name: 'restoreEventId', label: 'Completed restore event (id)', kind: 'text' },
                { name: 'ruleCode', label: 'Numbering rule', kind: 'text' },
                { name: 'serial', label: 'Serial in the skipped range', kind: 'text' },
                { name: 'batchNumber', label: 'Batch number', kind: 'text' },
                { name: 'evidenceReference', label: 'Evidence that it was issued (paper record, ERP document, label)', kind: 'text' },
                ...IDENTITY,
              ]}
            />
          </Section>
        </>
      ) : null}
    </>
  );
}

function NumberRow({ n, issuer }: { n: BatchNumberView; issuer: boolean }) {
  const voidIt = useCommand(routes.planning.voidBatchNumber, READS, 'voiding a batch number');
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <tr data-testid={`number-${n.batchNumber}`} data-status={n.status}>
      <th scope="row">
        {n.batchNumber}
        {n.parentBatchNumber ? ` (of ${n.parentBatchNumber})` : ''}
      </th>
      <td>{n.allocationDate}</td>
      <td>
        {n.productCode} {n.productName}
      </td>
      <td>
        {n.batchSize} {n.batchSizeUnit}
      </td>
      <td>
        {n.source.toLowerCase().replace(/_/g, ' ')}
        {n.externalReference ? `: ${n.externalReference}` : ''}
      </td>
      <td>
        <StatusChip tone={n.status === 'VOIDED' ? 'neutral' : 'ok'} label={n.status === 'VOIDED' ? `voided (${n.voidReasonCode ?? ''}: ${n.voidReasonText ?? ''})` : 'allocated'} />
        {issuer && n.status === 'ALLOCATED' && !open ? <ActButton primary={false} label={`Void ${n.batchNumber}`} onPress={() => setOpen(true)} /> : null}
        {open ? (
          <>
            <Field name={`void-code-${n.allocationId}`} label="Reason code (e.g. ORDER_CANCELLED)" value={code} onChange={setCode} />
            <Field name={`void-text-${n.allocationId}`} label="Reason" value={text} onChange={setText} />
            <ActButton
              label={`Void ${n.batchNumber} for good`}
              disabled={!/^[A-Z][A-Z0-9_]{1,39}$/.test(code.trim()) || text.trim() === '' || voidIt.busy}
              onPress={async () => {
                if (await voidIt.run({ params: { allocationId: n.allocationId }, body: { reasonCode: code.trim(), reasonText: text.trim() } })) setOpen(false);
              }}
            />
          </>
        ) : null}
        <ActResult error={voidIt.error} />
      </td>
    </tr>
  );
}
