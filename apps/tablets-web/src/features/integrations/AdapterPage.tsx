/**
 * One adapter (Phase 6 slice 6a; DI-31): its health, the newest accepted messages, the newest refusals (each with its
 * alarm), and its reconciliation reports.
 */
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { useRouteParams } from '../floor/params.ts';
import { Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { age, freshnessText, words } from './reads.ts';

export function AdapterPage() {
  const adapterCode = useRouteParams()['adapterCode'] ?? '';
  const q = useApiQuery(routes.integrations.adapter, { params: { adapterCode } });
  const recs = useApiQuery(routes.integrations.reconciliations, { params: { adapterCode } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const d = q.data;
  if (!d) return <p>Loading the adapter.</p>;
  const h = d.health;
  return (
    <>
      <h1>
        Adapter {h.adapterCode} ({words(h.sourceSystem)})
      </h1>
      <p data-testid="adapter-health">
        {h.description}. Status {words(h.status)}; data age {age(h.dataAgeSeconds)}; {h.openAlarms} open alarm(s).
      </p>
      <p data-testid="adapter-worker">
        {h.worker
          ? `Worker on this server: ${words(h.worker.state)}; handled up to message ${h.worker.cursor} of ${h.worker.head ?? '(no answer yet)'}; ${h.worker.cycles} cycle(s), ${h.worker.accepted} accepted, ${h.worker.duplicates} duplicate(s), ${h.worker.refused} refused${h.worker.lastError ? `; last error: ${h.worker.lastError}` : ''}.`
          : 'No worker runs for this adapter on this server (its system is STAND_IN here, or no endpoint is configured).'}
      </p>
      <ul>
        {h.mirrors.map((m) => (
          <li key={m.dataClass}>
            {words(m.dataClass)}: {freshnessText(m)}
          </li>
        ))}
      </ul>
      <Section title="Messages accepted (newest first)" testId="adapter-messages">
        <table>
          <thead>
            <tr>
              <th scope="col">Sequence</th>
              <th scope="col">Message</th>
              <th scope="col">Source time</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {d.messages.map((m) => (
              <tr key={m.messageId}>
                <th scope="row">
                  {m.sequenceNo} {m.sequenceStatus === 'GAP' || m.sequenceStatus === 'LATE' ? <StatusChip tone="warning" label={words(m.sequenceStatus)} /> : null}
                </th>
                <td>
                  {m.messageType} {m.sourceRecordId}
                </td>
                <td>{m.sourceTimestamp.text}</td>
                <td>{m.receivedAt.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Messages refused (newest first)" testId="adapter-refusals">
        {d.refusals.length === 0 ? <p>None refused.</p> : null}
        <ul>
          {d.refusals.map((r) => (
            <li key={r.refusalId}>
              <StatusChip tone="error" label={words(r.errorClass)} /> sequence {r.sequenceNo ?? 'unreadable'} at {r.recordedAt.text}: {r.detail}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Reconciliation" testId="adapter-reconciliations">
        {recs.data && recs.data.reports.length === 0 ? <p>No reconciliation yet.</p> : null}
        <ul>
          {recs.data?.reports.map((r) => (
            <li key={r.reportId}>
              {r.matched ? <StatusChip tone="ok" label="Matched" /> : <StatusChip tone="error" label="Mismatch" />} {r.periodFrom.text} to {r.periodTo.text}: the source sent {r.sourceCount},
              this site received {r.receivedCount} ({r.acceptedCount} accepted, {r.refusedCount} refused)
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
