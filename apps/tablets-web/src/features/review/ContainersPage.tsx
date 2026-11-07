/**
 * The output containers of a GMP batch (Phase 4 slice 1b and 1c; contract ns/containers.ts): each with its state, its
 * close (weighed from two scale readings, or typed), the second person who verified a typed net, its holds, and the
 * database's own words for why it cannot be used and why QA cannot release it now.
 *
 * The acts are the person's own: open (at a stage, on a press and, when each side of the press discharges into its own
 * containers, on that side: its stream; Phase 7 slice 7h, gap report D2), close (weighed: tare and gross captured from a balance of the room, the readings
 * named by id; typed: the net, which a second person then verifies with CONTAINER_ACT VERIFY_CLOSE, DI-30), sort and
 * reject with a reason, QA's own hold with its reason (offered only when the server says the container takes it,
 * `qaHoldable`; API plan A4c), and QA's release (CONTAINER_ACT RELEASE, with QA's reason). On a shared terminal the plain
 * commands carry a fresh badge tap (FRESH_ON_SHARED, through app/acts.tsx). Every rule is the database's; the screen
 * only shows its answers.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type ContainerView, type ReadingView } from '@ebmr/api-contract';
import { Banner, decimalProblem, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { ScaleCaptureSlot } from '../../app/ports.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { CONTAINER_READS, words } from './reads.ts';

const STAGE = /^[A-Z][A-Z0-9_]{0,39}$/;

const tone = (s: ContainerView['state']) => (s === 'RELEASED_BY_QA' || s === 'CLOSED' ? 'ok' : s === 'OPEN' ? 'info' : s === 'REJECTED' ? 'error' : 'warning');

export function ContainersPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.containers.list, { query: { batchId } });
  const list = q.data?.containers ?? [];
  const number = list[0]?.batchNumber ?? batchId;
  return (
    <>
      <h1>Output containers of batch {number}</h1>
      <p>
        <Link to="/review/$batchId" params={{ batchId }}>
          Review of the record
        </Link>
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && list.length === 0 ? <p>No output container yet.</p> : null}
      {list.map((c) => (
        <ContainerCard key={c.containerId} c={c} />
      ))}
      <OpenContainer batchId={batchId} />
    </>
  );
}

function ContainerCard({ c }: { c: ContainerView }) {
  const qa = useOffered('QA');
  const floorActs = useOffered('PRODUCTION_FLOOR');
  return (
    <Section title={`Container ${c.label}`} testId={`container-${c.label}`}>
      <p data-testid="container-state">
        <StatusChip tone={tone(c.state)} label={words(c.state)} /> {words(c.stage)}
        {c.press ? `, press ${c.press}` : ''}
        {c.stream ? `, stream ${c.stream}` : ''} · opened by {c.openedBy.legalName}, {c.openedAt.text}
      </p>
      {c.netQuantity !== null ? (
        <p data-testid="container-net">
          Net {c.netQuantity} {c.unit} ({c.closeBasis === 'TYPED' ? 'typed' : c.closeBasis === 'WEIGHED' ? 'weighed' : 'recorded'})
          {c.closedBy ? `, closed by ${c.closedBy.legalName}${c.closedAt ? `, ${c.closedAt.text}` : ''}` : ''}
          {c.closeBasis === 'TYPED' ? (c.netVerifiedBy ? `; net verified by ${c.netVerifiedBy.legalName}` : '; net not verified by a second person yet') : ''}
        </p>
      ) : null}
      {c.holds.length > 0 ? (
        <ul aria-label="Holds">
          {c.holds.map((h) => (
            <li key={h.checkId}>
              Held by a {h.result === 'FAIL' ? 'failed' : 'missed'} check on {h.press}
              {h.stream ? ` stream ${h.stream}` : ''} ({h.reference}), {h.recordedAt.text}
            </li>
          ))}
        </ul>
      ) : null}
      {c.qaHolds.length > 0 ? (
        <ul aria-label="Holds by QA">
          {c.qaHolds.map((h) => (
            <li key={h.recordedAt.us}>
              Held by QA ({h.by.legalName}, {h.recordedAt.text}): {h.reasonText} [{h.reasonCode}]
            </li>
          ))}
        </ul>
      ) : null}
      {c.usableProblem ? <p data-testid="usable-problem">Not usable now: {c.usableProblem}</p> : null}
      {c.releaseProblem ? <Banner tone="warning" title="QA cannot release it yet" >{<p data-testid="release-problem">{c.releaseProblem}</p>}</Banner> : null}
      {c.state === 'OPEN' && floorActs ? <CloseContainer c={c} /> : null}
      {c.state !== 'OPEN' && c.closeBasis === 'TYPED' && c.netVerifiedBy === null ? <VerifyNet c={c} /> : null}
      {c.state === 'HELD' && floorActs ? <ReasonAct c={c} act="sort" /> : null}
      {c.qaHoldable && qa ? <ReasonAct c={c} act="hold" /> : null}
      {(c.state === 'HELD' || c.state === 'SORTED') && qa ? (
        <>
          <Release c={c} />
          <ReasonAct c={c} act="reject" />
        </>
      ) : null}
    </Section>
  );
}

function CloseContainer({ c }: { c: ContainerView }) {
  const [basis, setBasis] = useState<'TYPED' | 'WEIGHED' | null>(null);
  const [net, setNet] = useState('');
  const [tare, setTare] = useState<ReadingView | null>(null);
  const [gross, setGross] = useState<ReadingView | null>(null);
  const scales = useApiQuery(routes.devices.scales, {}, { enabled: basis === 'WEIGHED' });
  const close = useCommand(routes.containers.close, CONTAINER_READS, `the close of container ${c.label}`);
  const problem = net.trim() === '' ? null : decimalProblem(net.trim(), { maxDecimals: 3 });
  const send = () => {
    if (basis === 'TYPED') return close.run({ params: { containerId: c.containerId }, body: { expectedVersion: c.version, typed: { net: net.trim() } } });
    if (basis === 'WEIGHED' && tare && gross) return close.run({ params: { containerId: c.containerId }, body: { expectedVersion: c.version, weighing: { tareReadingId: tare.readingId, grossReadingId: gross.readingId } } });
    return null;
  };
  const ready = (basis === 'TYPED' && net.trim() !== '' && problem === null) || (basis === 'WEIGHED' && tare !== null && gross !== null);
  const devices = (scales.data?.scales ?? []).map((s) => s.deviceCode);
  return (
    <div data-testid="close-container">
      <floor.ChoiceGroup
        label={`Close ${c.label}`}
        options={[
          { value: 'WEIGHED', label: 'Weighed on a balance' },
          { value: 'TYPED', label: 'Net typed (a second person verifies it)' },
        ]}
        value={basis}
        onChange={(v) => setBasis(v === 'WEIGHED' ? 'WEIGHED' : 'TYPED')}
      />
      {basis === 'TYPED' ? <Field name={`net-${c.label}`} label={`Net quantity (${c.unit})`} value={net} onChange={setNet} inputMode="decimal" {...(problem ? { errorMessage: problem } : {})} /> : null}
      {basis === 'WEIGHED' ? (
        <>
          {scales.error ? <RefusalMessage error={scales.error.error} /> : null}
          <p>Tare: {tare ? `${tare.value} ${tare.unit} from ${tare.deviceCode}, ${tare.recordedAt.text}` : 'not captured'}</p>
          <ScaleCaptureSlot deviceCodes={devices} purpose="TARE" onCaptured={setTare} disabled={close.busy} />
          <p>Gross: {gross ? `${gross.value} ${gross.unit} from ${gross.deviceCode}, ${gross.recordedAt.text}` : 'not captured'}</p>
          <ScaleCaptureSlot deviceCodes={devices} purpose="GROSS" onCaptured={setGross} disabled={close.busy || tare === null} />
        </>
      ) : null}
      <ActButton label={`Close ${c.label}`} onPress={send} disabled={!ready || close.busy} />
      <ActResult error={close.error} done={close.done} label="Container closed." />
    </div>
  );
}

function VerifyNet({ c }: { c: ContainerView }) {
  const signed = useSignedAct(CONTAINER_READS);
  return (
    <div data-testid="verify-net">
      <p>The typed net is checked by a second person, never the person who closed or opened the container.</p>
      <ActButton
        label={`Verify the net of ${c.label} (second person)`}
        onPress={() => signed.sign({ kind: 'CONTAINER_ACT', act: 'VERIFY_CLOSE', containerId: c.containerId }, `Verify the typed net ${c.netQuantity ?? ''} ${c.unit} of container ${c.label}`)}
        disabled={signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </div>
  );
}

function Release({ c }: { c: ContainerView }) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(CONTAINER_READS);
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  return (
    <div data-testid="release-container">
      <Field name={`release-code-${c.label}`} label="Release reason code" value={code} onChange={setCode} />
      <Field name={`release-text-${c.label}`} label="Reason for the release" value={text} onChange={setText} />
      <ActButton
        label={`Release ${c.label} (QA signature)`}
        onPress={() => reason && signed.sign({ kind: 'CONTAINER_ACT', act: 'RELEASE', containerId: c.containerId, reason }, `Release container ${c.label}: ${reason.text}`)}
        disabled={reason === null || c.releaseProblem !== null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </div>
  );
}

const REASON_ACTS = {
  sort: { route: routes.containers.sort, what: 'Sort', done: 'Container sorted.' },
  reject: { route: routes.containers.reject, what: 'Reject', done: 'Container rejected.' },
  hold: { route: routes.containers.hold, what: 'Hold', done: 'Container held by QA.' },
} as const;

function ReasonAct({ c, act }: { c: ContainerView; act: keyof typeof REASON_ACTS }) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const { route, what, done } = REASON_ACTS[act];
  const cmd = useCommand(route, CONTAINER_READS, `the ${act} of container ${c.label}`);
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  return (
    <div data-testid={`${act}-container`}>
      <Field name={`${act}-code-${c.label}`} label={`${what} reason code`} value={code} onChange={setCode} />
      <Field name={`${act}-text-${c.label}`} label={`Reason to ${act}`} value={text} onChange={setText} />
      <ActButton primary={false} label={`${what} ${c.label}`} onPress={() => reason && cmd.run({ params: { containerId: c.containerId }, body: { expectedVersion: c.version, reason } })} disabled={reason === null || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label={done} />
    </div>
  );
}

function OpenContainer({ batchId }: { batchId: string }) {
  const floorActs = useOffered('PRODUCTION_FLOOR');
  const [stage, setStage] = useState('');
  const [unit, setUnit] = useState<'kg' | 'g' | 'units' | null>(null);
  const [press, setPress] = useState('');
  const [stream, setStream] = useState('');
  const open = useCommand(routes.containers.open, CONTAINER_READS, 'a new output container');
  if (!floorActs) return null;
  const s = stage.trim().toUpperCase();
  return (
    <Section title="Open a container" testId="open-container">
      <Field name="stage" label="Stage" value={stage} onChange={setStage} description="e.g. COMPRESSION" {...(s !== '' && !STAGE.test(s) ? { errorMessage: 'Capital letters, digits and _ only' } : {})} />
      <floor.ChoiceGroup label="Unit" options={['kg', 'g', 'units'].map((u) => ({ value: u, label: u }))} value={unit} onChange={(v) => setUnit(v === 'g' ? 'g' : v === 'units' ? 'units' : 'kg')} />
      <Field name="press" label="Press (optional)" value={press} onChange={setPress} />
      <Field name="stream" label="Side of the press (stream, optional)" value={stream} onChange={setStream} description="e.g. L or R, when each side of the press discharges into its own containers" />
      <ActButton
        label="Open the container"
        onPress={() => unit && open.run({ body: { batchId, stage: s, unit, ...(press.trim() ? { press: press.trim() } : {}), ...(stream.trim() ? { stream: stream.trim() } : {}) } })}
        disabled={!STAGE.test(s) || unit === null || open.busy || (stream.trim() !== '' && press.trim() === '')}
      />
      <ActResult error={open.error} done={open.done} label="Container opened." />
    </Section>
  );
}
