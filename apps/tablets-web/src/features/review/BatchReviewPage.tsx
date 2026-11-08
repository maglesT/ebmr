/**
 * One batch record in review (Phase 4 slice 1; outline 5.2.2, 7.3): its state, cycle and evidence epoch, the signed
 * acts of the review, and the signed acts that are due, each with the database's own reasons why it cannot be given yet
 * (the gates of review.batch, shown in the server's words):
 *  - production approval (REVIEW_ACT PRODUCTION_APPROVE; the abort checklist first for an ABORTED record, and the
 *    English translation of free text verified by a second person on a US or EU batch, D-P4-12);
 *  - the audit-trail review with its high-water mark and the delta review (AuditTrailPanel);
 *  - the QA review (REVIEW_ACT QA_REVIEW with the evidence epoch the reviewer saw: a later change refuses it);
 *  - the reopen with QA's reason (REVIEW_ACT REOPEN of the cycle shown).
 * What each act signs (aggregate, meaning) is the server's (esig.describe); the browser builds no aggregate id.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type BatchReviewView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { cls } from '../../app/classes.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { BatchAlarmLog } from '../plant-status/BatchAlarmLog.tsx';
import { AuditTrailPanel } from './AuditTrailPanel.tsx';
import { GateProblems } from './parts.tsx';
import { REVIEW_READS, stateTone, words } from './reads.ts';
import { BatchRecordPdfButton } from '../archive/BatchRecordPdf.tsx';

export function BatchReviewPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const q = useApiQuery(routes.review.batch, { params: { batchId } });
  const v = q.data;
  return (
    <>
      <h1>Review of batch {v ? v.batchNumber : batchId}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? <BatchReview view={v} /> : null}
    </>
  );
}

function BatchReview({ view: v }: { view: BatchReviewView }) {
  const qa = useOffered('QA');
  const production = useOffered('PRODUCTION_HEAD');
  return (
    <>
      <p data-testid="review-state">
        <StatusChip tone={stateTone(v.reviewState)} label={words(v.reviewState)} /> {v.product}, {words(v.recordKind)} record · execution {words(v.executionStatus)} · review cycle {v.cycle} · evidence epoch {v.epoch} · markets{' '}
        {v.markets.join(', ')} · {v.mode === 'FULL' ? 'every item reviewed one by one' : 'review by exception'}
      </p>
      <nav aria-label="Review of the record">
        <ul className={cls('linkList')}>
          <li>
            <Link to="/review/$batchId/register" params={{ batchId: v.batchId }}>
              Exception register ({v.items.total} items: {v.items.open} open, {v.items.concluded} concluded, {v.items.critical} critical)
            </Link>
          </li>
          <li>
            <Link to="/review/$batchId/containers" params={{ batchId: v.batchId }}>
              Output containers
            </Link>
          </li>
          <li>
            <Link to="/release/batches/$batchId" params={{ batchId: v.batchId }}>
              Markets of the batch (add or remove)
            </Link>
          </li>
        </ul>
      </nav>
      <BatchRecordPdfButton batchId={v.batchId} />
      {v.pausedSteps.length > 0 ? (
        <Banner tone="warning" title="Review by exception is paused for some steps (three deviations): their items are reviewed one by one.">
          <ul>
            {v.pausedSteps.map((s) => (
              <li key={s.stepId}>
                {s.stepId}: {s.deviations} deviations
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Section title="Signed acts of the review" testId="review-acts">
        {v.acts.length === 0 ? <p>None yet.</p> : null}
        <ul>
          {v.acts.map((a) => (
            <li key={a.signatureId}>
              {words(a.act)} (cycle {a.cycle}) by {a.by.legalName}, {a.at.text}
              {a.reason ? `: ${a.reason}` : ''} {a.valid ? null : <StatusChip tone="neutral" label="Superseded" />}
            </li>
          ))}
        </ul>
      </Section>
      {v.reviewState === 'ABORTED' ? <AbortChecklist view={v} /> : null}
      {v.freeText.length > 0 ? <FreeText view={v} /> : null}
      {/* Phase 6 slice 6b (DI-49): the batch's alarm log with the acknowledgment of open alarms. */}
      <BatchAlarmLog batchId={v.batchId} />
      <ProductionApproval view={v} offered={production} />
      <AuditTrailPanel batchId={v.batchId} gate={v.gates.auditTrailReview} offered={qa} />
      <QaReview view={v} offered={qa} />
      <Reopen view={v} offered={qa} />
    </>
  );
}

function ProductionApproval({ view: v, offered }: { view: BatchReviewView; offered: boolean }) {
  const signed = useSignedAct(REVIEW_READS);
  const gate = v.gates.productionApprove;
  return (
    <Section title="Production approval" testId="production-approval">
      <GateProblems gate={gate} testId="production-approval-problems" />
      {offered ? (
        <ActButton
          label="Approve the record (production)"
          onPress={() => signed.sign({ kind: 'REVIEW_ACT', act: 'PRODUCTION_APPROVE', batchId: v.batchId, input: {} }, `Approve the ${v.recordKind.toLowerCase()} record of batch ${v.batchNumber} (production)`)}
          disabled={!gate.ready || signed.busy}
        />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function QaReview({ view: v, offered }: { view: BatchReviewView; offered: boolean }) {
  const signed = useSignedAct(REVIEW_READS);
  const gate = v.gates.qaReview;
  return (
    <Section title="QA review" testId="qa-review">
      <GateProblems gate={gate} testId="qa-review-problems" />
      {offered ? (
        <>
          <p>The review is signed on the record as you see it now (evidence epoch {v.epoch}); a change after you read it refuses the signature.</p>
          <ActButton
            label="Sign the QA review"
            onPress={() => signed.sign({ kind: 'REVIEW_ACT', act: 'QA_REVIEW', batchId: v.batchId, input: { expectedEpoch: v.epoch } }, `QA review of batch ${v.batchNumber} (evidence epoch ${v.epoch})`)}
            disabled={!gate.ready || signed.busy}
          />
        </>
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function Reopen({ view: v, offered }: { view: BatchReviewView; offered: boolean }) {
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const signed = useSignedAct(REVIEW_READS);
  const gate = v.gates.reopen;
  if (!offered) return null;
  // The person's own reason, both halves (L-09, DI-22): nothing is filled in for them.
  const reason = code.trim() && text.trim() ? { code: code.trim(), text: text.trim() } : null;
  return (
    <Section title="Reopen the review" testId="reopen">
      <GateProblems gate={gate} testId="reopen-problems" />
      <p>A reopen makes the review signatures of cycle {v.cycle} no longer valid; the record is reviewed again in a new cycle.</p>
      <Field name="reopenCode" label="Reason code" value={code} onChange={setCode} isDisabled={!gate.ready} />
      <Field name="reopenText" label="Reason for the reopen" value={text} onChange={setText} isDisabled={!gate.ready} />
      <ActButton
        primary={false}
        label="Reopen (QA signature)"
        onPress={() => reason && signed.sign({ kind: 'REVIEW_ACT', act: 'REOPEN', batchId: v.batchId, input: { reason, cycle: v.cycle } }, `Reopen the review of batch ${v.batchNumber} (cycle ${v.cycle}): ${reason.text}`)}
        disabled={!gate.ready || reason === null || signed.busy}
      />
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function AbortChecklist({ view: v }: { view: BatchReviewView }) {
  const c = v.abortChecklist;
  return (
    <Section title="Abort checklist" testId="abort-checklist">
      {c ? (
        <dl>
          <dt>Materials accounted for</dt>
          <dd>{c.materialsAccounted}</dd>
          <dt>Outputs dispositioned</dt>
          <dd>{c.outputsDispositioned}</dd>
          <dt>Equipment left dirty</dt>
          <dd>{c.equipmentDirty}</dd>
          <dt>Genealogy closed</dt>
          <dd>{c.genealogyClosed}</dd>
          <dt>Contingency reconciled</dt>
          <dd>{c.contingencyReconciled}</dd>
          <dt>Recorded</dt>
          <dd>
            {c.recordedBy.legalName}, {c.recordedAt.text}
          </dd>
        </dl>
      ) : (
        <DefineForm
          title="Record the abort checklist"
          route={routes.review.recordAbortChecklist}
          params={{ batchId: v.batchId }}
          refresh={REVIEW_READS}
          submitLabel="Record the checklist"
          fields={[
            { name: 'materialsAccounted', label: 'Materials accounted for', kind: 'text' },
            { name: 'outputsDispositioned', label: 'Outputs dispositioned', kind: 'text' },
            { name: 'equipmentDirty', label: 'Equipment left dirty', kind: 'text' },
            { name: 'genealogyClosed', label: 'Genealogy closed', kind: 'text' },
            { name: 'contingencyReconciled', label: 'Contingency reconciled', kind: 'text' },
          ]}
        />
      )}
    </Section>
  );
}

function FreeText({ view: v }: { view: BatchReviewView }) {
  const verify = useCommand(routes.review.verifyTranslation, REVIEW_READS);
  return (
    <Section title="Free text of the record" testId="free-text">
      <ul>
        {v.freeText.map((f) => (
          <li key={f.sourceRef} data-testid={`free-text-${f.sourceRef}`}>
            <p>
              {f.source}: <span lang="und">{f.text}</span> {f.needsTranslation && !f.translation?.verifiedBy ? <StatusChip tone="warning" label="Needs a verified English translation" /> : null}
            </p>
            {f.translation ? (
              <p>
                English: {f.translation.english} (by {f.translation.translatedBy.legalName}
                {f.translation.verifiedBy ? `, verified by ${f.translation.verifiedBy.legalName}, ${f.translation.verifiedAt?.text ?? ''}` : ', not verified yet'})
              </p>
            ) : null}
            {f.translation && !f.translation.verifiedBy ? (
              <ActButton primary={false} label={`Verify the translation of ${f.source}`} onPress={() => verify.run({ params: { translationId: f.translation?.translationId ?? '' }, body: {} })} disabled={verify.busy} />
            ) : null}
            {f.needsTranslation && !f.translation ? (
              <DefineForm
                title={`Translate ${f.source}`}
                route={routes.review.recordTranslation}
                params={{ batchId: v.batchId }}
                fixed={{ sourceRef: f.sourceRef }}
                refresh={REVIEW_READS}
                submitLabel="Record the translation"
                fields={[{ name: 'english', label: 'English translation', kind: 'text' }]}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ActResult error={verify.error} done={verify.done} label="Translation verified." />
    </Section>
  );
}
