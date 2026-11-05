/**
 * The alarm log of a batch (DI-49), on the batch review screen (the whole batch) and on the floor step screen (one
 * step): each alarm bound to the batch with its raise and clear times at the source, its acknowledgment (time, person,
 * action taken, comment, deviation reference), the GMP-critical flag and the step; an open one is acknowledged here.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Acknowledgement, Flags, reading } from './AlarmParts.tsx';
import { useScreensOff } from '../../app/disconnected.tsx';

export function BatchAlarmLog({ batchId, step }: { batchId: string; step?: string }) {
  const off = useScreensOff();
  const q = useApiQuery(routes.alarms.batchLog, { params: { batchId }, query: step ? { step } : {} });
  const title = step ? 'Alarms at this step' : 'Alarm log of the batch';
  return (
    <section aria-label={title} data-testid="batch-alarm-log">
      <h2>{title}</h2>
      {step || off('/trends') ? null : (
        <p>
          <Link to="/trends" search={{ batchId }} data-testid="batch-trends-link">
            Trends of the batch (native equipment and room data)
          </Link>
        </p>
      )}
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.alarms.length === 0 ? <p>No alarm.</p> : null}
      {q.data && q.data.alarms.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Alarm</th>
              <th scope="col">Step</th>
              <th scope="col">Raised at source</th>
              <th scope="col">Cleared at source</th>
              <th scope="col">Acknowledgment</th>
            </tr>
          </thead>
          <tbody>
            {q.data.alarms.map((a) => (
              <tr key={a.alarmId} data-testid={`batch-alarm-${a.alarmId}`}>
                <th scope="row">
                  {a.source} {a.subject.code} {a.alarmCode}: {a.message} {reading(a)} <Flags a={a} />
                </th>
                <td>{a.batches.find((b) => b.batchId === batchId)?.step ?? 'Batch'}</td>
                <td>{a.raisedAtSource.text}</td>
                <td>{a.clearedAtSource ? a.clearedAtSource.text : 'Not cleared'}</td>
                <td>
                  <Acknowledgement a={a} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
