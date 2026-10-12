/**
 * Packaging orders of the site (Phase 4 slice 2c): each with its pack type, the processing batch it packs, whether QA has
 * released that batch for packing (the database's reason when not) and how many containers of bulk it took; each opens
 * its bulk-issue screen. A packaging order is planned from its ERP order on /planning.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';

export function PackagingOrdersPage() {
  const orders = useApiQuery(routes.planning.packagingOrders);
  return (
    <>
      <h1>Packaging orders</h1>
      <p>
        <Link to="/planning">Planning</Link> · <Link to="/planning/batches">Batches</Link>
      </p>
      {orders.isPending ? <p>Loading the packaging orders…</p> : null}
      {orders.error ? <RefusalMessage error={orders.error.error} /> : null}
      {orders.data && orders.data.orders.length === 0 ? <p>No packaging order is planned at this site.</p> : null}
      <table aria-label="Packaging orders">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Master and pack type</th>
            <th scope="col">State</th>
            <th scope="col">Processing batch</th>
            <th scope="col">Release for packing</th>
            <th scope="col">Bulk containers</th>
          </tr>
        </thead>
        <tbody>
          {orders.data?.orders.map((o) => (
            <tr key={o.batchId} data-testid={`packaging-order-${o.batchNumber}`}>
              <td>
                <Link to="/planning/packaging/$batchId" params={{ batchId: o.batchId }}>
                  {o.batchNumber}
                </Link>
              </td>
              <td>
                {o.familyCode} · {o.packType ?? 'no pack type'}
              </td>
              <td>
                <StatusChip tone={o.status === 'PLANNED' ? 'neutral' : 'ok'} label={o.status} />
              </td>
              <td>{o.parentBatchNumber ?? 'none'}</td>
              <td>{o.releaseForPackingProblem ? `Not yet: ${o.releaseForPackingProblem}` : 'Released for packing'}</td>
              <td>{o.bulkContainers}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
