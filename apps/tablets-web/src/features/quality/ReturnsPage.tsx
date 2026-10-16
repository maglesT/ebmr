/**
 * Returned goods (Phase 4 slice 2c screens, on slice 2b's contract ns/samples.ts; PR-48): the site's returns with their
 * quarantined lot; booking in a return of a finished lot; QC's assessment (nature, storage, condition history, time since
 * issue, doubt, other batches implicated, the disposition) and its signature (LIMS_ACT RETURN_ASSESSMENT_SIGN). With any
 * doubt only destruction or chemical recovery is allowed: the database decides and the screen shows its words.
 * Phase 6 slice 6d (IN-29, PR-48): once QC signed an assessment choosing chemical recovery, the stores record the
 * recovery (samples.recoverReturn): the recovered material becomes a quarantined lot linked in the genealogy.
 */
import { useState } from 'react';
import { routes, type LotSummaryView, type ReturnView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { LOT_READS } from './LotsPage.tsx';

const READS = [routes.samples.returns.id, ...LOT_READS];

export function ReturnsPage() {
  const q = useApiQuery(routes.samples.returns);
  const lots = useApiQuery(routes.quality.lots);
  const qc = useOffered('QC');
  const stores = useOffered('STORES');
  const finished = (lots.data?.lots ?? []).filter((l) => l.status === 'RELEASED');
  return (
    <>
      <h1>Returned goods</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.returns.length === 0 ? <p>No return booked in.</p> : null}
      {q.data?.returns.map((r) => (
        <ReturnCard key={r.lotId} r={r} qc={qc} stores={stores} />
      ))}
      {stores || qc ? (
        <ReceiveReturn lots={finished} />
      ) : null}
    </>
  );
}

function ReturnCard({ r, qc, stores }: { r: ReturnView; qc: boolean; stores: boolean }) {
  const signed = useSignedAct(READS);
  const a = r.assessment;
  return (
    <Section title={`Return ${r.lotCode} of lot ${r.originalLotCode}`} testId={`return-${r.lotCode}`}>
      <p>
        <StatusChip tone={r.status === 'QUARANTINE' ? 'warning' : 'neutral'} label={r.status} /> {r.productCode} · {r.quantity} {r.unit} from {r.returnedFrom}: {r.reason} · booked in by {r.receivedBy.legalName},{' '}
        {r.receivedAt.text}
      </p>
      {a ? (
        <p data-testid="return-assessment">
          Assessment: {a.nature}; storage {a.storage}; condition {a.conditionHistory}; {a.timeSinceIssue} since issue; {a.doubt ? 'doubt' : 'no doubt'};{' '}
          {a.implicatesOtherBatches ? 'other batches implicated' : 'no other batch implicated'} · disposition {a.disposition} · recorded by {a.recordedBy.legalName} · {a.signed ? 'signed' : 'not signed yet'}
        </p>
      ) : (
        <p>Not assessed yet.</p>
      )}
      {qc && r.status === 'QUARANTINE' && (!a || !a.signed) ? (
        <DefineForm
          title={`Assess ${r.lotCode}`}
          route={routes.samples.assessReturn}
          params={{ lotId: r.lotId }}
          refresh={READS}
          submitLabel="Record the assessment"
          fields={[
            { name: 'nature', label: 'Nature of the product', kind: 'text' },
            { name: 'storage', label: 'Storage conditions', kind: 'text' },
            { name: 'conditionHistory', label: 'Condition and history', kind: 'text' },
            { name: 'timeSinceIssue', label: 'Time since issue', kind: 'text' },
            { name: 'doubt', label: 'Any doubt about the quality', kind: 'yesno' },
            { name: 'implicatesOtherBatches', label: 'Other batches implicated', kind: 'yesno' },
            { name: 'investigationId', label: 'Investigation (deviation id)', kind: 'text', optional: true, description: 'When other batches are implicated' },
            { name: 'disposition', label: 'Disposition', kind: 'choice', options: ['DESTROY', 'CHEMICAL_RECOVERY', 'RETURN_TO_STOCK'], optional: true, description: 'DESTROY when none is chosen' },
          ]}
        />
      ) : null}
      {qc && a && !a.signed ? (
        <ActButton
          label={`Sign the assessment of ${r.lotCode}`}
          onPress={() => signed.sign({ kind: 'LIMS_ACT', act: 'RETURN_ASSESSMENT_SIGN', subjectId: r.lotId }, `Assessment of returned goods ${r.lotCode}: ${a.disposition}`)}
          disabled={signed.busy || signed.outcome === 'SIGNED'}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
      {stores && a?.signed && a.disposition === 'CHEMICAL_RECOVERY' && (r.status === 'QUARANTINE' || r.status === 'REJECTED') ? (
        <DefineForm
          title={`Chemical recovery of ${r.lotCode}`}
          route={routes.samples.recoverReturn}
          params={{ lotId: r.lotId }}
          refresh={READS}
          submitLabel="Record the chemical recovery"
          fields={[
            { name: 'materialCode', label: 'Recovered material code', kind: 'text' },
            { name: 'materialName', label: 'Recovered material name', kind: 'text' },
            { name: 'quantity', label: 'Quantity recovered', kind: 'decimal' },
            { name: 'unit', label: 'Unit', kind: 'text' },
            { name: 'processReference', label: 'Recovery procedure and run', kind: 'text' },
            { name: 'expiresAt', label: 'Expiry (UTC, e.g. 2029-01-01T00:00:00Z)', kind: 'instant' },
            { name: 'retestAt', label: 'Retest (UTC)', kind: 'instant', optional: true },
            { name: 'returnedQuantity', label: 'Returned quantity taken', kind: 'decimal', optional: true, description: 'All of the return when empty' },
          ]}
        />
      ) : null}
    </Section>
  );
}

/** Books in returned goods of a released lot: the database creates the quarantined lot of kind RETURNED (PR-48). */
function ReceiveReturn({ lots }: { lots: LotSummaryView[] }) {
  const [lotId, setLotId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState('');
  const cmd = useCommand(routes.samples.receiveReturn, READS, 'booking in returned goods');
  const body = { originalLotId: lotId ?? '', quantity: quantity.trim(), reason: reason.trim(), returnedFrom: from.trim() };
  const ok = routes.samples.receiveReturn.body?.safeParse(body).success === true;
  return (
    <Section title="Book in a return" testId="receive-return">
      {lots.length === 0 ? <p>No released lot to return.</p> : <floor.ChoiceGroup label="Lot returned" options={lots.map((l) => ({ value: l.lotId, label: `${l.lotCode} ${l.material.name}` }))} value={lotId} onChange={setLotId} />}
      <Field name="returnQuantity" label="Quantity returned" value={quantity} onChange={setQuantity} inputMode="decimal" />
      <Field name="returnReason" label="Reason for the return" value={reason} onChange={setReason} />
      <Field name="returnedFrom" label="Returned from" value={from} onChange={setFrom} />
      <ActButton label="Book in the return" onPress={() => cmd.run({ body })} disabled={!ok || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label="Booked in, in quarantine." />
    </Section>
  );
}
