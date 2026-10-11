/**
 * ERP import status (Phase 3 slice 6): what the ERP stub has sent for the site (products, materials, production
 * orders), as the database holds it. The import itself is the ERP interface's own call (POST /api/erp/import).
 *
 * Exit review HIGH-1 (site-services 0802): the masters counted are the versions in effect. A new code, or a version that
 * changes a product's reprocessing permission or shelf life, or a material's kind or maximum retest interval, waits for
 * QA: it is listed beside the values in effect, and the QA MBR approver confirms it with ERP_MASTER_CONFIRMED through the
 * ceremony (signable action MASTER_DATA_APPROVE). The database decides who may confirm, and refuses the ERP interface's
 * own person.
 */
import { routes, type ErpPendingView } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';

const REFRESH = [routes.quality.erpPending.id, routes.quality.erpProducts.id, routes.quality.erpMaterials.id];

const show = (v: unknown): string => (v === null || v === undefined ? '-' : String(v));

/** The values a pending version changes, as "name: in effect -> received" (all of them for a new code). */
export function changesOf(p: ErpPendingView): string[] {
  return Object.keys(p.values)
    .filter((k) => p.inEffect === null || p.inEffect[k] !== p.values[k])
    .map((k) => (p.inEffect === null ? `${k}: ${show(p.values[k])}` : `${k}: ${show(p.inEffect[k])} -> ${show(p.values[k])}`));
}

function PendingRow({ p, confirmer }: { p: ErpPendingView; confirmer: boolean }) {
  const signed = useSignedAct(REFRESH);
  const masterKind = p.masterKind === 'PRODUCT' ? 'ERP_PRODUCT' : 'ERP_MATERIAL';
  return (
    <tr>
      <td>{p.masterKind === 'PRODUCT' ? 'Product' : 'Material'}</td>
      <td>{p.key.replace('|', ' ')}</td>
      <td>{p.inEffect === null ? 'New code' : changesOf(p).join('; ')}</td>
      <td>{p.erpReference}</td>
      <td>{p.receivedAt.text}</td>
      <td>
        {confirmer ? (
          <>
            <ActButton
              label={`Confirm ${p.key.replace('|', ' ')}`}
              onPress={() => signed.sign({ kind: 'MASTER_DATA_APPROVE', masterKind, versionId: p.versionId }, `Confirm the ERP ${p.masterKind === 'PRODUCT' ? 'product' : 'material'} master ${p.key.replace('|', ' ')} (${p.erpReference})`)}
              disabled={signed.busy}
            />
            <ActResult error={signed.error} outcome={signed.outcome} />
          </>
        ) : (
          'Waiting for QA'
        )}
      </td>
    </tr>
  );
}

export function ErpStatusPage() {
  const products = useApiQuery(routes.quality.erpProducts);
  const materials = useApiQuery(routes.quality.erpMaterials);
  const orders = useApiQuery(routes.quality.erpOrders);
  const pending = useApiQuery(routes.quality.erpPending);
  const confirmer = useOffered('MASTER_CONFIRMER');
  const error = products.error ?? materials.error ?? orders.error ?? pending.error;
  return (
    <>
      <h1>ERP import status</h1>
      {error ? <RefusalMessage error={error.error} /> : null}
      <ul data-testid="erp-counts">
        <li>Products in effect: {products.data?.products.length ?? '…'}</li>
        <li>Materials in effect: {materials.data?.materials.length ?? '…'}</li>
        <li>Production orders: {orders.data?.orders.length ?? '…'}</li>
        <li>Waiting for QA confirmation: {pending.data?.pending.length ?? '…'}</li>
      </ul>
      <Section title="Master data waiting for QA confirmation" testId="erp-pending">
        {pending.data && pending.data.pending.length === 0 ? <p>Nothing is waiting: every master version received is in effect.</p> : null}
        <table aria-label="Master data waiting for QA confirmation">
          <thead>
            <tr>
              <th scope="col">Master</th>
              <th scope="col">Code</th>
              <th scope="col">Change (in effect -&gt; received)</th>
              <th scope="col">ERP reference</th>
              <th scope="col">Received</th>
              <th scope="col">Confirmation</th>
            </tr>
          </thead>
          <tbody>
            {pending.data?.pending.map((p) => (
              <PendingRow key={p.versionId} p={p} confirmer={confirmer} />
            ))}
          </tbody>
        </table>
      </Section>
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
