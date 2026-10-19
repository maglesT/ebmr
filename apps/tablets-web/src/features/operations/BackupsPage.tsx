/**
 * Backups (Phase 7 slice 7g-4; DI-45; kernel 1376): the system administrator takes an operational backup now with a
 * reason (CONTINUITY.BACKUP_RUN); the server's backup job runs it as the kernel's job always does (pg_dump, encrypted at
 * rest, hashed, with a manifest) and the backup service identity records it. The catalogue shows every backup with its
 * size, time and SHA-256 (CONTINUITY.BACKUP_READ: the administrator, the process owner, QA), the job runs (a failed one
 * raised an alarm) and the requests; a copy of a stored artefact is taken as stored, encrypted, and the copy recorded.
 * Retention-grade backups go to write-once storage on the backup host's schedule, not from here.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type BackupView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import type { CallError } from '@ebmr/api-contract';
import { BACKUP_READS, bytes } from './reads.ts';

function BackupRow({ b }: { b: BackupView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [href, setHref] = useState<{ url: string; name: string } | null>(null);
  const fetchCopy = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.call(routes.operations.backupFile, { params: { backupId: b.backupId } });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setHref({ url: `data:application/octet-stream;base64,${r.value.contentBase64}`, name: r.value.fileName });
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid={`backup-${b.backupId}`}>
      <th scope="row">
        {b.backupId}
        <br />
        <StatusChip tone="info" label={b.tier === 'OPERATIONAL' ? 'Operational' : 'Retention grade'} />
      </th>
      <td>{b.recordedAt.text}</td>
      <td>{bytes(b.sizeBytes)}</td>
      <td>
        <code data-testid={`backup-hash-${b.backupId}`}>{b.sha256}</code>
      </td>
      <td>
        {b.storageUri}
        <br />
        Key {b.encryptionKeyRef}
        {b.immutableUntil ? `, write-once until ${b.immutableUntil}` : ''}
      </td>
      <td>
        {b.downloadable ? (
          href ? (
            <a href={href.url} download={href.name} data-testid={`backup-download-${b.backupId}`}>
              Save {href.name}
            </a>
          ) : (
            <ActButton label="Take a copy" primary={false} disabled={busy} onPress={fetchCopy} />
          )
        ) : (
          'Held by the backup store'
        )}
        {error ? <RefusalMessage error={error} /> : null}
      </td>
    </tr>
  );
}

export function BackupsPage() {
  const view = useApiQuery(routes.operations.backups);
  const run = useCommand(routes.operations.runBackup, BACKUP_READS);
  const [reason, setReason] = useState('');
  const v = view.data;
  return (
    <>
      <h1>Backups</h1>
      <p>
        A backup is a copy of the whole database at one moment, encrypted and hashed, kept with a manifest. Every backup job is recorded, a failed one with an alarm; the
        restore drill (<Link to="/operations/drills">drills</Link>) proves a backup can be restored.
      </p>
      {view.error ? <RefusalMessage error={view.error.error} /> : null}
      {v && !v.configured ? (
        <Banner tone="warning" title="This server does not take backups from the screen yet.">
          <p>{v.problem}</p>
        </Banner>
      ) : null}
      <Section title="Take a backup now" testId="backup-run">
        <Field name="backup-reason" label="Reason (recorded with the request)" value={reason} onChange={setReason} />
        <ActButton
          label="Take a backup now"
          disabled={reason.trim().length < 3 || run.busy || v?.configured === false}
          onPress={() => run.run({ body: { reason: reason.trim(), tier: 'OPERATIONAL' } })}
        />
        {run.busy ? <p>Taking the backup…</p> : null}
        <ActResult
          error={run.error}
          done={run.done}
          label={run.done?.run ? `Backup ${run.done.run.backupId ?? ''} ${run.done.run.status === 'SUCCEEDED' ? 'taken' : 'failed'}.` : 'Requested.'}
        />
        {run.done?.error ? <Banner tone="error" title="The backup job failed; it is recorded with its alarm."><p>{run.done.error}</p></Banner> : null}
      </Section>
      <Section title="Backups" testId="backup-list">
        {v && v.backups.length === 0 ? <p>No backup is in the catalogue.</p> : null}
        {v && v.backups.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Backup</th>
                <th scope="col">Taken</th>
                <th scope="col">Size</th>
                <th scope="col">SHA-256</th>
                <th scope="col">Stored</th>
                <th scope="col">Copy</th>
              </tr>
            </thead>
            <tbody>
              {v.backups.map((b) => (
                <BackupRow key={b.backupId} b={b} />
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      <Section title="Backup jobs" testId="backup-runs">
        {v && v.runs.length === 0 ? <p>No backup job has run.</p> : null}
        <ul>
          {v?.runs.map((r) => (
            <li key={r.jobRunId}>
              <StatusChip tone={r.status === 'SUCCEEDED' ? 'ok' : 'error'} label={r.status === 'SUCCEEDED' ? 'Succeeded' : 'Failed'} /> {r.jobName}, {r.startedAt.text} to {r.finishedAt.text}
              {r.error ? `: ${r.error}` : ''}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Requests" testId="backup-requests">
        <ul>
          {v?.requests.map((q) => (
            <li key={q.requestId}>
              {q.recordedAt.text}: {q.by}, {q.reason}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
