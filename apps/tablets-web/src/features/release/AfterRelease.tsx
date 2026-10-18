/**
 * The "After release" tab of the release cockpit (Phase 4 slice 5c; L-19, IN-29, PR-46, PR-57, IN-05 (e); defaults
 * D-5-1 to D-5-6), on release.afterRelease:
 *  - the manufacturer state and each market's state after release, with the state a re-confirmation restores;
 *  - the causes that suspended the lot (per market, where each was linked: the lot itself or a lot, batch or equipment
 *    upstream of it), each with the database's reason while it is not resolved;
 *  - the forward trace through the PR-57 genealogy: the finished lots downstream of this one, which a suspension of this
 *    lot suspends too;
 *  - the ERP stock-block messages and the recall-assessment and serial-decommissioning tasks;
 *  - per market, the authorised person's RECONFIRM (with an impact assessment, on G-REL for the market at the epoch
 *    shown), RECALL and REJECT_AFTER_RELEASE (each with the person's reason), each behind the server's gate;
 *  - the signed decisions so far, and the disposal (Disposal.tsx);
 *  - the shipments the ERP recorded, with the states the interlock saw (Shipments.tsx; slice 7g-5).
 * Every state, gate and meaning is the server's; the browser computes none of them, and every act goes through
 * esig.describe and the ceremony (RELEASE_ACT).
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type LotReleaseView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { GateProblems } from '../review/parts.tsx';
import { DisposalSection } from './Disposal.tsx';
import { LotShipments } from './Shipments.tsx';
import { RELEASE_READS, releaseTone, stateTone, words, type AfterReleaseMarketView, type LotAfterReleaseView } from './reads.ts';

const HEX64 = /^[0-9a-f]{64}$/;

export function AfterReleaseTab({ lot }: { lot: LotReleaseView }) {
  const q = useApiQuery(routes.release.afterRelease, { params: { lotId: lot.lotId } });
  const v = q.data;
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!v) return <p aria-busy="true">Loading the lot after release…</p>;
  return (
    <>
      <AfterRelease view={v} lot={lot} />
      <LotShipments lotId={lot.lotId} />
    </>
  );
}

function AfterRelease({ view: v, lot }: { view: LotAfterReleaseView; lot: LotReleaseView }) {
  const suspended = v.markets.filter((m) => m.state === 'RELEASE_SUSPENDED');
  return (
    <>
      <p data-testid="after-release-state">
        Manufacturer: <StatusChip tone={releaseTone(v.manufacturerState)} label={words(v.manufacturerState)} />
      </p>
      {suspended.length > 0 ? (
        <Banner tone="warning" title={`The release is suspended for ${suspended.map((m) => m.market).join(', ')}`}>
          The lot may not be shipped for these markets. Its stock is blocked in the ERP until each market is re-confirmed, recalled or rejected.
        </Banner>
      ) : null}
      <MarketStates view={v} />
      <Causes view={v} />
      <ForwardTrace view={v} />
      <Tasks view={v} />
      {v.markets.map((m) => (
        <MarketActs key={m.market} view={v} lot={lot} m={m} />
      ))}
      <Decisions view={v} />
      <DisposalSection view={v} />
    </>
  );
}

function MarketStates({ view: v }: { view: LotAfterReleaseView }) {
  return (
    <Section title="Markets after release" testId="after-release-markets">
      <ul>
        {v.markets.map((m) => (
          <li key={m.market} data-testid={`after-release-market-${m.market}`} data-state={m.state}>
            <strong>{m.market}</strong> <StatusChip tone={stateTone(m.state)} label={words(m.state)} />
            {m.priorState ? ` a re-confirmation restores ${words(m.priorState)}` : ''}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function viaLink(via: { kind: 'LOT' | 'BATCH' | 'EQUIPMENT'; id: string }, lotId: string) {
  if (via.kind === 'LOT' && via.id === lotId) return <span>this lot</span>;
  if (via.kind === 'LOT')
    return (
      <Link to="/release/$lotId" params={{ lotId: via.id }}>
        lot upstream {via.id}
      </Link>
    );
  if (via.kind === 'BATCH')
    return (
      <Link to="/review/$batchId" params={{ batchId: via.id }}>
        batch {via.id}
      </Link>
    );
  return <span>equipment {via.id}</span>;
}

function Causes({ view: v }: { view: LotAfterReleaseView }) {
  return (
    <Section title="What suspended the lot" testId="suspension-causes">
      {v.causes.length === 0 ? <p>No cause has suspended this lot.</p> : null}
      <ul>
        {v.causes.map((c) => (
          <li key={c.suspensionId} data-testid={`suspension-cause-${c.suspensionId}`} data-covered={String(c.covered)}>
            <strong>{c.market}</strong> {words(c.causeKind)}:{' '}
            {c.causeKind === 'DEVIATION' ? (
              <Link to="/quality/deviations/$deviationId" params={{ deviationId: c.causeRef }}>
                {c.label}
              </Link>
            ) : (
              c.label
            )}{' '}
            (linked to {viaLink(c.via, v.lotId)}), suspended {c.suspendedAt.text}, the market was {words(c.priorState)}.{' '}
            {c.covered ? <StatusChip tone="ok" label="Covered by a re-confirmation" /> : c.problem ? <StatusChip tone="warning" label="Not resolved" /> : <StatusChip tone="info" label="Resolved" />}
            {c.problem && !c.covered ? <p>{c.problem}</p> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** PR-57 forward trace: the lots made downstream of this one, which a suspension of this lot suspends too (D-5-2). */
function ForwardTrace({ view: v }: { view: LotAfterReleaseView }) {
  return (
    <Section title="Affected lots downstream (forward trace)" testId="forward-trace">
      {v.downstream.length === 0 ? (
        <p>No finished lot was made from this lot.</p>
      ) : (
        <>
          <p>These finished lots were made from this lot (genealogy). A suspension of this lot suspends their released markets too; each is decided on its own page.</p>
          <ul>
            {v.downstream.map((d) => (
              <li key={d.lotId} data-testid={`downstream-${d.lotCode}`}>
                <Link to="/release/$lotId" params={{ lotId: d.lotId }} search={{ tab: 'AFTER' }}>
                  {d.lotCode}
                </Link>{' '}
                <StatusChip tone={stateTone(d.state)} label={words(d.state)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function Tasks({ view: v }: { view: LotAfterReleaseView }) {
  if (v.tasks.length === 0 && v.stockBlocks.length === 0) return null;
  return (
    <Section title="Recall assessment, tasks and ERP stock" testId="after-release-tasks">
      <ul>
        {v.tasks.map((t) => (
          <li key={t.taskId} data-testid={`task-${t.kind}`}>
            {words(t.kind)} for the {words(t.ownerRole).toLowerCase()} <StatusChip tone={stateTone(t.status)} label={words(t.status)} /> opened {t.openedAt.text}
            {t.closedAt ? `, closed ${t.closedAt.text}` : ''}
          </li>
        ))}
        {v.stockBlocks.map((b) => (
          <li key={b.requestId} data-testid={`stock-${b.kind}`}>
            ERP stock {b.kind === 'BLOCK' ? 'block' : 'unblock'} ({b.causeKey}) requested {b.requestedAt.text}:{' '}
            {b.deliveredAt ? `applied by the ERP ${b.deliveredAt.text}` : <StatusChip tone="pending" label="Waiting for the ERP" />}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The AP's acts for one market, offered while the market is suspended or decided (the gates are the server's). Offered
 * to the authorised person only: the database refuses an after-release decision signed in any other role (EBMR-ARL-015).
 */
function MarketActs({ view: v, lot, m }: { view: LotAfterReleaseView; lot: LotReleaseView; m: AfterReleaseMarketView }) {
  const offered = useSessionRole() === 'AUTHORISED_PERSON';
  const anyGate = m.gates.reconfirm.ready || m.gates.recall.ready || m.gates.rejectAfterRelease.ready;
  if (!offered || (m.state !== 'RELEASE_SUSPENDED' && !anyGate)) return null;
  return (
    <Section title={`Decide market ${m.market} after release`} testId={`after-release-acts-${m.market}`}>
      {m.state === 'RELEASE_SUSPENDED' ? <Reconfirm view={v} lot={lot} m={m} /> : null}
      <Terminal view={v} m={m} act="RECALL" />
      <Terminal view={v} m={m} act="REJECT_AFTER_RELEASE" />
    </Section>
  );
}

/** D-5-4: re-confirm on G-REL for the market as it stands now, with the person's impact assessment. */
function Reconfirm({ view: v, lot, m }: { view: LotAfterReleaseView; lot: LotReleaseView; m: AfterReleaseMarketView }) {
  const grel = useApiQuery(routes.release.grel, { params: { lotId: lot.lotId }, query: { market: m.market } });
  const [text, setText] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const epoch = grel.data && HEX64.test(grel.data.epoch) ? grel.data.epoch : null;
  const assessment = text.trim() === '' ? null : text.trim();
  const gate = m.gates.reconfirm;
  return (
    <div data-testid={`reconfirm-${m.market}`}>
      <h3>Re-confirm {m.market}</h3>
      <GateProblems gate={gate} testId={`reconfirm-${m.market}-problems`} />
      {grel.error ? <RefusalMessage error={grel.error.error} /> : null}
      {grel.data ? (
        <p>
          G-REL for {m.market} now: {grel.data.ready ? 'no item is red' : 'some items are red'}, evidence epoch {grel.data.epoch}. A change after you read it refuses the signature.
          {m.priorState ? ` The market returns to ${words(m.priorState)}.` : ''}
        </p>
      ) : null}
      <Field name={`reconfirmText-${m.market}`} label="Impact assessment" value={text} onChange={setText} isDisabled={!gate.ready} />
      <ActButton
        label={`Sign the re-confirmation of ${m.market}`}
        onPress={() =>
          epoch &&
          assessment &&
          signed.sign(
            { kind: 'RELEASE_ACT', act: 'RECONFIRM', lotId: v.lotId, input: { market: m.market, expectedEpoch: epoch, text: assessment } },
            `Re-confirm lot ${v.lotCode} for ${m.market} at evidence epoch ${epoch}: ${assessment}`,
          )
        }
        disabled={!gate.ready || epoch === null || assessment === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </div>
  );
}

/** D-5-5: RECALL or REJECT_AFTER_RELEASE, terminal, with the person's reason. */
function Terminal({ view: v, m, act }: { view: LotAfterReleaseView; m: AfterReleaseMarketView; act: 'RECALL' | 'REJECT_AFTER_RELEASE' }) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const gate = act === 'RECALL' ? m.gates.recall : m.gates.rejectAfterRelease;
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  const what = act === 'RECALL' ? 'recall' : 'rejection after release';
  const id = `${act === 'RECALL' ? 'recall' : 'reject-after-release'}-${m.market}`;
  return (
    <div data-testid={id}>
      <h3>{act === 'RECALL' ? `Recall from ${m.market}` : `Reject for ${m.market} after release`}</h3>
      <GateProblems gate={gate} testId={`${id}-problems`} />
      <p>{act === 'RECALL' ? 'A recall is final for the market and is written to the lot\'s events.' : 'A rejection after release is final for the market; the lot then goes to disposal.'}</p>
      <Field name={`${id}-code`} label="Reason code" value={code} onChange={setCode} isDisabled={!gate.ready} />
      <Field name={`${id}-text`} label={`Reason for the ${what}`} value={text} onChange={setText} isDisabled={!gate.ready} />
      <ActButton
        primary={false}
        label={act === 'RECALL' ? `Sign the recall from ${m.market}` : `Sign the rejection for ${m.market}`}
        onPress={() =>
          reason &&
          signed.sign(
            { kind: 'RELEASE_ACT', act, lotId: v.lotId, input: { market: m.market, reason } },
            `${act === 'RECALL' ? 'Recall' : 'Reject after release'} lot ${v.lotCode} for ${m.market}: ${reason.text}`,
          )
        }
        disabled={!gate.ready || reason === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </div>
  );
}

function Decisions({ view: v }: { view: LotAfterReleaseView }) {
  if (v.decisions.length === 0) return null;
  return (
    <Section title="Signed decisions after release" testId="after-release-decisions">
      <ul>
        {v.decisions.map((d) => (
          <li key={d.decisionId} data-testid={`after-release-decision-${d.market}-${d.act}`}>
            <strong>{d.market}</strong> {words(d.act)}: <StatusChip tone={stateTone(d.toState)} label={words(d.toState)} /> by {d.by.legalName} ({words(d.by.role)}), {d.at.text}: {d.text}
            {d.epoch ? ` (evidence epoch ${d.epoch})` : ''}
          </li>
        ))}
      </ul>
    </Section>
  );
}

