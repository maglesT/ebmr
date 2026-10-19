/**
 * The full export (DI-08: the data return with audit trails and signatures, for the stand-alone viewer) and the periodic
 * evaluation pack with its readability report and QA's signed sign-off (DI-11, DI-44), Phase 7 slice 7g-3. The export
 * runs on the server as a background job; the page follows it until it has ended.
 */
import { useEffect, useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useRefresh, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { Download, VALIDATION_READS } from './shared.tsx';

export function FullExportPage() {
  const q = useApiQuery(routes.validation.fullExports);
  const start = useCommand(routes.validation.startFullExport, VALIDATION_READS);
  const reread = useRefresh([routes.validation.fullExports.id]);
  const [reason, setReason] = useState('');
  const v = q.data;
  const running = v?.job.state === 'RUNNING' || start.done?.job.state === 'RUNNING';
  // Follow the job while it runs (the list is read again until the job has ended).
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => void reread(), 1500);
    return () => clearInterval(t);
  }, [running, reread]);
  return (
    <>
      <h1>Full export</h1>
      <p>
        Every closed record with its audit trail and its signatures in readable form, written as a folder the stand-alone record viewer opens and checks against the
        export&apos;s SHA-256. Exports are written on the server to {v?.folder ?? 'its export folder'}.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Start a full export" testId="full-export-start">
        <Field name="export-reason" label="Reason (recorded)" value={reason} onChange={setReason} />
        <ActButton label="Start the full export" disabled={reason.trim() === '' || start.busy || running} onPress={() => start.run({ body: { reason: reason.trim() } })} />
        <ActResult error={start.error} done={start.done} label="The export is running." />
        {v ? (
          <p data-testid="full-export-job" data-state={v.job.state}>
            Export job: {v.job.state === 'IDLE' ? 'none has run since the server started' : `${v.job.state.toLowerCase()}${v.job.step ? `, ${v.job.step}` : ''}`}
          </p>
        ) : null}
        {v?.job.state === 'FAILED' ? (
          <Banner tone="error" title="The export failed; nothing was registered.">
            <p>{v.job.error}</p>
          </Banner>
        ) : null}
      </Section>
      <Section title="Past exports" testId="full-exports">
        {v && v.exports.length === 0 ? <p>No full export has been made.</p> : null}
        <ul>
          {v?.exports.map((e) => (
            <li key={e.exportId} data-testid={`full-export-${e.exportId}`}>
              {e.at.text}, by {e.by}: {e.recordCount} closed records, {e.fileCount} files. SHA-256 <code>{e.manifestSha256}</code>{' '}
              <Download label="Download the manifest" route={routes.validation.fullExportManifest} input={{ params: { exportId: e.exportId } }} pick={(m) => ({ name: `manifest-${m.exportId}.json`, text: m.manifest, mediaType: 'application/json' })} testId={`full-export-manifest-${e.exportId}`} />
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** An instant typed with its offset (2026-09-01T00:00+05:30); seconds are added when left out. */
const instant = (text: string): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.exec(text.trim());
  return m ? `${m[1] ?? ''}${m[2] ?? ':00'}${m[3] ?? ''}` : null;
};

export function EvaluationPacksPage() {
  const q = useApiQuery(routes.validation.evaluationPacks);
  const run = useCommand(routes.validation.runEvaluationPack, VALIDATION_READS);
  const signed = useSignedAct(VALIDATION_READS);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [seed, setSeed] = useState('');
  const [sample, setSample] = useState('10');
  const f = instant(from);
  const t = instant(to);
  const ok = f !== null && t !== null && seed.trim() !== '' && /^[1-9][0-9]{0,3}$/.test(sample);
  return (
    <>
      <h1>Periodic evaluation</h1>
      <p>
        The evaluation pack of an ended period lists every entry of every topic (changes, deviations and incidents, reviews, recertifications, backups and drills,
        alarms, time-sync events, integrity checks, open issues) with its source, and a readability report of a seeded sample of closed records. QA signs it off.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      <Section title="Generate a pack" testId="evaluation-run">
        <Field name="from" label="Period from (e.g. 2026-09-01T00:00+05:30)" value={from} onChange={setFrom} />
        <Field name="to" label="Period to (e.g. 2026-10-01T00:00+05:30)" value={to} onChange={setTo} />
        <Field name="seed" label="Readability sample seed" value={seed} onChange={setSeed} />
        <Field name="sample" label="Records sampled" value={sample} onChange={setSample} />
        <ActButton
          label="Generate the evaluation pack"
          disabled={!ok || run.busy}
          onPress={() => (f && t ? run.run({ body: { from: f, to: t, seed: seed.trim(), sampleSize: sample } }) : undefined)}
        />
        {run.busy ? <p>Reading the period and the sample…</p> : null}
        <ActResult error={run.error} done={run.done} label={run.done ? `Pack stored: ${run.done.entryCount} entries, ${run.done.sampleCount} records sampled, ${run.done.unreadableCount} unreadable.` : 'Stored.'} />
      </Section>
      <Section title="Evaluation packs" testId="evaluation-packs">
        {q.data && q.data.packs.length === 0 ? <p>No evaluation pack has been generated.</p> : null}
        {q.data?.packs.map((p) => (
          <article key={p.packId} data-testid={`pack-${p.packId}`} data-state={p.approval ? 'APPROVED' : 'STORED'}>
            <h3>
              {p.periodFrom.text} to {p.periodTo.text} <StatusChip tone={p.approval ? 'ok' : 'warning'} label={p.approval ? 'Signed off' : 'Awaiting QA'} />
            </h3>
            <p>
              {p.entryCount} entries; {p.sampleCount} of {p.sampleSize} records sampled (seed {p.readabilitySeed}), {p.unreadableCount} unreadable. Generated by {p.generatedBy} at {p.at.text}.
              SHA-256 <code>{p.packSha256}</code>
            </p>
            {p.approval ? <p>Signed off by {p.approval.approvedBy} at {p.approval.at.text}.</p> : null}
            <Download label="Download the pack" route={routes.validation.evaluationPackFile} input={{ params: { packId: p.packId } }} pick={(x) => ({ name: `evaluation-pack-${x.packId}.json`, text: x.content, mediaType: 'application/json' })} testId={`pack-download-${p.packId}`} />
            {!p.approval ? (
              <>
                <ActButton label="Sign off the pack (signature)" disabled={signed.busy} onPress={() => signed.sign({ kind: 'EVALUATION_PACK_APPROVE', packId: p.packId }, 'Sign off the periodic evaluation pack')} />
                <ActResult error={signed.error} outcome={signed.outcome} />
              </>
            ) : null}
          </article>
        ))}
      </Section>
    </>
  );
}
