/**
 * The shipments of a finished lot (slice 7g-5, decision 0025; route erpShipping.lot; INV-42): every shipment the ERP
 * recorded, with the market, consignee, quantity and the manufacturer and market states the shipping interlock saw when
 * it let the shipment through. The ERP ships under its own identity; this is the read of what it did.
 */
import { routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { words } from './reads.ts';

export function LotShipments({ lotId }: { lotId: string }) {
  const q = useApiQuery(routes.erpShipping.lot, { params: { lotId } });
  return (
    <Section title="Shipments" testId="lot-shipments">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.shipments.length === 0 ? <p>The lot has not been shipped.</p> : null}
      {q.data && q.data.shipments.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Shipment</th>
              <th scope="col">Market</th>
              <th scope="col">Consignee</th>
              <th scope="col">Quantity</th>
              <th scope="col">States the interlock saw</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {q.data.shipments.map((s) => (
              <tr key={s.shipmentId} data-testid={`shipment-${s.shipmentNo}`}>
                <th scope="row">
                  {s.shipmentNo} <span>(ERP {s.erpReference})</span>
                </th>
                <td>{s.market}</td>
                <td>
                  {s.consigneeName} ({s.consigneeCode})
                </td>
                <td>
                  {floor.quantityText(s.quantity, s.unit)} {s.quarantine ? <StatusChip tone="warning" label="Under quarantine" /> : null}
                </td>
                <td>
                  Manufacturer {words(s.manufacturerState)}, market {words(s.dispositionState)}
                </td>
                <td>{s.recordedAt.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Section>
  );
}
