/**
 * The locked records (Phase 4 slice 5c; INV-21, D-5-7): every processing, reprocessing and packaging record that is
 * LOCKED or UNDER_AMENDMENT, newest lock first, as the server lists them (records.locks), with why each locked; and the
 * products' maximum hold for bright stock (PR-38, D-5-8), set as a new version by master data, never edited.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { lockTone, RECORDS_READS, words } from './reads.ts';

const FILTERS = ['ALL', 'LOCKED', 'UNDER_AMENDMENT'] as const;

export function RecordLocksPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const q = useApiQuery(routes.records.locks, { query: filter === 'ALL' ? {} : { state: filter } });
  return (
    <>
      <h1>Record locks and amendments</h1>
      <p>
        A processing record locks when its bulk reconciliation is closed: by production, or by itself at the first manufacturer decision on a lot packed from it once every packaging order is closed
        and no bulk is left. A packaging record locks at its lot's first manufacturer decision. A locked record is changed only through an amendment
        under a linked deviation or change record, which appends entries and never edits the record.
      </p>
      <floor.ChoiceGroup label="Show" options={FILTERS.map((f) => ({ value: f, label: f === 'ALL' ? 'All' : words(f) }))} value={filter} onChange={(v) => setFilter(FILTERS.find((f) => f === v) ?? 'ALL')} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.records.length === 0 ? <p>No record is locked.</p> : null}
      <ul data-testid="record-locks">
        {q.data?.records.map((r) => (
          <li key={r.batchId} data-testid={`record-lock-${r.batchNumber}`} data-state={r.state}>
            <Link to="/records/$batchId" params={{ batchId: r.batchId }}>
              {r.batchNumber}
            </Link>{' '}
            {words(r.recordKind).toLowerCase()} record <StatusChip tone={lockTone(r.state)} label={words(r.state)} /> locked {r.lockedAt.text} ({words(r.cause).toLowerCase()})
            {r.openAmendmentNumber !== null ? `, amendment ${r.openAmendmentNumber} open` : ''}
          </li>
        ))}
      </ul>
      <BrightStockHolds />
    </>
  );
}

function BrightStockHolds() {
  const q = useApiQuery(routes.records.brightStockHolds, {});
  const qa = useOffered('QA');
  const steward = useOffered('FORMULA_AUTHOR');
  const offered = qa || steward;
  const set = useCommand(routes.records.setBrightStockHold, RECORDS_READS);
  const [product, setProduct] = useState('');
  const [strength, setStrength] = useState('');
  const [hours, setHours] = useState('');
  const [reason, setReason] = useState('');
  const ok = /^[A-Z0-9][A-Z0-9-]{0,31}$/.test(product.trim()) && strength.trim() !== '' && /^[1-9][0-9]{0,4}$/.test(hours.trim()) && reason.trim().length >= 10;
  return (
    <Section title="Maximum hold of bright stock" testId="bright-stock-holds">
      <p>Filled, unlabelled bulk past its product's maximum hold (counted from the container's close) is not issued or packed unless a deviation assessed by QA covers it.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.holds.length === 0 ? <p>No maximum hold is set: none is checked.</p> : null}
      <ul>
        {q.data?.holds.map((h) => (
          <li key={`${h.productCode}/${h.strength}`} data-testid={`bright-stock-hold-${h.productCode}`}>
            {h.productCode} {h.strength}: at most {h.maxHoldHours} hours, set by {h.setBy.legalName} {h.setAt.text} ({h.reason})
          </li>
        ))}
      </ul>
      {offered ? (
        <>
          <Field name="holdProduct" label="Product code" value={product} onChange={setProduct} />
          <Field name="holdStrength" label="Strength" value={strength} onChange={setStrength} />
          <Field name="holdHours" label="Maximum hold (hours)" value={hours} onChange={setHours} />
          <Field name="holdReason" label="Reason (at least 10 characters)" value={reason} onChange={setReason} />
          <ActButton
            primary={false}
            label="Set the maximum hold"
            onPress={() => ok && set.run({ body: { productCode: product.trim(), strength: strength.trim(), maxHoldHours: hours.trim(), reason: reason.trim() } })}
            disabled={!ok || set.busy}
          />
          <ActResult error={set.error} done={set.done} label="The maximum hold is set." />
        </>
      ) : null}
    </Section>
  );
}
