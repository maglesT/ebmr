/**
 * The EU QP batch package on the EU tab (Phase 4 slice 4c, on slice 4b's routes; outline 4.6, 5.2.6; DI-41):
 *  - QA assembles the package of a released lot (qpPackage.assemble: the server registers the true copies and the
 *    database computes the package SHA-256 again); the reasons it cannot be assembled are the database's;
 *  - QA issues it by signing TRUE_COPY_VERIFIED through esig.describe and the ceremony (QP_PACKAGE_ACT ISSUE);
 *  - QA grants a QP account read-only access to the lot's issued packages until a time, with a reason, and may revoke
 *    it early with a reason; each access shows its state (LIVE, EXPIRED, REVOKED) and how often it was read.
 * The QP's own read-only view is QpReaderPage.tsx. Every state, hash and gate is the server's.
 */
import { useState } from 'react';
import { routes, type LotReleaseView, type QpAccessView, type QpPackageView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { GateProblems } from '../review/parts.tsx';
import { RELEASE_READS, words } from './reads.ts';

export const QP_READS: readonly string[] = [...RELEASE_READS, routes.qpPackage.lot.id];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An instant as QA writes it, with its offset (no local-time guess): 2026-10-26T18:00:00+05:30. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

/** The end of the window in microseconds since the epoch, from the instant QA typed (exact integer text). */
export function validToUs(text: string): string | null {
  const t = text.trim();
  if (!INSTANT.test(t)) return null;
  const ms = Date.parse(t);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return (BigInt(ms) * 1000n).toString();
}

export function QpPackageSection({ lot, offered }: { lot: LotReleaseView; offered: boolean }) {
  const q = useApiQuery(routes.qpPackage.lot, { params: { lotId: lot.lotId } });
  const assemble = useCommand(routes.qpPackage.assemble, QP_READS, 'assembling the QP package');
  const v = q.data;
  return (
    <Section title="EU QP batch package" testId="qp-package">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <>
          {offered ? (
            <>
              <GateProblems gate={{ ready: v.assembleProblems.length === 0, problems: v.assembleProblems }} testId="qp-assemble-problems" />
              <ActButton
                primary={false}
                label="Assemble the package"
                onPress={() => assemble.run({ params: { lotId: lot.lotId }, body: {} })}
                disabled={v.assembleProblems.length > 0 || assemble.busy}
              />
              <ActResult error={assemble.error} done={assemble.done} label="Package assembled: verify it and sign to issue it." />
            </>
          ) : null}
          {v.packages.length === 0 ? <p>No package is assembled yet.</p> : null}
          {v.packages.map((p) => (
            <PackageCard key={p.packageId} lot={lot} p={p} offered={offered} />
          ))}
          <Accesses accesses={v.accesses} offered={offered} />
        </>
      ) : null}
    </Section>
  );
}

function PackageCard({ lot, p, offered }: { lot: LotReleaseView; p: QpPackageView; offered: boolean }) {
  const issue = useSignedAct(QP_READS);
  return (
    <article data-testid={`qp-package-${p.packageId}`} data-state={p.state} aria-label={`Package ${p.label}`}>
      <h3>
        {p.label} <StatusChip tone={p.state === 'ISSUED' ? 'ok' : 'pending'} label={words(p.state)} />
      </h3>
      <p>
        Package SHA-256 {p.packageSha256}, {p.contentBytes} bytes; assembled by {p.assembledBy.legalName}, {p.assembledAt.text}
        {p.issuedBy && p.issuedAt ? `; issued by ${p.issuedBy.legalName}, ${p.issuedAt.text}` : ''}.
      </p>
      <ul aria-label={`Sections of ${p.label}`}>
        {p.sections.map((s) => (
          <li key={s.name}>
            {s.title} ({words(s.role)}, {s.kind === 'TRUE_COPY' ? `true copy of ${s.chainKey ?? 'its chain'}` : 'document'}), SHA-256 {s.sha256}, {s.bytes} bytes
          </li>
        ))}
      </ul>
      {p.state === 'ASSEMBLED' && offered ? (
        <>
          <ActButton
            label="Sign and issue the package"
            onPress={() => issue.sign({ kind: 'QP_PACKAGE_ACT', act: 'ISSUE', packageId: p.packageId }, `Issue the EU QP batch package of lot ${lot.lotCode} as a verified true copy (SHA-256 ${p.packageSha256})`)}
            disabled={issue.busy}
          />
          <ActResult error={issue.error} outcome={issue.outcome} />
        </>
      ) : null}
      {p.state === 'ISSUED' && offered ? <GrantAccess p={p} /> : null}
    </article>
  );
}

function GrantAccess({ p }: { p: QpPackageView }) {
  const [account, setAccount] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const grant = useCommand(routes.qpPackage.grantAccess, QP_READS, 'granting QP access');
  const accountId = UUID.test(account.trim()) ? account.trim() : null;
  const us = validToUs(until);
  return (
    <div data-testid={`qp-grant-${p.packageId}`}>
      <h4>Grant a QP read-only access to this lot</h4>
      <Field name={`qpAccount-${p.packageId}`} label="QP account (id)" value={account} onChange={setAccount} />
      <Field name={`qpUntil-${p.packageId}`} label="Access ends at (with its offset, e.g. 2026-10-26T18:00:00+05:30)" value={until} onChange={setUntil} />
      <Field name={`qpReason-${p.packageId}`} label="Reason for the access" value={reason} onChange={setReason} />
      <ActButton
        label="Grant the access"
        onPress={() => accountId && us && grant.run({ params: { packageId: p.packageId }, body: { accountId, validToUs: us, reason: reason.trim() } })}
        disabled={accountId === null || us === null || reason.trim() === '' || grant.busy}
      />
      <ActResult error={grant.error} done={grant.done} label="Access granted." />
    </div>
  );
}

function Accesses({ accesses, offered }: { accesses: readonly QpAccessView[]; offered: boolean }) {
  if (accesses.length === 0) return <p>No QP access has been granted.</p>;
  return (
    <ul aria-label="QP accesses" data-testid="qp-accesses">
      {accesses.map((a) => (
        <AccessRow key={a.accessId} a={a} offered={offered} />
      ))}
    </ul>
  );
}

function AccessRow({ a, offered }: { a: QpAccessView; offered: boolean }) {
  const [reason, setReason] = useState('');
  const revoke = useCommand(routes.qpPackage.revokeAccess, QP_READS, 'revoking QP access');
  return (
    <li data-testid={`qp-access-${a.accessId}`} data-state={a.state}>
      <StatusChip tone={a.state === 'LIVE' ? 'ok' : a.state === 'REVOKED' ? 'error' : 'neutral'} label={words(a.state)} /> {a.qp.legalName} ({a.qp.loginName}) from {a.validFrom.text} to {a.validTo.text}, granted by{' '}
      {a.grantedBy.legalName}: {a.reason} · read {a.reads} times
      {a.state === 'LIVE' && offered ? (
        <>
          <Field name={`revokeReason-${a.accessId}`} label={`Reason to end the access of ${a.qp.legalName}`} value={reason} onChange={setReason} />
          <ActButton primary={false} label={`End the access of ${a.qp.legalName}`} onPress={() => revoke.run({ params: { accessId: a.accessId }, body: { reason: reason.trim() } })} disabled={reason.trim() === '' || revoke.busy} />
          <ActResult error={revoke.error} done={revoke.done} label="Access ended." />
        </>
      ) : null}
    </li>
  );
}
