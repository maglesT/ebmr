/**
 * The analytics flags (Phase 6A slice 6A-1; DI-52, DI-53): the open flags the person may see (or every flag of a
 * period), each with its method and version, its reasons and its data age, and QA's disposition: real issue, false
 * alarm or not assessable, with the cause and an optional deviation reference; a later disposition supersedes the
 * current one with a reason. Flags about a person are listed only when asked for, for data-integrity review. A real
 * problem goes into the deviation path as usual: the disposition records QA's view of the flag, nothing more. One flag
 * opens in detail (analytics.flag; slice 7g-5): every disposition it had, the superseded ones with the reason given.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type FlagView } from '@ebmr/api-contract';
import { Dialog, Field, StatusChip, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { ANALYTICS_READS, AdvisoryBand, VERDICTS, verdictLabel, type Verdict } from './shared.tsx';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['', 'BATCH', 'PRODUCT_ITEM', 'GROUP', 'EQUIPMENT_STEP_TAG', 'METHOD', 'PERSON', 'ACCOUNT'] as const;
type Kind = Exclude<(typeof KINDS)[number], ''>;

export function FlagsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('');
  const [asked, setAsked] = useState<{ from?: string; to?: string; kind?: Kind }>({});
  const q = useApiQuery(routes.analytics.flags, { query: asked });
  const ok = (from === '' || DATE.test(from)) && (to === '' || DATE.test(to));
  return (
    <>
      <h1>Analytics flags</h1>
      {q.data ? <AdvisoryBand v={q.data} /> : null}
      <Section title="Which flags" testId="analytics-flags-filter">
        <Field name="flagsFrom" label="From (YYYY-MM-DD; empty: open flags)" value={from} onChange={setFrom} />
        <Field name="flagsTo" label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
        <floor.ChoiceGroup label="About" options={KINDS.map((k) => ({ value: k, label: k === '' ? 'Records' : k === 'PERSON' || k === 'ACCOUNT' ? `${k} (data-integrity review)` : k }))} value={kind}
          onChange={(v) => setKind(KINDS.find((k) => k === v) ?? '')} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ ...(from ? { from } : {}), ...(to ? { to } : {}), ...(kind ? { kind } : {}) })} />
      </Section>
      <Section title={asked.from || asked.to ? 'Flags of the period' : 'Open flags'} testId="analytics-flags">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.flags.length === 0 ? <p>No flag.</p> : null}
        <ul>{q.data?.flags.map((f) => <FlagLine key={f.flagId} f={f} />)}</ul>
      </Section>
    </>
  );
}

function FlagLine({ f }: { f: FlagView }) {
  const qa = useOffered('QA');
  const [open, setOpen] = useState(false);
  return (
    <li data-testid={`analytics-flag-${f.flagId}`}>
      <StatusChip tone={f.severity === 'HIGH' ? 'error' : f.severity === 'ATTENTION' ? 'warning' : 'info'} label={f.severity} /> <strong>{f.rule}</strong> on{' '}
      {f.drill ? <Link to={f.drill}>{f.subjectLabel}</Link> : f.subjectLabel} · {f.method.id} version {f.method.version.toString()} · raised {f.raisedAt.text}{f.raisedCount !== undefined && f.raisedCount > 1 && f.firstRaisedAt ? <span data-testid="analytics-flag-repeats">{` (raised ${f.raisedCount.toString()} times since ${f.firstRaisedAt.text})`}</span> : null} · data as of{' '}
      {f.run.dataAsOf.text}
      <ul>{f.reasons.map((r, i) => <li key={`${r.code}-${i.toString()}`}>{r.text}</li>)}</ul>
      {f.disposition ? (
        <p data-testid={`analytics-flag-${f.flagId}-disposition`}>
          {verdictLabel(f.disposition.verdict)} ({f.disposition.person.legalName}, {f.disposition.recordedAt.text}): {f.disposition.cause}
          {f.disposition.deviationRef ? ` · deviation ${f.disposition.deviationRef}` : ''}
        </p>
      ) : null}
      <FlagHistory flagId={f.flagId} />
      {qa ? <ActButton label={f.disposition ? 'Supersede the disposition' : 'Disposition'} primary={false} onPress={() => setOpen(true)} /> : null}
      {open ? <DispositionDialog f={f} onClose={() => setOpen(false)} /> : null}
    </li>
  );
}

/** Every disposition of one flag, read when opened (analytics.flag). */
function FlagHistory({ flagId }: { flagId: string }) {
  const [open, setOpen] = useState(false);
  const q = useApiQuery(routes.analytics.flag, { params: { flagId } }, { enabled: open });
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid={`analytics-flag-${flagId}-history`}>
      <summary style={{ minHeight: '2.75rem', paddingBlock: '0.65rem', cursor: 'pointer', boxSizing: 'border-box' }}>Every disposition of this flag</summary>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.dispositions.length === 0 ? <p>No disposition yet.</p> : null}
      <ol>
        {q.data?.dispositions.map((d) => (
          <li key={d.dispositionId}>
            {verdictLabel(d.verdict)} by {d.person.legalName}, {d.recordedAt.text}: {d.cause}
            {d.deviationRef ? ` · deviation ${d.deviationRef}` : ''}
            {d.reason ? ` · superseding with the reason: ${d.reason}` : ''} {d.current ? <StatusChip tone="ok" label="Current" /> : <StatusChip tone="neutral" label="Superseded" />}
          </li>
        ))}
      </ol>
    </details>
  );
}

function DispositionDialog({ f, onClose }: { f: FlagView; onClose: () => void }) {
  const dispose = useCommand(routes.analytics.dispose, ANALYTICS_READS);
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [cause, setCause] = useState('');
  const [deviationRef, setDeviationRef] = useState('');
  const [reason, setReason] = useState('');
  const current = f.disposition;
  const ok = verdict !== '' && cause.trim().length >= 10 && (current === null || reason.trim() !== '');
  return (
    <Dialog title={`Disposition of ${f.rule} on ${f.subjectLabel}`} isOpen onOpenChange={(o) => (o ? null : onClose())}>
      <div data-testid="analytics-disposition-dialog">
        {current ? <p>The current disposition ({verdictLabel(current.verdict)}) is superseded by this one; give the reason.</p> : null}
        <floor.ChoiceGroup label="Verdict" options={VERDICTS.map((v) => ({ value: v.value, label: v.label }))} value={verdict} onChange={(v) => setVerdict(VERDICTS.find((x) => x.value === v)?.value ?? '')} />
        <Field name="dispCause" label="Cause (at least 10 characters)" value={cause} onChange={setCause} />
        <Field name="dispDeviation" label="Deviation reference (optional)" value={deviationRef} onChange={setDeviationRef} />
        {current ? <Field name="dispReason" label="Reason for superseding" value={reason} onChange={setReason} /> : null}
        <ActButton
          label="Record the disposition"
          disabled={!ok || dispose.busy}
          onPress={async () => {
            if (!ok) return;
            const r = await dispose.run({
              params: { flagId: f.flagId },
              body: { verdict, cause: cause.trim(), deviationRef: deviationRef.trim() === '' ? null : deviationRef.trim(), ...(current ? { supersedes: current.dispositionId, reason: reason.trim() } : {}) },
            });
            if (r) onClose();
          }}
        />
        <ActButton label="Cancel" primary={false} onPress={onClose} />
        <ActResult error={dispose.error} done={dispose.done} label="Recorded." />
      </div>
    </Dialog>
  );
}
