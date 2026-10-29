/**
 * Controlled-substance mode (Phase 6 slice 6e; draft IN-53): the product flags, the dual-custody records of a lot or a
 * batch, and the register export. The banner says the control is a draft until the NDPS Act and Rules are verified.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CONTROLLED_DRAFT_BANNER, routes, type ControlledProductView, type CustodyView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { CONTROLLED_READS, CUSTODIANS, DAY, FLAG_APPROVERS, FLAG_RECORDERS, QUANTITY, REGISTER_RUNNERS, UUID, words } from './reads.ts';

export function DraftBanner() {
  return (
    <p data-testid="controlled-banner">
      <StatusChip tone="warning" label={CONTROLLED_DRAFT_BANNER} />
    </p>
  );
}

export function ControlledPage() {
  const role = useSessionRole();
  return (
    <>
      <h1>Controlled substances</h1>
      <DraftBanner />
      <p>
        A flagged product&apos;s controlled API is moved and dispensed only under dual custody: two different people sign every record. Its account in each batch closes with no
        unexplained difference at every yield checkpoint, rejects are destroyed only with a witness, and the movements are exported for the registers.
      </p>
      <ProductFlags role={role} />
      <Custody role={role} />
      <RegisterExport role={role} />
    </>
  );
}

function ProductFlags({ role }: { role: string | null }) {
  const q = useApiQuery(routes.controlled.products);
  return (
    <Section title="Product flags" testId="controlled-products">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.products.length === 0 ? <p>No product is flagged.</p> : null}
      <ul>
        {q.data?.products.map((p) => <Product key={p.productCode} p={p} role={role} />)}
      </ul>
      {role !== null && FLAG_RECORDERS.test(role) ? <RecordFlag /> : null}
    </Section>
  );
}

function Product({ p, role }: { p: ControlledProductView; role: string | null }) {
  const signed = useSignedAct(CONTROLLED_READS);
  return (
    <li data-testid={`controlled-product-${p.productCode}`}>
      <strong>{p.productCode}</strong>: {p.materialsInEffect.length === 0 ? 'not controlled' : `controlled API ${p.materialsInEffect.join(', ')}`}
      <ul>
        {p.records.map((r) => (
          <li key={r.recordId} data-testid={`controlled-flag-${r.recordId}`} data-state={r.state}>
            {r.controlled ? `Controlled: ${r.materialCodes.join(', ')}` : 'Not controlled'} ({r.basisRef}), recorded by {r.recordedBy.legalName} on {r.recordedAt.text}.{' '}
            <StatusChip tone={r.state === 'APPROVED' ? 'ok' : r.state === 'RECORDED' ? 'info' : 'neutral'} label={r.state === 'RECORDED' ? 'Awaiting a second QA person' : words(r.state)} />
            {r.approvedBy && r.approvedAt ? ` Approved by ${r.approvedBy.legalName} on ${r.approvedAt.text}.` : ''}
            {r.state === 'RECORDED' && role !== null && FLAG_APPROVERS.test(role) ? (
              <ActButton label={`Approve the flag of ${p.productCode}`} onPress={() => signed.sign({ kind: 'CONTROLLED_ACT', act: 'FLAG_APPROVE', subjectId: r.recordId }, `Approve the controlled-substance flag of ${p.productCode}`)} disabled={signed.busy} />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </li>
  );
}

function RecordFlag() {
  const record = useCommand(routes.controlled.recordProduct, CONTROLLED_READS);
  const [product, setProduct] = useState('');
  const [controlled, setControlled] = useState(true);
  const [materials, setMaterials] = useState('');
  const [basis, setBasis] = useState('');
  const [change, setChange] = useState('');
  const codes = materials.split(',').map((m) => m.trim()).filter((m) => m !== '');
  const ok = product.trim() !== '' && basis.trim() !== '' && change.trim() !== '' && (controlled ? codes.length > 0 : codes.length === 0);
  return (
    <div data-testid="controlled-record-flag">
      <h3>Record a flag</h3>
      <Field name="ctlProduct" label="Product code" value={product} onChange={setProduct} />
      <floor.ChoiceGroup
        label="Controlled substance"
        options={[
          { value: 'YES', label: 'Controlled' },
          { value: 'NO', label: 'Not controlled' },
        ]}
        value={controlled ? 'YES' : 'NO'}
        onChange={(v) => setControlled(v === 'YES')}
      />
      <Field name="ctlMaterials" label="Controlled API materials (codes, comma separated)" value={materials} onChange={setMaterials} />
      <Field name="ctlBasis" label="Basis (licence or quota reference)" value={basis} onChange={setBasis} />
      <Field name="ctlChange" label="Change record" value={change} onChange={setChange} />
      <ActButton
        label="Record the flag"
        onPress={() => record.run({ body: { productCode: product.trim(), controlled, materialCodes: codes, basisRef: basis.trim(), changeRecord: change.trim() } })}
        disabled={!ok || record.busy}
      />
      <ActResult error={record.error} done={record.done} label="Recorded. A second QA person approves it." />
    </div>
  );
}

function Custody({ role }: { role: string | null }) {
  const [lot, setLot] = useState('');
  const [batch, setBatch] = useState('');
  const query = { ...(UUID.test(lot.trim()) ? { lotId: lot.trim() } : {}), ...(UUID.test(batch.trim()) ? { batchId: batch.trim() } : {}) };
  const q = useApiQuery(routes.controlled.custody, { query });
  return (
    <Section title="Dual custody" testId="controlled-custody">
      <Field name="ctlLot" label="Lot (id)" value={lot} onChange={setLot} />
      <Field name="ctlBatch" label="Batch (id)" value={batch} onChange={setBatch} />
      {UUID.test(batch.trim()) ? (
        <p>
          <Link to="/controlled/batches/$batchId" params={{ batchId: batch.trim() }}>
            The controlled balance of this batch
          </Link>
        </p>
      ) : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.records.length === 0 ? <p>No custody record.</p> : null}
      <ul>
        {q.data?.records.map((r) => <CustodyRecord key={r.custodyId} r={r} role={role} />)}
      </ul>
      {role !== null && CUSTODIANS.test(role) ? <ProposeCustody lot={lot.trim()} batch={batch.trim()} /> : null}
    </Section>
  );
}

export function CustodyRecord({ r, role }: { r: CustodyView; role: string | null }) {
  const signed = useSignedAct(CONTROLLED_READS);
  const custodian = role !== null && CUSTODIANS.test(role);
  const what = `${words(r.kind)} of ${r.quantity} ${r.unit} of lot ${r.lotCode} (${r.materialCode})`;
  return (
    <li data-testid={`controlled-custody-${r.custodyId}`} data-state={r.state}>
      <p>
        <strong>{what}</strong>
        {r.batchNumber ? ` for batch ${r.batchNumber}` : ''}
        {r.fromLocation && r.toLocation ? ` from ${r.fromLocation} to ${r.toLocation}` : ''}
        {r.note ? `: ${r.note}` : ''}. Proposed by {r.proposedBy.legalName} on {r.proposedAt.text}.{' '}
        <StatusChip tone={r.state === 'CONFIRMED' ? 'ok' : 'info'} label={r.state === 'AWAITING_COUNTERSIGN' ? 'Awaiting the second custodian' : words(r.state)} />
        {r.used ? ' Used.' : ''}
      </p>
      <p>{r.custodians.length === 0 ? 'Not signed yet.' : r.custodians.map((c) => `${c.position === 'FIRST' ? 'First' : 'Second'} custodian ${c.person.legalName} on ${c.at.text}`).join('; ')}</p>
      {custodian && r.state === 'PROPOSED' ? (
        <ActButton label="Sign as the first custodian" onPress={() => signed.sign({ kind: 'CONTROLLED_ACT', act: 'CUSTODY_FIRST', subjectId: r.custodyId }, `First custodian: ${what}`)} disabled={signed.busy} />
      ) : null}
      {custodian && r.state === 'AWAITING_COUNTERSIGN' ? (
        <ActButton
          label={r.kind === 'DESTRUCTION' ? 'Countersign as the witness' : 'Countersign as the second custodian'}
          onPress={() => signed.sign({ kind: 'CONTROLLED_ACT', act: 'CUSTODY_SECOND', subjectId: r.custodyId }, `Second custodian: ${what}`)}
          disabled={signed.busy}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </li>
  );
}

const KINDS = ['DISPENSE', 'TRANSFER', 'RETURN', 'DESTRUCTION'] as const;

function ProposeCustody({ lot, batch }: { lot: string; batch: string }) {
  const propose = useCommand(routes.controlled.proposeCustody, CONTROLLED_READS);
  const [kind, setKind] = useState<(typeof KINDS)[number]>('DISPENSE');
  const [quantity, setQuantity] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const transfer = kind === 'TRANSFER';
  const ok = UUID.test(lot) && QUANTITY.test(quantity.trim()) && (transfer ? from.trim() !== '' && to.trim() !== '' : UUID.test(batch)) && (kind !== 'DESTRUCTION' || note.trim() !== '');
  return (
    <div data-testid="controlled-propose">
      <h3>Propose a custody record</h3>
      <floor.ChoiceGroup label="Act" options={KINDS.map((k) => ({ value: k, label: words(k) }))} value={kind} onChange={(v) => setKind(KINDS.find((k) => k === v) ?? 'DISPENSE')} />
      {kind === 'DISPENSE' ? (
        <p data-testid="controlled-dispense-prompt">
          Dual custody: sign this record for the lot, the batch and the exact net you will weigh, and have a second person countersign it before you weigh. A dispensing with one
          person is refused.
        </p>
      ) : null}
      <Field name="ctlQuantity" label="Quantity (in the lot's unit)" value={quantity} onChange={setQuantity} />
      {transfer ? (
        <>
          <Field name="ctlFrom" label="From location" value={from} onChange={setFrom} />
          <Field name="ctlTo" label="To location" value={to} onChange={setTo} />
        </>
      ) : null}
      <Field name="ctlNote" label={kind === 'DESTRUCTION' ? 'How and why the rejects are destroyed' : 'Note (optional)'} value={note} onChange={setNote} />
      <ActButton
        label="Propose"
        onPress={() =>
          propose.run({
            body: {
              kind,
              lotId: lot,
              quantity: quantity.trim(),
              ...(transfer ? { fromLocation: from.trim(), toLocation: to.trim() } : { batchId: batch }),
              ...(note.trim() !== '' ? { note: note.trim() } : {}),
            },
          })
        }
        disabled={!ok || propose.busy}
      />
      <ActResult error={propose.error} done={propose.done} label="Proposed. Sign it as the first custodian." />
    </div>
  );
}

function RegisterExport({ role }: { role: string | null }) {
  const list = useApiQuery(routes.controlled.registerExtracts);
  const run = useCommand(routes.controlled.runRegister, CONTROLLED_READS);
  const [material, setMaterial] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const ok = material.trim() !== '' && DAY.test(from.trim()) && DAY.test(to.trim());
  return (
    <Section title="Register export" testId="controlled-register">
      <p>Generic layout (material, lot, time in UTC, movement, quantity, persons) until the statutory forms are verified.</p>
      {role !== null && REGISTER_RUNNERS.test(role) ? (
        <>
          <Field name="ctlRegMaterial" label="Material code" value={material} onChange={setMaterial} />
          <Field name="ctlRegFrom" label="From (YYYY-MM-DD, UTC)" value={from} onChange={setFrom} />
          <Field name="ctlRegTo" label="To (YYYY-MM-DD, UTC)" value={to} onChange={setTo} />
          <ActButton label="Run the export" onPress={() => run.run({ body: { materialCode: material.trim(), from: from.trim(), to: to.trim() } })} disabled={!ok || run.busy} />
          <ActResult error={run.error} done={run.done} label="The export is stored with its hash." />
        </>
      ) : null}
      {list.error ? <RefusalMessage error={list.error.error} /> : null}
      <ul>
        {list.data?.extracts.map((x) => (
          <li key={x.extractId} data-testid={`controlled-extract-${x.extractId}`}>
            {x.materialCode}, {x.from} to {x.to}: {x.rows.toString()} rows, SHA-256 <code>{x.resultSha256}</code>, run by {x.runBy.legalName} on {x.runAt.text}.{' '}
            <ActButton label="Open" primary={false} onPress={() => setOpen(x.extractId)} />
          </li>
        ))}
      </ul>
      {open ? <Extract extractId={open} /> : null}
    </Section>
  );
}

function Extract({ extractId }: { extractId: string }) {
  const q = useApiQuery(routes.controlled.registerExtract, { params: { extractId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return null;
  const x = q.data;
  return (
    <div data-testid="controlled-extract" data-reproduces={String(x.reproduces)}>
      <p>
        <StatusChip tone="warning" label={x.banner} />{' '}
        <StatusChip tone={x.reproduces ? 'ok' : 'error'} label={x.reproduces ? 'Reproduces (the same hash now)' : 'Does not reproduce: the data changed since; run it again'} />
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Movement</th>
            <th scope="col">Lot</th>
            <th scope="col">Quantity</th>
            <th scope="col">Batch</th>
            <th scope="col">Persons</th>
          </tr>
        </thead>
        <tbody>
          {x.result.rows.map((r) => (
            <tr key={`${r.movement}-${r.ref}`}>
              <td>{r.at}</td>
              <td>{words(r.movement)}</td>
              <td>{r.lot}</td>
              <td>
                {floor.quantityText(r.quantity, r.unit)}
              </td>
              <td>{r.batch ?? ''}</td>
              <td>{r.persons.filter((p) => p !== null).length.toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
