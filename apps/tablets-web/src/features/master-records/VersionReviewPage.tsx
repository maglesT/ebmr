/**
 * The periodic review of an MBR version and its risk-assessment links (slice 7g WP3, decision 0025; PR-05, PR-07): QA
 * records the review of an approved version with its outcome, a summary and the next due date (a date in the future);
 * the author unlinks a risk assessment from a draft. Whether the person may, and whether the version's state allows it,
 * is the database's rule; its refusal is shown in its own words.
 */
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { MASTER_RECORD_READS, stateTone, words } from './reads.ts';

const REVIEW_READS = [...MASTER_RECORD_READS, routes.marketConfig.versionReview.id];
const OUTCOMES = [
  { value: 'NO_CHANGE', label: 'No change needed' },
  { value: 'REVISION_REQUIRED', label: 'A revision is required' },
  { value: 'RETIREMENT_PROPOSED', label: 'Retirement proposed' },
] as const;
type Outcome = (typeof OUTCOMES)[number]['value'];

export function VersionReviewPage() {
  const params: { versionId?: string } = useParams({ strict: false });
  const versionId = params.versionId ?? '';
  const q = useApiQuery(routes.marketConfig.versionReview, { params: { versionId } });
  const record = useCommand(routes.marketConfig.recordPeriodicReview, REVIEW_READS);
  const unlink = useCommand(routes.marketConfig.unlinkRiskAssessment, REVIEW_READS);
  const [outcome, setOutcome] = useState<Outcome>('NO_CHANGE');
  const [summary, setSummary] = useState('');
  const [nextDue, setNextDue] = useState('');
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading…</p>;
  const v = q.data;
  const ok = summary.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(nextDue.trim());
  return (
    <>
      <h1>Periodic review and risk assessments</h1>
      <p data-testid="review-state">
        Version state: <StatusChip tone={stateTone(v.state)} label={words(v.state)} />
      </p>
      <Section title="Periodic reviews" testId="periodic-reviews">
        <p>An approved master is reviewed periodically. The review records its outcome and the date the next review is due, which lies in the future.</p>
        {v.reviews.length === 0 ? <p>No periodic review is recorded for this version.</p> : null}
        <ul>
          {v.reviews.map((r) => (
            <li key={r.reviewId}>
              {words(r.outcome)}: {r.summary}. Next due {r.nextDue}. Reviewed by {r.reviewedBy.legalName} {r.recordedAt.text}.
            </li>
          ))}
        </ul>
        <floor.ChoiceGroup label="Outcome" options={OUTCOMES.map((o) => ({ value: o.value, label: o.label }))} value={outcome} onChange={(x) => setOutcome(x as Outcome)} />
        <Field name="reviewSummary" label="Summary of the review" value={summary} onChange={setSummary} />
        <Field name="reviewNextDue" label="Next review due (YYYY-MM-DD)" value={nextDue} onChange={setNextDue} />
        <ActButton
          label="Record the periodic review"
          disabled={record.busy || !ok}
          onPress={() => ok && record.run({ params: { versionId }, body: { outcome, summary: summary.trim(), nextDue: nextDue.trim() } })}
        />
        <ActResult error={record.error} done={record.done} label="The periodic review is recorded." />
      </Section>
      <Section title="Risk assessments linked" testId="risk-links">
        <p>The risk assessments a draft rests on. The author may unlink one that no longer applies; an approved version keeps its links.</p>
        {v.riskAssessments.length === 0 ? <p>No risk assessment is linked.</p> : null}
        <ul>
          {v.riskAssessments.map((r) => (
            <li key={r.riskAssessmentId} data-testid={`risk-${r.code}`}>
              {r.code} version {r.version} ({r.riskClass}; {r.rationaleRef}){' '}
              <ActButton primary={false} label={`Unlink ${r.code} version ${r.version}`} disabled={unlink.busy} onPress={() => unlink.run({ params: { versionId, riskAssessmentId: r.riskAssessmentId }, body: {} })} />
            </li>
          ))}
        </ul>
        <ActResult error={unlink.error} done={unlink.done} label="The risk assessment is unlinked." />
      </Section>
    </>
  );
}
