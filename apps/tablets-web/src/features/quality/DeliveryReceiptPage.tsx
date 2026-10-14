/**
 * Receipt of a delivery with its supplier batches (Phase 6 slice 6a, builder A; PR-17 clause 2; site services 0910): one
 * lot in quarantine per supplier batch, each with its own receipt record (supplier, supplier batch, manufacturer,
 * containers). The database numbers each lot and says whether its manufacturer is approved; stores then examine the
 * containers of each lot (its receipt page). Deliveries that arrive from the WMS are received by its adapter the same way.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { useOffered } from '../../app/roles.ts';

const MATERIAL = /^[A-Z0-9][A-Z0-9/._-]{0,39}$/;
const CODE = /^[!-~]{1,64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface BatchDraft {
  supplierLot: string;
  manufacturerCode: string;
  containers: string;
  quantity: string;
  expiry: string;
}
const empty = (): BatchDraft => ({ supplierLot: '', manufacturerCode: '', containers: '', quantity: '', expiry: '' });
const batchOk = (b: BatchDraft) => CODE.test(b.supplierLot.trim()) && CODE.test(b.manufacturerCode.trim()) && /^[1-9][0-9]{0,5}$/.test(b.containers.trim()) && DECIMAL.test(b.quantity.trim()) && DATE.test(b.expiry.trim());

export function DeliveryReceiptPage() {
  const stores = useOffered('STORES');
  const receive = useCommand(routes.quality.receiveDelivery, [routes.quality.lots.id], 'the receipt of the delivery');
  const [deliveryId, setDeliveryId] = useState('');
  const [material, setMaterial] = useState('');
  const [supplier, setSupplier] = useState('');
  const [noteName, setNoteName] = useState('');
  const [unit, setUnit] = useState('kg');
  const [batches, setBatches] = useState<BatchDraft[]>([empty()]);
  const set = (i: number, k: keyof BatchDraft, v: string) => setBatches((bs) => bs.map((b, j) => (j === i ? { ...b, [k]: v } : b)));
  const ok = CODE.test(deliveryId.trim()) && MATERIAL.test(material.trim()) && CODE.test(supplier.trim()) && /^[!-~]{1,32}$/.test(unit.trim()) && batches.length > 0 && batches.every(batchOk);
  return (
    <>
      <h1>Receive a delivery</h1>
      <p>Each supplier batch of the delivery becomes its own lot in quarantine. The same supplier batch in another delivery is another lot.</p>
      {stores ? null : <p>Receipt is the warehouse&apos;s act.</p>}
      <Section title="Delivery" testId="delivery-receipt">
        <Field name="deliveryId" label="Delivery (goods receipt note)" value={deliveryId} onChange={setDeliveryId} />
        <Field name="deliveryMaterial" label="Material code" value={material} onChange={setMaterial} />
        <Field name="deliverySupplier" label="Supplier code" value={supplier} onChange={setSupplier} />
        <Field name="deliveryNote" label="Name on the delivery note (optional)" value={noteName} onChange={setNoteName} />
        <Field name="deliveryUnit" label="Unit of the quantities" value={unit} onChange={setUnit} />
        {batches.map((b, i) => (
          <fieldset key={i} data-testid={`supplier-batch-${i.toString()}`}>
            <legend>Supplier batch {(i + 1).toString()}</legend>
            <Field name={`sb-lot-${i.toString()}`} label="Supplier batch number" value={b.supplierLot} onChange={(v) => set(i, 'supplierLot', v)} />
            <Field name={`sb-mfr-${i.toString()}`} label="Manufacturer code (from the label)" value={b.manufacturerCode} onChange={(v) => set(i, 'manufacturerCode', v)} />
            <Field name={`sb-cont-${i.toString()}`} label="Number of containers" value={b.containers} onChange={(v) => set(i, 'containers', v)} />
            <Field name={`sb-qty-${i.toString()}`} label="Quantity" value={b.quantity} onChange={(v) => set(i, 'quantity', v)} />
            <Field name={`sb-exp-${i.toString()}`} label="Expiry date (YYYY-MM-DD)" value={b.expiry} onChange={(v) => set(i, 'expiry', v)} />
          </fieldset>
        ))}
        <ActButton label="Add a supplier batch" primary={false} onPress={() => setBatches((bs) => [...bs, empty()])} disabled={batches.length >= 100} />
        <ActButton
          label="Receive the delivery"
          disabled={!ok || receive.busy}
          onPress={() =>
            receive.run({
              body: {
                deliveryId: deliveryId.trim(), materialCode: material.trim(), supplierCode: supplier.trim(), ...(noteName.trim() ? { deliveryNoteName: noteName.trim() } : {}),
                supplierBatches: batches.map((b) => ({
                  supplierLot: b.supplierLot.trim(), manufacturerCode: b.manufacturerCode.trim(), containers: b.containers.trim(),
                  quantity: { value: b.quantity.trim(), unit: unit.trim() }, expiresAt: `${b.expiry.trim()}T00:00:00+05:30`,
                })),
              },
            })
          }
        />
        <ActResult error={receive.error} done={receive.done} label="The delivery is received." />
      </Section>
      {receive.done ? (
        <Section title="Lots received" testId="delivery-lots">
          <ul>
            {receive.done.lots.map((l) => (
              <li key={l.lotId}>
                <Link to="/quality/lots/$lotId/receipt" params={{ lotId: l.lotId }}>
                  {l.lotCode}
                </Link>{' '}
                (supplier batch {l.supplierLot}, manufacturer {l.manufacturerCode}){' '}
                {l.manufacturerApproved ? <StatusChip tone="ok" label="Manufacturer approved" /> : <StatusChip tone="error" label="Manufacturer not approved: lot blocked" />}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
