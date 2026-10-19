/**
 * The change records of master records with their assessments (slice 7g WP3, decision 0025; PR-04): for each change, the
 * validation it rests on and its regulatory assessment per market (reporting category and reference), recorded by a
 * holder of MBR.CHANGE_RECORD (QA, the regulatory-conformity signer). Every act is offered; the database refuses whoever
 * lacks the right, in its own words.
 */
import { useState } from 'react';
import { routes, type MbrChangeRecordView } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { MASTER_RECORD_READS } from './reads.ts';

export function ChangeRecordsPage() {
  const q = useApiQuery(routes.marketConfig.changeRecords, {});
  return (
    <>
      <h1>MBR change records</h1>
      <p>
        A change to a master record cites its change record. The change record carries the validation the change rests on and, for every market the master serves, the
        regulatory assessment: how the change is reported to that market (its reporting category) and the reference of the filing or the reason none is needed.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.changeRecords.length === 0 ? <p>No change record is recorded.</p> : null}
      {q.data?.changeRecords.map((c) => <ChangeRecord key={c.changeRecordId} c={c} />)}
    </>
  );
}

function ChangeRecord({ c }: { c: MbrChangeRecordView }) {
  const regulatory = useCommand(routes.marketConfig.addChangeRegulatory, MASTER_RECORD_READS);
  const validation = useCommand(routes.marketConfig.addChangeValidation, MASTER_RECORD_READS);
  const [market, setMarket] = useState('');
  const [category, setCategory] = useState('');
  const [reference, setReference] = useState('');
  const [validationRef, setValidationRef] = useState('');
  const [description, setDescription] = useState('');
  const marketOk = /^[A-Z]{2}$/.test(market.trim()) && category.trim() !== '';
  return (
    <Section title={`${c.number}: ${c.title}`} testId={`change-record-${c.number}`}>
      <p>
        {c.changeClass} change{c.processImpacting ? ', process-impacting' : ''}, recorded {c.recordedAt.text}.
      </p>
      <h3>Validation</h3>
      {c.validations.length === 0 ? <p>No validation assessment yet.</p> : null}
      <ul>
        {c.validations.map((v) => (
          <li key={v.id}>
            {v.validationRef}
            {v.description ? `: ${v.description}` : ''} (recorded by {v.recordedBy.legalName} {v.recordedAt.text})
          </li>
        ))}
      </ul>
      <Field name={`validationRef-${c.changeRecordId}`} label="Validation reference" value={validationRef} onChange={setValidationRef} />
      <Field name={`validationText-${c.changeRecordId}`} label="What the validation covers (optional)" value={description} onChange={setDescription} />
      <ActButton
        label="Record the validation assessment"
        disabled={validation.busy || validationRef.trim() === ''}
        onPress={() =>
          validationRef.trim() &&
          validation.run({ params: { changeRecordId: c.changeRecordId }, body: { validationRef: validationRef.trim(), ...(description.trim() ? { description: description.trim() } : {}) } })
        }
      />
      <ActResult error={validation.error} done={validation.done} label="The validation assessment is recorded." />
      <h3>Regulatory assessment per market</h3>
      {c.regulatory.length === 0 ? <p>No regulatory assessment yet.</p> : null}
      <ul>
        {c.regulatory.map((g) => (
          <li key={g.id} data-testid={`regulatory-${c.number}-${g.market}`}>
            {g.market}: {g.reportingCategory}
            {g.reference ? ` (${g.reference})` : ''}, recorded by {g.recordedBy.legalName} {g.recordedAt.text}
          </li>
        ))}
      </ul>
      <Field name={`market-${c.changeRecordId}`} label="Market (two letters)" value={market} onChange={setMarket} />
      <Field name={`category-${c.changeRecordId}`} label="Reporting category" value={category} onChange={setCategory} />
      <Field name={`reference-${c.changeRecordId}`} label="Regulatory reference (optional)" value={reference} onChange={setReference} />
      <ActButton
        label="Record the regulatory assessment"
        disabled={regulatory.busy || !marketOk}
        onPress={() =>
          marketOk &&
          regulatory.run({
            params: { changeRecordId: c.changeRecordId },
            body: { market: market.trim(), reportingCategory: category.trim(), ...(reference.trim() ? { reference: reference.trim() } : {}) },
          })
        }
      />
      <ActResult error={regulatory.error} done={regulatory.done} label="The regulatory assessment is recorded." />
    </Section>
  );
}
