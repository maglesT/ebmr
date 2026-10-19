/**
 * Continuity alarms (Phase 7 slice 7g, work package 2; kernel 0600; DI-45, DI-23): a failed backup job, restore drill,
 * upgrade drill or hardening check, and a broken audit chain raise an alarm; a person who acknowledges alarms
 * (CONTINUITY.ALARM_ACKNOWLEDGE: the system administrator, the process owner) records what was done with a comment. An
 * alarm is acknowledged once; the database refuses a second acknowledgement and an empty comment.
 */
import { useState } from 'react';
import { routes, type ContinuityAlarmView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ALARM_READS, words } from './reads.ts';

export function AlarmsPage() {
  const q = useApiQuery(routes.operations.alarms);
  const open = (q.data?.alarms ?? []).filter((a) => a.acknowledgement === null);
  const done = (q.data?.alarms ?? []).filter((a) => a.acknowledgement !== null);
  return (
    <>
      <h1>Continuity alarms</h1>
      <p>Failed backups, drills and hardening checks, and broken audit chains. Acknowledge each with what was done about it.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Open" testId="alarms-open">
        {q.data && open.length === 0 ? <p>No open alarm.</p> : null}
        <ul>
          {open.map((a) => (
            <Alarm key={a.alarmId} a={a} />
          ))}
        </ul>
      </Section>
      <Section title="Acknowledged" testId="alarms-acknowledged">
        <ul>
          {done.map((a) => (
            <Alarm key={a.alarmId} a={a} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function Alarm({ a }: { a: ContinuityAlarmView }) {
  const ack = useCommand(routes.operations.acknowledgeAlarm, ALARM_READS);
  const [comment, setComment] = useState('');
  return (
    <li data-testid={`alarm-${a.alarmId}`} data-code={a.code}>
      <p>
        <StatusChip tone={a.severity === 'WARNING' ? 'warning' : 'error'} label={words(a.severity)} /> <strong>{a.code}</strong>: {a.subject} ({a.raisedAt.text})
      </p>
      <details>
        <summary style={{ minHeight: '2.75rem', paddingBlock: '0.65rem', cursor: 'pointer' }}>Details</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{a.details}</pre>
      </details>
      {a.acknowledgement ? (
        <p>
          Acknowledged by {a.acknowledgement.by} on {a.acknowledgement.at.text}: {a.acknowledgement.comment}
        </p>
      ) : (
        <>
          <Field name={`alarm-comment-${a.alarmId}`} label={`What was done (${a.code})`} value={comment} onChange={setComment} />
          <ActButton label="Acknowledge" disabled={comment.trim() === '' || ack.busy} onPress={() => ack.run({ params: { alarmId: a.alarmId }, body: { comment: comment.trim() } })} />
          <ActResult error={ack.error} done={ack.done} label="Acknowledged." />
        </>
      )}
    </li>
  );
}
