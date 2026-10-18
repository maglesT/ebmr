/**
 * Access recertification and break-glass (Phase 7 slice 7g-1, decision 0025):
 *  - recertification (people.recertification, people.recertify): the process owner confirms that each account due still
 *    needs its grants, or revokes them all (IAM.ACCESS_RECERTIFY; nobody recertifies their own access);
 *  - break-glass (people.breakGlass and its acts): the holder of a sealed break-glass account requests a time-limited
 *    window (SYSTEM.CONFIGURE), a second person approves it (IAM.BREAK_GLASS_APPROVE; never the requester) and reviews it
 *    after it ends. Every use raises a critical alert; a break-glass account never signs and never does GMP work.
 */
import { useState } from 'react';
import { routes, type BreakGlassWindowView, type RecertificationDueView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { BREAK_GLASS_READS, offeredTo, PROCESS_OWNERS, RECERT_READS, Row, Select, useSessionPerson, words } from './shared.tsx';

export function RecertificationPage() {
  const q = useApiQuery(routes.people.recertification);
  const role = useSessionRole();
  const owner = offeredTo(role, PROCESS_OWNERS);
  const due = (q.data?.due ?? []).filter((d) => d.overdue);
  const later = (q.data?.due ?? []).filter((d) => !d.overdue);
  return (
    <>
      <h1>Access recertification</h1>
      <p>The process owner confirms, account by account, that each grant is still needed, or revokes them. The periodic evaluation pack lists the recertifications of its period.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Due now" testId="recert-due">
        {q.data && due.length === 0 ? <p>No account is due.</p> : null}
        <ul>
          {due.map((d) => (
            <Due key={d.accountId} d={d} owner={owner} />
          ))}
        </ul>
      </Section>
      <Section title="Due later" testId="recert-later">
        <ul>
          {later.map((d) => (
            <Due key={d.accountId} d={d} owner={owner} />
          ))}
        </ul>
      </Section>
      <Section title="Recent recertifications" testId="recert-recent">
        <ul>
          {(q.data?.recent ?? []).map((r) => (
            <li key={r.recertificationId}>
              {r.loginName}: {words(r.outcome)} by {r.reviewer.legalName} on {r.recordedAt.text} ({r.grantsReviewed} grant(s)): {r.comment}.
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Due({ d, owner }: { d: RecertificationDueView; owner: boolean }) {
  const recertify = useCommand(routes.people.recertify, RECERT_READS);
  const [comment, setComment] = useState('');
  const c = comment.trim();
  return (
    <li data-testid={`recert-${d.loginName}`}>
      <p>
        {d.person.legalName} ({d.loginName}): {d.roles.length === 0 ? 'no live grant' : d.roles.join(', ')}. Due {d.dueAt.text}
        {d.lastRecertifiedAt ? `, last recertified ${d.lastRecertifiedAt.text}` : ', never recertified'}. {d.overdue ? <StatusChip tone="warning" label="Overdue" /> : null}
      </p>
      {owner ? (
        <>
          <Field name={`recert-${d.accountId}`} label={`Comment (${d.loginName})`} value={comment} onChange={setComment} />
          <Row>
            <ActButton label={`Confirm the access of ${d.loginName}`} disabled={c === '' || recertify.busy} onPress={() => recertify.run({ params: { accountId: d.accountId }, body: { outcome: 'CONFIRMED', comment: c } })} />
            <ActButton primary={false} label={`Revoke every grant of ${d.loginName}`} disabled={c === '' || recertify.busy} onPress={() => recertify.run({ params: { accountId: d.accountId }, body: { outcome: 'REVOKED', comment: c } })} />
          </Row>
        </>
      ) : null}
      <ActResult error={recertify.error} done={recertify.done} label="Recertified." />
    </li>
  );
}

export function BreakGlassPage() {
  const q = useApiQuery(routes.people.breakGlass);
  const people = useApiQuery(routes.people.directory);
  const role = useSessionRole();
  const me = useSessionPerson();
  const mine = (people.data?.people ?? []).filter((p) => p.personId === me).flatMap((p) => p.accounts.filter((a) => a.breakGlass && a.status === 'ACTIVE'));
  return (
    <>
      <h1>Break-glass access</h1>
      <p>
        A break-glass account is sealed: it signs in only inside a window its holder requested and a second person approved, for the minutes stated. Every use raises a critical alert;
        it never signs and never does GMP work, and each window is reviewed after it ends.
      </p>
      {mine.length > 0 ? <RequestWindow accounts={mine} /> : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Windows" testId="break-glass-windows">
        {q.data && q.data.windows.length === 0 ? <p>No break-glass window.</p> : null}
        <ul>
          {q.data?.windows.map((w) => (
            <Window key={w.windowId} w={w} owner={offeredTo(role, PROCESS_OWNERS)} me={me} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function RequestWindow({ accounts }: { accounts: readonly { accountId: string; loginName: string }[] }) {
  const request = useCommand(routes.people.requestBreakGlass, BREAK_GLASS_READS);
  const [account, setAccount] = useState(accounts.length === 1 ? (accounts[0]?.accountId ?? '') : '');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('30');
  const ok = account !== '' && reason.trim() !== '' && /^[1-9][0-9]{0,3}$/.test(minutes.trim());
  return (
    <Section title="Request a window for your break-glass account" testId="break-glass-request">
      <Select name="bgAccount" label="Your break-glass account" value={account} onChange={setAccount} options={accounts.map((a) => ({ value: a.accountId, label: a.loginName }))} />
      <Field name="bgReason" label="Why the window is needed" value={reason} onChange={setReason} />
      <Field name="bgMinutes" label="Minutes (the policy sets the longest window)" value={minutes} onChange={setMinutes} inputMode="numeric" />
      <ActButton label="Request the window" disabled={!ok || request.busy} onPress={() => (ok ? request.run({ body: { accountId: account, reason: reason.trim(), minutes: Number(minutes.trim()) } }) : null)} />
      <ActResult error={request.error} done={request.done} label="Requested: a second person approves it." />
    </Section>
  );
}

function Window({ w, owner, me }: { w: BreakGlassWindowView; owner: boolean; me: string | null }) {
  const approve = useCommand(routes.people.approveBreakGlass, BREAK_GLASS_READS);
  const review = useCommand(routes.people.reviewBreakGlass, BREAK_GLASS_READS);
  const [text, setText] = useState('');
  const t = text.trim();
  const notMine = me !== w.requestedBy.personId;
  return (
    <li data-testid={`break-glass-${w.loginName}`} data-state={w.state}>
      <p>
        {w.holder.legalName} ({w.loginName}), {w.minutes} minutes: {w.reason}. Requested by {w.requestedBy.legalName} on {w.requestedAt.text}.{' '}
        <StatusChip tone={w.state === 'OPEN' ? 'warning' : w.state === 'REQUESTED' ? 'pending' : 'neutral'} label={words(w.state)} />
      </p>
      <p>
        {w.approvedBy && w.approvedAt ? `Approved by ${w.approvedBy.legalName} on ${w.approvedAt.text}${w.validTo ? `; open until ${w.validTo.text}` : ''}.` : 'Not approved yet.'}
        {w.review ? ` Reviewed by ${w.review.by.legalName} on ${w.review.at.text}: ${words(w.review.outcome)}, ${w.review.comment}.` : ''}
      </p>
      {owner && notMine && (w.state === 'REQUESTED' || w.state === 'ENDED') ? (
        <>
          <Field name={`bg-${w.windowId}`} label={w.state === 'REQUESTED' ? `Reason for the approval (${w.loginName})` : `Review of the window (${w.loginName})`} value={text} onChange={setText} />
          <Row>
            {w.state === 'REQUESTED' ? <ActButton label={`Approve the window for ${w.loginName}`} disabled={t === '' || approve.busy} onPress={() => approve.run({ params: { windowId: w.windowId }, body: { reason: t } })} /> : null}
            {w.state === 'ENDED' ? (
              <>
                <ActButton label="Reviewed: no findings" disabled={t === '' || review.busy} onPress={() => review.run({ params: { windowId: w.windowId }, body: { outcome: 'NO_FINDINGS', comment: t } })} />
                <ActButton primary={false} label="Reviewed: findings raised" disabled={t === '' || review.busy} onPress={() => review.run({ params: { windowId: w.windowId }, body: { outcome: 'FINDINGS_RAISED', comment: t } })} />
              </>
            ) : null}
          </Row>
        </>
      ) : null}
      <ActResult error={approve.error ?? review.error} done={approve.done ?? review.done} label="Saved." />
    </li>
  );
}
