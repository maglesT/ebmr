/**
 * A list of notifications as the server reads them (notifications.list): about one subject (every department's, so the
 * release cockpit shows that production and QA were both notified) or the session's departments. A person of the
 * notification's department acknowledges it as themselves (notifications.acknowledge, a fresh badge tap on a shared
 * terminal through acts.tsx); whether they may is the server's answer (mayAcknowledge).
 */
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

export const NOTIFICATION_READS: readonly string[] = [routes.notifications.list.id];

const DEPARTMENT: Readonly<Record<string, string>> = { PRODUCTION: 'Production', QA: 'Quality assurance' };

export function NotificationList({ subjectId, openOnly = false, empty }: { subjectId?: string; openOnly?: boolean; empty: string }) {
  const query = { ...(subjectId !== undefined ? { subjectId } : {}), ...(openOnly ? { open: 'true' as const } : {}) };
  const q = useApiQuery(routes.notifications.list, { query });
  const ack = useCommand(routes.notifications.acknowledge, NOTIFICATION_READS, 'the acknowledgement of a notification');
  return (
    <>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.notifications.length === 0 ? <p>{empty}</p> : null}
      <ul data-testid="notifications">
        {q.data?.notifications.map((n) => (
          <li key={n.notificationId} data-testid={`notification-${n.department}`} data-subject={n.subjectId}>
            <StatusChip tone={n.event === 'MANUFACTURER_RELEASED' ? 'ok' : 'error'} label={DEPARTMENT[n.department] ?? n.department} /> {n.message} ({n.at.text})
            {n.acknowledgements.length > 0 ? (
              <span> Acknowledged by {n.acknowledgements.map((a) => `${a.by.legalName}, ${a.at.text}`).join('; ')}.</span>
            ) : (
              <span> Not acknowledged yet.</span>
            )}
            {n.mayAcknowledge ? (
              <ActButton primary={false} label={`Acknowledge (${DEPARTMENT[n.department] ?? n.department})`} onPress={() => ack.run({ params: { notificationId: n.notificationId }, body: {} })} disabled={ack.busy} />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={ack.error} done={ack.done} label="Acknowledged." />
    </>
  );
}
