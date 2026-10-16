/**
 * The controlled balance panel of a batch at its yield steps (Phase 6 slice 6e; draft IN-53): per controlled API the
 * account (dispensed, consumed, in process, returned, destroyed, difference) and its checkpoints. A stage sign-off is
 * refused by the database until a signed checkpoint closes the account at that stage, with no difference or with an
 * explanation and the batch's deviation (D-P6e-1: exact decimals, no tolerance). The difference shown is the server's.
 */
import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { routes, type CheckpointView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { CustodyRecord, DraftBanner } from './ControlledPage.tsx';
import { BALANCE_SIGNERS, CONTROLLED_READS, QUANTITY, UUID, words } from './reads.ts';

export function ControlledBalancePage() {
  const { batchId } = useParams({ strict: false });
  const id = typeof batchId === 'string' ? batchId : '';
  const role = useSessionRole();
  const q = useApiQuery(routes.controlled.balance, { params: { batchId: id } });
  const custody = useApiQuery(routes.controlled.custody, { query: { batchId: id } });
  const signer = role !== null && BALANCE_SIGNERS.test(role);
  return (
    <>
      <h1>Controlled balance{q.data ? ` of batch ${q.data.batchNumber}` : ''}</h1>
      <DraftBanner />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.materials.length === 0 ? <p>The product of this batch has no controlled API: nothing is accounted.</p> : null}
      {q.data?.materials.map((m) => (
        <Section key={m.materialCode} title={`Controlled API ${m.materialCode}`} testId={`controlled-balance-${m.materialCode}`}>
          <p>
            Dispensed {m.dispensed} {m.unit ?? ''}, returned {m.returned}, destroyed {m.destroyed} (from the custody records).
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Stage</th>
                <th scope="col">Dispensed</th>
                <th scope="col">Consumed</th>
                <th scope="col">In process</th>
                <th scope="col">Returned</th>
                <th scope="col">Destroyed</th>
                <th scope="col">Difference</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {m.checkpoints.map((k) => (
                <Checkpoint key={k.checkpointId} k={k} signer={signer} />
              ))}
            </tbody>
          </table>
          {signer ? <RecordCheckpoint batchId={id} materialCode={m.materialCode} /> : null}
        </Section>
      ))}
      <Section title="Custody records of the batch" testId="controlled-batch-custody">
        <ul>
          {custody.data?.records.map((r) => <CustodyRecord key={r.custodyId} r={r} role={role} />)}
        </ul>
      </Section>
    </>
  );
}

function Checkpoint({ k, signer }: { k: CheckpointView; signer: boolean }) {
  const signed = useSignedAct(CONTROLLED_READS);
  const zero = /^0(\.0+)?$/.test(k.difference);
  return (
    <tr data-testid={`controlled-checkpoint-${k.checkpointId}`} data-state={k.state} data-difference={k.difference}>
      <th scope="row">{k.stageKey}</th>
      <td>{k.dispensed}</td>
      <td>{k.consumed}</td>
      <td>{k.inProcess}</td>
      <td>{k.returned}</td>
      <td>{k.destroyed}</td>
      <td>
        {k.difference} {k.unit}{' '}
        {zero ? null : <StatusChip tone="warning" label={`Explained: ${k.explanation ?? ''} (${k.deviationRef ?? 'deviation'})`} />}
      </td>
      <td>
        {words(k.state)}
        {k.current ? '' : ' (the account has moved since: record it again)'}
        {signer && k.state === 'RECORDED' && k.current ? (
          <ActButton label={`Sign the account at ${k.stageKey}`} onPress={() => signed.sign({ kind: 'CONTROLLED_ACT', act: 'BALANCE_SIGN', subjectId: k.checkpointId }, `Controlled API account at ${k.stageKey}`)} disabled={signed.busy} />
        ) : null}
        <ActResult error={signed.error} outcome={signed.outcome} />
      </td>
    </tr>
  );
}

function RecordCheckpoint({ batchId, materialCode }: { batchId: string; materialCode: string }) {
  const record = useCommand(routes.controlled.recordCheckpoint, CONTROLLED_READS);
  const [stage, setStage] = useState('');
  const [consumed, setConsumed] = useState('');
  const [inProcess, setInProcess] = useState('0');
  const [explanation, setExplanation] = useState('');
  const [deviation, setDeviation] = useState('');
  const ok = /^[!-~]{1,200}$/.test(stage.trim()) && QUANTITY.test(consumed.trim()) && QUANTITY.test(inProcess.trim()) && (deviation.trim() === '' || UUID.test(deviation.trim()));
  return (
    <div data-testid={`controlled-record-checkpoint-${materialCode}`}>
      <h3>Record the account at a yield checkpoint</h3>
      <Field name={`ctlStage-${materialCode}`} label="Stage (as signed off)" value={stage} onChange={setStage} />
      <Field name={`ctlConsumed-${materialCode}`} label="Consumed into the product" value={consumed} onChange={setConsumed} />
      <Field name={`ctlInProcess-${materialCode}`} label="In process" value={inProcess} onChange={setInProcess} />
      <Field name={`ctlExplanation-${materialCode}`} label="Explanation of a difference" value={explanation} onChange={setExplanation} />
      <Field name={`ctlDeviation-${materialCode}`} label="Deviation of the batch (id), for a difference" value={deviation} onChange={setDeviation} />
      <ActButton
        label="Record the account"
        onPress={() =>
          record.run({
            body: {
              batchId,
              stageKey: stage.trim(),
              materialCode,
              consumed: consumed.trim(),
              inProcess: inProcess.trim(),
              ...(explanation.trim() !== '' ? { explanation: explanation.trim() } : {}),
              ...(deviation.trim() !== '' ? { deviationId: deviation.trim() } : {}),
            },
          })
        }
        disabled={!ok || record.busy}
      />
      <ActResult error={record.error} done={record.done} label="Recorded. Sign it to close the checkpoint." />
    </div>
  );
}
