/**
 * The background workers (Phase 7 slice 7g-4): each integration adapter's worker and the analytics runner, with its
 * state and why it does not run (an adapter refused on its transport names EBMR-INT-034), started, stopped or restarted
 * with a reason by the system administrator (PLATFORM.OPERATE, kernel 1376); the last operations with who did them. The
 * panel sits on the operations console and on the integration health page.
 */
import { useState } from 'react';
import { routes, type WorkerView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { WORKER_READS, words } from './reads.ts';

const tone = (w: WorkerView) => (w.running ? (w.state === 'RETRYING' || w.state === 'BLOCKED' ? 'warning' : 'ok') : w.problem ? 'error' : 'neutral');

function WorkerRow({ w, reason }: { w: WorkerView; reason: string }) {
  const control = useCommand(routes.operations.controlWorker, WORKER_READS);
  const run = (action: 'START' | 'STOP' | 'RESTART') => control.run({ params: { code: w.code }, body: { action, reason: reason.trim() } });
  const noReason = reason.trim().length < 3 || control.busy;
  return (
    <tr data-testid={`worker-${w.code}`} data-running={String(w.running)}>
      <th scope="row">
        {w.code}
        {w.sourceSystem ? ` (${words(w.sourceSystem)})` : w.kind === 'ANALYTICS' ? ' (analytics runner)' : ''}
      </th>
      <td>
        <StatusChip tone={tone(w)} label={words(w.state)} />
        {w.problem ? <p data-testid={`worker-problem-${w.code}`}>{w.problem}</p> : null}
      </td>
      <td>
        {w.running ? (
          <>
            <ActButton label={`Stop ${w.code}`} disabled={noReason} onPress={() => run('STOP')} />{' '}
            <ActButton label={`Restart ${w.code}`} primary={false} disabled={noReason} onPress={() => run('RESTART')} />
          </>
        ) : (
          <ActButton label={`Start ${w.code}`} disabled={noReason} onPress={() => run('START')} />
        )}
        <ActResult error={control.error} done={control.done} label={control.done ? `${control.done.code} is ${control.done.running ? 'running' : 'stopped'}.` : 'Done.'} />
      </td>
    </tr>
  );
}

export function WorkersPanel() {
  const workers = useApiQuery(routes.operations.workers, {}, { refetchInterval: 5000 });
  const [reason, setReason] = useState('');
  return (
    <Section title="Background workers" testId="operations-workers">
      {workers.error ? <RefusalMessage error={workers.error.error} /> : null}
      {workers.data && workers.data.workers.length === 0 ? <p>This server runs no background worker (no adapter is registered, and the analytics runner is off or not on this installation).</p> : null}
      {workers.data && workers.data.workers.length > 0 ? (
        <>
          <Field name="worker-reason" label="Reason (recorded with the start, stop or restart)" value={reason} onChange={setReason} />
          <table>
            <thead>
              <tr>
                <th scope="col">Worker</th>
                <th scope="col">State</th>
                <th scope="col">Act</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.workers.map((w) => (
                <WorkerRow key={w.code} w={w} reason={reason} />
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {workers.data && workers.data.acts.length > 0 ? (
        <>
          <h3>Last operations</h3>
          <ul data-testid="worker-acts">
            {workers.data.acts.map((a) => (
              <li key={`${a.at.us}-${a.act}-${a.target}`}>
                {a.at.text}: {words(a.act)} {a.target} by {a.by} ({a.reason}){a.outcome === 'REFUSED' ? `: refused, ${a.detail ?? ''}` : ''}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}

export function WorkersPage() {
  return (
    <>
      <h1>Background workers</h1>
      <p>
        The server runs one worker per integration adapter the site runs as a mirror, and the advisory analytics runner on the GMP installation. Stopping a worker stops its
        synchronisation: a mirrored data class becomes stale after its bound, and the steps that read it are refused until it runs again.
      </p>
      <WorkersPanel />
    </>
  );
}
