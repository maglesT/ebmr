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
import { PotencyPreview } from '../../app/potency.tsx';

const REFRESH = [routes.planning.orders.id, routes.batches.list.id, routes.planning.packagingOrders.id];

export function PlanningPage() {
  const orders = useApiQuery(routes.planning.orders);
  const erp = useApiQuery(routes.quality.erpOrders);
  const canPlan = useOffered('PLANNING');
  return (
    <>
      <h1>Planning</h1>
      <p>
        <Link to="/planning/batches">Batches and their states</Link> · <Link to="/planning/packaging">Packaging orders and their bulk</Link>
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
        {order.orderNo} · {order.productName ?? order.productCode} {order.strength} · {floor.quantityText(order.batchSize, order.batchSizeUnit)}
      </h2>
      <p>Bill of materials: {order.bom.map((b) => `${b.materialCode} ${floor.quantityText(b.quantity, b.unit)}`).join('; ')}</p>
      {order.match ? (
        <p data-testid="match">
          MBR {order.match.familyCode} version {order.match.versionNumber} (batch size {order.match.batchSizeId}; markets {order.match.markets.join(', ')})
          {order.match.recordKind === 'PACKAGING' ? `; packaging order, pack type ${order.match.packType ?? 'not named'}` : ''}
        </p>
      ) : (
        <Banner tone="warning" title="No master record matches this order.">
          {order.noMatch}
        </Banner>
      )}
      {order.batches.length > 0 ? <p>Batches: {order.batches.map((b) => `${b.batchNumber} (${floor.stateWords(b.status)})`).join(', ')}</p> : null}
      {canPlan && !planned
        ? order.batches
            .filter((b) => b.status === 'PLANNED')
            .map((b) => <PlannedRow key={b.batchId} batchId={b.batchId} batchNumber={b.batchNumber} />)
        : null}
      {order.match && canPlan && !planned && !order.batches.some((b) => b.status === 'PLANNED') ? (
        order.match.recordKind === 'PACKAGING' ? <PackagingPlanForm order={order} site={site} onPlanned={setPlanned} /> : <PlanForm order={order} site={site} onPlanned={setPlanned} />
      ) : null}
      {planned ? <IssueForm batch={planned} /> : null}
      {planned ? <PotencyPreview batchId={planned.batchId} /> : null}
    </article>
  );
}

/**
 * A batch of the order planned and not yet issued (G4, owner report item 14): the issue form opens from the server's own
 * record of it, so a planned batch is issued from any session, not only right after "Plan a batch".
 */
function PlannedRow({ batchId, batchNumber }: { batchId: string; batchNumber: string }) {
  const [open, setOpen] = useState(false);
  const view = useApiQuery(routes.execution.plannedBatch, { params: { batchId } }, { enabled: open });
  return (
    <div data-testid={`planned-${batchNumber}`}>
      <p>
        {batchNumber} is planned and not issued yet.{' '}
        {!open ? <ActButton label={`Issue ${batchNumber}`} onPress={() => setOpen(true)} /> : null}
      </p>
      {view.error ? <RefusalMessage error={view.error.error} /> : null}
      {view.data ? <IssueForm batch={view.data} /> : null}
      {view.data ? <PotencyPreview batchId={view.data.batchId} /> : null}
    </div>
  );
}

function PlanForm({ order, site, onPlanned }: { order: PlanningOrderView; site: string | null; onPlanned: (b: PlannedBatchView) => void }) {
  const match = order.match;
  const [siteCode, setSite] = useState('');
  const [line, setLine] = useState('');
  const plan = useCommand(routes.execution.planBatch, REFRESH);
  const areas = useApiQuery(routes.plant.areas);
  const lines = areas.data?.areas.filter((a) => a.kind === 'LINE') ?? [];
  // Phase 7 slice 7g (WP4; PR-47): a REPROCESSING master is planned with the quality unit's authorised request.
  const reprocessing = match?.recordKind === 'REPROCESSING';
  const requests = useApiQuery(routes.quality.reprocessingRequests, {}, { enabled: reprocessing });
  const [request, setRequest] = useState<string | null>(null);
  const authorised = requests.data?.requests.filter((r) => r.familyId === match?.familyId && r.authorisedBy !== null) ?? [];
  const chosenSite = siteCode.trim() || site || '';
  if (!match) return null;
  const go = async () => {
    const b = await plan.run({ body: { familyId: match.familyId, markets: match.markets, site: chosenSite, line: line.trim(), batchSize: match.batchSizeId, erpOrder: order.orderNo, ...(reprocessing && request ? { reprocessingRequest: request } : {}) } });
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
      {reprocessing ? (
        authorised.length === 0 ? (
          <Banner tone="warning" title="No authorised reprocessing request for this master.">
            A whole-batch reprocessing is planned only on a request the quality unit authorised (Quality, Reprocessing).
          </Banner>
        ) : (
          <floor.ChoiceGroup
            label="Authorised reprocessing request"
            options={authorised.map((r) => ({ value: r.requestId, label: `${r.parents.map((p) => p.batchNumber).join(', ')} (${r.investigationRef})` }))}
            value={request}
            onChange={setRequest}
          />
        )
      ) : null}
      <ActButton label={`Plan a batch for ${order.orderNo}`} onPress={go} disabled={plan.busy || chosenSite === '' || line.trim() === '' || (reprocessing && !request)} />
      <ActResult error={plan.error} />
    </div>
  );
}

/**
 * A packaging order (Phase 4 slice 2c) packs one issued processing batch of the product: the issuer picks it from the
 * server's candidates, each shown with the database's reason it is not released for packing yet (the order can be planned
 * and issued before; bulk is issued only after QA's release for packing). The register gives the packaging number.
 */
function PackagingPlanForm({ order, site, onPlanned }: { order: PlanningOrderView; site: string | null; onPlanned: (b: PlannedBatchView) => void }) {
  const match = order.match;
  const [siteCode, setSite] = useState('');
  const [line, setLine] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  // Slice 7h (gap report D2): the markets the order packs for, of those the master is authorised for (all by default); an
  // order whose step prints variable data packs for one market (PR-36), so the issuer may narrow them.
  const [unpicked, setUnpicked] = useState<ReadonlySet<string>>(new Set());
  const plan = useCommand(routes.planning.planPackagingOrder, REFRESH, 'planning a packaging order');
  const areas = useApiQuery(routes.plant.areas);
  const lines = areas.data?.areas.filter((a) => a.kind === 'LINE') ?? [];
  const chosenSite = siteCode.trim() || site || '';
  if (!match) return null;
  const markets = match.markets.filter((m) => !unpicked.has(m));
  const toggle = (m: string) =>
    setUnpicked((u) => {
      const next = new Set(u);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  const go = async () => {
    if (!parent) return;
    const b = await plan.run({ body: { familyId: match.familyId, parentBatchId: parent, markets, site: chosenSite, line: line.trim(), batchSize: match.batchSizeId, erpOrder: order.orderNo } });
    if (b) onPlanned(b);
  };
  return (
    <div data-testid="packaging-plan-form">
      <h3>Plan a packaging order</h3>
      {match.parents.length === 0 ? (
        <Banner tone="warning" title="No issued processing batch of this product can be packed.">
          A packaging order packs an issued processing batch of the same product at this site.
        </Banner>
      ) : (
        <ul aria-label="Processing batches to pack">
          {match.parents.map((p) => (
            <li key={p.batchId} data-testid={`parent-${p.batchNumber}`}>
              <label>
                <input type="radio" name={`parent-${order.orderNo}`} checked={parent === p.batchId} onChange={() => setParent(p.batchId)} /> {p.batchNumber} ({floor.stateWords(p.status)}; {p.usableContainers} usable
                containers)
              </label>
              {p.releaseForPackingProblem ? <p>Not released for packing yet: {p.releaseForPackingProblem}</p> : <p>Released for packing.</p>}
            </li>
          ))}
        </ul>
      )}
      <Field name="site" label="Site" value={siteCode} onChange={setSite} description={site ? `The order's site is ${site}` : 'The site code'} />
      {lines.length > 0 ? (
        <floor.ChoiceGroup label="Line" options={lines.map((l) => ({ value: l.code, label: `${l.code} ${l.name}` }))} value={line === '' ? null : line} onChange={setLine} />
      ) : (
        <Field name="line" label="Line" value={line} onChange={setLine} />
      )}
      <fieldset data-testid="packaging-markets">
        <legend>Markets the order packs for</legend>
        {match.markets.map((m) => (
          <label key={m}>
            <input type="checkbox" checked={!unpicked.has(m)} onChange={() => toggle(m)} /> {m}
          </label>
        ))}
      </fieldset>
      <ActButton label={`Plan a packaging order for ${order.orderNo}`} onPress={go} disabled={plan.busy || parent === null || chosenSite === '' || line.trim() === '' || markets.length === 0} />
      <ActResult error={plan.error} />
    </div>
  );
}

function IssueForm({ batch }: { batch: PlannedBatchView }) {
  const [variants, setVariants] = useState<Record<string, string>>({});
  // R3.1 (D-7k-1): each input the master implies (the tablet count) starts at the master's value.
  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(batch.inputs.flatMap((i) => (i.expected ? [[i.id, i.expected.value]] : []))));
  const [confirmations, setConfirmations] = useState<Record<string, string>>({});
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
  // An input further from the master's value than the tolerance needs the issuer's reason (the server refuses it otherwise).
  const away = batch.inputs.filter((i) => i.expected && farFrom(inputs[i.id] ?? '', i.expected.value, i.expected.tolerancePercent));
  const inputConfirmations: Record<string, string> = {};
  for (const i of away) {
    const why = (confirmations[i.id] ?? '').trim();
    if (why === '') complete = false;
    else inputConfirmations[i.id] = why;
  }
  complete = complete && code.trim() !== '' && text.trim() !== '';
  const issue = () =>
    signed.sign(
      { kind: 'GMP_BATCH_ISSUE', batchId: batch.batchId, reason: { code: code.trim(), text: text.trim() }, variants, inputs: values, ...(away.length > 0 ? { inputConfirmations } : {}) },
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
        <div key={i.id}>
          <Field
            name={`input-${i.id}`}
            label={i.unit ? `${i.name} (${i.unit})` : i.name}
            description={i.expected ? `${i.source}; the master gives ${i.expected.value} (${i.expected.basis})` : `${i.source}${i.required ? '' : ' (optional)'}`}
            value={inputs[i.id] ?? ''}
            onChange={(v) => setInputs((s) => ({ ...s, [i.id]: v }))}
          />
          {away.includes(i) && i.expected ? (
            <>
              <Banner tone="warning" title={`${inputs[i.id] ?? ''} is more than ${i.expected.tolerancePercent} % away from the ${i.expected.value} the master gives.`}>
                Correct it, or say why this batch differs: the reason is kept with the value in the record.
              </Banner>
              <Field name={`confirm-${i.id}`} label={`Why ${i.name} differs from the master`} value={confirmations[i.id] ?? ''} onChange={(v) => setConfirmations((s) => ({ ...s, [i.id]: v }))} />
            </>
          ) : null}
        </div>
      ))}
      <Field name="reason-code" label="Reason code" value={code} onChange={setCode} />
      <Field name="reason-text" label="Reason" value={text} onChange={setText} description="Your own words: why this batch is issued now" />
      <ActButton label="Sign and issue" onPress={issue} disabled={!complete || signed.busy || signed.outcome === 'SIGNED'} />
      <ActResult error={signed.error} outcome={signed.outcome} />
      {signed.outcome === 'SIGNED' ? <StatusChip tone="ok" label={`${batch.batchNumber} issued`} /> : null}
    </div>
  );
}

/**
 * Whether `entered` (a whole number) is more than `tolerancePercent` (a whole number) per cent away from `expected`: the
 * server's check (R3.1), said before signing. Whole numbers as BigInt, never a JavaScript number; anything else is left
 * to the server.
 */
export function farFrom(entered: string, expected: string, tolerancePercent: string): boolean {
  const whole = /^[0-9]+$/;
  if (!whole.test(entered.trim()) || !whole.test(expected) || !whole.test(tolerancePercent)) return false;
  const e = BigInt(expected);
  if (e === 0n) return false;
  const x = BigInt(entered.trim());
  const diff = x > e ? x - e : e - x;
  return diff * 100n > BigInt(tolerancePercent) * e;
}
