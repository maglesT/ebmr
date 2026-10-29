/**
 * The Phase 4 slice 2b parts of a lot's page (screens of slice 2c, on the contract ns/specifications.ts and
 * ns/samples.ts): why the lot is not released yet on its specification's required results and its reserve samples (the
 * database's words); QA's status events HOLD, UNHOLD, RETURN and RECALL, proposed first and then signed as LOT_DECISION
 * over the proposed decision (D-P4-3); the reserve or retention samples with their pull and disposal. The required
 * sample quantity and the kept-until instant are the database's; the screen sends what the person typed.
 */
import { useState } from 'react';
import { routes, type LotDecisionProposalView, type LotSummaryView, type SampleView } from '@ebmr/api-contract';
import { Banner, Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { LOT_READS } from './LotsPage.tsx';

const EVENTS = ['HOLD', 'UNHOLD', 'RETURN', 'RECALL'] as const;
type LotEvent = (typeof EVENTS)[number];
const SAMPLE_READS = [routes.samples.list.id, routes.specifications.lotReleaseCheck.id];
const READS = [...LOT_READS, routes.specifications.lotReleaseCheck.id];

/** Why the lot is not released yet on its results and samples (null problems: nothing stands in the way of those). */
export function LotReleaseCheck({ lotId }: { lotId: string }) {
  const q = useApiQuery(routes.specifications.lotReleaseCheck, { params: { lotId } });
  return (
    <Section title="Release check" testId="lot-release-check">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <>
          <p>{q.data.specificationId ? 'Checked against the specification in effect.' : 'No specification is in effect for the material.'}</p>
          {q.data.limsProblem ? <Banner tone="warning" title="Results">{q.data.limsProblem}</Banner> : <p data-testid="lims-ok">The required results stand.</p>}
          {q.data.sampleProblem ? <Banner tone="warning" title="Samples">{q.data.sampleProblem}</Banner> : <p data-testid="samples-ok">The samples stand.</p>}
        </>
      ) : null}
    </Section>
  );
}

/** QA's status event on a lot: proposed (the server names the lot's state version), then signed as LOT_DECISION. */
export function LotEvents({ lot }: { lot: LotSummaryView }) {
  const [event, setEvent] = useState<LotEvent | null>(null);
  const [proposal, setProposal] = useState<LotDecisionProposalView | null>(null);
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const propose = useCommand(routes.specifications.proposeLotDecision, READS, 'proposing a lot decision');
  const signed = useSignedAct(READS);
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  const go = async () => {
    if (!event) return;
    const p = await propose.run({ params: { lotId: lot.lotId }, body: { event } });
    if (p) setProposal(p);
  };
  const sign = () =>
    proposal && reason
      ? signed.sign({ kind: 'LOT_DECISION', lotId: lot.lotId, decision: proposal.event, reason }, `${proposal.event} lot ${lot.lotCode} (${lot.material.name}): ${reason.text}`)
      : undefined;
  return (
    <Section title="Status event (hold, unhold, return, recall)" testId="lot-events">
      <floor.ChoiceGroup
        label="Event"
        options={EVENTS.map((e) => ({ value: e, label: e.toLowerCase() }))}
        value={event}
        onChange={(v) => {
          setEvent(EVENTS.find((e) => e === v) ?? null);
          setProposal(null);
        }}
      />
      <ActButton label="Propose the event" onPress={go} disabled={!event || propose.busy || proposal !== null} />
      <ActResult error={propose.error} />
      {proposal ? (
        <div data-testid="lot-event-proposal">
          <p>
            Proposed: {proposal.event} from {proposal.fromState} (lot state version {proposal.version}). A later change of the lot voids the proposal.
          </p>
          <Field name="eventCode" label="Reason code" value={code} onChange={setCode} />
          <Field name="eventText" label="Reason for the event" value={text} onChange={setText} />
          <ActButton label={`Sign the ${proposal.event.toLowerCase()}`} onPress={sign} disabled={!reason || signed.busy || signed.outcome === 'SIGNED'} />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </div>
      ) : null}
    </Section>
  );
}

/** The reserve or retention samples of the lot, the pull of one and the disposal of one after its retention period. */
export function LotSamples({ lotId, canPull, canDispose }: { lotId: string; canPull: boolean; canDispose: boolean }) {
  const q = useApiQuery(routes.samples.list, { params: { lotId } });
  return (
    <Section title="Reserve and retention samples" testId="lot-samples">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.samples.length === 0 ? <p>No sample pulled yet.</p> : null}
      <ul>
        {q.data?.samples.map((s) => (
          <li key={s.sampleId} data-testid={`sample-${s.sampleId}`}>
            <SampleRow s={s} canDispose={canDispose} />
          </li>
        ))}
      </ul>
      {canPull ? (
        <DefineForm
          title="Pull a sample"
          route={routes.samples.pull}
          params={{ lotId }}
          refresh={SAMPLE_READS}
          submitLabel="Pull the sample"
          fields={[
            { name: 'kind', label: 'Kind', kind: 'choice', options: ['RESERVE', 'RETENTION'], description: 'Reserve: a finished lot; retention: a starting material' },
            { name: 'quantity', label: 'Quantity', kind: 'decimal', description: 'In the lot\'s unit; the database computes what is required' },
            { name: 'container', label: 'Container', kind: 'text' },
            { name: 'storageLocation', label: 'Storage location', kind: 'text' },
          ]}
        />
      ) : null}
    </Section>
  );
}

function SampleRow({ s, canDispose }: { s: SampleView; canDispose: boolean }) {
  const [reason, setReason] = useState('');
  const dispose = useCommand(routes.samples.dispose, SAMPLE_READS, 'disposing of a sample');
  return (
    <>
      <p>
        {s.kind} · {floor.quantityText(s.quantity, s.unit)} (required {s.requiredQuantity}) · {s.container}, {s.storageLocation} · kept until {s.retainUntil.text} · pulled by {s.pulledBy.legalName}, {s.pulledAt.text}
        {s.disposedAt ? ` · disposed ${s.disposedAt.text} by ${s.disposedBy?.legalName ?? 'unknown'}: ${s.disposalReason ?? ''}` : ''}
      </p>
      {canDispose && !s.disposedAt ? (
        <>
          <Field name={`dispose-${s.sampleId}`} label="Reason for the disposal" value={reason} onChange={setReason} />
          <ActButton primary={false} label="Dispose of the sample" onPress={() => dispose.run({ params: { sampleId: s.sampleId }, body: { reason: reason.trim() } })} disabled={reason.trim() === '' || dispose.busy} />
          <ActResult error={dispose.error} done={dispose.done} label="Disposed." />
        </>
      ) : null}
    </>
  );
}
