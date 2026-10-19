/**
 * People and accounts (Phase 7 slice 7g-1, decision 0025; routes people.*): the system administrator records a person,
 * verifies the identity, opens and activates an account, issues an initial password, PIN or service key (shown once, for
 * its owner; SecretHandover) and badges (issued against an identity check, tested, activated; reported lost or
 * revoked), suspends, reinstates, unlocks or deactivates an account and processes a leaver. Every rule is the
 * database's (DI-14 to DI-19): an act it refuses is refused here with its words. No stored secret is ever shown: the
 * page lists credentials and badges as metadata only.
 */
import { useRef, useState } from 'react';
import { routes, type AccountView, type PersonView } from '@ebmr/api-contract';
import { Field, floor, StatusChip, takeSecret } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { ADMINISTRATORS, DEVICE_MANAGERS, Check, offeredTo, PEOPLE_READS, Row, SecretHandover, Select, SUMMARY_STYLE, words } from './shared.tsx';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const PURPOSES = ['INITIAL', 'REHIRE', 'BADGE_REPLACEMENT', 'CREDENTIAL_RECOVERY', 'PERIODIC'] as const;
const METHODS = ['IN_PERSON_DOCUMENT', 'HR_ONBOARDING_RECORD', 'VIDEO_WITH_DOCUMENT'] as const;
const KINDS = ['HUMAN', 'SERVICE', 'INTEGRATION', 'READONLY_DISPLAY'] as const;

export function PeoplePage() {
  const q = useApiQuery(routes.people.directory);
  const role = useSessionRole();
  const admin = offeredTo(role, ADMINISTRATORS);
  const [filter, setFilter] = useState('');
  const shown = (q.data?.people ?? []).filter((p) => filter.trim() === '' || `${p.legalName} ${p.accounts.map((a) => a.loginName).join(' ')}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <>
      <h1>People and accounts</h1>
      <p>
        A person is recorded once, with one legal name in every record. An account is opened only for a person whose identity was checked; its first password or PIN is made by the system,
        shown here once for its owner and changed at the first sign-in. Roles are granted on the role grants page: requested here, approved by a second person.
      </p>
      {admin ? <CreatePerson /> : null}
      <Section title="People" testId="people-list">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        <Field name="peopleFilter" label="Find a person or user ID" type="search" value={filter} onChange={setFilter} />
        {q.data && shown.length === 0 ? <p>No person matches.</p> : null}
        <ul>
          {shown.map((p) => (
            <PersonCard key={p.personId} p={p} role={role} technologies={q.data?.badgeTechnologies ?? []} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function CreatePerson() {
  const create = useCommand(routes.people.createPerson, PEOPLE_READS);
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState<string | null>('NATURAL');
  const ok = name.trim() !== '' && (kind === 'NATURAL' || kind === 'SYSTEM');
  return (
    <Section title="Record a person" testId="person-create">
      <Field name="personName" label="Legal name" value={name} onChange={setName} />
      <Field name="personRef" label="Employee reference (optional)" value={ref} onChange={setRef} />
      <floor.ChoiceGroup label="Kind" options={[{ value: 'NATURAL', label: 'A person' }, { value: 'SYSTEM', label: 'A system (service or integration identity)' }]} value={kind} onChange={setKind} />
      <ActButton
        label="Record the person"
        disabled={!ok || create.busy}
        onPress={() => (ok ? create.run({ body: { kind: kind === 'SYSTEM' ? 'SYSTEM' : 'NATURAL', legalName: name.trim(), ...(ref.trim() ? { employeeRef: ref.trim() } : {}) } }) : null)}
      />
      <ActResult error={create.error} done={create.done} label="Recorded. Verify the identity next." />
    </Section>
  );
}

function PersonCard({ p, role, technologies }: { p: PersonView; role: string | null; technologies: readonly string[] }) {
  const admin = offeredTo(role, ADMINISTRATORS);
  return (
    <li data-testid={`person-${p.legalName}`} data-status={p.status} style={{ marginBlock: '1rem' }}>
      <h3>
        {p.legalName} <StatusChip tone={p.status === 'ACTIVE' ? 'ok' : 'neutral'} label={p.status === 'ACTIVE' ? words(p.kind) : 'Left'} />
      </h3>
      <p>
        {p.employeeRef ? `Employee reference ${p.employeeRef}. ` : ''}
        {p.verifications.length === 0
          ? 'No identity check yet.'
          : `Identity checked: ${p.verifications.map((v) => `${words(v.purpose)} by ${v.verifiedBy.legalName} on ${v.occurredAt.text} (${words(v.method)}, ${v.documentType})`).join('; ')}.`}
      </p>
      {admin && p.status === 'ACTIVE' ? <VerifyIdentity p={p} /> : null}
      {p.accounts.map((a) => (
        <AccountCard key={a.accountId} a={a} p={p} role={role} technologies={technologies} />
      ))}
      {admin && p.status === 'ACTIVE' ? <CreateAccount p={p} /> : null}
      {admin && p.status === 'ACTIVE' ? <Rename p={p} /> : null}
      {admin && p.status === 'ACTIVE' && p.kind === 'NATURAL' ? <Leaver p={p} /> : null}
      {admin && p.status === 'LEFT' ? <Rehire p={p} /> : null}
    </li>
  );
}

function VerifyIdentity({ p }: { p: PersonView }) {
  const verify = useCommand(routes.people.verifyIdentity, PEOPLE_READS);
  const [purpose, setPurpose] = useState(p.verifications.length === 0 ? 'INITIAL' : 'PERIODIC');
  const [method, setMethod] = useState('IN_PERSON_DOCUMENT');
  const [doc, setDoc] = useState('');
  const [evidence, setEvidence] = useState('');
  const [at, setAt] = useState('');
  const ok = purpose !== '' && method !== '' && doc.trim() !== '' && evidence.trim() !== '' && ISO_INSTANT.test(at.trim());
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Record an identity check of {p.legalName}</summary>
      <Row>
        <Select name={`ivPurpose-${p.personId}`} label="Purpose" value={purpose} onChange={setPurpose} options={PURPOSES.map((x) => ({ value: x, label: words(x) }))} />
        <Select name={`ivMethod-${p.personId}`} label="Method" value={method} onChange={setMethod} options={METHODS.map((x) => ({ value: x, label: words(x) }))} />
      </Row>
      <Field name={`ivDoc-${p.personId}`} label="Document type" value={doc} onChange={setDoc} />
      <Field name={`ivEvidence-${p.personId}`} label="Evidence reference" value={evidence} onChange={setEvidence} />
      <Field name={`ivAt-${p.personId}`} label="When the check took place (e.g. 2026-10-18T09:30:00+05:30)" value={at} onChange={setAt} />
      <ActButton
        label="Record the identity check"
        disabled={!ok || verify.busy}
        onPress={() =>
          ok
            ? verify.run({
                params: { personId: p.personId },
                body: { purpose: purpose as (typeof PURPOSES)[number], method: method as (typeof METHODS)[number], documentType: doc.trim(), evidenceRef: evidence.trim(), occurredAt: at.trim() },
              })
            : null
        }
      />
      <ActResult error={verify.error} done={verify.done} label="Identity check recorded." />
    </details>
  );
}

function CreateAccount({ p }: { p: PersonView }) {
  const create = useCommand(routes.people.createAccount, PEOPLE_READS);
  const [login, setLogin] = useState('');
  const [kind, setKind] = useState(p.kind === 'SYSTEM' ? 'INTEGRATION' : 'HUMAN');
  const [breakGlass, setBreakGlass] = useState(false);
  const [generic, setGeneric] = useState(false);
  const ok = login.trim() !== '' && kind !== '';
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Open an account for {p.legalName}</summary>
      <Field name={`accLogin-${p.personId}`} label="User ID (never reused)" value={login} onChange={setLogin} />
      <Select name={`accKind-${p.personId}`} label="Account kind" value={kind} onChange={setKind} options={KINDS.map((x) => ({ value: x, label: words(x) }))} />
      <Check name={`accBg-${p.personId}`} label="Break-glass account (sealed; used only inside an approved window)" checked={breakGlass} onChange={setBreakGlass} />
      <Check name={`accGeneric-${p.personId}`} label="Generic account (read-only displays only)" checked={generic} onChange={setGeneric} />
      <ActButton
        label="Open the account"
        disabled={!ok || create.busy}
        onPress={() => (ok ? create.run({ body: { personId: p.personId, loginName: login.trim(), kind: kind as (typeof KINDS)[number], generic, breakGlass } }) : null)}
      />
      <ActResult error={create.error} done={create.done} label="Account opened. Issue its first credential and activate it." />
    </details>
  );
}

function AccountCard({ a, p, role, technologies }: { a: AccountView; p: PersonView; role: string | null; technologies: readonly string[] }) {
  const admin = offeredTo(role, ADMINISTRATORS);
  const manager = offeredTo(role, DEVICE_MANAGERS);
  const activate = useCommand(routes.people.activateAccount, PEOPLE_READS);
  const status = useCommand(routes.people.setAccountStatus, PEOPLE_READS);
  const unlock = useCommand(routes.people.unlockAccount, PEOPLE_READS);
  const issue = useCommand(routes.people.issueCredential, PEOPLE_READS);
  const [reason, setReason] = useState('');
  const r = reason.trim();
  const live = a.status !== 'DISABLED';
  const kinds = a.kind === 'HUMAN' ? (['PASSWORD', 'PIN'] as const) : a.kind === 'READONLY_DISPLAY' ? (['PASSWORD'] as const) : (['SERVICE_KEY'] as const);
  return (
    <div data-testid={`account-${a.loginName}`} data-status={a.status} style={{ borderInlineStart: '3px solid var(--ebmr-neutral-border, #999)', paddingInlineStart: '0.75rem', marginBlock: '0.75rem' }}>
      <p>
        <strong>{a.loginName}</strong> ({words(a.kind)}
        {a.breakGlass ? ', break-glass' : ''}
        {a.generic ? ', generic' : ''}) <StatusChip tone={a.status === 'ACTIVE' ? 'ok' : a.status === 'DISABLED' ? 'neutral' : 'warning'} label={words(a.status)} />{' '}
        {a.locked ? <StatusChip tone="error" label="Locked after failed sign-ins" /> : null}
        {a.statusReason ? ` ${a.statusReason}.` : ''}
      </p>
      <p>
        Roles: {a.roles.length === 0 ? 'none yet' : a.roles.join(', ')}. Credentials:{' '}
        {a.credentials.length === 0
          ? 'none'
          : a.credentials.map((c) => `${words(c.kind)} (${c.mustChange ? 'must be changed at first use' : 'set by its owner'}${c.expiresAt ? `, expires ${c.expiresAt.text}` : ''})`).join(', ')}
        .
      </p>
      {a.badges.length > 0 ? (
        <ul aria-label={`Badges of ${a.loginName}`}>
          {a.badges.map((b) => (
            <BadgeRow key={b.badgeId} b={b} admin={admin} />
          ))}
        </ul>
      ) : null}
      {(admin || manager) && live ? (
        <>
          <Field name={`accReason-${a.accountId}`} label={`Reason (for the record of acts on ${a.loginName})`} value={reason} onChange={setReason} />
          <Row>
            {admin && a.status === 'PENDING_ACTIVATION' ? (
              <ActButton label={`Activate ${a.loginName}`} disabled={r === '' || activate.busy} onPress={() => activate.run({ params: { accountId: a.accountId }, body: { reason: r } })} />
            ) : null}
            {admin
              ? kinds.map((k) => (
                  <ActButton
                    key={k}
                    primary={false}
                    label={`Issue ${k === 'PIN' ? 'a PIN' : k === 'SERVICE_KEY' ? 'a service key' : 'a password'} for ${a.loginName}`}
                    disabled={r === '' || issue.busy}
                    onPress={() => issue.run({ params: { accountId: a.accountId }, body: { kind: k, reason: r } })}
                  />
                ))
              : null}
            {admin && a.status === 'ACTIVE' ? (
              <ActButton primary={false} label={`Suspend ${a.loginName}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { accountId: a.accountId }, body: { action: 'SUSPEND', reason: r } })} />
            ) : null}
            {admin && a.status === 'SUSPENDED' ? (
              <ActButton primary={false} label={`Reinstate ${a.loginName}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { accountId: a.accountId }, body: { action: 'REINSTATE', reason: r } })} />
            ) : null}
            {admin ? (
              <ActButton primary={false} label={`Deactivate ${a.loginName}`} disabled={r === '' || status.busy} onPress={() => status.run({ params: { accountId: a.accountId }, body: { action: 'DEACTIVATE', reason: r } })} />
            ) : null}
            {a.locked ? <ActButton primary={false} label={`Unlock ${a.loginName}`} disabled={r === '' || unlock.busy} onPress={() => unlock.run({ params: { accountId: a.accountId }, body: { reason: r } })} /> : null}
          </Row>
          <ActResult error={activate.error ?? status.error ?? unlock.error ?? issue.error} done={activate.done ?? status.done ?? unlock.done} label="Saved." />
          {issue.done ? <SecretHandover issued={issue.done} onDone={issue.reset} /> : null}
          {admin && a.kind === 'HUMAN' ? <IssueBadge a={a} p={p} technologies={technologies} /> : null}
        </>
      ) : null}
    </div>
  );
}

function BadgeRow({ b, admin }: { b: AccountView['badges'][number]; admin: boolean }) {
  const test = useCommand(routes.people.recordBadgeTest, PEOPLE_READS);
  const activate = useCommand(routes.people.activateBadge, PEOPLE_READS);
  const withdraw = useCommand(routes.people.withdrawBadge, PEOPLE_READS);
  const [reason, setReason] = useState('');
  const r = reason.trim();
  const open = b.status === 'ISSUED' || b.status === 'ACTIVE';
  return (
    <li data-testid={`badge-${b.label}`} data-status={b.status}>
      Badge {b.label} ({b.technology}) <StatusChip tone={b.status === 'ACTIVE' ? 'ok' : open ? 'info' : 'neutral'} label={words(b.status)} />
      {b.lastTest ? ` Last test: ${words(b.lastTest.kind)} ${b.lastTest.result} on ${b.lastTest.at.text}.` : ' Not tested yet.'}
      {admin && open ? (
        <>
          <Row>
            <ActButton primary={false} label={`Badge ${b.label} passed its test`} disabled={test.busy} onPress={() => test.run({ params: { badgeId: b.badgeId }, body: { kind: b.status === 'ISSUED' ? 'AT_ISSUE' : 'PERIODIC', result: 'PASS' } })} />
            <ActButton primary={false} label={`Badge ${b.label} failed its test`} disabled={test.busy} onPress={() => test.run({ params: { badgeId: b.badgeId }, body: { kind: b.status === 'ISSUED' ? 'AT_ISSUE' : 'PERIODIC', result: 'FAIL' } })} />
          </Row>
          <Field name={`badgeReason-${b.badgeId}`} label={`Reason (badge ${b.label})`} value={reason} onChange={setReason} />
          <Row>
            {b.status === 'ISSUED' ? <ActButton label={`Activate badge ${b.label}`} disabled={r === '' || activate.busy} onPress={() => activate.run({ params: { badgeId: b.badgeId }, body: { reason: r } })} /> : null}
            <ActButton primary={false} label={`Report badge ${b.label} lost`} disabled={r === '' || withdraw.busy} onPress={() => withdraw.run({ params: { badgeId: b.badgeId }, body: { action: 'LOST', reason: r } })} />
            <ActButton primary={false} label={`Revoke badge ${b.label}`} disabled={r === '' || withdraw.busy} onPress={() => withdraw.run({ params: { badgeId: b.badgeId }, body: { action: 'REVOKE', reason: r } })} />
          </Row>
          <ActResult error={test.error ?? activate.error ?? withdraw.error} done={test.done ?? activate.done ?? withdraw.done} />
        </>
      ) : null}
    </li>
  );
}

/** The badge UID is a secret field (never in React state); the database keeps only its peppered hash. */
function IssueBadge({ a, p, technologies }: { a: AccountView; p: PersonView; technologies: readonly string[] }) {
  const issue = useCommand(routes.people.issueBadge, PEOPLE_READS);
  const uid = useRef<HTMLInputElement>(null);
  const [technology, setTechnology] = useState(technologies.includes('ISO14443_DESFIRE_EV3') ? 'ISO14443_DESFIRE_EV3' : '');
  const [label, setLabel] = useState('');
  const [check, setCheck] = useState(p.verifications[0]?.verificationId ?? '');
  const ok = technology !== '' && label.trim() !== '' && check !== '';
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Issue a badge for {a.loginName}</summary>
      <Field name={`badgeUid-${a.accountId}`} type="password" label="Badge UID (tap the badge on the reader)" inputRef={uid} autoComplete="off" />
      <Select name={`badgeTech-${a.accountId}`} label="Technology" value={technology} onChange={setTechnology} options={technologies.map((t) => ({ value: t, label: t }))} />
      <Field name={`badgeLabel-${a.accountId}`} label="Printed label" value={label} onChange={setLabel} />
      <Select
        name={`badgeCheck-${a.accountId}`}
        label="Identity check it is issued against"
        value={check}
        onChange={setCheck}
        options={p.verifications.map((v) => ({ value: v.verificationId, label: `${words(v.purpose)} on ${v.occurredAt.text}` }))}
      />
      <ActButton
        label={`Issue the badge for ${a.loginName}`}
        disabled={!ok || issue.busy}
        onPress={() => {
          const badgeUid = takeSecret(uid).trim();
          if (!ok || badgeUid === '') return null;
          return issue.run({ params: { accountId: a.accountId }, body: { badgeUid, technology, label: label.trim(), identityVerificationId: check } });
        }}
      />
      <ActResult error={issue.error} done={issue.done} label="Badge issued: test it, then activate it." />
    </details>
  );
}

/** A change of legal name is recorded as a name event; records already signed keep the name they were signed with. */
function Rename({ p }: { p: PersonView }) {
  const rename = useCommand(routes.people.renamePerson, PEOPLE_READS);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const ok = name.trim() !== '' && reason.trim() !== '';
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Record a change of legal name of {p.legalName}</summary>
      <Field name={`rename-${p.personId}`} label="New legal name" value={name} onChange={setName} />
      <Field name={`renameReason-${p.personId}`} label="Reason (e.g. the document that shows it)" value={reason} onChange={setReason} />
      <ActButton label={`Record the new name of ${p.legalName}`} primary={false} disabled={!ok || rename.busy} onPress={() => (ok ? rename.run({ params: { personId: p.personId }, body: { legalName: name.trim(), reason: reason.trim() } }) : null)} />
      <ActResult error={rename.error} done={rename.done} label="New name recorded." />
    </details>
  );
}

function Leaver({ p }: { p: PersonView }) {
  const leave = useCommand(routes.people.processLeaver, PEOPLE_READS);
  const [reason, setReason] = useState('');
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Process {p.legalName} as a leaver</summary>
      <p>Every account is disabled, every grant and badge ended. The person stays in every record they signed.</p>
      <Field name={`leaver-${p.personId}`} label="Reason" value={reason} onChange={setReason} />
      <ActButton label={`Process ${p.legalName} as a leaver`} primary={false} disabled={reason.trim() === '' || leave.busy} onPress={() => leave.run({ params: { personId: p.personId }, body: { reason: reason.trim() } })} />
      <ActResult error={leave.error} done={leave.done} label="Processed as a leaver." />
    </details>
  );
}

/** Slice 7g, work package 2: a person who left is rehired (iam.rehire_person); a REHIRE identity check comes next. */
function Rehire({ p }: { p: PersonView }) {
  const rehire = useCommand(routes.people.rehirePerson, PEOPLE_READS);
  const [reason, setReason] = useState('');
  return (
    <details>
      <summary style={SUMMARY_STYLE}>Rehire {p.legalName}</summary>
      <p>The person is active again; record a new identity check (purpose Rehire) before any account is opened or used again. The old accounts stay disabled.</p>
      <Field name={`rehire-${p.personId}`} label="Reason" value={reason} onChange={setReason} />
      <ActButton label={`Rehire ${p.legalName}`} primary={false} disabled={reason.trim() === '' || rehire.busy} onPress={() => rehire.run({ params: { personId: p.personId }, body: { reason: reason.trim() } })} />
      <ActResult error={rehire.error} done={rehire.done} label="Rehired: record the identity check next." />
    </details>
  );
}
