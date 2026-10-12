/**
 * The market tabs of the release cockpit (Phase 4 slice 4c; outline 3.3.3, 5.2.6, 5.2.7 items 8 and 11, 7.3), beside
 * the manufacturer tab of slice 3:
 *  - US: the disposition state, G-REL for US with its "since review" items, the QCU's signed release or rejection (a
 *    rejection names the investigation every other market sees, PR-56), the recorded decision, and the two-row release
 *    (the manufacturer and US release in one ceremony, D-P4-5) offered when the authorised person also holds the US
 *    quality-unit role;
 *  - EU: the disposition state, G-REL for EU, the importer, the certification intake and the register (EuTab.tsx);
 *  - India: the manufacturer state (market IN is decided by the manufacturer release);
 *  - each market tab: the market-add evaluation (MET, UNMET_RECOVERABLE, UNMET_FINAL, with the database's reasons), the
 *    signed addition under a change record, the signed removal with a linked deviation, and every signed change.
 * Every state, gate, outcome and meaning is the server's: the browser computes none of them, and every signed act goes
 * through esig.describe and the ceremony (acts.tsx).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type LotReleaseView, type ReleaseMarket } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered, useSessionRole, useSessionRoles } from '../../app/roles.ts';
import { GateProblems } from '../review/parts.tsx';
import { EuTab } from './EuTab.tsx';
import { EvidenceList, GrelChecklist, SinceReview } from './parts.tsx';
import { addTone, marketTone, RELEASE_READS, releaseTone, words, type ExportMarket, type MarketAddEvaluationView, type MarketChangeView, type MarketDispositionView } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;

/** A US or EU tab: the lot's disposition for the market, read from release.markets. */
export function MarketTab({ lot, market }: { lot: LotReleaseView; market: ExportMarket }) {
  const q = useApiQuery(routes.release.markets, { params: { lotId: lot.lotId } });
  const v = q.data;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!v) return <p aria-busy="true">Loading the {market} disposition…</p>;
  const d = v.dispositions.find((x) => x.market === market) ?? null;
  const inSet = v.markets.includes(market);
  return (
    <>
      <p data-testid={`market-state-${market}`}>
        {d ? <StatusChip tone={marketTone(d.state)} label={words(d.state)} /> : <StatusChip tone="neutral" label="No disposition" />}{' '}
        {inSet ? `${market} is in the lot's market set.` : `${market} is not in the lot's market set.`} Manufacturer release:{' '}
        <StatusChip tone={releaseTone(v.manufacturerState)} label={words(v.manufacturerState)} />
      </p>
      {d?.state === 'INELIGIBLE' ? (
        <Banner tone="error" title={`The lot can never be released for ${market}`}>
          The market-add evaluation signed with the addition had an item that can no longer be met.
        </Banner>
      ) : null}
      {d?.state === 'RELEASE_SUSPENDED' ? (
        <Banner tone="warning" title="The decision is suspended">
          The manufacturer release of the lot is no longer released, so the {market} decision does not stand.
        </Banner>
      ) : null}
      {d?.grel ? (
        <>
          <GrelChecklist grel={d.grel} title={`G-REL, market ${market}`} testId={`grel-${market}`} testIdPrefix={`grel-${market}-item-`} />
          <SinceReview lotId={lot.lotId} grel={d.grel} testId={`since-review-${market}`} />
        </>
      ) : null}
      {market === 'US' && d ? <UsParts lot={lot} d={d} inSet={inSet} /> : null}
      {market === 'EU' ? <EuTab lot={lot} d={d} /> : null}
      <MarketChanges lot={lot} market={market} d={d} inSet={inSet} />
    </>
  );
}

/** India: market IN is decided by the manufacturer release (slice 3); its state and checklist are on that tab. */
export function IndiaTab({ lot }: { lot: LotReleaseView }) {
  return (
    <Section title="India (market IN)" testId="market-in">
      <p data-testid="market-state-IN">
        <StatusChip tone={releaseTone(lot.state)} label={words(lot.state)} /> India Revised Schedule M always applies: the lot is released for India by the manufacturer release, on the market IN checklist of
        the manufacturer tab.
      </p>
      {lot.decision ? (
        <p>
          {words(lot.decision.decision)} by {lot.decision.by.legalName} ({words(lot.decision.by.role)}), {lot.decision.at.text}.
        </p>
      ) : (
        <p>No manufacturer decision is recorded yet.</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// US
// ---------------------------------------------------------------------------------------------------------------------

function UsParts({ lot, d, inSet }: { lot: LotReleaseView; d: MarketDispositionView; inSet: boolean }) {
  const qcu = useOffered('US_QCU');
  return (
    <>
      {d.decision ? <UsDecision d={d} /> : null}
      {!d.decision && inSet ? <TwoRowRelease lot={lot} d={d} /> : null}
      {!d.decision && inSet && qcu ? <UsDisposition lot={lot} d={d} /> : null}
    </>
  );
}

function UsDecision({ d }: { d: MarketDispositionView }) {
  const x = d.decision;
  if (!x) return null;
  return (
    <Section title="US decision" testId="us-decision">
      <p>
        <StatusChip tone={x.decision === 'RELEASED' ? 'ok' : 'error'} label={words(x.decision)} /> by {x.by.legalName} ({words(x.by.role)}), {x.at.text}
        {x.withManufacturerRelease ? ', in the same ceremony as the manufacturer release' : ''}
        {x.reason ? `: ${x.reason}` : ''}
      </p>
      <p>
        Checklist signed at evidence epoch {x.epoch}, checklist hash {x.checklistHash}.
      </p>
      {x.deviationId ? (
        <p>
          Investigation:{' '}
          <Link to="/quality/deviations/$deviationId" params={{ deviationId: x.deviationId }}>
            {x.deviationId}
          </Link>
        </p>
      ) : null}
    </Section>
  );
}

/**
 * D-P4-5: the authorised person who also holds the US quality-unit role releases the lot for the manufacturer and for the
 * US in one ceremony: two signature rows, each on its own record with its own meaning (the server's descriptor names the
 * second). Offered only to that person (display only; the server decides).
 */
function TwoRowRelease({ lot, d }: { lot: LotReleaseView; d: MarketDispositionView }) {
  const role = useSessionRole();
  const roles = useSessionRoles();
  const [delegation, setDelegation] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const us = d.grel;
  if (lot.decision || role !== 'AUTHORISED_PERSON' || !roles.includes('US_QCU_SIGNER') || !us) return null;
  const inEpoch = HEX64.test(lot.grel.epoch) ? lot.grel.epoch : null;
  const usEpoch = HEX64.test(us.epoch) ? us.epoch : null;
  const delegationId = delegation.trim() === '' ? {} : { delegationId: delegation.trim() };
  return (
    <Section title="Manufacturer and US release in one ceremony" testId="two-row-release">
      <GateProblems gate={lot.gates.release} testId="two-row-problems" />
      {!us.ready ? <p>G-REL for US has red items: the US release cannot be signed yet.</p> : null}
      <p>
        You hold the US quality-unit role too: you may sign the manufacturer release (market IN checklist at evidence epoch {lot.grel.epoch}) and the US release (G-REL for US at evidence epoch {us.epoch})
        once. Two signatures are recorded, each with its own meaning; a change to either checklist after you read it refuses both.
      </p>
      <Field name="twoRowDelegationId" label="Delegation (only when you sign as a named delegate of the authorised person)" value={delegation} onChange={setDelegation} />
      <ActButton
        label="Sign the manufacturer and US release"
        onPress={() =>
          inEpoch &&
          usEpoch &&
          signed.sign(
            { kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId: lot.lotId, input: { expectedEpoch: inEpoch, usExpectedEpoch: usEpoch, ...delegationId } },
            `Release lot ${lot.lotCode} (batch ${lot.batchNumber}) for the manufacturer (evidence epoch ${lot.grel.epoch}) and for the US (evidence epoch ${us.epoch}): two signatures`,
          )
        }
        disabled={!lot.gates.release.ready || !us.ready || inEpoch === null || usEpoch === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

/** The US quality unit's release or rejection (US_DISPOSE) on G-REL for US as it stands now. */
function UsDisposition({ lot, d }: { lot: LotReleaseView; d: MarketDispositionView }) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [deviation, setDeviation] = useState('');
  const release = useSignedAct(RELEASE_READS);
  const reject = useSignedAct(RELEASE_READS);
  const g = d.grel;
  if (!g) return null;
  const epoch = HEX64.test(g.epoch) ? g.epoch : null;
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  const deviationId = UUID.test(deviation.trim()) ? deviation.trim() : null;
  return (
    <>
      <Section title="US release" testId="us-release">
        <GateProblems gate={d.gates.release} testId="us-release-problems" />
        <p>You sign G-REL for US above as it stands now (evidence epoch {g.epoch}); a change after you read it refuses the signature.</p>
        <ActButton
          label="Sign the US release"
          onPress={() => epoch && release.sign({ kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId: lot.lotId, input: { usDecision: 'RELEASE', expectedEpoch: epoch } }, `Release lot ${lot.lotCode} for the US at evidence epoch ${g.epoch}`)}
          disabled={!d.gates.release.ready || epoch === null || release.busy}
        />
        <ActResult error={release.error} outcome={release.outcome} />
      </Section>
      <Section title="US rejection" testId="us-reject">
        <GateProblems gate={d.gates.reject} testId="us-reject-problems" />
        <p>A US rejection names the investigation (a deviation linked to the lot) that every other market of the lot then sees.</p>
        <Field name="usRejectCode" label="Reason code" value={code} onChange={setCode} isDisabled={!d.gates.reject.ready} />
        <Field name="usRejectText" label="Reason for the US rejection" value={text} onChange={setText} isDisabled={!d.gates.reject.ready} />
        <Field name="usRejectDeviation" label="Investigation (deviation id)" value={deviation} onChange={setDeviation} isDisabled={!d.gates.reject.ready} />
        <ActButton
          primary={false}
          label="Sign the US rejection"
          onPress={() =>
            epoch &&
            reason &&
            deviationId &&
            reject.sign({ kind: 'RELEASE_ACT', act: 'US_DISPOSE', lotId: lot.lotId, input: { usDecision: 'REJECT', expectedEpoch: epoch, reason, deviationId } }, `Reject lot ${lot.lotCode} for the US at evidence epoch ${g.epoch}: ${reason.text}`)
          }
          disabled={!d.gates.reject.ready || epoch === null || reason === null || deviationId === null || reject.busy}
        />
        <ActResult error={reject.error} outcome={reject.outcome} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Market add and removal (3.3.3)
// ---------------------------------------------------------------------------------------------------------------------

/** A market-add evaluation as the database answered it: the outcome, each item with its reason and evidence. */
export function MarketAddEvaluation({ evaluation: e, testId }: { evaluation: MarketAddEvaluationView; testId: string }) {
  return (
    <div data-testid={testId} data-outcome={e.outcome}>
      <p>
        <StatusChip tone={addTone(e.outcome)} label={words(e.outcome)} />{' '}
        {e.outcome === 'MET'
          ? `Every item is met: ${e.market} can be added.`
          : e.outcome === 'UNMET_RECOVERABLE'
            ? `Some items are not met yet but can still be: ${e.market} can be added, and the lot waits for them.`
            : `An item can never be met on the recorded data: added, ${e.market} would be ineligible.`}
      </p>
      <ul>
        {e.items.map((i) => (
          <li key={i.id} data-testid={`${testId}-${i.id}`} data-outcome={i.outcome}>
            <StatusChip tone={addTone(i.outcome)} label={words(i.outcome)} /> <strong>{i.id}</strong> {i.title}
            {i.detail ? <p>{i.detail}</p> : null}
            <EvidenceList evidence={i.evidence} label={`Evidence of ${i.id}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MarketChanges({ lot, market, d, inSet }: { lot: LotReleaseView; market: ReleaseMarket; d: MarketDispositionView | null; inSet: boolean }) {
  const qa = useOffered('QA');
  return (
    <>
      {d?.marketAdd ? (
        <Section title={`Market-add evaluation for ${market} (G-REL item 8)`} testId={`market-add-now-${market}`}>
          <MarketAddEvaluation evaluation={d.marketAdd} testId={`market-add-current-${market}`} />
        </Section>
      ) : null}
      {!inSet && qa ? <AddMarket lot={lot} market={market} /> : null}
      {inSet && qa ? <RemoveMarket lot={lot} market={market} /> : null}
      {d && d.changes.length > 0 ? <ChangeList changes={d.changes} market={market} /> : null}
    </>
  );
}

function AddMarket({ lot, market }: { lot: LotReleaseView; market: ReleaseMarket }) {
  const q = useApiQuery(routes.release.marketAdd, { params: { lotId: lot.lotId }, query: { market } });
  const [change, setChange] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const changeRecordId = UUID.test(change.trim()) ? change.trim() : null;
  return (
    <Section title={`Add ${market} to the lot's markets`} testId={`market-add-${market}`}>
      <p>The evaluation against the recorded data, now. The addition is signed with it, under a change record.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <MarketAddEvaluation evaluation={q.data} testId={`market-add-eval-${market}`} /> : null}
      <Field name={`changeRecord-${market}`} label="Change record (id)" value={change} onChange={setChange} />
      <ActButton
        label={`Sign the addition of ${market}`}
        onPress={() =>
          changeRecordId && signed.sign({ kind: 'RELEASE_ACT', act: 'MARKET_ADD', lotId: lot.lotId, input: { market, changeRecordId } }, `Add market ${market} to lot ${lot.lotCode} under change record ${changeRecordId}`)
        }
        disabled={q.data === undefined || changeRecordId === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function RemoveMarket({ lot, market }: { lot: LotReleaseView; market: ReleaseMarket }) {
  const deviations = useApiQuery(routes.quality.deviations, { query: { batchId: lot.batchId } });
  const [deviation, setDeviation] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const deviationId = UUID.test(deviation.trim()) ? deviation.trim() : null;
  const list = deviations.data?.deviations ?? [];
  return (
    <Section title={`Remove ${market} from the lot's markets`} testId={`market-remove-${market}`}>
      <p>A removal is signed with a linked deviation record. Whether the market had failed against its own rules before the removal is recorded by the database and shown on the change.</p>
      {list.length > 0 ? (
        <floor.ChoiceGroup label="Deviation linked to the batch" options={list.map((x) => ({ value: x.deviationId, label: `${x.ref} ${x.title} (${words(x.state)})` }))} value={deviation} onChange={setDeviation} />
      ) : null}
      <Field name={`removeDeviation-${market}`} label="Deviation (id)" value={deviation} onChange={setDeviation} />
      <ActButton
        primary={false}
        label={`Sign the removal of ${market}`}
        onPress={() => deviationId && signed.sign({ kind: 'RELEASE_ACT', act: 'MARKET_REMOVE', lotId: lot.lotId, input: { market, deviationId } }, `Remove market ${market} from lot ${lot.lotCode}, deviation ${deviationId}`)}
        disabled={deviationId === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

export function ChangeList({ changes, market }: { changes: readonly MarketChangeView[]; market: string }) {
  return (
    <Section title={`Signed changes of ${market}`} testId={`market-changes-${market}`}>
      <ul>
        {changes.map((c) => (
          <li key={c.changeId} data-testid={`market-change-${c.changeId}`}>
            <StatusChip tone={c.change === 'ADD' ? 'info' : 'neutral'} label={c.change === 'ADD' ? 'Added' : 'Removed'} /> {c.market} on the {words(c.subjectKind).toLowerCase()} by {c.by.legalName} ({words(c.by.role)}), {c.at.text}
            {c.changeRecord ? `, change record ${c.changeRecord}` : ''}
            {c.deviationRef ? `, deviation ${c.deviationRef}` : ''}
            {c.removedAfterFailure ? <StatusChip tone="warning" label="Removed after failure" /> : null}
            {c.evaluation ? <MarketAddEvaluation evaluation={c.evaluation} testId={`market-change-eval-${c.changeId}`} /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
