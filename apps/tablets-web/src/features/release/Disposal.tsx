/**
 * The disposal of a rejected lot (Phase 4 slice 5c; PR-46, IN-05 (e), D-5-6), once per lot, on the "After release" tab:
 *  - one route: WITNESSED_DESTRUCTION (the performer signs DISPOSAL_RECORDED, then an independent witness signs
 *    DESTRUCTION_WITNESSED on the same record), REPROCESSING (naming a reprocessing authorisation of the same product) or
 *    RETURN (to the supplier or the customer, with a reference);
 *  - the recorded disposal with both signatures, and the serial-decommissioning task when the lot has serials.
 * Whether a disposal may be recorded, who may witness and whether the reprocessing authorisation fits are the database's
 * answers; the browser checks only the form of what it sends.
 */
import { useState } from 'react';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { GateProblems } from '../review/parts.tsx';
import { RELEASE_READS, stateTone, words, type DisposalView, type LotAfterReleaseView } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const ROUTES = ['WITNESSED_DESTRUCTION', 'REPROCESSING', 'RETURN'] as const;
type Route = (typeof ROUTES)[number];

export function DisposalSection({ view: v }: { view: LotAfterReleaseView }) {
  if (v.disposal) return <Recorded view={v} d={v.disposal} />;
  return <RecordDisposal view={v} />;
}

function RecordDisposal({ view: v }: { view: LotAfterReleaseView }) {
  const [route, setRoute] = useState<Route>('WITNESSED_DESTRUCTION');
  const [quantity, setQuantity] = useState('');
  const [returnTo, setReturnTo] = useState<'SUPPLIER' | 'CUSTOMER'>('SUPPLIER');
  const [reference, setReference] = useState('');
  const [reprocessing, setReprocessing] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const gate = v.disposalGate;
  const qty = QUANTITY.test(quantity.trim()) ? quantity.trim() : null;
  const ref = reference.trim() === '' ? null : reference.trim();
  const reprocessingRef = UUID.test(reprocessing.trim()) ? reprocessing.trim() : null;
  const note = text.trim() === '' ? null : text.trim();
  const complete = qty !== null && (route !== 'RETURN' || ref !== null) && (route !== 'REPROCESSING' || reprocessingRef !== null);
  const input = {
    disposalRoute: route,
    disposalQuantity: qty ?? '',
    ...(route === 'RETURN' ? { returnTo } : {}),
    ...(ref !== null && route !== 'REPROCESSING' ? { disposalReference: ref } : {}),
    ...(route === 'REPROCESSING' && reprocessingRef ? { reprocessingRef } : {}),
    ...(note ? { text: note } : {}),
  };
  return (
    <Section title="Disposal of the rejected lot" testId="disposal">
      <GateProblems gate={gate} testId="disposal-problems" />
      <p>A rejected lot is disposed of once, by one route. A destruction is signed by the person who performed it and then by an independent witness.</p>
      <floor.ChoiceGroup label="Route" options={ROUTES.map((r) => ({ value: r, label: words(r) }))} value={route} onChange={(x) => setRoute(ROUTES.find((r) => r === x) ?? 'WITNESSED_DESTRUCTION')} />
      <Field name="disposalQuantity" label="Quantity disposed of (in the lot's unit)" value={quantity} onChange={setQuantity} isDisabled={!gate.ready} />
      {route === 'RETURN' ? (
        <floor.ChoiceGroup
          label="Returned to"
          options={[
            { value: 'SUPPLIER', label: 'Supplier' },
            { value: 'CUSTOMER', label: 'Customer' },
          ]}
          value={returnTo}
          onChange={(x) => setReturnTo(x === 'CUSTOMER' ? 'CUSTOMER' : 'SUPPLIER')}
        />
      ) : null}
      {route === 'REPROCESSING' ? (
        <Field name="disposalReprocessing" label="Reprocessing authorisation (id)" value={reprocessing} onChange={setReprocessing} isDisabled={!gate.ready} />
      ) : (
        <Field name="disposalReference" label={route === 'RETURN' ? 'Return reference' : 'Destruction record reference (optional)'} value={reference} onChange={setReference} isDisabled={!gate.ready} />
      )}
      <Field name="disposalText" label="Note (optional)" value={text} onChange={setText} isDisabled={!gate.ready} />
      <ActButton
        label={route === 'WITNESSED_DESTRUCTION' ? 'Sign the destruction as performer' : `Sign the ${words(route).toLowerCase()}`}
        onPress={() => complete && signed.sign({ kind: 'RELEASE_ACT', act: 'DISPOSAL', lotId: v.lotId, input }, `Dispose of lot ${v.lotCode} by ${words(route).toLowerCase()}: ${qty ?? ''}`)}
        disabled={!gate.ready || !complete || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function Recorded({ view: v, d }: { view: LotAfterReleaseView; d: DisposalView }) {
  const signed = useSignedAct(RELEASE_READS);
  return (
    <Section title="Disposal of the lot" testId="disposal-recorded">
      <p data-testid="disposal-state" data-state={d.state}>
        <StatusChip tone={stateTone(d.state)} label={words(d.state)} /> {words(d.route)}, {floor.quantityText(d.quantity, d.unit)}
        {d.returnTo ? ` to the ${d.returnTo.toLowerCase()}` : ''}
        {d.reference ? `, reference ${d.reference}` : ''}
        {d.reprocessingRef ? `, reprocessing ${d.reprocessingRef}` : ''}
        {d.text ? `: ${d.text}` : ''}
      </p>
      <p>
        Performed and signed by {d.performedBy.legalName} ({words(d.performedBy.role)}), {d.performedAt.text}.
        {d.witnessedBy && d.witnessedAt ? ` Witnessed and signed by ${d.witnessedBy.legalName} (${words(d.witnessedBy.role)}), ${d.witnessedAt.text}.` : ''}
      </p>
      {d.state === 'AWAITING_WITNESS' ? (
        <div data-testid="disposal-witness">
          <p>The destruction waits for an independent witness: another person than the performer signs that it was done as recorded.</p>
          <ActButton
            label="Sign as the witness of the destruction"
            onPress={() => signed.sign({ kind: 'RELEASE_ACT', act: 'DISPOSAL', lotId: v.lotId, input: { disposalId: d.disposalId } }, `Witness the destruction of lot ${v.lotCode}: ${d.quantity} ${d.unit}`)}
            disabled={signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </div>
      ) : null}
    </Section>
  );
}
