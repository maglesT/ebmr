/**
 * QC's decision on extra testing of a GMP batch (Phase 3 slice 6): no extra test, or the tests named; signed by QC
 * (QUALITY_ACT QC_EXTRA_TESTING_DECISION). The decision and its tests are part of what is signed, so the server
 * describes each choice when it is made (esig.describe).
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const TEST_CODE = /^[A-Z0-9][A-Z0-9/._-]{0,39}$/;

export function BatchQualityPage() {
  const batches = useApiQuery(routes.batches.list);
  const [batchId, setBatchId] = useState<string | null>(null);
  return (
    <>
      <h1>Extra testing of a batch</h1>
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      <floor.ChoiceGroup label="Batch" options={(batches.data?.batches ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))} value={batchId} onChange={setBatchId} />
      {batchId ? <ExtraTesting key={batchId} batchId={batchId} batchNumber={batches.data?.batches.find((b) => b.runId === batchId)?.batchNumber ?? batchId} /> : null}
    </>
  );
}

function ExtraTesting({ batchId, batchNumber }: { batchId: string; batchNumber: string }) {
  const q = useApiQuery(routes.quality.extraTesting, { params: { batchId } });
  const qc = useOffered('QC');
  const [decision, setDecision] = useState<'NONE_REQUIRED' | 'EXTRA_TESTS' | null>(null);
  const [tests, setTests] = useState('');
  const signed = useSignedAct([routes.quality.extraTesting.id]);
  const list = tests
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const ready = decision === 'NONE_REQUIRED' || (decision === 'EXTRA_TESTS' && list.length > 0 && list.every((t) => TEST_CODE.test(t)));
  const d = q.data?.decision;
  return (
    <Section title={`Batch ${batchNumber}`} testId="extra-testing">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <p data-testid="extra-testing-decision">{d ? `Decided ${d.decidedAt.text}: ${d.decision === 'NONE_REQUIRED' ? 'no extra testing' : `extra tests ${d.tests.join(', ')}`}.` : 'No decision yet.'}</p>
      {qc ? (
        <>
          <floor.ChoiceGroup
            label="Decision"
            options={[
              { value: 'NONE_REQUIRED', label: 'No extra testing' },
              { value: 'EXTRA_TESTS', label: 'Extra tests' },
            ]}
            value={decision}
            onChange={(v) => setDecision(v === 'EXTRA_TESTS' ? 'EXTRA_TESTS' : 'NONE_REQUIRED')}
          />
          {decision === 'EXTRA_TESTS' ? <Field name="tests" label="Tests" value={tests} onChange={setTests} description="Test codes, separated by commas" /> : null}
          <ActButton
            label="Sign the decision"
            onPress={() =>
              decision &&
              signed.sign(
                { kind: 'QUALITY_ACT', act: 'QC_EXTRA_TESTING_DECISION', subjectId: batchId, input: decision === 'EXTRA_TESTS' ? { decision, tests: list } : { decision } },
                `Extra testing of ${batchNumber}: ${decision === 'EXTRA_TESTS' ? list.join(', ') : 'none required'}`,
              )
            }
            disabled={!ready || signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
    </Section>
  );
}
