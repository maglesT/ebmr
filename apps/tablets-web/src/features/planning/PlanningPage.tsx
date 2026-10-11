/**
 * Planning (Phase 3 slice 6, outline 7 and 5.2.2): the site's open ERP production orders, each with the MBR version
 * effective for its product, strength and batch size (or the server's reason none matches); a batch is planned from an
 * order (POST /api/batches: batch number from the register, control recipe pinned) and issued through the ceremony
 * (GMP_BATCH_ISSUE, meaning ISSUED, with the issuer's own reason). The database checks the order again at issue.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type DataValueWire, type PlannedBatchView, type PlanningOrderView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { inputValue } from '../floor/pages/IssueForm.tsx';

const REFRESH = [routes.planning.orders.id, routes.batches.list.id];

export function PlanningPage() {
  const orders = useApiQuery(routes.planning.orders);
  const erp = useApiQuery(routes.quality.erpOrders);
  const canPlan = useOffered('PLANNING');
  return (
    <>
      <h1>Planning</h1>
      <p>
        <Link to="/planning/batches">Batches and their states</Link>
      </p>
      {orders.isPending ? <p>Loading the orders…</p> : null}
      {orders.error ? <RefusalMessage error={orders.error.error} /> : null}
      {orders.data && orders.data.orders.length === 0 ? <p>No open production order from the ERP.</p> : null}
      <ul aria-label="Open production orders">
        {orders.data?.orders.map((o) => (
          <li key={o.orderNo} data-testid={`order-${o.orderNo}`}>
            <OrderCard order={o} site={erp.data?.orders.find((e) => e.orderNo === o.orderNo)?.siteCode ?? null} canPlan={canPlan} />
          </li>
        ))}
      </ul>
    </>
  );
}

function OrderCard({ order, site, canPlan }: { order: PlanningOrderView; site: string | null; canPlan: boolean }) {
  const [planned, setPlanned] = useState<PlannedBatchView | null>(null);
  return (
    <article aria-label={`Order ${order.orderNo}`}>
      <h2>
        {order.orderNo} · {order.productName ?? order.productCode} {order.strength} · {order.batchSize} {order.batchSizeUnit}
      </h2>
      <p>Bill of materials: {order.bom.map((b) => `${b.materialCode} ${b.quantity} ${b.unit}`).join('; ')}</p>
      {order.match ? (
        <p data-testid="match">
          MBR {order.match.familyCode} version {order.match.versionNumber} (batch size {order.match.batchSizeId}; markets {order.match.markets.join(', ')})
        </p>
      ) : (
        <Banner tone="warning" title="No master record matches this order.">
          {order.noMatch}
        </Banner>
      )}
      {order.batches.length > 0 ? <p>Batches: {order.batches.map((b) => `${b.batchNumber} (${b.status})`).join(', ')}</p> : null}
      {order.match && canPlan && !planned ? <PlanForm order={order} site={site} onPlanned={setPlanned} /> : null}
      {planned ? <IssueForm batch={planned} /> : null}
    </article>
  );
}

function PlanForm({ order, site, onPlanned }: { order: PlanningOrderView; site: string | null; onPlanned: (b: PlannedBatchView) => void }) {
  const match = order.match;
  const [siteCode, setSite] = useState('');
  const [line, setLine] = useState('');
  const plan = useCommand(routes.execution.planBatch, REFRESH);
  const areas = useApiQuery(routes.plant.areas);
  const lines = areas.data?.areas.filter((a) => a.kind === 'LINE') ?? [];
  const chosenSite = siteCode.trim() || site || '';
  if (!match) return null;
  const go = async () => {
    const b = await plan.run({ body: { familyId: match.familyId, markets: match.markets, site: chosenSite, line: line.trim(), batchSize: order.batchSize } });
    if (b) onPlanned(b);
  };
  return (
    <div data-testid="plan-form">
      <h3>Plan a batch</h3>
      <Field name="site" label="Site" value={siteCode} onChange={setSite} description={site ? `The order's site is ${site}` : 'The site code'} />
      {lines.length > 0 ? (
        <floor.ChoiceGroup label="Line" options={lines.map((l) => ({ value: l.code, label: `${l.code} ${l.name}` }))} value={line === '' ? null : line} onChange={setLine} />
      ) : (
        <Field name="line" label="Line" value={line} onChange={setLine} />
      )}
      <ActButton label={`Plan a batch for ${order.orderNo}`} onPress={go} disabled={plan.busy || chosenSite === '' || line.trim() === ''} />
      <ActResult error={plan.error} />
    </div>
  );
}

function IssueForm({ batch }: { batch: PlannedBatchView }) {
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(REFRESH);
  const values: Record<string, DataValueWire> = {};
  let complete = batch.variants.every((v) => variants[v.id] !== undefined);
  for (const i of batch.inputs) {
    const v = inputValue({ ...i, unit: i.unit }, inputs[i.id] ?? '');
    if (v) values[i.id] = v;
    else if (i.required) complete = false;
  }
  complete = complete && code.trim() !== '' && text.trim() !== '';
  const issue = () =>
    signed.sign(
      { kind: 'GMP_BATCH_ISSUE', batchId: batch.batchId, reason: { code: code.trim(), text: text.trim() }, variants, inputs: values },
      `Issue batch ${batch.batchNumber} (${batch.product.name} ${batch.product.strength}, ${batch.familyCode} version ${batch.versionNumber})`,
    );
  return (
    <div data-testid="issue-form">
      <h3>Issue batch {batch.batchNumber}</h3>
      <p>
        Planned from {batch.familyCode} version {batch.versionNumber}, site {batch.site}, line {batch.line}, batch size {batch.batchSize}; markets {batch.markets.join(', ')}.
      </p>
      {batch.variants.map((v) => (
        <floor.ChoiceGroup key={v.id} label={v.name} options={v.options.map((o) => ({ value: o, label: o }))} value={variants[v.id] ?? null} onChange={(o) => setVariants((s) => ({ ...s, [v.id]: o }))} />
      ))}
      {batch.inputs.map((i) => (
        <Field key={i.id} name={`input-${i.id}`} label={i.unit ? `${i.name} (${i.unit})` : i.name} description={`${i.source}${i.required ? '' : ' (optional)'}`} value={inputs[i.id] ?? ''} onChange={(v) => setInputs((s) => ({ ...s, [i.id]: v }))} />
      ))}
      <Field name="reason-code" label="Reason code" value={code} onChange={setCode} />
      <Field name="reason-text" label="Reason" value={text} onChange={setText} description="Your own words: why this batch is issued now" />
      <ActButton label="Sign and issue" onPress={issue} disabled={!complete || signed.busy || signed.outcome === 'SIGNED'} />
      <ActResult error={signed.error} outcome={signed.outcome} />
      {signed.outcome === 'SIGNED' ? <StatusChip tone="ok" label={`${batch.batchNumber} issued`} /> : null}
    </div>
  );
}
