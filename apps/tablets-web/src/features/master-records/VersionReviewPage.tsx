/**
 * Change control, risk assessments, verification evidence and the periodic review of an MBR version (slice 7g WP3,
 * decision 0025; slice 7h, B2-B4; PR-02, PR-05, PR-06, PR-07, DI-04, DI-05):
 *  - the draft's attributes: the change record it cites, the instant it takes effect and the date its periodic review is
 *    due, set by the author (recipe.set_draft_attributes; MBR.AUTHOR);
 *  - the risk assessments it rests on: QA records a versioned assessment (recipe.record_risk_assessment;
 *    MBR.CHANGE_RECORD) and the author links it to the draft, for the whole master or for listed elements, or unlinks one
 *    (recipe.link_risk_assessment, recipe.unlink_risk_assessment; MBR.AUTHOR);
 *  - the verification evidence of the exact current content: the validator report, the simulation's sealed verification
 *    and the test vectors are recorded when the author starts the verification on the designer; the sandbox test run
 *    returns as a test-run result exported from the sandbox's run page, which the author imports here from the exchange
 *    folder or uploads (hash, sandbox stamp and GMP export checked; recipe.record_evidence; decision D-P7R-16);
 *  - the periodic review of an approved version (recipe.record_periodic_review; MBR.APPROVE).
 * Whether the person may, and whether the version's state allows it, is the database's rule; its refusal is shown in its
 * own words.
 */
import { useParams } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { routes, type MbrReviewView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { MASTER_RECORD_READS, stateTone, words } from './reads.ts';

const REVIEW_READS = [...MASTER_RECORD_READS, routes.marketConfig.versionReview.id, routes.marketConfig.riskAssessments.id, routes.marketConfig.sandboxRunResults.id];
const OUTCOMES = [
  { value: 'NO_CHANGE', label: 'No change needed' },
  { value: 'REVISION_REQUIRED', label: 'A revision is required' },
  { value: 'RETIREMENT_PROPOSED', label: 'Retirement proposed' },
] as const;
type Outcome = (typeof OUTCOMES)[number]['value'];

const EVIDENCE_WORDS: Record<MbrReviewView['evidence']['items'][number]['kind'], string> = {
  VALIDATOR: 'Static validation (validator report)',
  VERIFICATION: 'Simulation with coverage (sealed verification)',
  TEST_VECTORS: 'Test vectors confirmed by the author',
  SANDBOX_RUN: 'Sandbox test run on this exact content',
};

export function VersionReviewPage() {
  const params: { versionId?: string } = useParams({ strict: false });
  const versionId = params.versionId ?? '';
  const q = useApiQuery(routes.marketConfig.versionReview, { params: { versionId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading…</p>;
  const v = q.data;
  return (
    <>
      <nav aria-label="Breadcrumb">
        <a href="/mbr">Master records</a> / <a href={`/mbr/versions/${versionId}`}>the version</a> / <a href={`/mbr/versions/${versionId}/signing`}>signatures and markets</a>
      </nav>
      <h1>Change control, risk assessments, evidence and periodic review</h1>
      <p data-testid="review-state">
        Version state: <StatusChip tone={stateTone(v.state)} label={words(v.state)} />
      </p>
      <DraftAttributes versionId={versionId} v={v} />
      <RiskAssessments versionId={versionId} v={v} />
      <Evidence versionId={versionId} v={v} />
      <PeriodicReviews versionId={versionId} v={v} />
    </>
  );
}

/** Slice 7h (B3): the draft's change record, effective-from and periodic-review due date (MBR.AUTHOR; PR-02, PR-05, PR-06). */
function DraftAttributes({ versionId, v }: { versionId: string; v: MbrReviewView }) {
  const set = useCommand(routes.marketConfig.setDraftAttributes, REVIEW_READS);
  const records = useApiQuery(routes.marketConfig.changeRecords, {});
  const [number, setNumber] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reviewDue, setReviewDue] = useState('');
  const [reason, setReason] = useState('');
  const chosen = number.trim() === '' ? undefined : records.data?.changeRecords.find((c) => c.number === number.trim());
  const unknown = number.trim() !== '' && records.data !== undefined && chosen === undefined;
  const dateOk = reviewDue.trim() === '' || /^\d{4}-\d{2}-\d{2}$/.test(reviewDue.trim());
  const any = chosen !== undefined || effectiveFrom.trim() !== '' || reviewDue.trim() !== '';
  const ok = any && !unknown && dateOk && reason.trim() !== '';
  return (
    <Section title="Draft attributes" testId="draft-attributes">
      <p>
        A new master or a change cites its change record; the master takes effect from an instant and its periodic review falls due on a date. The author sets them on
        the draft with a reason; a field left empty keeps its value. Every signature covers them, so a change after a signature supersedes it.
      </p>
      <ul>
        <li data-testid="draft-change-record">Change record: {v.draft.changeRecord ? `${v.draft.changeRecord.number} (${v.draft.changeRecord.title})` : 'none yet'}</li>
        <li data-testid="draft-effective-from">Effective from: {v.draft.effectiveFrom ? v.draft.effectiveFrom.text : 'not set'}</li>
        <li data-testid="draft-review-due">Periodic review due: {v.draft.reviewDue ?? 'not set'}</li>
      </ul>
      <Field name="draftChangeRecord" label="Change record number" value={number} onChange={setNumber} {...(unknown ? { errorMessage: 'No change record has this number: raise it on the change records page first.' } : {})} />
      <Field name="draftEffectiveFrom" label="Effective from (ISO instant with offset, e.g. 2026-11-01T00:00:00+05:30)" value={effectiveFrom} onChange={setEffectiveFrom} />
      <Field name="draftReviewDue" label="Periodic review due (YYYY-MM-DD)" value={reviewDue} onChange={setReviewDue} />
      <Field name="draftReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Set the draft attributes"
        disabled={set.busy || !ok}
        onPress={() =>
          ok &&
          set.run({
            params: { versionId },
            body: {
              ...(chosen ? { changeRecordId: chosen.changeRecordId } : {}),
              ...(effectiveFrom.trim() ? { effectiveFrom: effectiveFrom.trim() } : {}),
              ...(reviewDue.trim() ? { reviewDue: reviewDue.trim() } : {}),
              reason: reason.trim(),
            },
          })
        }
      />
      <ActResult error={set.error} done={set.done} label="The draft attributes are set." />
      <p>
        <a href="/mbr/change-records">Change records</a>
      </p>
    </Section>
  );
}

/** Slice 7h (B2) and 7g WP3: record a risk assessment, link it to the draft, unlink one (PR-07). */
function RiskAssessments({ versionId, v }: { versionId: string; v: MbrReviewView }) {
  const all = useApiQuery(routes.marketConfig.riskAssessments, {});
  const record = useCommand(routes.marketConfig.recordRiskAssessment, REVIEW_READS);
  const link = useCommand(routes.marketConfig.linkRiskAssessment, REVIEW_READS);
  const unlink = useCommand(routes.marketConfig.unlinkRiskAssessment, REVIEW_READS);
  const [code, setCode] = useState('');
  const [version, setVersion] = useState('1');
  const [title, setTitle] = useState('');
  const [riskClass, setRiskClass] = useState('');
  const [rationale, setRationale] = useState('');
  const [subjects, setSubjects] = useState('');
  const recordOk = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(code.trim()) && version.trim() !== '' && title.trim() !== '' && riskClass.trim() !== '' && rationale.trim() !== '';
  const linked = new Set(v.riskAssessments.map((r) => r.riskAssessmentId));
  const linkable = (all.data?.riskAssessments ?? []).filter((r) => !linked.has(r.riskAssessmentId));
  const subjectList = subjects
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  return (
    <Section title="Risk assessments" testId="risk-links">
      <p>
        The risk assessments a draft rests on: every critical parameter and calculation needs one, linked for the whole master or naming the element, before the author
        signs it as prepared. QA records a versioned assessment; the author links it to the draft, or unlinks one that no longer applies. An approved version keeps its
        links.
      </p>
      <h3>Linked to this version</h3>
      {v.riskAssessments.length === 0 ? <p>No risk assessment is linked.</p> : null}
      <ul>
        {v.riskAssessments.map((r) => (
          <li key={r.riskAssessmentId} data-testid={`risk-${r.code}`}>
            {r.code} version {r.version} ({r.riskClass}; {r.rationaleRef}){r.subjects.length > 0 ? `, covering ${r.subjects.join(', ')}` : ', for the whole master'}{' '}
            <ActButton primary={false} label={`Unlink ${r.code} version ${r.version}`} disabled={unlink.busy} onPress={() => unlink.run({ params: { versionId, riskAssessmentId: r.riskAssessmentId }, body: {} })} />
          </li>
        ))}
      </ul>
      <ActResult error={unlink.error} done={unlink.done} label="The risk assessment is unlinked." />
      <h3>Link a recorded assessment</h3>
      <Field name="riskSubjects" label="Elements it covers (ids separated by commas; empty for the whole master)" value={subjects} onChange={setSubjects} />
      {linkable.length === 0 ? <p>No other risk assessment is recorded.</p> : null}
      <ul>
        {linkable.map((r) => (
          <li key={r.riskAssessmentId} data-testid={`linkable-${r.code}-${r.version}`}>
            {r.code} version {r.version}: {r.title} ({r.riskClass}; {r.rationaleRef}), recorded by {r.recordedBy.legalName}{' '}
            <ActButton
              primary={false}
              label={`Link ${r.code} version ${r.version}`}
              disabled={link.busy}
              onPress={() => link.run({ params: { versionId }, body: { riskAssessmentId: r.riskAssessmentId, ...(subjectList.length > 0 ? { subjects: subjectList } : {}) } })}
            />
          </li>
        ))}
      </ul>
      <ActResult error={link.error} done={link.done} label="The risk assessment is linked." />
      <h3>Record a risk assessment</h3>
      <Field name="riskCode" label="Assessment code" value={code} onChange={setCode} />
      <Field name="riskVersion" label="Assessment version" value={version} onChange={setVersion} />
      <Field name="riskTitle" label="Title" value={title} onChange={setTitle} />
      <Field name="riskClass" label="Risk class" value={riskClass} onChange={setRiskClass} />
      <Field name="riskRationale" label="Rationale reference (the QRM report)" value={rationale} onChange={setRationale} />
      <ActButton
        label="Record the risk assessment"
        disabled={record.busy || !recordOk}
        onPress={() => recordOk && record.run({ body: { code: code.trim(), version: version.trim(), title: title.trim(), riskClass: riskClass.trim(), rationaleRef: rationale.trim() } })}
      />
      <ActResult error={record.error} done={record.done} label={record.done ? `Risk assessment ${record.done.code} version ${record.done.version} is recorded.` : 'The risk assessment is recorded.'} />
    </Section>
  );
}

/** Slice 7h (B4, decision D-P7R-16): the evidence of the current content, and the sandbox test-run results to import. */
function Evidence({ versionId, v }: { versionId: string; v: MbrReviewView }) {
  const results = useApiQuery(routes.marketConfig.sandboxRunResults, { params: { versionId } });
  const importer = useCommand(routes.marketConfig.importSandboxRunResult, REVIEW_READS);
  const [uploaded, setUploaded] = useState<{ name: string; text: string } | null>(null);
  const fileId = useId();
  return (
    <Section title="Verification evidence" testId="verification-evidence">
      <p>
        The evidence of the exact current content (any edit voids it). Starting the verification on the designer records the validator report, the simulation&apos;s sealed
        verification and the test vectors. The sandbox test run comes back from the sandbox: export its result on the run page of the sandbox, then import it here from the
        exchange folder, or upload the downloaded file.
      </p>
      <p data-testid="evidence-complete">{v.evidence.complete ? 'The evidence is complete for this content.' : `Still missing: ${v.evidence.missing.join('; ')}.`}</p>
      <ul>
        {v.evidence.items.map((i) => (
          <li key={i.kind} data-testid={`evidence-${i.kind}`} data-result={i.result}>
            {EVIDENCE_WORDS[i.kind]}: {i.result === 'PASS' ? 'passed' : `failed (${i.problems.join('; ')})`}
          </li>
        ))}
      </ul>
      <h3>Sandbox test-run results in the exchange folder</h3>
      {results.error ? <RefusalMessage error={results.error.error} /> : null}
      {results.data && results.data.results.length === 0 ? <p>No test-run result for this version is in the exchange folder.</p> : null}
      <ul>
        {results.data?.results.map((r) => (
          <li key={r.fileName} data-testid={`run-result-${r.batchNumber}`} data-imported={r.imported ? 'yes' : 'no'}>
            Run {r.batchNumber} ({words(r.runStatus)}, {r.passed ? 'passed' : 'not passed'}), exported {r.exportedAt.text} by {r.exporter}
            {r.imported ? '; imported.' : ''}
            {r.problem ? <span> Cannot be imported: {r.problem}</span> : null}{' '}
            <ActButton primary={false} label={`Import the result of run ${r.batchNumber}`} disabled={importer.busy || r.problem !== null} onPress={() => importer.run({ params: { versionId }, body: { fileName: r.fileName } })} />
          </li>
        ))}
      </ul>
      <h3>Upload a test-run result</h3>
      <label htmlFor={fileId}>Result file (.json)</label>{' '}
      <input
        id={fileId}
        name="runResultFile"
        type="file"
        accept="application/json,.json"
        style={{ minHeight: '2.75rem' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return setUploaded(null);
          void f.text().then((text) => setUploaded({ name: f.name, text }));
        }}
      />{' '}
      <ActButton label="Import the uploaded result" disabled={importer.busy || uploaded === null} onPress={() => uploaded && importer.run({ params: { versionId }, body: { text: uploaded.text } })} />
      <ActResult error={importer.error} done={importer.done} label="The sandbox test run is recorded as evidence of this content." />
    </Section>
  );
}

/** Slice 7g WP3: the periodic review of an approved version (MBR.APPROVE; PR-05). */
function PeriodicReviews({ versionId, v }: { versionId: string; v: MbrReviewView }) {
  const record = useCommand(routes.marketConfig.recordPeriodicReview, REVIEW_READS);
  const [outcome, setOutcome] = useState<Outcome>('NO_CHANGE');
  const [summary, setSummary] = useState('');
  const [nextDue, setNextDue] = useState('');
  const ok = summary.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(nextDue.trim());
  return (
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
  );
}
