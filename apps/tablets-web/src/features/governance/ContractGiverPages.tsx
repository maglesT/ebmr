/**
 * The contract giver's reviewer (Phase 6 slice 6f; IN-30): QA grants a reviewer account a time-boxed, read-only access to
 * the batches made under one loan licence; the reviewer sees only those batches and their records, never an act. Every
 * record opened is logged by the database.
 */
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { CONTRACT_GIVER_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** QA's page: the accesses, their reads, grant and revoke. */
export function ContractGiverAccessPage() {
  const q = useApiQuery(routes.contractGiver.accesses);
  const qa = useOffered('QA');
  const revoke = useCommand(routes.contractGiver.revokeAccess, CONTRACT_GIVER_READS);
  return (
    <>
      <h1>Contract givers&apos; read access</h1>
      <p>A contract giver&apos;s reviewer reads the records of the batches made under its loan licence, read-only, for the time QA grants; each record opened is logged.</p>
      {qa ? <GrantAccess /> : null}
      <Section title="Accesses" testId="contract-giver-accesses">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.accesses.length === 0 ? <p>No access.</p> : null}
        <ul>
          {q.data?.accesses.map((a) => (
            <li key={a.accessId} data-testid={`cg-access-${a.loanLicenceNumber}`}>
              {a.reviewer.legalName} ({a.loginName}) for {a.holderName}, loan licence {a.loanLicenceNumber}: {a.validFrom.text} to {a.validTo.text}, {a.live ? 'live' : 'ended'}, {a.reads.toString()} record(s) read.{' '}
              {qa && a.live ? <ActButton label="End the access" primary={false} onPress={() => revoke.run({ params: { accessId: a.accessId }, body: { reason: 'Ended by QA' } })} disabled={revoke.busy} /> : null}
            </li>
          ))}
        </ul>
        <ActResult error={revoke.error} done={revoke.done} label="The access has ended." />
      </Section>
    </>
  );
}

function GrantAccess() {
  const grant = useCommand(routes.contractGiver.grantAccess, CONTRACT_GIVER_READS);
  const [licence, setLicence] = useState('');
  const [account, setAccount] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const ok = UUID.test(licence.trim()) && UUID.test(account.trim()) && !Number.isNaN(Date.parse(until.trim())) && reason.trim() !== '';
  return (
    <Section title="Grant a read access" testId="contract-giver-grant">
      <Field name="cgLicence" label="Loan licence (id)" value={licence} onChange={setLicence} />
      <Field name="cgAccount" label="Reviewer account (id)" value={account} onChange={setAccount} />
      <Field name="cgUntil" label="Until (ISO date and time with offset)" value={until} onChange={setUntil} />
      <Field name="cgReason" label="Reason (technical agreement)" value={reason} onChange={setReason} />
      <ActButton
        label="Grant the access"
        onPress={() => (ok ? grant.run({ body: { loanLicenceId: licence.trim(), accountId: account.trim(), validTo: until.trim(), reason: reason.trim() } }) : null)}
        disabled={!ok || grant.busy}
      />
      <ActResult error={grant.error} done={grant.done} label="The access is granted." />
    </Section>
  );
}

/** The reviewer's own page: the batches of its loan licence, read-only. */
export function ContractGiverBatchesPage() {
  const q = useApiQuery(routes.contractGiver.batches);
  return (
    <>
      <h1>Batches made for you</h1>
      <p>Read-only: the records of the batches made under your loan licence while your access lasts. Nothing can be changed here.</p>
      <Section title="Batches" testId="contract-giver-batches">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.batches.length === 0 ? <p>No batch is open to you now.</p> : null}
        <ul>
          {q.data?.batches.map((b) => (
            <li key={b.batchId} data-testid={`cg-batch-${b.batchNumber}`}>
              <Link to="/contract-giver/$batchId" params={{ batchId: b.batchId }}>
                {b.batchNumber}
              </Link>{' '}
              {b.productName ?? b.productCode ?? ''}, loan licence {b.loanLicenceNumber} (host {b.hostLicenceNumber}), {words(b.status ?? 'UNKNOWN')}; issued {b.issuedAt.text}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function ContractGiverRecordPage() {
  const { batchId } = useParams({ strict: false }) as { batchId: string };
  const q = useApiQuery(routes.contractGiver.batch, { params: { batchId } });
  const r = q.data;
  return (
    <>
      <h1>Batch record {r?.batchNumber ?? ''}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {r ? (
        <Section title="Record (read-only)" testId="contract-giver-record">
          <p>
            {r.productName ?? r.productCode ?? ''}, batch size {r.batchSize}; loan licence {r.loanLicenceNumber} of {r.loanHolderName ?? 'the contract giver'}, host licence {r.hostLicenceNumber}
            {r.technicalAgreement ? `, technical agreement ${r.technicalAgreement}` : ''}. {words(r.status ?? 'UNKNOWN')}, review {words(r.reviewState ?? 'NOT_STARTED')}.
          </p>
          <h3>Stages</h3>
          <ul>
            {r.stages.map((s) => (
              <li key={s.key}>
                {s.name ?? s.key}: {words(s.status ?? 'UNKNOWN')}
              </li>
            ))}
          </ul>
          <h3>Recorded values</h3>
          <ul>
            {r.values.map((v) => (
              <li key={`${v.step}:${v.item}`}>
                {v.item} ({v.step}): {v.value} [{words(v.status)}]
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
