/**
 * The golden batch profiles (Phase 6A slice 6A-6; /analytics/profiles; DI-52, DI-09): the model candidates the runner
 * fitted per product, family, equipment type, step and tag on the batches that may be reference batches (released, no
 * deviation, no alarm on the step), the batches each leaves out and why, and whether a reference set in force was made
 * from it. QA makes a candidate the reference set under a change record approved for ANALYTICS_REFERENCE. Below, a
 * batch's curve against the band (the same overlay the trend viewer shows). Advisory: nothing here is a GMP record.
 */
import { useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { routes, type ProfileCandidatesView } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../../app/acts.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { useOffered } from '../../../app/roles.ts';
import { ANALYTICS_READS, AdvisoryBand, Stat } from '../shared.tsx';
import { ProfileOverlay } from './ProfileOverlay.tsx';

export interface ProfileSearch {
  batch?: string;
  step?: string;
  tag?: string;
}

export function parseProfileSearch(raw: Record<string, unknown>): ProfileSearch {
  const pick = (k: string): string | undefined => (typeof raw[k] === 'string' && /^.{1,200}$/.test(raw[k]) ? raw[k] : undefined);
  const [batch, step, tag] = [pick('batch'), pick('step'), pick('tag')];
  return { ...(batch ? { batch } : {}), ...(step ? { step } : {}), ...(tag ? { tag } : {}) };
}

const route = getRouteApi('/analytics/profiles');
const PROFILE_READS = [...ANALYTICS_READS, routes.analyticsProfile.candidates.id, routes.analyticsProfile.batch.id];

export function ProfilesPage() {
  const search: ProfileSearch = route.useSearch();
  const q = useApiQuery(routes.analyticsProfile.candidates);
  const [batch, setBatch] = useState(search.batch ?? '');
  const [step, setStep] = useState(search.step ?? '');
  const [tag, setTag] = useState(search.tag ?? '');
  const [asked, setAsked] = useState<ProfileSearch>(search);
  return (
    <>
      <h1>Golden batch profiles</h1>
      {q.data ? <AdvisoryBand v={q.data} /> : null}
      <p>A batch&apos;s equipment curve of a step against the band of QA&apos;s reference batches. Connected equipment only: a step without a series has no profile.</p>
      <Section title="Model candidates" testId="profile-candidates">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.candidates.length === 0 ? <p>No candidate yet: a scope needs at least 10 batches that may be reference batches.</p> : null}
        <ul>{q.data?.candidates.map((c) => <Candidate key={c.outputId} c={c} />)}</ul>
      </Section>
      <Section title="A batch against its golden profile" testId="profile-lookup">
        <Field name="profileBatch" label="Batch id" value={batch} onChange={setBatch} />
        <Field name="profileStep" label="Step" value={step} onChange={setStep} />
        <Field name="profileTag" label="Tag" value={tag} onChange={setTag} />
        <ActButton label="Show the profile" onPress={() => setAsked({ batch: batch.trim(), step: step.trim(), tag: tag.trim() })} />
        {asked.batch && asked.step && asked.tag ? <ProfileOverlay batchId={asked.batch} step={asked.step} tag={asked.tag} /> : null}
      </Section>
    </>
  );
}

function Candidate({ c }: { c: ProfileCandidatesView['candidates'][number] }) {
  const qa = useOffered('QA');
  const set = useCommand(routes.analyticsConfig.setReferenceSet, PROFILE_READS);
  const [cr, setCr] = useState('');
  const [reason, setReason] = useState('');
  const ok = cr.trim() !== '' && reason.trim() !== '';
  return (
    <li data-testid={`profile-candidate-${c.outputId}`}>
      <strong>{c.productCode} · {c.familyCode} · {c.equipmentType} · {c.step} · {c.tag}</strong> ({c.unit}): {c.batches.toString()} reference batches, distance limit{' '}
      <Stat value={c.distanceLimit} />, fitted {c.fittedAt.text}, model {c.modelSha256.slice(0, 12)}…{' '}
      {c.referenceSet ? <span data-testid="profile-candidate-in-force">reference set {c.referenceSet} in force</span> : <span>not a reference set</span>}
      {c.skipped.length > 0 ? <ul>{c.skipped.map((s) => <li key={s.subject}>Left out: {s.reason}</li>)}</ul> : null}
      {qa && !c.referenceSet ? (
        <div>
          <Field name={`profileCr-${c.outputId}`} label="Change-record number (ANALYTICS_REFERENCE)" value={cr} onChange={setCr} />
          <Field name={`profileReason-${c.outputId}`} label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Make it the reference set"
            disabled={!ok || set.busy}
            onPress={() => (ok ? set.run({
              body: {
                method: 'GBP.DTW_BAND', scope: { productCode: c.productCode, familyCode: c.familyCode, equipmentType: c.equipmentType, step: c.step, tag: c.tag },
                batchIds: c.batchIds, candidateOutput: c.outputId, status: 'EFFECTIVE', changeRecord: cr.trim(), reason: reason.trim(),
              },
            }) : undefined)}
          />
          <ActResult error={set.error} done={set.done} label="The reference set is in force under the change record." />
        </div>
      ) : null}
    </li>
  );
}
