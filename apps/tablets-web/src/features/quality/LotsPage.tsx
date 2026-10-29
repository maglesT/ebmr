/**
 * Material lots (Phase 3 slice 6, outline 5.2.9): the site's lots with status and dates, and a lot received into
 * quarantine from the ERP material master (kind, name and unit are the master's).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

export const LOT_READS = [routes.quality.lots.id, routes.quality.lotResults.id, routes.quality.lotProfiles.id];

export function LotsPage() {
  const q = useApiQuery(routes.quality.lots);
  const stores = useOffered('STORES');
  return (
    <>
      <h1>Material lots</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <table aria-label="Lots">
        <thead>
          <tr>
            <th scope="col">Lot</th>
            <th scope="col">Material</th>
            <th scope="col">Status</th>
            <th scope="col">Quantity</th>
            <th scope="col">Supplier</th>
            <th scope="col">Expiry</th>
            <th scope="col">Retest</th>
          </tr>
        </thead>
        <tbody>
          {q.data?.lots.map((l) => (
            <tr key={l.lotId} data-testid={`lot-${l.lotCode}`}>
              <td>
                <Link to="/quality/lots/$lotId" params={{ lotId: l.lotId }}>
                  {l.lotCode}
                </Link>
              </td>
              <td>
                {l.material.name} ({l.material.code}, {l.material.kind})
              </td>
              <td>
                <StatusChip tone={l.status === 'RELEASED' ? 'ok' : l.status === 'REJECTED' ? 'error' : 'warning'} label={l.status} />
              </td>
              <td>
                {floor.quantityText(l.quantity, l.unit)}
              </td>
              <td>{[l.supplier, l.supplierLot].filter(Boolean).join(' / ') || '-'}</td>
              <td>{l.expiry?.text ?? '-'}</td>
              <td>{l.retest?.text ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stores ? (
        <Section title="Receive a lot" testId="receive-lot">
          <DefineForm
            title="Receive a lot into quarantine"
            route={routes.quality.receiveLot}
            refresh={LOT_READS}
            submitLabel="Receive the lot"
            fields={[
              { name: 'materialCode', label: 'Material code', kind: 'text', description: 'From the ERP material master' },
              { name: 'lotCode', label: 'Lot code', kind: 'text' },
              { name: 'supplier', label: 'Supplier', kind: 'text' },
              { name: 'supplierLot', label: 'Supplier lot', kind: 'text' },
              { name: 'quantity', label: 'Quantity', kind: 'decimal' },
              { name: 'expiresAt', label: 'Expiry', kind: 'instant', description: 'ISO-8601 with offset, e.g. 2028-06-30T23:59:59+05:30' },
              { name: 'retestAt', label: 'Retest date', kind: 'instant', optional: true },
            ]}
          />
        </Section>
      ) : null}
    </>
  );
}
