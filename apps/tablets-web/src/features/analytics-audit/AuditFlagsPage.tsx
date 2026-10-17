/**
 * The audit-trail flags (slice 6A-4; DI-53): one line per key (the latest flag of the same hit, raised again by each
 * run; D-6A-4-5) with its rule, the person, why, how often and since when, and QA's current disposition. Without a
 * period the open ones. A flag is a pointer for data-integrity review, never a finding; it is closed by QA's
 * disposition, and a real problem goes into the deviation process as usual.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type AuditFlagRepeat, type FlagView } from '@ebmr/api-contract';
import { Banner, Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { AdvisoryBand, verdictLabel } from '../analytics/shared.tsx';
import { ruleLabel } from './shared.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function NotAccusation() {
  return (
    <Banner tone="warning" title="A flag is not a finding">
      It points data-integrity review at audit-trail entries worth a look, with the reasons. It says nothing about the person until QA has looked; nobody is notified, and
      a confirmed problem is raised as a deviation.
    </Banner>
  );
}

export function AuditFlagsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [asked, setAsked] = useState<{ from?: string; to?: string }>({});
  const q = useApiQuery(routes.analyticsAudit.flags, { query: asked });
  const ok = (from === '' || DATE.test(from)) && (to === '' || DATE.test(to));
  const repeats = new Map((q.data?.repeats ?? []).map((r) => [r.flagId, r]));
  return (
    <>
      <h1>Audit-trail flags</h1>
      {q.data ? <AdvisoryBand v={q.data} /> : null}
      <NotAccusation />
      <Section title="Which flags" testId="audit-flags-filter">
        <Field name="auditFrom" label="From (YYYY-MM-DD; empty: open flags)" value={from} onChange={setFrom} />
        <Field name="auditTo" label="To (YYYY-MM-DD)" value={to} onChange={setTo} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ ...(from ? { from } : {}), ...(to ? { to } : {}) })} />
      </Section>
      <Section title={asked.from || asked.to ? 'Flags of the period' : 'Open flags'} testId="audit-flags">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.flags.length === 0 ? <p>No flag.</p> : null}
        <ul>{q.data?.flags.map((f) => <FlagLine key={f.flagId} f={f} repeat={repeats.get(f.flagId)} />)}</ul>
      </Section>
    </>
  );
}

function FlagLine({ f, repeat }: { f: FlagView; repeat: AuditFlagRepeat | undefined }) {
  return (
    <li data-testid={`audit-flag-${f.flagId}`}>
      <StatusChip tone={f.severity === 'ATTENTION' ? 'warning' : 'info'} label={ruleLabel(f.rule)} /> <Link to={`/analytics/audit-flags/${f.flagId}`}>{f.subjectLabel}</Link> · {f.method.id} version{' '}
      {f.method.version.toString()} · raised {f.raisedAt.text}
      {repeat && repeat.raisedCount > 1 ? ` (raised ${repeat.raisedCount.toString()} times since ${repeat.firstRaisedAt.text})` : ''}
      <ul>{f.reasons.map((r, i) => <li key={`${r.code}-${i.toString()}`}>{r.text}</li>)}</ul>
      {f.disposition ? <p data-testid={`audit-flag-${f.flagId}-disposition`}>{verdictLabel(f.disposition.verdict)} ({f.disposition.person.legalName}): {f.disposition.cause}</p> : <p>Open: no disposition yet.</p>}
    </li>
  );
}
