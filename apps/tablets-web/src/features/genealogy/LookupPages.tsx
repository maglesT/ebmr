/**
 * The complaint-to-lot lookup, the API supply-chain report of a finished lot and the deviation impact query (Phase 6
 * slice 6d; PR-57, PR-50). Read-only; every value is the server's (genealogy.lookup, genealogy.supplyChain,
 * genealogy.deviationImpact). A distribution record without the consignee's address is flagged incomplete
 * (D-P6d-0-7), never filled in.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type DistributionRecordView, type GenealogyNodeView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteParams } from '../floor/params.ts';
import { csvHref, nodeLine, words } from './reads.ts';

export function ComplaintLookupPage() {
  const [code, setCode] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  return (
    <>
      <h1>Complaint lookup</h1>
      <p>Type the lot, batch or shipment number a complaint names: the lot, the records that made it, its deviations, its shipments and its genealogy.</p>
      <Section title="Find the lot" testId="lookup-ask">
        <Field name="lookupCode" label="Lot, batch or shipment number" value={code} onChange={setCode} />
        <ActButton label="Look up" disabled={code.trim() === ''} onPress={() => setAsked(code.trim())} />
      </Section>
      {asked ? <LookupResult code={asked} /> : null}
    </>
  );
}

function LookupResult({ code }: { code: string }) {
  const q = useApiQuery(routes.genealogy.lookup, { query: { code } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const v = q.data;
  if (!v) return <p>Looking up…</p>;
  return (
    <Section title={`Lot ${v.lot.label}`} testId="lookup-result">
      <p data-testid="lookup-lot">
        {nodeLine(v.lot)} ·{' '}
        <Link to="/genealogy" search={{ kind: 'LOT', id: v.lot.id, direction: 'BACKWARD' }}>
          trace back
        </Link>{' '}
        ·{' '}
        <Link to="/genealogy" search={{ kind: 'LOT', id: v.lot.id, direction: 'FORWARD' }}>
          trace forward
        </Link>
        {v.lot.subKind === 'FINISHED' ? (
          <>
            {' '}
            ·{' '}
            <Link to="/genealogy/lots/$lotId/supply-chain" params={{ lotId: v.lot.id }}>
              API supply chain
            </Link>
          </>
        ) : null}
      </p>
      <h3>Records</h3>
      <NodeList nodes={v.batches} testId="lookup-batches" empty="No batch record makes this lot." />
      <h3>Deviations</h3>
      {v.deviations.length === 0 ? <p>No deviation.</p> : null}
      <ul data-testid="lookup-deviations">
        {v.deviations.map((d) => (
          <li key={d.deviationId}>
            {d.ref} {d.title}: {words(d.kind)}, {words(d.classification)}, {words(d.state)} ·{' '}
            <Link to="/genealogy/deviations/$deviationId/impact" params={{ deviationId: d.deviationId }}>
              impact
            </Link>
          </li>
        ))}
      </ul>
      <h3>Shipments</h3>
      <Shipments rows={v.shipments} />
      <h3>Lots upstream</h3>
      <NodeList nodes={v.upstreamLots} testId="lookup-upstream" empty="None." />
      <h3>Lots downstream</h3>
      <NodeList nodes={v.downstreamLots} testId="lookup-downstream" empty="None." />
    </Section>
  );
}

function NodeList({ nodes, testId, empty }: { nodes: readonly GenealogyNodeView[]; testId: string; empty: string }) {
  if (nodes.length === 0) return <p data-testid={testId}>{empty}</p>;
  return (
    <ul data-testid={testId}>
      {nodes.map((n) => (
        <li key={`${n.kind}:${n.id}`}>{nodeLine(n)}</li>
      ))}
    </ul>
  );
}

/** The distribution records (PR-57): what the eBMR knows of the lot, where the ERP says it went. */
export function Shipments({ rows }: { rows: readonly DistributionRecordView[] }) {
  if (rows.length === 0) return <p data-testid="shipments">No shipment.</p>;
  return (
    <table data-testid="shipments">
      <thead>
        <tr>
          <th scope="col">Shipment</th>
          <th scope="col">Product</th>
          <th scope="col">Lot</th>
          <th scope="col">Consignee</th>
          <th scope="col">Quantity</th>
          <th scope="col">Shipped</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.shipmentId} data-testid={`shipment-${s.shipmentNo}`} data-complete={String(s.complete)}>
            <th scope="row">
              {s.shipmentNo} ({s.market}) {s.complete ? null : <StatusChip tone="warning" label="Incomplete record: no consignee address" />}
            </th>
            <td>{[s.productName, s.strength, s.dosageForm].filter((p) => p !== null).join(' ')}</td>
            <td>{s.lotCode}</td>
            <td>
              {s.consigneeName} ({s.consigneeCode}){s.consigneeAddress ? `, ${s.consigneeAddress}` : ''}
            </td>
            <td>
              {floor.quantityText(s.quantity, s.unit)}
            </td>
            <td>{s.shippedAt.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SupplyChainPage() {
  const lotId = useRouteParams()['lotId'] ?? '';
  const q = useApiQuery(routes.genealogy.supplyChain, { params: { lotId } });
  const v = q.data;
  return (
    <>
      <h1>API supply chain of lot {v ? v.lot.label : lotId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <Section title={`As of ${v.asOf.text}`} testId="supply-chain">
          <table>
            <thead>
              <tr>
                <th scope="col">Lot</th>
                <th scope="col">Supplier</th>
                <th scope="col">Supplier lot</th>
                <th scope="col">Manufacturer</th>
                <th scope="col">Consumed by</th>
              </tr>
            </thead>
            <tbody>
              {v.lines.map((l) => (
                <tr key={l.lot.id} data-testid={`supply-${l.lot.label}`} data-kind={l.lot.subKind ?? ''}>
                  <th scope="row">{nodeLine(l.lot)}</th>
                  <td>{l.supplier ?? 'made on site'}</td>
                  <td>{l.supplierLot ?? ''}</td>
                  <td>{l.manufacturerCode ?? ''}</td>
                  <td>{l.consumedBy.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <a
              data-testid="supply-chain-export"
              href={csvHref([
                ['lot', 'material_code', 'material_kind', 'depth', 'supplier', 'supplier_lot', 'manufacturer', 'consumed_by', 'as_of_us'],
                ...v.lines.map((l) => [l.lot.label, l.lot.code ?? '', l.lot.subKind ?? '', l.depth.toString(), l.supplier ?? '', l.supplierLot ?? '', l.manufacturerCode ?? '', l.consumedBy.join(' '), v.asOf.us]),
              ])}
              download={`supply-chain-${v.lot.label}-${v.asOf.us}.csv`}
            >
              Export as CSV
            </a>
          </p>
        </Section>
      ) : null}
    </>
  );
}

export function DeviationImpactPage() {
  const deviationId = useRouteParams()['deviationId'] ?? '';
  const q = useApiQuery(routes.genealogy.deviationImpact, { params: { deviationId } });
  const v = q.data;
  return (
    <>
      <h1>Impact of deviation {v ? v.ref : deviationId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <Section title={`Affected batches as of ${v.asOf.text}`} testId="deviation-impact">
          <p>
            Linked: named by the deviation. Downstream: made from a linked subject. Shared lot: consumed a lot a linked batch consumed. Equipment, rooms and people are the
            investigation&apos;s assessment, not this list.
          </p>
          {v.batches.length === 0 ? <p>No batch.</p> : null}
          <ul>
            {v.batches.map((b) => (
              <li key={b.batchId} data-testid={`impact-${b.batchNumber}`} data-relation={b.relation}>
                <Link to="/review/$batchId" params={{ batchId: b.batchId }}>
                  {b.batchNumber}
                </Link>{' '}
                {b.productCode ?? ''} <StatusChip tone={b.relation === 'LINKED' ? 'error' : 'warning'} label={words(b.relation)} />
              </li>
            ))}
          </ul>
          <p>
            <Link to="/recall" search={{ subjectKind: 'DEVIATION', subjectId: v.deviationId }}>
              Run a mock recall from this deviation
            </Link>
          </p>
        </Section>
      ) : null}
    </>
  );
}
