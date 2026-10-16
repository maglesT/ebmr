/**
 * The label store (Phase 6 slice 6c; PR-32, D-P6c-11): a printed-material lot's balance and transactions, and the label
 * store's own transactions (receipt, issue to a packaging order, return, destruction with its reason). Only the label
 * store's role may open one; the database refuses anyone else with its words.
 */
import { useState } from 'react';
import { routes, StoreTransactionKind } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteSearch } from '../floor/params.ts';
import { LABEL_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS = StoreTransactionKind.options;

export function StorePage() {
  const [lotId, setLotId] = useState(useRouteSearch()['lot'] ?? '');
  const valid = UUID.test(lotId.trim());
  return (
    <>
      <h1>Label store</h1>
      <p>Printed material is kept under the label store&apos;s control: only the label store receives, issues, takes back and destroys it.</p>
      <Field name="storeLot" label="Printed-material lot (id)" value={lotId} onChange={setLotId} />
      {valid ? <Lot lotId={lotId.trim()} /> : null}
    </>
  );
}

function Lot({ lotId }: { lotId: string }) {
  const q = useApiQuery(routes.labels.store, { params: { lotId } });
  const stores = useOffered('STORES');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading the lot.</p>;
  const v = q.data;
  return (
    <>
      <Section title={`Lot ${v.lotCode}`} testId="label-store-lot">
        <p>
          {v.material}, {words(v.status)}. In the store: <strong data-testid="label-store-balance">{v.balance}</strong> units.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Transaction</th>
              <th scope="col">Units</th>
              <th scope="col">Order</th>
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {v.transactions.map((t) => (
              <tr key={t.transactionId}>
                <th scope="row">{words(t.kind)}{t.reason ? ` (${t.reason})` : ''}</th>
                <td>{t.quantity}</td>
                <td>{t.batchRef ?? ''}</td>
                <td>{t.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {stores ? <Transaction lotId={lotId} /> : null}
    </>
  );
}

function Transaction({ lotId }: { lotId: string }) {
  const open = useCommand(routes.labels.openStoreTransaction, LABEL_READS, 'the label-store transaction');
  const [kind, setKind] = useState<(typeof KINDS)[number] | null>(null);
  const [qty, setQty] = useState('');
  const [order, setOrder] = useState('');
  const [reason, setReason] = useState('');
  const needsOrder = kind === 'ISSUE' || kind === 'RETURN';
  const ok = kind !== null && /^[1-9][0-9]{0,8}$/.test(qty.trim()) && (!needsOrder || order.trim() !== '') && (kind !== 'DESTRUCTION' || reason.trim() !== '');
  return (
    <Section title="Open a transaction" testId="label-store-transaction">
      <floor.ChoiceGroup label="Transaction" options={KINDS.map((k) => ({ value: k, label: words(k) }))} value={kind} onChange={(v) => setKind(KINDS.find((k) => k === v) ?? null)} />
      <Field name="storeQty" label="Units" value={qty} onChange={setQty} />
      {needsOrder ? <Field name="storeOrder" label="Packaging order (batch number)" value={order} onChange={setOrder} /> : null}
      <Field name="storeReason" label={kind === 'DESTRUCTION' ? 'Reason for the destruction' : 'Reason (optional)'} value={reason} onChange={setReason} />
      <ActButton
        label="Record the transaction"
        onPress={() => (ok && kind ? open.run({ body: { kind, lotId, quantity: qty.trim(), ...(needsOrder ? { batchRef: order.trim() } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) } }) : undefined)}
        disabled={!ok || open.busy}
      />
      <ActResult error={open.error} done={open.done} label="The transaction is recorded." />
    </Section>
  );
}
