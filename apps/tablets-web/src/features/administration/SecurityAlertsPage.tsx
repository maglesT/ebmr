/**
 * Security alerts (Phase 7 slice 7g, work package 2; kernel 0100, 0130; DI-19): failed sign-ins and signatures, locked,
 * disabled or blocked use, break-glass use and the rest are raised as alerts; a person who acknowledges them
 * (IAM.ALERT_ACKNOWLEDGE: the system administrator, QA on the shop floor) records what was found with a comment. An alert
 * left unanswered escalates. Nobody acknowledges an alert about themselves: the database refuses it, and the page does not
 * offer it.
 */
import { useState } from 'react';
import { routes, type SecurityAlertView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ALERT_READS, useSessionPerson, words } from './shared.tsx';

export function SecurityAlertsPage() {
  const q = useApiQuery(routes.people.alerts);
  const me = useSessionPerson();
  const open = (q.data?.alerts ?? []).filter((a) => a.acknowledgement === null);
  const done = (q.data?.alerts ?? []).filter((a) => a.acknowledgement !== null);
  return (
    <>
      <h1>Security alerts</h1>
      <p>Each alert is acknowledged with what was found; an alert left unanswered escalates. Nobody acknowledges an alert about themselves.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Unanswered" testId="alerts-open">
        {q.data && open.length === 0 ? <p>No alert is waiting.</p> : null}
        <ul>
          {open.map((a) => (
            <Alert key={a.alertId} a={a} me={me} />
          ))}
        </ul>
      </Section>
      <Section title="Acknowledged" testId="alerts-acknowledged">
        <ul>
          {done.map((a) => (
            <Alert key={a.alertId} a={a} me={me} />
          ))}
        </ul>
      </Section>
    </>
  );
}

function Alert({ a, me }: { a: SecurityAlertView; me: string | null }) {
  const ack = useCommand(routes.people.acknowledgeAlert, ALERT_READS, 'acknowledging a security alert');
  const [comment, setComment] = useState('');
  const aboutMe = me !== null && a.person?.personId === me;
  const who = [a.person?.legalName, a.loginName, a.deviceCode].filter((x) => x).join(', ');
  return (
    <li data-testid={`alert-${a.alertId}`} data-kind={a.kind}>
      <p>
        <StatusChip tone={a.severity === 'LOW' ? 'info' : a.severity === 'MEDIUM' ? 'warning' : 'error'} label={words(a.severity)} /> <strong>{words(a.kind)}</strong>
        {who ? ` (${who})` : ''}, {a.raisedAt.text}. {a.escalated ? <StatusChip tone="error" label="Escalated" /> : null}
      </p>
      {a.acknowledgement ? (
        <p>
          Acknowledged by {a.acknowledgement.by.legalName} on {a.acknowledgement.at.text}: {a.acknowledgement.comment}
        </p>
      ) : aboutMe ? (
        <p>This alert is about you, so another person acknowledges it.</p>
      ) : (
        <>
          <Field name={`alert-comment-${a.alertId}`} label={`What was found (${words(a.kind)})`} value={comment} onChange={setComment} />
          <ActButton label="Acknowledge" disabled={comment.trim() === '' || ack.busy} onPress={() => ack.run({ params: { alertId: a.alertId }, body: { comment: comment.trim() } })} />
          <ActResult error={ack.error} done={ack.done} label="Acknowledged." />
        </>
      )}
    </li>
  );
}
