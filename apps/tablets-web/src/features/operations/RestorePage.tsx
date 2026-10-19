/**
 * The restore procedure (Phase 7 slice 7g, work package 2; decision 0025; DI-45, DI-18, DI-37; INV-27). After a restore,
 * a copy or a failover the server runs on the restored database and the procedure is done here, in order:
 *  1. the system administrator secures the identifiers (every protected identifier moves past the external ledger before
 *     anything else is written);
 *  2. records the restore event with its change record and the persons who approve it (never the operator); the database
 *     compares the external anchors itself and lists the history the restore discarded;
 *  3. each named approver signs the approval (RESTORE_APPROVED) through the ceremony;
 *  4. the administrator completes it: number issue resumes under the new incarnation.
 * The marks and anchors are the server's own ledger's; the database refuses every step out of order, and its words are
 * shown as they are.
 */
import { useState } from 'react';
import { routes, type RestoreEventKind, type RestoreEventView, type RestoreView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { Check, Select, useSessionPerson } from '../administration/shared.tsx';
import { RESTORE_READS, words } from './reads.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const KINDS: readonly RestoreEventKind[] = ['FULL_RESTORE', 'POINT_IN_TIME_RESTORE', 'FAILOVER', 'CLUSTER_MIGRATION'];

export function RestorePage() {
  const q = useApiQuery(routes.operations.restore);
  const role = useSessionRole();
  const admin = role === 'SYSTEM_ADMINISTRATOR';
  const v = q.data;
  return (
    <>
      <h1>Restore procedure</h1>
      <p>
        After a restore from a backup, a copy of the database or a failover, nothing is used until this procedure has run: the identifiers are moved past every value the original may have
        issued, the restore is recorded with the history it lost, a second person approves it with their signature, and only then does number issue resume.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v && !v.configured ? (
        <Banner tone="warning" title="This server does not run the restore procedure yet.">
          <p>{v.problem}</p>
        </Banner>
      ) : null}
      {v ? <State v={v} /> : null}
      {admin && v ? <Secure v={v} /> : null}
      {admin && v ? <RecordEvent v={v} /> : null}
      <Section title="Restore events" testId="restore-events">
        {v && v.events.length === 0 ? <p>No restore has been recorded in this database.</p> : null}
        <ul>
          {v?.events.map((e) => (
            <Event key={e.restoreEventId} e={e} admin={admin} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function State({ v }: { v: RestoreView }) {
  return (
    <p data-testid="restore-state">
      Database incarnation <code>{v.incarnation}</code>:{' '}
      {v.identifiersSecured ? <StatusChip tone="ok" label="Identifiers secured" /> : <StatusChip tone="error" label="Identifiers not secured: secure them first" />}
    </p>
  );
}

function Secure({ v }: { v: RestoreView }) {
  const run = useCommand(routes.operations.secureIdentifiers, RESTORE_READS);
  const [reason, setReason] = useState('');
  return (
    <Section title="1. Secure the identifiers" testId="restore-secure">
      <p>Every protected sequence moves past the highest value the external ledger holds, and the login names it holds are reserved. Moving forward needs no approval.</p>
      <Field name="secure-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
      <ActButton label="Secure the identifiers" disabled={reason.trim().length < 3 || run.busy || !v.configured} onPress={() => run.run({ body: { reason: reason.trim() } })} />
      <ActResult error={run.error} done={run.done} label={run.done ? `${String(run.done.moves.length)} identifier source(s) moved.` : 'Done.'} />
    </Section>
  );
}

function RecordEvent({ v }: { v: RestoreView }) {
  const run = useCommand(routes.operations.recordRestoreEvent, RESTORE_READS);
  const me = useSessionPerson();
  const [kind, setKind] = useState<RestoreEventKind | ''>('');
  const [backupId, setBackupId] = useState('');
  const [backupTakenAt, setBackupTakenAt] = useState('');
  const [restorePoint, setRestorePoint] = useState('');
  const [performedAt, setPerformedAt] = useState('');
  const [reason, setReason] = useState('');
  const [change, setChange] = useState('');
  const [approvers, setApprovers] = useState<string[]>([]);
  const fromBackup = kind === 'FULL_RESTORE' || kind === 'POINT_IN_TIME_RESTORE';
  const ok =
    kind !== '' && ISO.test(performedAt.trim()) && reason.trim() !== '' && change.trim() !== '' && approvers.length > 0 &&
    (!fromBackup || (backupId.trim() !== '' && ISO.test(backupTakenAt.trim()))) && (restorePoint.trim() === '' || ISO.test(restorePoint.trim()));
  const candidates = v.approverCandidates.filter((c) => c.personId !== me);
  return (
    <Section title="2. Record the restore" testId="restore-record">
      <p>Name who approves it: never yourself. The database compares the external anchors with the restored audit trail and records the history after the restore point as lost.</p>
      <Select name="restore-kind" label="What was done" value={kind} onChange={(x) => setKind(KINDS.find((k) => k === x) ?? '')} options={KINDS.map((k) => ({ value: k, label: words(k) }))} />
      {fromBackup ? (
        <>
          <Field name="restore-backup" label="Backup restored from" value={backupId} onChange={setBackupId} />
          <Field name="restore-backup-at" label="When that backup was taken (ISO 8601, e.g. 2026-10-18T04:00:00Z)" value={backupTakenAt} onChange={setBackupTakenAt} />
        </>
      ) : null}
      <Field name="restore-point" label="Restore point, if not the backup's time (ISO 8601)" value={restorePoint} onChange={setRestorePoint} />
      <Field name="restore-performed" label="When the restore or failover was performed (ISO 8601)" value={performedAt} onChange={setPerformedAt} />
      <Field name="restore-reason" label="Reason" value={reason} onChange={setReason} />
      <Field name="restore-change" label="Incident or change record" value={change} onChange={setChange} />
      <fieldset>
        <legend>Approvers</legend>
        {candidates.length === 0 ? <p>Nobody holds the approval of a restore yet.</p> : null}
        {candidates.map((c) => (
          <Check
            key={c.personId}
            name={`restore-approver-${c.personId}`}
            label={c.legalName}
            checked={approvers.includes(c.personId)}
            onChange={(on) => setApprovers((a) => (on ? [...a, c.personId] : a.filter((x) => x !== c.personId)))}
          />
        ))}
      </fieldset>
      <ActButton
        label="Record the restore"
        disabled={!ok || run.busy || !v.configured}
        onPress={() =>
          run.run({
            body: {
              eventKind: kind === '' ? 'FULL_RESTORE' : kind,
              ...(fromBackup ? { backupId: backupId.trim(), backupTakenAt: backupTakenAt.trim() } : {}),
              ...(restorePoint.trim() ? { restorePoint: restorePoint.trim() } : {}),
              performedAt: performedAt.trim(),
              reason: reason.trim(),
              changeReference: change.trim(),
              approverPersonIds: approvers,
            },
          })
        }
      />
      <ActResult error={run.error} done={run.done} label="Recorded; the named approvers approve it next." />
    </Section>
  );
}

function Event({ e, admin }: { e: RestoreEventView; admin: boolean }) {
  const me = useSessionPerson();
  const approve = useSignedAct(RESTORE_READS);
  const complete = useCommand(routes.operations.completeRestore, RESTORE_READS);
  const [reason, setReason] = useState('');
  const mine = e.approvers.find((a) => a.personId === me);
  const unexplained = e.anchorComparison.filter((c) => c.status === 'UNEXPLAINED');
  return (
    <li data-testid={`restore-event-${e.restoreEventId}`} data-status={e.status}>
      <p>
        <strong>{words(e.eventKind)}</strong>
        {e.backupId ? ` from backup ${e.backupId}` : ''}, performed {e.performedAt.text}, recorded by {e.operator} on {e.recordedAt.text}.{' '}
        <StatusChip tone={e.status === 'COMPLETED' ? 'ok' : e.status === 'APPROVED' ? 'info' : 'pending'} label={words(e.status)} />
      </p>
      <p>
        {e.reason} (change record {e.changeReference}). {e.discardedAnchorIds.length} external anchor(s) discarded; {e.affectedChainKeys.length} audit chain(s) lost history
        {e.affectedChainKeys.length > 0 ? `: ${e.affectedChainKeys.join(', ')}` : ''}.
      </p>
      {unexplained.length > 0 ? (
        <Banner tone="error" title={`${String(unexplained.length)} anchor(s) the restore does not explain`}>
          <ul>
            {unexplained.map((c) => (
              <li key={c.anchorId}>
                Anchor {c.anchorId}: {c.problems.join('; ')}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <p>
        Approvers:{' '}
        {e.approvers.map((a) => `${a.legalName} (${a.approvedAt ? `approved ${a.approvedAt.text}` : 'not yet'})`).join(', ')}. Content hash <code>{e.contentHash.slice(0, 16)}…</code>
      </p>
      {e.status === 'RECORDED' && mine && !mine.approvedAt ? (
        <ActButton
          label="Approve this restore"
          disabled={approve.busy}
          onPress={() => approve.sign({ kind: 'RESTORE_APPROVE', restoreEventId: e.restoreEventId }, `Approve the restore recorded by ${e.operator}`)}
        />
      ) : null}
      <ActResult error={approve.error} outcome={approve.outcome} />
      {e.status === 'APPROVED' && admin ? (
        <>
          <Field name={`complete-reason-${e.restoreEventId}`} label="Reason for completing (recorded)" value={reason} onChange={setReason} />
          <ActButton label="4. Complete the restore" disabled={reason.trim().length < 3 || complete.busy} onPress={() => complete.run({ params: { restoreEventId: e.restoreEventId }, body: { reason: reason.trim() } })} />
          <ActResult error={complete.error} done={complete.done} label={complete.done ? `Completed; ${String(complete.done.moves.length)} identifier source(s) moved.` : 'Completed.'} />
        </>
      ) : null}
      {e.status === 'COMPLETED' && e.completedAt ? <p>Completed {e.completedAt.text}; {e.moves.length} identifier source(s) moved past the external ledger.</p> : null}
    </li>
  );
}
