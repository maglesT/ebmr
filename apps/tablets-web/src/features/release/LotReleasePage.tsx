/**
 * One finished lot in the release cockpit (Phase 4 slice 3; outline 5.2.6, 5.2.7, 7.3), manufacturer tab:
 *  - G-REL for market IN, the manufacturer release checklist: each item green, red or not applicable, with the database's
 *    reason when red and links to the evidence it rests on;
 *  - the "since review" list: items whose evidence changed after the QA review, acknowledged by the signer one by one at
 *    the epoch shown (release.acknowledge; a later change needs a new acknowledgement);
 *  - DI-12 incidents and PR-08 registration-relevant deviations, as the server lists them;
 *  - the QA acts the release may wait for: the post-change evaluation (IN-03), the PPQ outcome (PR-09) and, only while
 *    the PR-53 switch is on, the justification of an open investigation;
 *  - the manufacturer release (with the checklist shown and the epoch the signer saw) or rejection (with the person's
 *    reason), each through esig.describe and the ceremony (RELEASE_ACT); the decision once recorded;
 *  - the notifications of the decision to production and QA (IN-39 clause 2);
 *  - slice 4: the US, EU and India tabs (MarketTabs.tsx);
 *  - Phase 6 slice 6d: the recurrence warning of the lot's deviations above every tab (PR-49, genealogy.recurrence);
 *  - slice 5: the "After release" tab (AfterRelease.tsx, Disposal.tsx): suspension causes, forward trace, the AP's
 *    re-confirmation, recall and rejection after release per market, and the disposal (opened by `?tab=AFTER`).
 * Every gate, state, item status and meaning is the server's; the browser computes none of them.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type LotReleaseView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams, useRouteSearch } from '../floor/params.ts';
import { GateProblems } from '../review/parts.tsx';
import { NotificationList } from '../notifications/NotificationList.tsx';
import { RecurrenceWarning } from '../genealogy/RecurrenceWarning.tsx';
import { AfterReleaseTab } from './AfterRelease.tsx';
import { IndiaTab, MarketTab } from './MarketTabs.tsx';
import { GrelChecklist, SinceReview } from './parts.tsx';
import { itemWord, RELEASE_READS, releaseTone, words } from './reads.ts';

export function LotReleasePage() {
  const lotId = useRouteParams()['lotId'] ?? '';
  const q = useApiQuery(routes.release.lot, { params: { lotId } });
  const v = q.data;
  return (
    <>
      <h1>Release of lot {v ? v.lotCode : lotId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <LotRelease view={v} /> : null}
    </>
  );
}

type Tab = 'MANUFACTURER' | 'US' | 'EU' | 'IN' | 'AFTER';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'MANUFACTURER', label: 'Manufacturer (market IN checklist)' },
  { id: 'US', label: 'US' },
  { id: 'EU', label: 'EU' },
  { id: 'IN', label: 'India' },
  { id: 'AFTER', label: 'After release' },
];

function LotRelease({ view: v }: { view: LotReleaseView }) {
  const wanted = useRouteSearch()['tab'];
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t.id === wanted)?.id ?? 'MANUFACTURER');
  return (
    <>
      <p data-testid="release-state">
        <StatusChip tone={releaseTone(v.state)} label={words(v.state)} /> {v.productCode} {v.strength} · batch{' '}
        <Link to="/review/$batchId" params={{ batchId: v.batchId }}>
          {v.batchNumber}
        </Link>{' '}
        · lot {words(v.lotStatus)} · markets {v.markets.join(', ')}
      </p>
      <RecurrenceWarning lotId={v.lotId} />
      <div role="tablist" aria-label="Release of the lot">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            data-testid={t.id === 'MANUFACTURER' ? 'tab-manufacturer' : `tab-${t.id.toLowerCase()}`}
            onClick={() => setTab(t.id)}
            style={{ fontWeight: tab === t.id ? 700 : 400, marginInlineEnd: '0.5rem' }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} aria-label={TABS.find((t) => t.id === tab)?.label}>
        {tab === 'MANUFACTURER' ? <ManufacturerTab view={v} /> : tab === 'IN' ? <IndiaTab lot={v} /> : tab === 'AFTER' ? <AfterReleaseTab lot={v} /> : <MarketTab lot={v} market={tab} />}
      </div>
    </>
  );
}

function ManufacturerTab({ view: v }: { view: LotReleaseView }) {
  const qa = useOffered('QA');
  return (
    <>
      {/* R10 #6: once the decision is recorded it leads the tab and nothing of the decision is offered again (the
          acknowledgements, evaluations and justifications serve the decision; evidence that changes afterwards, such as
          the record locked at release, is the After release tab's). */}
      {v.decision ? <Decision view={v} /> : null}
      <GrelChecklist grel={v.grel} title="Release checklist (G-REL, market IN)" testId="grel-checklist" />
      {v.decision ? null : <SinceReview lotId={v.lotId} grel={v.grel} />}
      <Flags view={v} />
      {!v.decision && v.postChange.length > 0 ? <PostChange view={v} offered={qa} /> : null}
      {!v.decision && v.validationBatches.length > 0 ? <PpqOutcome view={v} offered={qa} /> : null}
      {!v.decision && v.openInvestigationPath ? <Justifications view={v} offered={qa} /> : null}
      {v.decision ? null : <ReleaseDecision view={v} offered={qa} />}
      <Section title="Notifications of the decision" testId="lot-notifications">
        <NotificationList subjectId={v.lotId} empty="No notification yet: production and QA are notified when the decision is signed." />
      </Section>
    </>
  );
}

function Flags({ view: v }: { view: LotReleaseView }) {
  if (v.incidents.length === 0 && v.registrationRelevant.length === 0) return null;
  return (
    <>
      {v.incidents.length > 0 ? (
        <Banner tone="warning" title="Incidents linked to the batches of this lot (DI-12)">
          <ul data-testid="release-incidents">
            {v.incidents.map((i) => (
              <li key={i.incidentId}>
                {i.number}: {words(i.severity)}, {words(i.status)}, {i.assessed ? 'assessed for this lot' : 'not yet assessed for this lot'}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {v.registrationRelevant.length > 0 ? (
        <Banner tone="warning" title="Registration-relevant deviations (PR-08)">
          <ul data-testid="release-registration-relevant">
            {v.registrationRelevant.map((r) => (
              <li key={`${r.batchId}:${r.exceptionId}`}>
                {r.title} ({r.exceptionId}){r.deviationRef ? `, deviation ${r.deviationRef}` : ', no deviation linked'}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
    </>
  );
}

function PostChange({ view: v, offered }: { view: LotReleaseView; offered: boolean }) {
  const [text, setText] = useState<Record<string, string>>({});
  const signed = useSignedAct(RELEASE_READS);
  return (
    <Section title="Post-change evaluation (IN-03)" testId="post-change">
      <ul>
        {v.postChange.map((p) => {
          const t = (text[p.batchId] ?? '').trim();
          return (
            <li key={p.batchId} data-testid={`post-change-${p.batchNumber}`}>
              Batch {p.batchNumber}, first under change {p.changeRecord}: {p.evaluated ? <StatusChip tone="ok" label="Evaluated by QA" /> : <StatusChip tone="pending" label="Not evaluated yet" />}
              {!p.evaluated && offered ? (
                <>
                  <Field name={`postChange-${p.batchId}`} label={`Evaluation of batch ${p.batchNumber}`} value={text[p.batchId] ?? ''} onChange={(x) => setText({ ...text, [p.batchId]: x })} />
                  <ActButton
                    label={`Sign the post-change evaluation of ${p.batchNumber}`}
                    onPress={() => signed.sign({ kind: 'RELEASE_ACT', act: 'POST_CHANGE_EVALUATE', lotId: v.lotId, input: { batchId: p.batchId, text: t } }, `Post-change evaluation of batch ${p.batchNumber} (${p.changeRecord})`)}
                    disabled={t === '' || signed.busy}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

const OUTCOMES = ['PASSED', 'FAILED', 'CONCURRENT_RELEASE'] as const;

function PpqOutcome({ view: v, offered }: { view: LotReleaseView; offered: boolean }) {
  const [form, setForm] = useState<Record<string, { outcome: string; protocolRef: string; text: string }>>({});
  const signed = useSignedAct(RELEASE_READS);
  return (
    <Section title="Validation batches (PR-09)" testId="ppq">
      <ul>
        {v.validationBatches.map((b) => {
          const f = form[b.batchId] ?? { outcome: '', protocolRef: '', text: '' };
          const set = (patch: Partial<typeof f>) => setForm({ ...form, [b.batchId]: { ...f, ...patch } });
          const outcome = OUTCOMES.find((o) => o === f.outcome);
          const ready = outcome !== undefined && f.protocolRef.trim() !== '' && f.text.trim() !== '';
          return (
            <li key={b.batchId} data-testid={`ppq-${b.batchNumber}`}>
              Batch {b.batchNumber} ({b.purpose}): {b.outcome ? <StatusChip tone="info" label={`Outcome ${words(b.outcome)}`} /> : <StatusChip tone="pending" label="Outcome not recorded" />}
              {!b.outcome && offered ? (
                <>
                  <floor.ChoiceGroup label="Validation outcome" options={OUTCOMES.map((o) => ({ value: o, label: words(o) }))} value={f.outcome} onChange={(x) => set({ outcome: x })} />
                  <Field name={`ppqProtocol-${b.batchId}`} label="Protocol (and report)" value={f.protocolRef} onChange={(x) => set({ protocolRef: x })} />
                  <Field name={`ppqText-${b.batchId}`} label="Outcome statement" value={f.text} onChange={(x) => set({ text: x })} />
                  <ActButton
                    label={`Sign the PPQ outcome of ${b.batchNumber}`}
                    onPress={() =>
                      outcome &&
                      signed.sign(
                        { kind: 'RELEASE_ACT', act: 'PPQ_OUTCOME', lotId: v.lotId, input: { batchId: b.batchId, outcome, protocolRef: f.protocolRef.trim(), text: f.text.trim() } },
                        `Validation outcome ${words(outcome)} of batch ${b.batchNumber} under ${f.protocolRef.trim()}`,
                      )
                    }
                    disabled={!ready || signed.busy}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function Justifications({ view: v, offered }: { view: LotReleaseView; offered: boolean }) {
  const [text, setText] = useState<Record<string, string>>({});
  const signed = useSignedAct(RELEASE_READS);
  // The open investigations are the deviations the red items name as their evidence (the server's list).
  const open = v.grel.items.filter((i) => i.status === 'RED').flatMap((i) => i.evidence.filter((e) => e.kind === 'DEVIATION'));
  const unique = open.filter((e, n) => open.findIndex((x) => x.ref === e.ref) === n);
  return (
    <Section title="Open investigations (PR-53)" testId="investigation-justify">
      <p>The open-investigation path is on: an open investigation may be released under your signed justification; the database refuses it where it is not allowed.</p>
      {unique.length === 0 ? <p>No open investigation is listed.</p> : null}
      <ul>
        {unique.map((d) => {
          const t = (text[d.ref] ?? '').trim();
          return (
            <li key={d.ref}>
              {d.label || d.ref}
              {offered ? (
                <>
                  <Field name={`justify-${d.ref}`} label={`Justification for ${d.label || d.ref}`} value={text[d.ref] ?? ''} onChange={(x) => setText({ ...text, [d.ref]: x })} />
                  <ActButton
                    label={`Sign the justification for ${d.label || d.ref}`}
                    onPress={() => signed.sign({ kind: 'RELEASE_ACT', act: 'INVESTIGATION_JUSTIFY', lotId: v.lotId, input: { deviationId: d.ref, text: t } }, `Release of lot ${v.lotCode} with ${d.label || d.ref} still open: ${t}`)}
                    disabled={t === '' || signed.busy}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function ReleaseDecision({ view: v, offered }: { view: LotReleaseView; offered: boolean }) {
  const [delegation, setDelegation] = useState('');
  const [code, setCode] = useState('');
  const [reasonText, setReasonText] = useState('');
  const release = useSignedAct(RELEASE_READS);
  const reject = useSignedAct(RELEASE_READS);
  if (!offered) return null;
  const g = v.grel;
  const delegationId = delegation.trim() === '' ? {} : { delegationId: delegation.trim() };
  // The person's own reason, both halves (DI-22): nothing is filled in for them.
  const reason = code.trim() && reasonText.trim() ? { code: code.trim(), text: reasonText.trim() } : null;
  const epochSigned = /^[0-9a-f]{64}$/.test(g.epoch) ? g.epoch : null;
  return (
    <>
      <Section title="Manufacturer release" testId="manufacturer-release">
        <GateProblems gate={v.gates.release} testId="release-problems" />
        <p>You sign the checklist below as it stands now (evidence epoch {g.epoch}); a change after you read it refuses the signature.</p>
        <ol data-testid="release-checklist" aria-label="The checklist you sign">
          {g.items.map((i) => (
            <li key={i.id}>
              {itemWord(i.status)}: {i.id} {i.title}
            </li>
          ))}
        </ol>
        <Field name="delegationId" label="Delegation (only when you sign as a named delegate of the authorised person)" value={delegation} onChange={setDelegation} />
        <ActButton
          label="Sign the manufacturer release"
          onPress={() =>
            epochSigned &&
            release.sign({ kind: 'RELEASE_ACT', act: 'MANUFACTURER_RELEASE', lotId: v.lotId, input: { expectedEpoch: epochSigned, ...delegationId } }, `Release lot ${v.lotCode} (batch ${v.batchNumber}) for the manufacturer, checklist at evidence epoch ${g.epoch}`)
          }
          disabled={!v.gates.release.ready || epochSigned === null || release.busy}
        />
        <ActResult error={release.error} outcome={release.outcome} />
      </Section>
      <Section title="Manufacturer rejection" testId="manufacturer-reject">
        <GateProblems gate={v.gates.reject} testId="reject-problems" />
        <p>The rejection is signed on the checklist above as it stands now (evidence epoch {g.epoch}).</p>
        <Field name="rejectCode" label="Reason code" value={code} onChange={setCode} isDisabled={!v.gates.reject.ready} />
        <Field name="rejectText" label="Reason for the rejection" value={reasonText} onChange={setReasonText} isDisabled={!v.gates.reject.ready} />
        <ActButton
          primary={false}
          label="Sign the rejection"
          onPress={() =>
            reason &&
            epochSigned &&
            reject.sign({ kind: 'RELEASE_ACT', act: 'MANUFACTURER_REJECT', lotId: v.lotId, input: { expectedEpoch: epochSigned, reason, ...delegationId } }, `Reject lot ${v.lotCode} (batch ${v.batchNumber}) at evidence epoch ${g.epoch}: ${reason.text}`)
          }
          disabled={!v.gates.reject.ready || reason === null || epochSigned === null || reject.busy}
        />
        <ActResult error={reject.error} outcome={reject.outcome} />
      </Section>
    </>
  );
}

function Decision({ view: v }: { view: LotReleaseView }) {
  const d = v.decision;
  if (!d) return null;
  return (
    <Section title="Manufacturer decision" testId="release-decision">
      <p>
        <StatusChip tone={d.decision === 'RELEASED' ? 'ok' : 'error'} label={words(d.decision)} /> by {d.by.legalName} ({words(d.by.role)}) on {d.at.text}
        {d.delegationId ? ', as a named delegate' : ''}
        {d.reason ? `: ${d.reason}` : ''}
      </p>
      <p>
        Checklist signed at evidence epoch {d.epoch}, checklist hash {d.checklistHash}.
      </p>
      {d.justifications.length > 0 ? (
        <ul aria-label="Open investigations released under a justification">
          {d.justifications.map((j) => (
            <li key={j.signatureId}>{j.text}</li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
