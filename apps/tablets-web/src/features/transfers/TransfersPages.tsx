/**
 * Inter-site transfers (Phase 6 slice 6i; L-41, DI-31, DI-39): this installation and the installations it trusts (QA
 * approves a proposed key through the ceremony, PEER_INSTALLATION_APPROVE), the packages this site sealed (built by the
 * database, sealed by the server; downloadable as the file exchanged), the packages received (taken in as received; a
 * refused one is shown with its reason and alarm), local QA's decision on a received lot (TRANSFER_RECEIPT_DECIDE) and the
 * alarms of the transfer and federation paths. Every value and gate is the server's; the screens send what the person
 * chose and show what came back.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type TransferImportView, type TransferReceiptView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { offered, useSessionRole } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { words } from '../genealogy/reads.ts';

export const TRANSFER_READS: readonly string[] = [routes.transfers.peers.id, routes.transfers.packages.id, routes.transfers.receipts.id, routes.transfers.receipt.id, routes.transfers.alarms.id];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,9})?$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;

/** Hold time left as days, hours and minutes (display only; the seconds are the server's). */
export function holdLeft(seconds: string): string {
  const s = BigInt(seconds);
  if (s === 0n) return 'passed';
  const d = s / 86400n;
  const h = (s % 86400n) / 3600n;
  const m = (s % 3600n) / 60n;
  return `${d > 0n ? `${d.toString()} d ` : ''}${h.toString()} h ${m.toString()} min`;
}

/** The exchanged file of a package: its payload and seal as JSON (what the receiving site's stores take in). */
export function packageFileHref(f: { payload: string; seal: string }): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ payload: f.payload, seal: f.seal }))}`;
}

/** The payload and seal from an exchanged file's text; null when it is not one. */
export function parsePackageFile(text: string): { payload: string; seal: string } | null {
  try {
    const j = JSON.parse(text) as { payload?: unknown; seal?: unknown };
    return typeof j.payload === 'string' && typeof j.seal === 'string' ? { payload: j.payload, seal: j.seal } : null;
  } catch {
    return null;
  }
}

export function TransfersPage() {
  return (
    <>
      <h1>Inter-site transfers</h1>
      <p>
        A lot sent to another site travels as a sealed package: its status and release decision, its test results, its hold limit, the rule resolutions and its genealogy. The
        receiving site checks the seal and takes the lot into quarantine; it is used only after local QA accepts it.
      </p>
      <Installations />
      <Outbound />
      <Inbound />
      <Alarms />
    </>
  );
}

function Installations() {
  const q = useApiQuery(routes.transfers.peers);
  const qa = offered(useSessionRole(), 'QA');
  const act = useSignedAct(TRANSFER_READS);
  const v = q.data;
  return (
    <Section title="This installation and its peers" testId="transfer-peers">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        v.installation ? (
          <p data-testid="transfer-installation">
            This is {v.installation.installationCode} (site {v.installation.siteCode}, {words(v.installation.edition)}), key {v.installation.keyFingerprint.slice(0, 16)}… version{' '}
            {v.installation.keyVersion.toString()}{' '}
            {v.installation.serverHoldsKey ? <StatusChip tone="ok" label="Server holds the key" /> : <StatusChip tone="error" label="Server holds no key: nothing can be sealed" />}
          </p>
        ) : (
          <Banner tone="warning" title="This installation has no identity yet">
            The system administrator sets the installation code and key first.
          </Banner>
        )
      ) : null}
      <ul>
        {v?.peers.map((p) => (
          <li key={p.peerId} data-testid={`peer-${p.installationCode}`} data-state={p.state}>
            {p.installationCode} (site {p.siteCode}) at {p.baseUrl}, key {p.keyFingerprint.slice(0, 16)}…{' '}
            <StatusChip tone={p.state === 'APPROVED' ? 'ok' : p.state === 'REVOKED' ? 'error' : 'pending'} label={words(p.state)} />
            {p.approvedBy ? ` by ${p.approvedBy.legalName}` : null}
            {p.state === 'PROPOSED' && qa ? (
              <ActButton label={`Approve the key of ${p.installationCode}`} disabled={act.busy} onPress={() => act.sign({ kind: 'PEER_INSTALLATION_APPROVE', peerId: p.peerId }, `Approve the key of installation ${p.installationCode}`)} />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={act.error} outcome={act.outcome} />
    </Section>
  );
}

function Outbound() {
  const q = useApiQuery(routes.transfers.packages);
  const peers = useApiQuery(routes.transfers.peers);
  const stores = offered(useSessionRole(), 'STORES');
  const prepare = useCommand(routes.transfers.prepare, TRANSFER_READS, 'sealing the transfer package');
  const [lotId, setLotId] = useState('');
  const [destination, setDestination] = useState('');
  const [quantity, setQuantity] = useState('');
  const [holdUntil, setHoldUntil] = useState('');
  const trusted = (peers.data?.peers ?? []).filter((p) => p.state === 'APPROVED');
  const ok = UUID.test(lotId.trim()) && trusted.some((p) => p.installationCode === destination) && DECIMAL.test(quantity.trim()) && (holdUntil.trim() === '' || ISO.test(holdUntil.trim()));
  return (
    <Section title="Packages sent" testId="transfer-outbound">
      {stores ? (
        <div data-testid="transfer-prepare">
          <Field name="transferLot" label="Lot (id)" value={lotId} onChange={setLotId} />
          <label htmlFor="transfer-destination">Destination installation</label>
          <select id="transfer-destination" value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">Choose…</option>
            {trusted.map((p) => (
              <option key={p.peerId} value={p.installationCode}>
                {p.installationCode}
              </option>
            ))}
          </select>
          <Field name="transferQuantity" label="Quantity (in the lot's unit)" value={quantity} onChange={setQuantity} />
          <Field name="transferHold" label="Earlier hold limit (optional, UTC, e.g. 2026-10-20T00:00:00Z)" value={holdUntil} onChange={setHoldUntil} />
          <ActButton
            label="Build and seal the package"
            disabled={!ok || prepare.busy}
            onPress={() =>
              ok && prepare.run({ body: { lotId: lotId.trim().toLowerCase(), destination, quantity: quantity.trim(), ...(holdUntil.trim() ? { holdUntil: holdUntil.trim() } : {}) } })
            }
          />
          <ActResult error={prepare.error} done={prepare.done} label="The package is sealed." />
          {prepare.done ? (
            <p>
              <a data-testid="transfer-file-new" href={packageFileHref(prepare.done)} download={prepare.done.fileName}>
                Download {prepare.done.fileName}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.packages.length === 0 ? <p>No package sent yet.</p> : null}
      <ul>
        {q.data?.packages.map((p) => (
          <li key={p.packageId} data-testid={`package-${p.packageNo}`}>
            {p.packageNo}: lot {p.lotCode} ({p.materialName}), {p.quantity} {p.unit} to {p.destination} · status {words(p.status)} · hold until {p.holdUntil.text} ({words(p.holdBasis)}) ·{' '}
            {p.ruleCount.toString()} rule resolution(s) · {p.sealed ? <PackageFileLink packageId={p.packageId} /> : <StatusChip tone="pending" label="Not sealed" />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function PackageFileLink({ packageId }: { packageId: string }) {
  const [want, setWant] = useState(false);
  const f = useApiQuery(routes.transfers.packageFile, { params: { packageId } }, { enabled: want });
  if (!want) return <ActButton primary={false} label="Get the file" onPress={() => setWant(true)} />;
  if (!f.data) return <span>…</span>;
  return (
    <a data-testid={`package-file-${f.data.packageNo}`} href={packageFileHref(f.data)} download={f.data.fileName}>
      Download {f.data.fileName}
    </a>
  );
}

function Inbound() {
  const q = useApiQuery(routes.transfers.receipts);
  const stores = offered(useSessionRole(), 'STORES');
  const take = useCommand(routes.transfers.import, TRANSFER_READS, 'taking in the transfer package');
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<TransferImportView | null>(null);
  const file = parsePackageFile(text);
  return (
    <Section title="Packages received" testId="transfer-inbound">
      {stores ? (
        <div data-testid="transfer-import">
          <label>
            Package file
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Package file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then(setText);
              }}
            />
          </label>
          <div>
            <label htmlFor="transfer-file-text">Package file as received</label>
            <textarea id="transfer-file-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ display: 'block', inlineSize: '100%' }} />
          </div>
          <ActButton
            label="Take in the package"
            disabled={file === null || take.busy}
            onPress={async () => {
              if (!file) return;
              const r = await take.run({ body: file });
              if (r) setAnswer(r);
            }}
          />
          {take.error ? <RefusalMessage error={take.error} /> : null}
          {answer?.outcome === 'REFUSED' ? (
            <Banner tone="error" title={`Refused: ${words(answer.kind)}`} live="polite">
              <p data-testid="transfer-refused">{answer.reason}</p>
              <p>Nothing was taken in; an alarm was raised.</p>
            </Banner>
          ) : null}
          {answer?.outcome === 'RECEIVED' ? (
            <Banner tone="ok" title="Taken in: the lot is in quarantine until local QA accepts it" live="polite">
              <p data-testid="transfer-received">
                Lot {answer.receipt.lotCode} from {answer.receipt.origin}.{' '}
                <Link to="/transfers/receipts/$receiptId" params={{ receiptId: answer.receipt.receiptId }}>
                  Open the receipt
                </Link>
              </p>
            </Banner>
          ) : null}
        </div>
      ) : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.receipts.length === 0 ? <p>No package received yet.</p> : null}
      <ul>
        {q.data?.receipts.map((r) => (
          <li key={r.receiptId} data-testid={`receipt-${r.packageNo}`} data-state={r.state}>
            <Link to="/transfers/receipts/$receiptId" params={{ receiptId: r.receiptId }}>
              {r.packageNo}
            </Link>{' '}
            from {r.origin}: lot {r.lotCode}, {r.quantity} {r.unit} · {words(r.lotState)} · hold {holdLeft(r.holdRemainingSeconds)} ·{' '}
            <StatusChip tone={r.state === 'ACCEPTED' ? 'ok' : r.state === 'REFUSED' ? 'error' : 'pending'} label={words(r.state)} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Alarms() {
  const q = useApiQuery(routes.transfers.alarms);
  const ack = useCommand(routes.transfers.acknowledgeAlarm, TRANSFER_READS, 'acknowledging the alarm');
  const [notes, setNotes] = useState<Record<string, string>>({});
  return (
    <Section title="Transfer and federation alarms" testId="transfer-alarms">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.alarms.length === 0 ? <p>No alarm.</p> : null}
      <ul>
        {q.data?.alarms.map((a) => (
          <li key={a.alarmId} data-testid={`alarm-${a.alarmId}`} data-kind={a.kind}>
            <StatusChip tone={a.severity === 'MINOR' ? 'warning' : 'error'} label={`${words(a.kind)} (${words(a.severity)})`} /> {words(a.path)} · {a.peer ?? 'unknown sender'} ·{' '}
            {a.raisedAt.text}
            {a.reason ? <p>{a.reason}</p> : null}
            {a.acknowledgement ? (
              <p>
                Acknowledged by {a.acknowledgement.by.legalName} at {a.acknowledgement.at.text}: {a.acknowledgement.note}
              </p>
            ) : (
              <>
                <Field name={`ack-${a.alarmId}`} label="Note" value={notes[a.alarmId] ?? ''} onChange={(v) => setNotes({ ...notes, [a.alarmId]: v })} />
                <ActButton
                  primary={false}
                  label="Acknowledge"
                  disabled={(notes[a.alarmId] ?? '').trim() === '' || ack.busy}
                  onPress={() => ack.run({ params: { alarmId: a.alarmId }, body: { note: (notes[a.alarmId] ?? '').trim() } })}
                />
              </>
            )}
          </li>
        ))}
      </ul>
      <ActResult error={ack.error} done={ack.done} label="Acknowledged." />
    </Section>
  );
}

export function ReceiptPage() {
  const receiptId = useRouteParams()['receiptId'] ?? '';
  const q = useApiQuery(routes.transfers.receipt, { params: { receiptId } });
  const v = q.data;
  return (
    <>
      <h1>Received package {v ? v.packageNo : receiptId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <Receipt v={v} /> : null}
    </>
  );
}

function Receipt({ v }: { v: TransferReceiptView }) {
  return (
    <>
      <p data-testid="receipt-summary" data-state={v.state}>
        From {v.origin}: lot {v.originLotCode} ({words(v.originState)} at its origin) became lot {v.lotCode} here, {v.quantity} {v.unit}, now {words(v.lotState)} · received by{' '}
        {v.receivedBy.legalName} at {v.receivedAt.text} · payload SHA-256 <code>{v.payloadSha256}</code>
      </p>
      <p data-testid="receipt-hold">
        Hold limit {v.holdUntil.text}: {holdLeft(v.holdRemainingSeconds)} left (the hold time kept running since the origin).
      </p>
      {v.holdRemainingSeconds === '0' ? <Banner tone="error" title="The hold limit has passed: the lot cannot be accepted or used." /> : null}
      <Section title="Status and release decision at the origin" testId="receipt-origin">
        <p>
          {v.originDecision
            ? `${words(v.originDecision.event)}${v.originDecision.route ? ` (${words(v.originDecision.route)})` : ''}${v.originDecision.decidedAt ? `, ${v.originDecision.decidedAt.text}` : ''}`
            : 'No release decision stated.'}{' '}
          · markets {v.markets.join(', ')}
        </p>
        <table data-testid="receipt-coa">
          <thead>
            <tr>
              <th scope="col">Test</th>
              <th scope="col">Result</th>
              <th scope="col">Limits</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {v.coa.map((c) => (
              <tr key={`${c.testCode}-${c.methodReference}`}>
                <th scope="row">
                  {c.testCode} ({c.methodReference})
                </th>
                <td>
                  {c.result} {c.unit}
                </td>
                <td>
                  {c.lowerLimit ?? '–'} to {c.upperLimit ?? '–'}
                </td>
                <td>{words(c.verdict)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Rule resolutions: carried, local and the one that applies here" testId="receipt-rules">
        <table>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Carried</th>
              <th scope="col">Here</th>
              <th scope="col">Applies</th>
            </tr>
          </thead>
          <tbody>
            {v.rules.map((r) => (
              <tr key={r.key} data-testid={`rule-${r.key}`} data-winner={r.winner}>
                <th scope="row">{r.key}</th>
                <td>{r.carried}</td>
                <td>{r.local ?? '–'}</td>
                <td>
                  {r.resolved ?? 'not comparable: both shown'} <StatusChip tone={r.winner === 'NOT_COMPARABLE' ? 'warning' : 'neutral'} label={words(r.winner)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Genealogy at the origin" testId="receipt-genealogy">
        <p>As of {v.genealogyAsOf?.text ?? 'unknown'}:</p>
        <ul>
          {v.genealogy.map((n) => (
            <li key={`${n.kind}:${n.id}`}>
              {words(n.kind)} {n.label} {n.code ?? ''} {n.name ?? ''}
            </li>
          ))}
        </ul>
        <Link to="/genealogy" search={{ kind: 'LOT', id: v.lotId, direction: 'BACKWARD' }}>
          Trace the local lot across sites
        </Link>
      </Section>
      <Decision v={v} />
    </>
  );
}

function Decision({ v }: { v: TransferReceiptView }) {
  const qa = offered(useSessionRole(), 'QA');
  const act = useSignedAct(TRANSFER_READS);
  const [reason, setReason] = useState('');
  return (
    <Section title="Local QA's decision" testId="receipt-decision">
      {v.decision ? (
        <p data-testid="receipt-decided">
          {words(v.decision.decision)} by {v.decision.by.legalName} at {v.decision.at.text}
          {v.decision.reason ? `: ${v.decision.reason}` : ''}. {v.decision.decision === 'ACCEPTED' ? 'The lot is released through the ordinary lot release.' : ''}
        </p>
      ) : qa ? (
        <>
          <ActButton
            label="Accept the received lot"
            disabled={act.busy || v.holdRemainingSeconds === '0'}
            onPress={() => act.sign({ kind: 'TRANSFER_RECEIPT_DECIDE', receiptId: v.receiptId, decision: 'ACCEPTED' }, `Accept lot ${v.lotCode} received from ${v.origin}`)}
          />
          <Field name="receiptRefusal" label="Reason for a refusal (at least 10 characters)" value={reason} onChange={setReason} />
          <ActButton
            primary={false}
            label="Refuse the received lot"
            disabled={act.busy || reason.trim().length < 10}
            onPress={() => act.sign({ kind: 'TRANSFER_RECEIPT_DECIDE', receiptId: v.receiptId, decision: 'REFUSED', reason: reason.trim() }, `Refuse lot ${v.lotCode} received from ${v.origin}`)}
          />
          <ActResult error={act.error} outcome={act.outcome} />
        </>
      ) : (
        <p>Not decided yet: local QA accepts or refuses the received lot; until then it cannot be released or used.</p>
      )}
    </Section>
  );
}
