/**
 * Vendor support grants (Phase 6 slice 6f; DI-08, D-P6f-2): IT's administrator requests a time-boxed grant for one named
 * support account; the quality unit and IT each approve it with their own signature (SUPPORT_ACT); the second approval
 * opens the window, which ends by itself. Anyone involved may end it early. A support login outside a live grant is
 * refused and logged by the database.
 */
import { useState } from 'react';
import { routes, type SupportGrantView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { SUPPORT_READS, words } from './reads.ts';

const QA_APPROVERS = /^(QA_MBR_APPROVER|AUTHORISED_PERSON)$/;
const IT_APPROVERS = /^PROCESS_OWNER$/;

export function SupportGrantsPage() {
  const q = useApiQuery(routes.support.grants);
  const role = useSessionRole();
  return (
    <>
      <h1>Vendor support grants</h1>
      <p>
        A vendor support engineer signs in only inside a grant the company approved: requested by IT for one named account, approved by the quality unit and by IT with two
        signatures of two people, and ended by itself after the hours stated. Every refused support login is logged and alerted.
      </p>
      {role === 'SYSTEM_ADMINISTRATOR' ? <RequestGrant accounts={q.data?.accounts ?? []} /> : null}
      <Section title="Grants" testId="support-grants">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.grants.length === 0 ? <p>No support grant.</p> : null}
        <ul>
          {q.data?.grants.map((g) => (
            <Grant key={g.grantId} g={g} role={role} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function Grant({ g, role }: { g: SupportGrantView; role: string | null }) {
  const signed = useSignedAct(SUPPORT_READS);
  const revoke = useCommand(routes.support.revokeGrant, SUPPORT_READS);
  const [reason, setReason] = useState('');
  const has = (kind: 'QA' | 'IT') => g.approvals.some((a) => a.kind === kind);
  const mayQa = g.state === 'PENDING' && !has('QA') && role !== null && QA_APPROVERS.test(role);
  const mayIt = g.state === 'PENDING' && !has('IT') && role !== null && IT_APPROVERS.test(role);
  const mayEnd = (g.state === 'PENDING' || g.state === 'ACTIVE') && role !== null && (QA_APPROVERS.test(role) || IT_APPROVERS.test(role) || role === 'SYSTEM_ADMINISTRATOR');
  return (
    <li data-testid={`support-grant-${g.loginName}`} data-state={g.state}>
      <p>
        <strong>{g.engineer.legalName}</strong> ({g.loginName}, {g.vendor}): {g.purpose}. {g.validHours} hours, requested by {g.requestedBy.legalName} on {g.requestedAt.text}.{' '}
        <StatusChip tone={g.state === 'ACTIVE' ? 'warning' : g.state === 'PENDING' ? 'info' : 'neutral'} label={words(g.state)} />
      </p>
      <p>
        {g.approvals.length === 0 ? 'No approval yet.' : g.approvals.map((a) => `${a.kind} approved by ${a.by.legalName} on ${a.at.text}`).join('; ')}
        {g.validFrom && g.validTo ? ` Window ${g.validFrom.text} to ${g.validTo.text}; ${g.sessions.toString()} support session(s).` : ''}
        {g.revocation ? ` Ended early by ${g.revocation.by.legalName}: ${g.revocation.reason}.` : ''}
      </p>
      {mayQa ? <ActButton label={`Approve for QA (${g.loginName})`} onPress={() => signed.sign({ kind: 'SUPPORT_ACT', act: 'QA_APPROVE', grantId: g.grantId }, `Approve vendor support for ${g.loginName}`)} disabled={signed.busy} /> : null}
      {mayIt ? <ActButton label={`Approve for IT (${g.loginName})`} onPress={() => signed.sign({ kind: 'SUPPORT_ACT', act: 'IT_APPROVE', grantId: g.grantId }, `Approve vendor support for ${g.loginName}`)} disabled={signed.busy} /> : null}
      {mayEnd ? (
        <>
          <Field name={`supportEnd-${g.grantId}`} label="Reason to end the grant now" value={reason} onChange={setReason} />
          <ActButton label="End the grant now" primary={false} onPress={() => revoke.run({ params: { grantId: g.grantId }, body: { reason: reason.trim() } })} disabled={reason.trim() === '' || revoke.busy} />
        </>
      ) : null}
      <ActResult error={signed.error ?? revoke.error} outcome={signed.outcome} done={revoke.done} label="The grant has ended." />
    </li>
  );
}

function RequestGrant({ accounts }: { accounts: readonly { accountId: string; loginName: string; engineer: { legalName: string } }[] }) {
  const request = useCommand(routes.support.requestGrant, SUPPORT_READS);
  const [account, setAccount] = useState<string | null>(null);
  const [vendor, setVendor] = useState('');
  const [purpose, setPurpose] = useState('');
  const [hours, setHours] = useState('4');
  const ok = account !== null && vendor.trim() !== '' && purpose.trim() !== '' && /^[1-9][0-9]?$/.test(hours.trim());
  return (
    <Section title="Request a support grant" testId="support-request">
      {accounts.length === 0 ? <p>No account holds the vendor support role.</p> : null}
      <floor.ChoiceGroup label="Support engineer" options={accounts.map((a) => ({ value: a.accountId, label: `${a.engineer.legalName} (${a.loginName})` }))} value={account} onChange={setAccount} />
      <Field name="supportVendor" label="Vendor" value={vendor} onChange={setVendor} />
      <Field name="supportPurpose" label="Purpose of the access" value={purpose} onChange={setPurpose} />
      <Field name="supportHours" label="Hours (the grant ends by itself)" value={hours} onChange={setHours} />
      <ActButton
        label="Request the grant"
        onPress={() => (ok && account ? request.run({ body: { accountId: account, vendor: vendor.trim(), purpose: purpose.trim(), hours: Number(hours.trim()) } }) : null)}
        disabled={!ok || request.busy}
      />
      <ActResult error={request.error} done={request.done} label="Requested: QA and IT approve it next." />
    </Section>
  );
}
