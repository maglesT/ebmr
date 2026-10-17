/**
 * The audit-trail review of a batch record (Phase 4 slice 1; DI-25, INV-48, outline 5.4): the report the server builds
 * for the batch and the records linked to it (review.auditTrail), read from the last signed mark of the cycle. The
 * panel shows the scope, the high-water mark the review will cover per chain (and the previous mark for a delta review),
 * the events with the critical ones marked (D-P4-16), and whether the last signed mark covers everything. The review is
 * signed on the report's own review id (REVIEW_ACT AUDIT_TRAIL_REVIEW for a full review, DELTA_REVIEW for the events
 * after the last mark); the kind and the id are the server's.
 *
 * Phase 6A slice 6A-4 (DI-25, DI-53): for a data-integrity reviewer, the entries that audit-trail flags name are listed
 * first and highlighted (analytics-audit/FlaggedEntries.tsx). Every entry is still listed and the review is unchanged.
 */
import { routes, type AuditTrailReportView } from '@ebmr/api-contract';
import { Banner, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { flagNote, flaggedFirst, useFlaggedEntries } from '../analytics-audit/FlaggedEntries.tsx';
import { GateProblems } from './parts.tsx';
import { REVIEW_READS } from './reads.ts';

export function AuditTrailPanel({ batchId, gate, offered }: { batchId: string; gate: { ready: boolean; problems: string[] }; offered: boolean }) {
  const q = useApiQuery(routes.review.auditTrail, { params: { batchId }, query: {} });
  const signed = useSignedAct(REVIEW_READS);
  const r = q.data;
  return (
    <Section title="Audit-trail review" testId="audit-trail-review">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {r ? <Report report={r} batchId={batchId} /> : null}
      <GateProblems gate={gate} testId="audit-trail-problems" />
      {offered && r ? (
        <ActButton
          label={r.kind === 'DELTA' ? 'Sign the delta review' : 'Sign the audit-trail review'}
          onPress={() =>
            signed.sign(
              { kind: 'REVIEW_ACT', act: r.kind === 'DELTA' ? 'DELTA_REVIEW' : 'AUDIT_TRAIL_REVIEW', batchId, input: { reviewId: r.reviewId } },
              `${r.kind === 'DELTA' ? 'Delta review' : 'Audit-trail review'} ${r.reviewId}: ${r.eventCount} events up to the high-water mark`,
            )
          }
          disabled={r.covered || !gate.ready || signed.busy}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function Report({ report: r, batchId }: { report: AuditTrailReportView; batchId: string }) {
  const flagged = useFlaggedEntries(batchId);
  const events = flaggedFirst(r.events, flagged);
  const shownFlagged = events.filter((e) => flagged.has(`${e.chainKey}#${e.eventId}`)).length;
  const label = (chainKey: string) => r.scope.find((s) => s.chainKey === chainKey)?.label ?? chainKey;
  const critical = r.events.filter((e) => e.critical).length;
  return (
    <>
      <p data-testid="audit-trail-summary">
        {r.kind === 'DELTA' ? 'Delta review' : 'Full review'} {r.reviewId}: {r.eventCount} events in scope, {critical} critical.{' '}
        {r.covered ? <StatusChip tone="ok" label="Covered by the last signed mark" /> : <StatusChip tone="warning" label={r.kind === 'DELTA' ? 'A delta review is due' : 'Not reviewed yet'} />}
      </p>
      {r.truncated ? <Banner tone="warning" title={`The report lists the first ${r.events.length} of ${r.eventCount} events; the signature covers all of them up to the mark.`} /> : null}
      <table data-testid="audit-trail-marks">
        <caption>High-water mark per record (last audit sequence number covered)</caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Kind</th>
            {r.fromMark ? <th scope="col">From (last mark)</th> : null}
            <th scope="col">Up to</th>
          </tr>
        </thead>
        <tbody>
          {r.scope.map((s) => (
            <tr key={s.chainKey}>
              <td>{s.label}</td>
              <td>{s.kind}</td>
              {r.fromMark ? <td>{r.fromMark[s.chainKey] ?? '-'}</td> : null}
              <td>{r.highWater[s.chainKey] ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shownFlagged > 0 ? (
        <p data-testid="audit-trail-flagged-note">
          {shownFlagged} entries named by audit-trail flags are listed first (advisory, for data-integrity review); every entry is listed and the review is unchanged.
        </p>
      ) : null}
      <table data-testid="audit-trail-events">
        <caption>Events</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Record</th>
            <th scope="col">Sequence</th>
            <th scope="col">Action</th>
            <th scope="col">Table and row</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const f = flagged.get(`${e.chainKey}#${e.eventId}`);
            return (
            <tr key={e.eventId} data-critical={e.critical ? 'true' : undefined} data-flagged={f ? 'true' : undefined}>
              <td>{e.at.text}</td>
              <td>{label(e.chainKey)}</td>
              <td>{e.seq}</td>
              <td>{e.action}</td>
              <td>{e.table ? `${e.table} ${e.recordId ?? ''}` : '-'}</td>
              <td>
                {e.critical ? <StatusChip tone="error" label="Critical: changed shortly before use" /> : null} {e.linked ? <StatusChip tone="neutral" label="Linked record" /> : null}{' '}
                {f ? <StatusChip tone="warning" label={flagNote(f)} /> : null}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      <p>
        Report hash <code>{r.reportHash}</code>
      </p>
    </>
  );
}
