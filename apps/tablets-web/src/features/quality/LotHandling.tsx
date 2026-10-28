/**
 * What is done with a material lot besides its receipt and release (Phase 7 slice 7g, WP4; decision 0025), on the lot
 * page: the witnessed destruction of a rejected, returned or recalled lot (stores record it as its performer, a witness
 * other than the performer signs LOT_DESTRUCTION_WITNESS through the ceremony, then the performer destroys the lot with
 * that signature: IN-24 (a)), the lot's reservations (an open one cancelled with the person's reason) and its
 * stock-location exceptions (QA closes one with a deviation linked to the lot and what was done: PR-46). Every right and
 * rule is the database's; its refusal is shown in its own words.
 * Phase 7 slice 7h (WP-A, gap report A1): stores reserve a quantity of the lot for a batch chosen from the open batches
 * (MATERIAL.HANDLE; INV-13, PR-18: only a released lot, no more than is available, until no later than its retest or
 * expiry).
 */
import { useState } from 'react';
import { routes, type LotHandlingView, type LotSummaryView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { PotencyPreview } from '../../app/potency.tsx';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { LOT_READS } from './LotsPage.tsx';

const READS = [routes.quality.lotHandling.id, ...LOT_READS];
const DESTROYABLE = ['REJECTED', 'RETURNED', 'RECALLED'];

export function LotHandling({ lot }: { lot: LotSummaryView }) {
  const q = useApiQuery(routes.quality.lotHandling, { params: { lotId: lot.lotId } });
  const qa = useOffered('QA');
  return (
    <>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          {DESTROYABLE.includes(lot.status) || q.data.destruction ? <Destruction lot={lot} h={q.data} /> : null}
          <Reservations h={q.data} lot={lot} />
          {q.data.locationExceptions.length > 0 ? <LocationExceptions h={q.data} qa={qa} /> : null}
        </>
      ) : null}
    </>
  );
}

function Destruction({ lot, h }: { lot: LotSummaryView; h: LotHandlingView }) {
  const record = useCommand(routes.quality.recordLotDestruction, READS, 'recording the destruction of the lot');
  const destroy = useCommand(routes.quality.destroyLot, READS, 'the destruction of the lot');
  const witness = useSignedAct(READS);
  const [method, setMethod] = useState('');
  const [reason, setReason] = useState('');
  const d = h.destruction;
  return (
    <Section title="Destruction" testId="lot-destruction">
      {d ? (
        <p data-testid="destruction-record">
          {d.quantity} {d.unit} by {d.method}, recorded by {d.performedBy.legalName} at {d.recordedAt.text}. Reason: {d.reason}
        </p>
      ) : (
        <>
          <Field name="destructionMethod" label="Method of destruction" value={method} onChange={setMethod} />
          <Field name="destructionReason" label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Record the destruction (you perform it)"
            disabled={method.trim() === '' || reason.trim() === '' || record.busy}
            onPress={async () => {
              if (await record.run({ params: { lotId: lot.lotId }, body: { method: method.trim(), reason: reason.trim() } })) {
                setMethod('');
                setReason('');
              }
            }}
          />
          <ActResult error={record.error} />
        </>
      )}
      {d && lot.status !== 'DESTROYED' ? (
        <>
          {h.witness ? (
            <p data-testid="destruction-witness">Witnessed by {h.witness.signedBy.legalName}.</p>
          ) : (
            <>
              <p>A witness other than the performer signs the destruction.</p>
              <ActButton
                primary={false}
                label="Sign as the witness of the destruction"
                disabled={witness.busy}
                onPress={() => witness.sign({ kind: 'LOT_DESTRUCTION_WITNESS', lotId: lot.lotId }, `Witness the destruction of lot ${lot.lotCode} (${d.quantity} ${d.unit}, ${d.method})`)}
              />
              <ActResult error={witness.error} outcome={witness.outcome} />
            </>
          )}
          {h.witness ? (
            <>
              <ActButton
                label="Destroy the lot (the performer, with the witness's signature)"
                disabled={destroy.busy}
                onPress={() => h.witness && destroy.run({ params: { lotId: lot.lotId }, body: { expectedVersion: lot.version, witnessSignatureId: h.witness.signatureId } })}
              />
              <ActResult error={destroy.error} done={destroy.done} label="The lot is destroyed." />
            </>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function Reservations({ h, lot }: { h: LotHandlingView; lot: LotSummaryView }) {
  const stores = useOffered('STORES');
  const cancel = useCommand(routes.quality.cancelReservation, READS, 'cancelling a reservation');
  const [chosen, setChosen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const open = h.reservations.filter((r) => !r.revoked);
  return (
    <Section title="Reservations" testId="lot-reservations">
      {h.reservations.length === 0 ? <p>No reservation.</p> : null}
      <ul>
        {h.reservations.map((r) => (
          <li key={r.reservationId} data-testid={`reservation-${r.batchNumber}`}>
            {r.quantity} {r.unit} for batch {r.batchNumber}, by {r.reservedBy.legalName} at {r.reservedAt.text}, until {r.expiresAt.text}{' '}
            {r.revoked ? <StatusChip tone="neutral" label={`${r.revoked.kind.toLowerCase()} by ${r.revoked.by.legalName}${r.revoked.reason ? `: ${r.revoked.reason}` : ''}`} /> : <StatusChip tone="ok" label="open" />}
          </li>
        ))}
      </ul>
      {stores && open.length > 0 ? (
        <>
          <floor.ChoiceGroup label="Reservation to cancel" options={open.map((r) => ({ value: r.reservationId, label: `${r.batchNumber}: ${r.quantity} ${r.unit}` }))} value={chosen} onChange={setChosen} />
          <Field name="cancelReason" label="Your reason" value={reason} onChange={setReason} />
          <ActButton
            label="Cancel the reservation"
            disabled={!chosen || reason.trim() === '' || cancel.busy}
            onPress={async () => {
              if (chosen && (await cancel.run({ params: { reservationId: chosen }, body: { reason: reason.trim() } }))) {
                setChosen(null);
                setReason('');
              }
            }}
          />
          <ActResult error={cancel.error} done={cancel.done} label="Reservation cancelled." />
        </>
      ) : null}
      {stores ? <ReserveLot lot={lot} /> : null}
    </Section>
  );
}

const OPEN_BATCH = ['ISSUED', 'IN_PROGRESS', 'ON_HOLD'];

function ReserveLot({ lot }: { lot: LotSummaryView }) {
  const batches = useApiQuery(routes.batches.list);
  const reserve = useCommand(routes.quality.reserveLot, READS, 'reserving a lot');
  const [batch, setBatch] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [until, setUntil] = useState('');
  const open = (batches.data?.batches ?? []).filter((b) => OPEN_BATCH.includes(b.status));
  const chosenBatch = open.find((b) => b.batchNumber === batch) ?? null;
  const body = { batchNumber: batch ?? '', quantity: quantity.trim(), ...(until.trim() !== '' ? { expiresOn: until.trim() } : {}) };
  const parsed = routes.quality.reserveLot.body?.safeParse(body);
  return (
    <div data-testid="reserve-lot">
      <h3>Reserve for a batch</h3>
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      {batches.isPending ? <p>Loading…</p> : open.length === 0 ? <p>No open batch to reserve for.</p> : <floor.ChoiceGroup label="Batch" options={open.map((b) => ({ value: b.batchNumber, label: `${b.batchNumber} ${b.product.code} (${b.statusText})` }))} value={batch} onChange={setBatch} />}
      {/* R13: what the batch's potency-adjusted dispensing will calculate with this lot, before it is reserved. */}
      {chosenBatch ? <PotencyPreview batchId={chosenBatch.runId} lotCode={lot.lotCode} /> : null}
      <Field name="reserveQuantity" label={`Quantity (${lot.unit})`} value={quantity} onChange={setQuantity} inputMode="decimal" />
      <Field name="reserveUntil" label="Reserved until (YYYY-MM-DD, optional)" description="By default 30 days, or the lot's retest or expiry when sooner." value={until} onChange={setUntil} />
      <ActButton
        label="Reserve the lot"
        disabled={!batch || parsed?.success !== true || reserve.busy}
        onPress={async () => {
          if (parsed?.success && (await reserve.run({ params: { lotId: lot.lotId }, body: parsed.data }))) {
            setQuantity('');
            setUntil('');
          }
        }}
      />
      <ActResult error={reserve.error} done={reserve.done} label="Lot reserved." />
    </div>
  );
}

function LocationExceptions({ h, qa }: { h: LotHandlingView; qa: boolean }) {
  return (
    <Section title="Stock-location exceptions" testId="lot-location-exceptions">
      <ul>
        {h.locationExceptions.map((e) => (
          <li key={e.exceptionId} data-testid={`location-exception-${e.exceptionId}`}>
            <p>
              {e.problem} (raised {e.raisedAt.text}){' '}
              {e.resolved ? <StatusChip tone="ok" label={`closed by ${e.resolved.by.legalName}: ${e.resolved.note}`} /> : <StatusChip tone="warning" label="open: the lot is blocked" />}
            </p>
            {qa && !e.resolved ? <ResolveException exceptionId={e.exceptionId} /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ResolveException({ exceptionId }: { exceptionId: string }) {
  const resolve = useCommand(routes.quality.resolveLotLocationException, READS, 'closing a stock-location exception');
  const [deviationId, setDeviationId] = useState('');
  const [note, setNote] = useState('');
  return (
    <>
      <Field name="exceptionDeviation" label="Deviation linked to the lot (id)" value={deviationId} onChange={setDeviationId} />
      <Field name="exceptionNote" label="What was done" value={note} onChange={setNote} />
      <ActButton
        label="Close the exception"
        disabled={deviationId.trim() === '' || note.trim() === '' || resolve.busy}
        onPress={() => resolve.run({ params: { exceptionId }, body: { deviationId: deviationId.trim(), note: note.trim() } })}
      />
      <ActResult error={resolve.error} done={resolve.done} label="Exception closed." />
    </>
  );
}
