/**
 * Access governance (Phase 7 slice 7g-5, decision 0025; contract ns/access-governance.ts):
 *  - role permissions (/admin/role-permissions): the system administrator requests that a permission be added to a role;
 *    a second person approves or refuses it (never the requester, never a holder of the role), and an approval is
 *    written under an approved change record (a role's permissions are configuration, DI-09); the administrator removes
 *    a permission at once under a change record;
 *  - delegations (/admin/delegations): a holder of signing authority delegates delegable meanings to a named person for
 *    a scope, markets and a window, citing the procedure; a third person approves it (never the delegator, the delegate
 *    or the requester); the delegator or an approver revokes it;
 *  - the US e-signature certification (/admin/us-esig-certification): the process owner records the legal entity's
 *    letter to the US agency certifying that its electronic signatures bind as handwritten ones do, with its reference
 *    and submission date; the page says whether US-market work is blocked for a legal entity without one.
 * Every act is the database's to allow or refuse; a decision is never offered to a person the database would refuse on
 * segregation of duties, and a refusal is shown in the database's words.
 */
import { useState } from 'react';
import { routes, type DelegationView, type RolePermissionRequestView, type RolePermissionsView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { ADMINISTRATORS, Check, GRANT_APPROVERS, offeredTo, PROCESS_OWNERS, Row, Select, SUMMARY_STYLE, useSessionPerson, words } from './shared.tsx';

export const ROLE_PERMISSION_READS: readonly string[] = [routes.accessGovernance.rolePermissions.id];
export const DELEGATION_READS: readonly string[] = [routes.accessGovernance.delegations.id];
export const CERTIFICATION_READS: readonly string[] = [routes.accessGovernance.usEsigCertifications.id];

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CHANGE_RECORD = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

// ---------------------------------------------------------------------------------------------
// Role permissions

export function RolePermissionsPage() {
  const q = useApiQuery(routes.accessGovernance.rolePermissions);
  const role = useSessionRole();
  const me = useSessionPerson();
  const requests = q.data?.requests ?? [];
  const open = requests.filter((r) => r.status === 'REQUESTED');
  const decided = requests.filter((r) => r.status !== 'REQUESTED');
  return (
    <>
      <h1>Role permissions</h1>
      <p>
        Adding a permission to a role grants it to everyone who holds the role, so one person requests it and a second approves it; nobody decides a request for a role they hold. A role
        never combines administration and GMP permissions. A role&apos;s permissions are configuration: an approval and a removal are written under a change record QA has approved.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {offeredTo(role, ADMINISTRATORS) && q.data ? <RequestRolePermission data={q.data} /> : null}
      <Section title="Waiting for a decision" testId="role-permission-requested">
        {q.data && open.length === 0 ? <p>No request is waiting.</p> : null}
        <ul>
          {open.map((r) => (
            <RequestItem key={r.requestId} r={r} role={role} me={me} />
          ))}
        </ul>
      </Section>
      <Section title="Decided" testId="role-permission-decided">
        <ul>
          {decided.map((r) => (
            <RequestItem key={r.requestId} r={r} role={role} me={me} />
          ))}
        </ul>
      </Section>
      {offeredTo(role, ADMINISTRATORS) && q.data ? <RemoveRolePermission data={q.data} /> : null}
      <Section title="Roles and their permissions now" testId="role-permission-roles">
        <ul>
          {(q.data?.roles ?? []).map((r) => (
            <li key={r.code} data-testid={`role-${r.code}`}>
              <details>
                <summary style={SUMMARY_STYLE}>
                  <strong>{r.code}</strong> {r.name} ({r.group || 'no group'}; {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'})
                </summary>
                <p>{r.permissions.length === 0 ? 'No permission.' : r.permissions.join(', ')}</p>
              </details>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function RequestItem({ r, role, me }: { r: RolePermissionRequestView; role: string | null; me: string | null }) {
  const decide = useCommand(routes.accessGovernance.decideRolePermission, ROLE_PERMISSION_READS);
  const [reason, setReason] = useState('');
  const [changeRecord, setChangeRecord] = useState('');
  const mine = me !== null && r.requestedBy.personId === me;
  const mayDecide = r.status === 'REQUESTED' && offeredTo(role, GRANT_APPROVERS) && !mine;
  const why = reason.trim();
  const cr = changeRecord.trim();
  const crOk = cr === '' || CHANGE_RECORD.test(cr);
  const label = `${r.permissionCode} for ${r.roleCode}`;
  return (
    <li data-testid={`role-permission-${r.roleCode}-${r.permissionCode}`} data-status={r.status}>
      <p>
        <strong>{r.permissionCode}</strong> for role <strong>{r.roleCode}</strong>{' '}
        <StatusChip tone={r.status === 'APPROVED' ? 'ok' : r.status === 'REQUESTED' ? 'pending' : 'neutral'} label={words(r.status)} />
      </p>
      <p>
        Requested by {r.requestedBy.legalName} on {r.requestedAt.text}: {r.reason}.
        {r.decidedBy && r.decidedAt ? ` ${r.status === 'REJECTED' ? 'Refused' : 'Approved'} by ${r.decidedBy.legalName} on ${r.decidedAt.text}${r.decisionReason ? `: ${r.decisionReason}` : ''}.` : ''}
      </p>
      {r.status === 'REQUESTED' && mine ? <p>You requested this, so a second person decides it.</p> : null}
      {mayDecide ? (
        <>
          <Field name={`rpReason-${r.requestId}`} label={`Reason (${label})`} value={reason} onChange={setReason} />
          <Field name={`rpChange-${r.requestId}`} label={`Change record approved for role permissions (${label}; needed to approve)`} value={changeRecord} onChange={setChangeRecord} />
          <Row>
            <ActButton
              label={`Approve ${label}`}
              disabled={why === '' || !crOk || decide.busy}
              onPress={() => decide.run({ params: { requestId: r.requestId }, body: { approve: true, reason: why, ...(cr ? { changeRecord: cr } : {}) } })}
            />
            <ActButton primary={false} label={`Refuse ${label}`} disabled={why === '' || decide.busy} onPress={() => decide.run({ params: { requestId: r.requestId }, body: { approve: false, reason: why } })} />
          </Row>
        </>
      ) : null}
      <ActResult error={decide.error} done={decide.done} label="Decided." />
    </li>
  );
}

type RolePermissions = RolePermissionsView;

function RequestRolePermission({ data }: { data: RolePermissions }) {
  const request = useCommand(routes.accessGovernance.requestRolePermission, ROLE_PERMISSION_READS);
  const [role, setRole] = useState('');
  const [permission, setPermission] = useState('');
  const [reason, setReason] = useState('');
  const held = new Set(data.roles.find((r) => r.code === role)?.permissions ?? []);
  const ok = role !== '' && permission !== '' && reason.trim() !== '';
  return (
    <Section title="Request a permission for a role" testId="role-permission-request">
      <Select name="rpRole" label="Role" value={role} onChange={setRole} options={data.roles.map((r) => ({ value: r.code, label: `${r.code}: ${r.name}` }))} />
      <Select
        name="rpPermission"
        label="Permission"
        value={permission}
        onChange={setPermission}
        options={data.permissions.filter((p) => !held.has(p.code)).map((p) => ({ value: p.code, label: `${p.code} (${words(p.domain)}, ${words(p.effect)}): ${p.description}` }))}
      />
      <Field name="rpReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Request the permission"
        disabled={!ok || request.busy}
        onPress={() => (ok ? request.run({ body: { roleCode: role, permissionCode: permission, reason: reason.trim() } }) : null)}
      />
      <ActResult error={request.error} done={request.done} label="Requested: a second person approves it." />
    </Section>
  );
}

function RemoveRolePermission({ data }: { data: RolePermissions }) {
  const remove = useCommand(routes.accessGovernance.removeRolePermission, ROLE_PERMISSION_READS);
  const [role, setRole] = useState('');
  const [permission, setPermission] = useState('');
  const [changeRecord, setChangeRecord] = useState('');
  const [reason, setReason] = useState('');
  const held = data.roles.find((r) => r.code === role)?.permissions ?? [];
  const ok = role !== '' && permission !== '' && reason.trim() !== '' && CHANGE_RECORD.test(changeRecord.trim());
  return (
    <Section title="Remove a permission from a role" testId="role-permission-remove">
      <p>A removal takes the authority away from every holder of the role at once.</p>
      <Select name="rmRole" label="Role" value={role} onChange={setRole} options={data.roles.map((r) => ({ value: r.code, label: `${r.code}: ${r.name}` }))} />
      <Select name="rmPermission" label="Permission it holds" value={permission} onChange={setPermission} options={held.map((p) => ({ value: p, label: p }))} />
      <Field name="rmChange" label="Change record approved for role permissions" value={changeRecord} onChange={setChangeRecord} />
      <Field name="rmReason" label="Reason for the removal" value={reason} onChange={setReason} />
      <ActButton
        primary={false}
        label="Remove the permission"
        disabled={!ok || remove.busy}
        onPress={() => (ok ? remove.run({ body: { roleCode: role, permissionCode: permission, reason: reason.trim(), changeRecord: changeRecord.trim() } }) : null)}
      />
      <ActResult error={remove.error} done={remove.done} label="Removed." />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Delegations

export function DelegationsPage() {
  const q = useApiQuery(routes.accessGovernance.delegations);
  const me = useSessionPerson();
  const all = q.data?.delegations ?? [];
  const open = all.filter((d) => d.status === 'REQUESTED');
  const rest = all.filter((d) => d.status !== 'REQUESTED');
  return (
    <>
      <h1>Delegations of signing authority</h1>
      <p>
        A person who holds signing authority may delegate a delegable meaning (such as the manufacturer release) to a named person for a scope, markets and a period, citing the procedure
        that allows it. A third person approves it: never the delegator, the delegate or the requester. The delegate signs with their own credentials, citing the delegation, and must hold
        the authority to sign themselves; nobody passes on what they hold only by delegation.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <RequestDelegation meanings={q.data.meanings} /> : null}
      <Section title="Waiting for a decision" testId="delegations-requested">
        {q.data && open.length === 0 ? <p>No delegation is waiting.</p> : null}
        <ul>
          {open.map((d) => (
            <DelegationItem key={d.delegationId} d={d} me={me} mayApprove={q.data?.mayApprove === true} />
          ))}
        </ul>
      </Section>
      <Section title="Decided, in force and ended" testId="delegations-decided">
        {q.data && rest.length === 0 ? <p>None.</p> : null}
        <ul>
          {rest.map((d) => (
            <DelegationItem key={d.delegationId} d={d} me={me} mayApprove={q.data?.mayApprove === true} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function DelegationItem({ d, me, mayApprove }: { d: DelegationView; me: string | null; mayApprove: boolean }) {
  const decide = useCommand(routes.accessGovernance.decideDelegation, DELEGATION_READS);
  const revoke = useCommand(routes.accessGovernance.revokeDelegation, DELEGATION_READS);
  const [reason, setReason] = useState('');
  const why = reason.trim();
  // Segregation of duties as the database keeps it: never the delegator, the delegate or the requester.
  const involved = me !== null && [d.delegator.personId, d.delegate.personId, d.requestedBy.personId].includes(me);
  const mayDecide = d.status === 'REQUESTED' && mayApprove && !involved;
  const mayRevoke = d.status === 'APPROVED' && (me === d.delegator.personId || mayApprove);
  const scope = [d.scope.site, d.scope.area, d.scope.product].filter((x) => x !== null).join(' / ');
  const label = `${d.delegator.legalName} to ${d.delegate.legalName}`;
  return (
    <li data-testid={`delegation-${d.delegate.loginName}-${d.sopRef}`} data-status={d.status}>
      <p>
        <strong>{d.meanings.join(', ')}</strong> delegated by {d.delegator.legalName} to {d.delegate.legalName} ({d.delegate.loginName}){scope ? `, scope ${scope}` : ', every scope'}
        {d.markets.length > 0 ? `, markets ${d.markets.join(', ')}` : ', every market'}.{' '}
        <StatusChip tone={d.live ? 'ok' : d.status === 'REQUESTED' ? 'pending' : 'neutral'} label={d.live ? 'In force' : words(d.status)} />
      </p>
      <p>
        From {d.validFrom.text} to {d.validTo.text}, under {d.sopRef}: {d.reason}.
        {d.decidedBy && d.decidedAt ? ` ${d.status === 'REJECTED' ? 'Refused' : 'Approved'} by ${d.decidedBy.legalName} on ${d.decidedAt.text}${d.decisionReason ? `: ${d.decisionReason}` : ''}.` : ''}
        {d.revokedBy && d.revokedAt ? ` Revoked by ${d.revokedBy.legalName} on ${d.revokedAt.text}: ${d.revocationReason ?? ''}.` : ''}
      </p>
      {d.status === 'REQUESTED' && involved ? <p>You are the delegator, the delegate or the requester, so a third person decides it.</p> : null}
      {mayDecide || mayRevoke ? (
        <>
          <Field name={`delegationReason-${d.delegationId}`} label={`Reason (delegation ${label})`} value={reason} onChange={setReason} />
          <Row>
            {mayDecide ? <ActButton label={`Approve the delegation ${label}`} disabled={why === '' || decide.busy} onPress={() => decide.run({ params: { delegationId: d.delegationId }, body: { approve: true, reason: why } })} /> : null}
            {mayDecide ? (
              <ActButton primary={false} label={`Refuse the delegation ${label}`} disabled={why === '' || decide.busy} onPress={() => decide.run({ params: { delegationId: d.delegationId }, body: { approve: false, reason: why } })} />
            ) : null}
            {mayRevoke ? <ActButton primary={false} label={`Revoke the delegation ${label}`} disabled={why === '' || revoke.busy} onPress={() => revoke.run({ params: { delegationId: d.delegationId }, body: { reason: why } })} /> : null}
          </Row>
        </>
      ) : null}
      <ActResult error={decide.error ?? revoke.error} done={decide.done ?? revoke.done} label="Done." />
    </li>
  );
}

function RequestDelegation({ meanings }: { meanings: readonly { code: string; title: string }[] }) {
  const request = useCommand(routes.accessGovernance.requestDelegation, DELEGATION_READS);
  const [delegate, setDelegate] = useState('');
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [markets, setMarkets] = useState<readonly ('IN' | 'US' | 'EU')[]>([]);
  const [site, setSite] = useState('');
  const [product, setProduct] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sop, setSop] = useState('');
  const [reason, setReason] = useState('');
  const ok = delegate.trim() !== '' && chosen.length > 0 && ISO_INSTANT.test(from.trim()) && ISO_INSTANT.test(to.trim()) && sop.trim() !== '' && reason.trim() !== '';
  const toggle = <T,>(list: readonly T[], v: T, on: boolean): readonly T[] => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));
  return (
    <Section title="Delegate signing authority" testId="delegation-request">
      <p>You delegate as yourself: only a holder of signing authority may delegate, and the database refuses anyone else.</p>
      <Field name="delegateLogin" label="Delegate's user ID" value={delegate} onChange={setDelegate} />
      <fieldset>
        <legend>Meanings delegated</legend>
        {meanings.length === 0 ? <p>No meaning may be delegated.</p> : null}
        {meanings.map((m) => (
          <Check key={m.code} name={`meaning-${m.code}`} label={`${m.title} (${m.code})`} checked={chosen.includes(m.code)} onChange={(on) => setChosen((c) => toggle(c, m.code, on))} />
        ))}
      </fieldset>
      <fieldset>
        <legend>Markets (none ticked: every market)</legend>
        {(['IN', 'US', 'EU'] as const).map((m) => (
          <Check key={m} name={`market-${m}`} label={m} checked={markets.includes(m)} onChange={(on) => setMarkets((c) => toggle(c, m, on))} />
        ))}
      </fieldset>
      <Row>
        <Field name="delegationSite" label="Site (optional)" value={site} onChange={setSite} />
        <Field name="delegationProduct" label="Product (optional)" value={product} onChange={setProduct} />
      </Row>
      <Row>
        <Field name="delegationFrom" label="Valid from (e.g. 2026-11-01T00:00:00+05:30)" value={from} onChange={setFrom} />
        <Field name="delegationTo" label="Valid to (e.g. 2026-11-15T23:59:00+05:30)" value={to} onChange={setTo} />
      </Row>
      <Field name="delegationSop" label="Procedure that allows the delegation (SOP reference)" value={sop} onChange={setSop} />
      <Field name="delegationReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Request the delegation"
        disabled={!ok || request.busy}
        onPress={() =>
          ok
            ? request.run({
                body: {
                  delegateLoginName: delegate.trim(),
                  scope: { ...(site.trim() ? { site: site.trim() } : {}), ...(product.trim() ? { product: product.trim() } : {}) },
                  markets: [...markets],
                  meanings: [...chosen],
                  validFrom: from.trim(),
                  validTo: to.trim(),
                  sopRef: sop.trim(),
                  reason: reason.trim(),
                },
              })
            : null
        }
      />
      <ActResult error={request.error} done={request.done} label="Requested: a third person approves it." />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// The US electronic-signature certification

export function UsEsigCertificationPage() {
  const role = useSessionRole();
  const [entity, setEntity] = useState('');
  const asked = entity.trim();
  const q = useApiQuery(routes.accessGovernance.usEsigCertifications, { query: asked ? { legalEntity: asked } : {} });
  return (
    <>
      <h1>US electronic-signature certification</h1>
      <p>
        Before electronic signatures are used for US-market records, the legal entity certifies to the US agency, in a signed letter, that its electronic signatures are intended to be the
        legally binding equivalent of handwritten signatures. The letter itself is sent outside this system; here its reference and submission date are recorded.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? (
        <Banner tone={q.data.mode === 'BLOCK' ? 'warning' : 'info'} title={q.data.mode === 'BLOCK' ? 'Policy: a US-market batch is not issued without a letter on file.' : 'Policy: a missing letter is reported, not blocked.'} />
      ) : null}
      <Section title="Is a letter on file?" testId="us-esig-status">
        <Field name="usEsigEntity" label="Legal entity" value={entity} onChange={setEntity} />
        {asked && q.data?.status ? (
          <p data-testid="us-esig-status-result" data-on-file={String(q.data.status.onFile)}>
            {q.data.status.onFile ? `A certification letter of ${q.data.status.legalEntity} is on file.` : `No certification letter of ${q.data.status.legalEntity} is on file.`}{' '}
            {q.data.status.blocking ? <StatusChip tone="error" label="US-market work blocked" /> : null}
          </p>
        ) : null}
      </Section>
      {offeredTo(role, PROCESS_OWNERS) ? <RecordCertification /> : null}
      <Section title="Letters on file" testId="us-esig-certifications">
        {q.data && q.data.certifications.length === 0 ? <p>No letter is recorded.</p> : null}
        <ul>
          {(q.data?.certifications ?? []).map((c) => (
            <li key={c.certificationId} data-testid={`us-esig-${c.letterRef}`}>
              <strong>{c.legalEntity}</strong>: letter {c.letterRef}, submitted on {c.submittedOn}
              {c.agencyAcknowledgementRef ? `, acknowledged as ${c.agencyAcknowledgementRef}` : ''}; recorded by {c.recordedBy.legalName} on {c.recordedAt.text}.
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function RecordCertification() {
  const record = useCommand(routes.accessGovernance.recordUsEsigCertification, CERTIFICATION_READS);
  const [entity, setEntity] = useState('');
  const [letter, setLetter] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [ack, setAck] = useState('');
  const ok = entity.trim() !== '' && letter.trim() !== '' && ISO_DATE.test(submitted.trim());
  return (
    <Section title="Record a certification letter" testId="us-esig-record">
      <Field name="certEntity" label="Legal entity (as named in the letter)" value={entity} onChange={setEntity} />
      <Field name="certLetter" label="Letter reference" value={letter} onChange={setLetter} />
      <Field name="certSubmitted" label="Submitted on (YYYY-MM-DD)" value={submitted} onChange={setSubmitted} />
      <Field name="certAck" label="Agency acknowledgement reference (optional)" value={ack} onChange={setAck} />
      <ActButton
        label="Record the letter"
        disabled={!ok || record.busy}
        onPress={() =>
          ok ? record.run({ body: { legalEntity: entity.trim(), letterRef: letter.trim(), submittedOn: submitted.trim(), ...(ack.trim() ? { agencyAcknowledgementRef: ack.trim() } : {}) } }) : null
        }
      />
      <ActResult error={record.error} done={record.done} label="The letter is recorded." />
    </Section>
  );
}
