/**
 * ERP import status (Phase 3 slice 6): what the ERP stub has sent for the site (products, materials, production
 * orders), as the database holds it. The import itself is the ERP interface's own call (POST /api/erp/import).
 */
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

export function ErpStatusPage() {
  const products = useApiQuery(routes.quality.erpProducts);
  const materials = useApiQuery(routes.quality.erpMaterials);
  const orders = useApiQuery(routes.quality.erpOrders);
  const error = products.error ?? materials.error ?? orders.error;
  return (
    <>
      <h1>ERP import status</h1>
      {error ? <RefusalMessage error={error.error} /> : null}
      <ul data-testid="erp-counts">
        <li>Products: {products.data?.products.length ?? '…'}</li>
        <li>Materials: {materials.data?.materials.length ?? '…'}</li>
        <li>Production orders: {orders.data?.orders.length ?? '…'}</li>
      </ul>
      <Section title="Production orders received" testId="erp-orders">
        <table aria-label="Production orders">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Site</th>
              <th scope="col">Product</th>
              <th scope="col">Batch size</th>
              <th scope="col">ERP reference</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {orders.data?.orders.map((o) => (
              <tr key={o.orderNo}>
                <td>{o.orderNo}</td>
                <td>{o.siteCode}</td>
                <td>
                  {o.productCode} {o.strength}
                </td>
                <td>
                  {o.batchSize} {o.batchSizeUnit}
                </td>
                <td>{o.erpReference}</td>
                <td>{o.receivedAt.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}
