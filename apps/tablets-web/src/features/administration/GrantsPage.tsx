/**
 * Role grants (Phase 7 slice 7g-1, decision 0025; routes people.grants, requestGrant, decideGrant, revokeGrant): the
 * system administrator requests a role for an account and scope; a second person (the process owner) approves or refuses
 * it. The page never offers a decision on a grant the signed-in person requested or would receive, and the database
 * refuses it anyway (EBMR-IAM-032), as it refuses an administration role for a holder of a GMP role (INV-11) and the
 * rest of DI-14 to DI-18; its words are shown as they are.
 */
import { useState } from 'react';
import { routes, type GrantView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { ADMINISTRATORS, GRANT_APPROVERS, GRANT_READS, offeredTo, Row, Select, useSessionPerson, words } from './shared.tsx';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function GrantsPage() {
  const q = useApiQuery(routes.people.grants);
  const role = useSessionRole();
  const me = useSessionPerson();
  const requested = (q.data?.grants ?? []).filter((g) => g.status === 'REQUESTED');
  const decided = (q.data?.grants ?? []).filter((g) => g.status !== 'REQUESTED');
  return (
    <>
      <h1>Role grants</h1>
      <p>
        A role is granted to an account for a scope. One person requests it, a second approves it, and the grantee is a third. Nobody holds an administration role and a GMP role at once,
        through any of their accounts; the database refuses it at the request and again at the approval.
      </p>
      {offeredTo(role, ADMINISTRATORS) ? <RequestGrant roles={q.data?.roles ?? []} /> : null}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Waiting for a decision" testId="grants-requested">
        {q.data && requested.length === 0 ? <p>No grant is waiting.</p> : null}
        <ul>
          {requested.map((g) => (
            <Grant key={g.grantId} g={g} role={role} me={me} />
          ))}
        </ul>
      </Section>
      <Section title="Decided" testId="grants-decided">
        <ul>
          {decided.map((g) => (
            <Grant key={g.grantId} g={g} role={role} me={me} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function Grant({ g, role, me }: { g: GrantView; role: string | null; me: string | null }) {
  const decide = useCommand(routes.people.decideGrant, GRANT_READS);
  const revoke = useCommand(routes.people.revokeGrant, GRANT_READS);
  const [reason, setReason] = useState('');
  const r = reason.trim();
  // Segregation of duties, shown as the database keeps it: never the requester, never the grantee.
  const mine = me !== null && (g.requestedBy.personId === me || g.grantee.personId === me);
  const mayDecide = g.status === 'REQUESTED' && offeredTo(role, GRANT_APPROVERS) && !mine;
  const mayRevoke = g.live && offeredTo(role, ADMINISTRATORS) && me !== g.grantee.personId;
  const scope = [g.scope.site, g.scope.area, g.scope.product].filter((x) => x !== null).join(' / ');
  return (
    <li data-testid={`grant-${g.loginName}-${g.roleCode}`} data-status={g.status}>
      <p>
        <strong>{g.roleCode}</strong> ({g.roleName}) for {g.grantee.legalName} ({g.loginName}){scope ? `, scope ${scope}` : ', all scopes'}.{' '}
        <StatusChip tone={g.live ? 'ok' : g.status === 'REQUESTED' ? 'pending' : 'neutral'} label={g.live ? 'Live' : words(g.status)} />
      </p>
      <p>
        Requested by {g.requestedBy.legalName} on {g.requestedAt.text}: {g.reason}.
        {g.decidedBy && g.decidedAt ? ` ${g.status === 'REJECTED' ? 'Refused' : 'Approved'} by ${g.decidedBy.legalName} on ${g.decidedAt.text}${g.decisionReason ? `: ${g.decisionReason}` : ''}.` : ''}
        {g.revokedBy && g.revokedAt ? ` Revoked by ${g.revokedBy.legalName} on ${g.revokedAt.text}: ${g.revocationReason ?? ''}.` : ''}
        {g.validTo ? ` Valid to ${g.validTo.text}.` : ''}
      </p>
      {g.status === 'REQUESTED' && mine ? <p>You requested this grant or would receive it, so a second person decides it.</p> : null}
      {mayDecide || mayRevoke ? (
        <>
          <Field name={`grantReason-${g.grantId}`} label={`Reason (${g.roleCode} for ${g.loginName})`} value={reason} onChange={setReason} />
          <Row>
            {mayDecide ? <ActButton label={`Approve ${g.roleCode} for ${g.loginName}`} disabled={r === '' || decide.busy} onPress={() => decide.run({ params: { grantId: g.grantId }, body: { approve: true, reason: r } })} /> : null}
            {mayDecide ? <ActButton primary={false} label={`Refuse ${g.roleCode} for ${g.loginName}`} disabled={r === '' || decide.busy} onPress={() => decide.run({ params: { grantId: g.grantId }, body: { approve: false, reason: r } })} /> : null}
            {mayRevoke ? <ActButton primary={false} label={`Revoke ${g.roleCode} of ${g.loginName}`} disabled={r === '' || revoke.busy} onPress={() => revoke.run({ params: { grantId: g.grantId }, body: { reason: r } })} /> : null}
          </Row>
        </>
      ) : null}
      <ActResult error={decide.error ?? revoke.error} done={decide.done ?? revoke.done} label="Decided." />
    </li>
  );
}

function RequestGrant({ roles }: { roles: readonly { code: string; name: string; accountKinds: readonly string[] }[] }) {
  const request = useCommand(routes.people.requestGrant, GRANT_READS);
  const people = useApiQuery(routes.people.directory);
  const [account, setAccount] = useState('');
  const [role, setRole] = useState('');
  const [site, setSite] = useState('');
  const [product, setProduct] = useState('');
  const [validTo, setValidTo] = useState('');
  const [reason, setReason] = useState('');
  const accounts = (people.data?.people ?? []).flatMap((p) => p.accounts.filter((a) => a.status !== 'DISABLED').map((a) => ({ value: a.accountId, label: `${p.legalName} (${a.loginName}, ${words(a.kind)}${a.breakGlass ? ', break-glass' : ''})` })));
  const ok = account !== '' && role !== '' && reason.trim() !== '' && (validTo.trim() === '' || ISO_INSTANT.test(validTo.trim()));
  return (
    <Section title="Request a role grant" testId="grant-request">
      <Select name="grantAccount" label="Account" value={account} onChange={setAccount} options={accounts} />
      <Select name="grantRole" label="Role" value={role} onChange={setRole} options={roles.map((r) => ({ value: r.code, label: `${r.code}: ${r.name}` }))} />
      <Row>
        <Field name="grantSite" label="Site (optional; blank for every site)" value={site} onChange={setSite} />
        <Field name="grantProduct" label="Product (optional)" value={product} onChange={setProduct} />
        <Field name="grantValidTo" label="Valid to (optional, e.g. 2027-03-31T23:59:00+05:30)" value={validTo} onChange={setValidTo} />
      </Row>
      <Field name="grantReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Request the grant"
        disabled={!ok || request.busy}
        onPress={() =>
          ok
            ? request.run({
                body: {
                  accountId: account,
                  roleCode: role,
                  scope: { ...(site.trim() ? { site: site.trim() } : {}), ...(product.trim() ? { product: product.trim() } : {}) },
                  ...(validTo.trim() ? { validTo: validTo.trim() } : {}),
                  reason: reason.trim(),
                },
              })
            : null
        }
      />
      <ActResult error={request.error} done={request.done} label="Requested: a second person approves it." />
    </Section>
  );
}
