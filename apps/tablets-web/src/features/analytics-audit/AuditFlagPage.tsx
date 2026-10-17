/**
 * One audit-trail flag (slice 6A-4; DI-53): its rule and reasons, the audit entries behind them (who, when, the time
 * claimed, the action and field, a correction and its reason code, the terminal; never an old or new value), how often
 * it was raised, and QA's disposition: real issue, false alarm or not assessable, with the cause and an optional
 * deviation reference. The disposition is recorded on the flag holding the key's current one, so a later one supersedes
 * it with a reason (analytics.record_disposition).
 */
import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { routes, type AuditFlagDetailView } from '@ebmr/api-contract';
import { Dialog, Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { AdvisoryBand, VERDICTS, verdictLabel, type Verdict } from '../analytics/shared.tsx';
import { NotAccusation } from './AuditFlagsPage.tsx';
import { AUDIT_READS, offeredDiReview, ruleLabel } from './shared.ts';

export function AuditFlagPage() {
  const params: { flagId?: string } = useParams({ strict: false });
  const flagId = params.flagId ?? '';
  const q = useApiQuery(routes.analyticsAudit.flag, { params: { flagId } }, { enabled: flagId !== '' });
  const d = q.data;
  const reviewer = offeredDiReview(useSessionRole());
  const [open, setOpen] = useState(false);
  return (
    <>
      <h1>Audit-trail flag</h1>
      <p>
        <Link to="/analytics/audit-flags">All audit-trail flags</Link>
      </p>
      {d ? <AdvisoryBand v={d} /> : null}
      <NotAccusation />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {d ? (
        <>
          <Section title={`${ruleLabel(d.flag.rule)}: ${d.flag.subjectLabel}`} testId="audit-flag-detail">
            <p>
              {d.flag.method.id} version {d.flag.method.version.toString()} · raised {d.flag.raisedAt.text}
              {d.repeat && d.repeat.raisedCount > 1 ? ` (raised ${d.repeat.raisedCount.toString()} times since ${d.repeat.firstRaisedAt.text})` : ''} · data as of {d.flag.run.dataAsOf.text}
            </p>
            <ul data-testid="audit-flag-reasons">{d.flag.reasons.map((r, i) => <li key={`${r.code}-${i.toString()}`}>{r.text}</li>)}</ul>
          </Section>
          <Entries d={d} />
          <Section title="Disposition" testId="audit-flag-dispositions">
            {d.flag.disposition ? <p>Current: {verdictLabel(d.flag.disposition.verdict)} ({d.flag.disposition.person.legalName}, {d.flag.disposition.recordedAt.text}): {d.flag.disposition.cause}</p> : <p>Open: no disposition yet.</p>}
            <ul>
              {d.dispositions.map((x) => (
                <li key={x.dispositionId}>
                  {verdictLabel(x.verdict)} by {x.person.legalName}, {x.recordedAt.text}: {x.cause}
                  {x.deviationRef ? ` · deviation ${x.deviationRef}` : ''}
                  {x.reason ? ` · superseding: ${x.reason}` : ''}
                  {x.current ? ' (current)' : ''}
                </li>
              ))}
            </ul>
            {reviewer ? <ActButton label={d.flag.disposition ? 'Supersede the disposition' : 'Disposition'} onPress={() => setOpen(true)} /> : null}
          </Section>
          {open ? <DispositionDialog d={d} onClose={() => setOpen(false)} /> : null}
        </>
      ) : null}
    </>
  );
}

function Entries({ d }: { d: AuditFlagDetailView }) {
  return (
    <Section title="The audit entries behind it" testId="audit-flag-entries">
      {d.entries.length === 0 ? <p>The flag names no audit entry (a login or a week of the person's activity).</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">Recorded</th>
            <th scope="col">Time claimed</th>
            <th scope="col">Action</th>
            <th scope="col">Table and field</th>
            <th scope="col">Correction</th>
            <th scope="col">Terminal</th>
            <th scope="col">Audit trail</th>
          </tr>
        </thead>
        <tbody>
          {d.entries.map((e) => (
            <tr key={`${e.chainKey}#${e.eventId}`} data-testid={`audit-flag-entry-${e.eventId}`}>
              <td>{e.recordedAt.text}</td>
              <td>{e.claimedAt?.text ?? '-'}</td>
              <td>{e.action}</td>
              <td>{[e.tableName, e.field].filter((x) => x !== null).join(' · ') || '-'}</td>
              <td>{e.isCorrection ? `yes${e.reasonCode ? ` (${e.reasonCode})` : ''}` : 'no'}</td>
              <td>{e.terminal ?? '-'}</td>
              <td>{e.drill ? <Link to={e.drill}>{e.chainKey}</Link> : e.chainKey}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function DispositionDialog({ d, onClose }: { d: AuditFlagDetailView; onClose: () => void }) {
  const dispose = useCommand(routes.analytics.dispose, AUDIT_READS);
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [cause, setCause] = useState('');
  const [deviationRef, setDeviationRef] = useState('');
  const [reason, setReason] = useState('');
  const current = d.flag.disposition;
  const ok = verdict !== '' && cause.trim().length >= 10 && (current === null || reason.trim() !== '');
  return (
    <Dialog title={`Disposition of ${ruleLabel(d.flag.rule)} on ${d.flag.subjectLabel}`} isOpen onOpenChange={(o) => (o ? null : onClose())}>
      <div data-testid="audit-disposition-dialog">
        {current ? <p>The current disposition ({verdictLabel(current.verdict)}) is superseded by this one; give the reason.</p> : null}
        <floor.ChoiceGroup label="Verdict" options={VERDICTS.map((v) => ({ value: v.value, label: v.label }))} value={verdict} onChange={(v) => setVerdict(VERDICTS.find((x) => x.value === v)?.value ?? '')} />
        <Field name="auditCause" label="Cause (at least 10 characters)" value={cause} onChange={setCause} />
        <Field name="auditDeviation" label="Deviation reference (when raised as a deviation)" value={deviationRef} onChange={setDeviationRef} />
        {current ? <Field name="auditReason" label="Reason for superseding" value={reason} onChange={setReason} /> : null}
        <ActButton
          label="Record the disposition"
          disabled={!ok || dispose.busy}
          onPress={async () => {
            if (!ok) return;
            const r = await dispose.run({
              // The key's current disposition sits on the flag that holds it; a first one goes on the flag shown.
              params: { flagId: current?.flagId ?? d.flag.flagId },
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
