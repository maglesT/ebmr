/**
 * The mock-recall cockpit (Phase 6 slice 6d; IN-29, PR-57; D-P6d-2): the mock recalls run, newest first; QA's run from a
 * lot or a deviation as of an instant, with whether the licensing authority was informed (and its reference); and one
 * mock recall: the affected batches and lots, the consignees with what each was delivered, the reconciliation sheet of
 * delivered against returned, the incomplete distribution records, whether a re-run as of the same instant still gives
 * the stored hash, and the authorised person's sign-off through the ceremony (MOCK_RECALL_SIGN_OFF). A mock recall never
 * changes a lot; a real recall is the RECALL act of the release cockpit. Every value and gate is the server's.
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { routes, type MockRecallSummaryView, type MockRecallView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { offered, useSessionRole } from '../../app/roles.ts';
import { useRouteParams, useRouteSearch } from '../floor/params.ts';
import { validToUs } from '../release/QpPackage.tsx';
import { csvHref, RECALL_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECTS = ['LOT', 'DEVIATION'] as const;
type Subject = (typeof SUBJECTS)[number];

export function MockRecallsPage() {
  const q = useApiQuery(routes.recall.mockRecalls);
  return (
    <>
      <h1>Mock recalls</h1>
      <p>
        A mock recall finds, as of an instant, every batch and lot made from a lot or touched by a deviation, every consignee and what it was delivered, and reconciles delivered
        against returned. It is stored with its result hash and signed off by the authorised person; it never changes a lot.
      </p>
      <RunMockRecall />
      <Section title="Mock recalls run" testId="mock-recalls">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.mockRecalls.length === 0 ? <p>No mock recall yet.</p> : null}
        <ul>
          {q.data?.mockRecalls.map((m) => <SummaryRow key={m.mockRecallId} m={m} />)}
        </ul>
      </Section>
    </>
  );
}

function SummaryRow({ m }: { m: MockRecallSummaryView }) {
  return (
    <li data-testid={`mock-recall-${m.mockRecallId}`} data-signed={String(m.signOff !== null)}>
      <Link to="/recall/$mockRecallId" params={{ mockRecallId: m.mockRecallId }}>
        {words(m.subjectKind)} {m.subjectRef}
      </Link>{' '}
      as of {m.asOf.text}: {m.counts.batches.toString()} batch(es), {m.counts.lots.toString()} lot(s), {m.counts.consignees.toString()} consignee(s) · run by {m.ranBy.legalName}{' '}
      {m.signOff ? <StatusChip tone="ok" label={`Signed off by ${m.signOff.signedBy.legalName}`} /> : <StatusChip tone="pending" label="Not signed off" />}
    </li>
  );
}

function RunMockRecall() {
  const role = useSessionRole();
  const qa = offered(role, 'QA') || role === 'HEAD_OF_QC';
  const search = useRouteSearch();
  const run = useCommand(routes.recall.run, RECALL_READS, 'running the mock recall');
  const navigate = useNavigate();
  const [subject, setSubject] = useState<Subject>(SUBJECTS.find((s) => s === search['subjectKind']) ?? 'LOT');
  const [subjectId, setSubjectId] = useState(search['subjectId'] ?? '');
  const [asOf, setAsOf] = useState('');
  const [informed, setInformed] = useState<boolean | null>(null);
  const [reference, setReference] = useState('');
  if (!qa) return null;
  const asOfUs = asOf.trim() === '' ? null : validToUs(asOf);
  const ok = UUID.test(subjectId.trim()) && (asOf.trim() === '' || asOfUs !== null) && informed !== null && (!informed || reference.trim() !== '');
  return (
    <Section title="Run a mock recall" testId="mock-recall-run">
      <floor.ChoiceGroup label="From" options={SUBJECTS.map((s) => ({ value: s, label: words(s) }))} value={subject} onChange={(v) => setSubject(SUBJECTS.find((s) => s === v) ?? 'LOT')} />
      <Field name="recallSubject" label={subject === 'LOT' ? 'Lot (id)' : 'Deviation (id)'} value={subjectId} onChange={setSubjectId} />
      <Field name="recallAsOf" label="As of (empty: now; with offset, e.g. 2026-10-12T10:10:00+05:30)" value={asOf} onChange={setAsOf} />
      <floor.ChoiceGroup
        label="Licensing authority informed of the intended recall"
        options={[
          { value: 'NO', label: 'Not informed' },
          { value: 'YES', label: 'Informed' },
        ]}
        value={informed === null ? null : informed ? 'YES' : 'NO'}
        onChange={(v) => setInformed(v === 'YES')}
      />
      {informed ? <Field name="recallAuthorityRef" label="Authority reference" value={reference} onChange={setReference} /> : null}
      <ActButton
        label="Run the mock recall"
        disabled={!ok || run.busy}
        onPress={async () => {
          if (!ok || informed === null) return;
          const r = await run.run({
            body: { subjectKind: subject, subjectId: subjectId.trim().toLowerCase(), ...(asOfUs ? { asOfUs } : {}), authorityInformed: informed, ...(informed ? { authorityReference: reference.trim() } : {}) },
          });
          if (r) await navigate({ to: '/recall/$mockRecallId', params: { mockRecallId: r.mockRecallId } });
        }}
      />
      <ActResult error={run.error} done={run.done} label="The mock recall is stored." />
    </Section>
  );
}

export function MockRecallPage() {
  const mockRecallId = useRouteParams()['mockRecallId'] ?? '';
  const q = useApiQuery(routes.recall.mockRecall, { params: { mockRecallId } });
  const v = q.data;
  return (
    <>
      <h1>Mock recall {v ? `from ${words(v.subjectKind).toLowerCase()} ${v.subjectRef}` : mockRecallId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <MockRecall v={v} /> : null}
    </>
  );
}

/** The reconciliation sheet as CSV: one line per affected lot, delivered against returned in the lot's unit. */
export function reconciliationRows(v: MockRecallView): string[][] {
  return [
    ['lot', 'material_code', 'material_kind', 'depth', 'unit', 'delivered', 'returned', 'outstanding', 'as_of_us', 'result_sha256'],
    ...v.lots.map((l) => [l.lotCode, l.materialCode, l.materialKind, l.depth.toString(), l.unit, l.delivered, l.returned, l.outstanding, v.asOf.us, v.resultSha256]),
  ];
}

function MockRecall({ v }: { v: MockRecallView }) {
  return (
    <>
      <p data-testid="mock-recall-state" data-reproduces={String(v.reproduces)}>
        As of {v.asOf.text} · query version {v.queryVersion.toString()} · run by {v.ranBy.legalName} at {v.ranAt.text} · result SHA-256 <code>{v.resultSha256}</code>{' '}
        {v.reproduces ? <StatusChip tone="ok" label="Reproduces" /> : <StatusChip tone="error" label="Does not reproduce" />}
      </p>
      {v.reproduces ? null : (
        <Banner tone="error" title="A re-run as of the same instant no longer gives the stored result">
          A transaction recorded rows before the as-of instant and committed after the run. Run the mock recall again; this one cannot be signed off.
        </Banner>
      )}
      <p data-testid="mock-recall-authority">
        Licensing authority: {v.authorityInformed ? `informed (reference ${v.authorityReference ?? ''})` : 'not informed'}
      </p>
      {v.incomplete.length > 0 ? (
        <Banner tone="warning" title="Distribution records without the consignee's address">
          <p data-testid="mock-recall-incomplete">{v.incomplete.join(', ')}</p>
        </Banner>
      ) : null}
      <Section title="Affected batches" testId="mock-recall-batches">
        <ul>
          {v.batches.map((b) => (
            <li key={b.batchId}>
              <Link to="/review/$batchId" params={{ batchId: b.batchId }}>
                {b.batchNumber}
              </Link>{' '}
              {b.productCode ?? ''} (depth {b.depth.toString()})
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Reconciliation: delivered against returned" testId="mock-recall-reconciliation">
        <table>
          <thead>
            <tr>
              <th scope="col">Lot</th>
              <th scope="col">Material</th>
              <th scope="col">Delivered</th>
              <th scope="col">Returned</th>
              <th scope="col">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {v.lots.map((l) => (
              <tr key={l.lotId} data-testid={`reconcile-${l.lotCode}`}>
                <th scope="row">{l.lotCode}</th>
                <td>
                  {l.materialCode} ({words(l.materialKind)})
                </td>
                <td>
                  {l.delivered} {l.unit}
                </td>
                <td>
                  {l.returned} {l.unit}
                </td>
                <td>
                  {l.outstanding} {l.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <a data-testid="mock-recall-export" href={csvHref(reconciliationRows(v))} download={`mock-recall-${v.mockRecallId}.csv`}>
            Export the reconciliation sheet as CSV
          </a>
        </p>
      </Section>
      <Section title="Consignees" testId="mock-recall-consignees">
        {v.consignees.length === 0 ? <p>No consignee: nothing was shipped.</p> : null}
        <ul>
          {v.consignees.map((c) => (
            <li key={c.consigneeCode} data-testid={`consignee-${c.consigneeCode}`}>
              {c.consigneeName} ({c.consigneeCode}), {c.consigneeAddress ?? 'no address recorded'} · markets {c.markets.join(', ')}
              <ul>
                {c.shipments.map((s) => (
                  <li key={s.shipmentNo}>
                    {s.shipmentNo}: lot {s.lotCode}, {s.quantity} {s.unit}, {s.shippedAt.text}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Section>
      {v.federation ? <Federation v={v} /> : null}
      <SignOff v={v} />
    </>
  );
}

/**
 * Phase 6 slice 6i (L-41, IN-29): what each destination of an outbound transfer answered as of the run's own instant. An
 * unanswered site makes the run incomplete (the database decides; it is part of what the AP signs off); the last excerpt
 * received is shown with its own, older as-of. QA asks the sites again before the sign-off.
 */
function Federation({ v }: { v: MockRecallView }) {
  const f = v.federation!;
  const role = useSessionRole();
  const again = useCommand(routes.recall.refreshFederation, RECALL_READS, 'asking the other sites again');
  return (
    <Section title="Other sites" testId="mock-recall-federation">
      {f.complete ? (
        <Banner tone="ok" title="Complete across sites">
          {f.transfers.length === 0 ? 'No outbound transfer is reached.' : `Every destination answered as of ${v.asOf.text}.`}
        </Banner>
      ) : (
        <Banner tone="error" title="Incomplete: not every destination site answered as of the run's instant">
          <p data-testid="mock-recall-federation-incomplete">
            {[
              ...f.transfers.filter((t) => t.status !== 'ANSWERED').map((t) => `${t.destination} (${words(t.status)})`),
              ...f.beyondOneHop.map((b) => `${b.packageNo} to ${b.destination} (beyond one hop)`),
            ].join(', ')}
          </p>
        </Banner>
      )}
      <ul>
        {f.transfers.map((t) => (
          <li key={t.transferId} data-testid={`mock-recall-remote-${t.packageNo}`} data-status={t.status}>
            {t.packageNo} to {t.destination} <StatusChip tone={t.status === 'ANSWERED' ? 'ok' : 'error'} label={words(t.status)} />{' '}
            {t.excerptAsOf ? (t.status === 'ANSWERED' ? `as of ${t.excerptAsOf.text}` : `last excerpt as of ${t.excerptAsOf.text}`) : 'no excerpt'}
            {t.detail ? ` · ${t.detail}` : ''}
            <ul>
              {t.lots.map((l) => (
                <li key={l.lotId}>
                  Lot {l.lotCode} {l.materialCode ?? ''} {l.state ? `(${words(l.state)})` : ''}
                </li>
              ))}
              {t.batches.map((b) => (
                <li key={b.batchId}>Batch {b.batchNumber}</li>
              ))}
              {t.shipments.map((s) => (
                <li key={s.shipmentId}>
                  Shipment {s.shipmentNo} to {s.consigneeCode ?? 'unknown consignee'} {s.market ? `(${s.market})` : ''}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {!f.complete && !v.signOff && (offered(role, 'QA') || role === 'HEAD_OF_QC') ? (
        <>
          <ActButton primary={false} label="Ask the other sites again" disabled={again.busy} onPress={() => again.run({ params: { mockRecallId: v.mockRecallId }, body: {} })} />
          <ActResult error={again.error} done={again.done} label="Asked again." />
        </>
      ) : null}
    </Section>
  );
}

function SignOff({ v }: { v: MockRecallView }) {
  const ap = useSessionRole() === 'AUTHORISED_PERSON';
  const act = useSignedAct(RECALL_READS);
  return (
    <Section title="Sign-off by the authorised person" testId="mock-recall-sign-off">
      {v.signOff ? (
        <p data-testid="mock-recall-signed">
          Signed off by {v.signOff.signedBy.legalName} at {v.signOff.signedAt.text}.
        </p>
      ) : ap ? (
        <>
          <ActButton
            label="Sign off the mock recall"
            disabled={!v.reproduces || act.busy}
            onPress={() => act.sign({ kind: 'MOCK_RECALL_SIGN_OFF', mockRecallId: v.mockRecallId }, `Sign off the mock recall from ${v.subjectRef} as of ${v.asOf.text}`)}
          />
          <ActResult error={act.error} outcome={act.outcome} />
        </>
      ) : (
        <p>Not signed off yet: the authorised person signs it off.</p>
      )}
    </Section>
  );
}
