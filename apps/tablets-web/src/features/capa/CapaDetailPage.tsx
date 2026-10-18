/**
 * One CAPA (Phase 6 slice 6a; IN-01 (d), PR-51): its source, owner and due date, the deviations it is linked to (with
 * their batches), the master version it waits for and whether that version is effective, the effectiveness checks with
 * the due dates the database computed (overdue flagged), the events, and why it cannot close yet (the database's
 * words). QA links, implements, records results and cancels; another QA person closes it through the ceremony
 * (CAPA_ACT). A QMS mirror row shows its QMS history and version tokens and offers no act.
 */
import { useState } from 'react';
import { routes, type CapaView } from '@ebmr/api-contract';
import { Banner, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { CAPA_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function CapaDetailPage() {
  const capaId = useRouteParams()['capaId'] ?? '';
  const q = useApiQuery(routes.capa.detail, { params: { capaId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  if (!q.data) return <p>Loading the CAPA.</p>;
  const v = q.data;
  const open = v.origin === 'STAND_IN' && (v.state === 'OPEN' || v.state === 'IMPLEMENTED');
  return (
    <>
      <h1>
        {v.ref} {v.title}
      </h1>
      <dl data-testid="capa-header">
        <dt>State</dt>
        <dd data-testid="capa-state">
          {words(v.state)} {v.overdue ? <StatusChip tone="error" label="Overdue" /> : null}
        </dd>
        <dt>Source</dt>
        <dd>{v.sourceKind ? `${words(v.sourceKind)} ${v.sourceRef ?? ''}` : 'Mirrored from the QMS'}</dd>
        <dt>Owner</dt>
        <dd>{v.ownerName ?? 'in the QMS'}</dd>
        <dt>Due</dt>
        <dd>{v.dueOn ?? v.qmsEffectivenessDueOn ?? 'in the QMS'}</dd>
        <dt>Raised by</dt>
        <dd>{v.raisedBy}</dd>
        {v.versionToken ? (
          <>
            <dt>QMS version</dt>
            <dd data-testid="capa-version-token">{v.versionToken}</dd>
          </>
        ) : null}
      </dl>
      {v.description ? <p>{v.description}</p> : null}
      {v.origin === 'QMS' ? <Banner tone="info" title="This CAPA is held by the QMS; it is changed there and mirrored here with its version token." /> : null}
      <Section title="Deviations" testId="capa-deviations">
        {v.deviations.length === 0 ? <p>No deviation is linked.</p> : null}
        <ul>
          {v.deviations.map((d) => (
            <li key={d.deviationId}>
              {d.ref} ({words(d.state)}); batches {d.batches.join(', ') || 'none'}
            </li>
          ))}
        </ul>
        {open ? <LinkDeviation capaId={v.capaId} /> : null}
      </Section>
      {v.needsMasterChange ? (
        <Section title="Master change it waits for" testId="capa-master">
          {v.masterVersions.length === 0 ? <p>No master version is named yet.</p> : null}
          <ul>
            {v.masterVersions.map((m) => (
              <li key={m.versionId} data-effective={String(m.effective)}>
                {m.label} <StatusChip tone={m.effective ? 'ok' : 'warning'} label={m.effective ? 'Effective' : 'Not effective yet'} />
              </li>
            ))}
          </ul>
          {open ? <LinkMaster capaId={v.capaId} /> : null}
        </Section>
      ) : null}
      <Checks view={v} />
      <Section title="Events" testId="capa-events">
        <ul>
          {v.events.map((e) => (
            <li key={e.event}>
              {words(e.event)} by {e.by}
              {e.note ? `: ${e.note}` : ''}
            </li>
          ))}
          {v.qmsHistory.map((h) => (
            <li key={h.messageId}>
              QMS: {words(h.status)} (version {h.versionToken})
            </li>
          ))}
        </ul>
        {open && v.state === 'OPEN' ? <Implement capaId={v.capaId} /> : null}
      </Section>
      {v.origin === 'STAND_IN' ? <Close view={v} /> : null}
      {open ? <Cancel capaId={v.capaId} /> : null}
    </>
  );
}

function Checks({ view: v }: { view: CapaView }) {
  const qa = useOffered('QA');
  return (
    <Section title="Effectiveness checks" testId="capa-checks">
      {v.checks.length === 0 ? <p>No effectiveness check here.</p> : null}
      <ul>
        {v.checks.map((c) => (
          <li key={c.checkId} data-testid={`capa-check-${c.checkId}`} data-status={c.status}>
            {c.criteria}: {c.periodDays} days from {c.scheduledOn}, due {c.dueOn}{' '}
            <StatusChip tone={c.status === 'OVERDUE' ? 'error' : c.status === 'DONE' ? 'ok' : 'neutral'} label={c.status === 'DONE' ? (c.effective ? 'Effective' : 'Not effective') : words(c.status)} />
            {c.evidence ? ` ${c.evidence}` : ''}
            {qa && c.status !== 'DONE' && v.state === 'IMPLEMENTED' && v.origin === 'STAND_IN' ? <RecordResult capaId={v.capaId} checkId={c.checkId} /> : null}
          </li>
        ))}
      </ul>
      {qa && v.origin === 'STAND_IN' && (v.state === 'OPEN' || v.state === 'IMPLEMENTED' || v.state === 'EFFECTIVENESS_CHECK') ? <ScheduleCheck capaId={v.capaId} /> : null}
    </Section>
  );
}

/** QA schedules another effectiveness check (capa.scheduleCheck; slice 7g-5): the database computes its due date. */
function ScheduleCheck({ capaId }: { capaId: string }) {
  const schedule = useCommand(routes.capa.scheduleCheck, CAPA_READS);
  const [criteria, setCriteria] = useState('');
  const [days, setDays] = useState('');
  const period = /^[1-9][0-9]{0,3}$/.test(days.trim()) ? Number(days.trim()) : null;
  const ok = criteria.trim() !== '' && period !== null && period <= 1095;
  return (
    <div data-testid="capa-schedule-check">
      <h3>Schedule another check</h3>
      <Field name="capaCheckCriteria" label="What shows the action worked (criteria)" value={criteria} onChange={setCriteria} />
      <Field name="capaCheckDays" label="Period (days from today, 1 to 1095)" value={days} onChange={setDays} />
      <ActButton
        label="Schedule the check"
        onPress={() => (ok && period !== null ? schedule.run({ params: { capaId }, body: { criteria: criteria.trim(), periodDays: period } }) : undefined)}
        disabled={!ok || schedule.busy}
      />
      <ActResult error={schedule.error} done={schedule.done} label="The check is scheduled; its due date is the database's." />
    </div>
  );
}

function RecordResult({ capaId, checkId }: { capaId: string; checkId: string }) {
  const record = useCommand(routes.capa.recordEffectiveness, CAPA_READS);
  const [effective, setEffective] = useState<boolean | null>(null);
  const [evidence, setEvidence] = useState('');
  const ok = effective !== null && evidence.trim() !== '';
  return (
    <div data-testid="capa-record-result">
      <floor.ChoiceGroup
        label="Result"
        options={[
          { value: 'YES', label: 'Effective' },
          { value: 'NO', label: 'Not effective' },
        ]}
        value={effective === null ? null : effective ? 'YES' : 'NO'}
        onChange={(x) => setEffective(x === 'YES')}
      />
      <Field name="capaEvidence" label="Evidence" value={evidence} onChange={setEvidence} />
      <ActButton label="Record the result" onPress={() => (ok ? record.run({ params: { capaId, checkId }, body: { effective: effective === true, evidence: evidence.trim() } }) : undefined)} disabled={!ok || record.busy} />
      <ActResult error={record.error} done={record.done} label="The result is recorded." />
    </div>
  );
}

function LinkDeviation({ capaId }: { capaId: string }) {
  const qa = useOffered('QA');
  const link = useCommand(routes.capa.linkDeviation, CAPA_READS);
  const [id, setId] = useState('');
  if (!qa) return null;
  return (
    <div data-testid="capa-link-deviation">
      <Field name="capaDeviation" label="Deviation record (id)" value={id} onChange={setId} />
      <ActButton label="Link the deviation" onPress={() => (UUID.test(id.trim()) ? link.run({ params: { capaId }, body: { deviationId: id.trim() } }) : undefined)} disabled={!UUID.test(id.trim()) || link.busy} />
      <ActResult error={link.error} done={link.done} label="Linked." />
    </div>
  );
}

function LinkMaster({ capaId }: { capaId: string }) {
  const qa = useOffered('QA');
  const link = useCommand(routes.capa.linkMasterVersion, CAPA_READS);
  const [id, setId] = useState('');
  if (!qa) return null;
  return (
    <div data-testid="capa-link-master">
      <Field name="capaMaster" label="MBR version (id)" value={id} onChange={setId} />
      <ActButton label="Name the master version" onPress={() => (UUID.test(id.trim()) ? link.run({ params: { capaId }, body: { versionId: id.trim() } }) : undefined)} disabled={!UUID.test(id.trim()) || link.busy} />
      <ActResult error={link.error} done={link.done} label="Named." />
    </div>
  );
}

function Implement({ capaId }: { capaId: string }) {
  const qa = useOffered('QA');
  const implement = useCommand(routes.capa.implement, CAPA_READS);
  const [note, setNote] = useState('');
  if (!qa) return null;
  return (
    <div data-testid="capa-implement">
      <Field name="capaNote" label="What was done" value={note} onChange={setNote} />
      <ActButton label="Record the implementation" onPress={() => (note.trim() !== '' ? implement.run({ params: { capaId }, body: { note: note.trim() } }) : undefined)} disabled={note.trim() === '' || implement.busy} />
      <ActResult error={implement.error} done={implement.done} label="Recorded." />
    </div>
  );
}

function Close({ view: v }: { view: CapaView }) {
  const qa = useOffered('QA');
  const signed = useSignedAct(CAPA_READS);
  if (v.state === 'CLOSED' || v.state === 'CANCELLED') return null;
  return (
    <Section title="Closure" testId="capa-close">
      {v.closeProblem ? (
        <p data-testid="capa-close-problem">Not closable yet: {v.closeProblem}</p>
      ) : (
        <p>The CAPA may be closed by QA other than the person who raised it.</p>
      )}
      {qa ? (
        <>
          <ActButton label="Close the CAPA" onPress={() => signed.sign({ kind: 'CAPA_ACT', act: 'CLOSE', capaId: v.capaId }, `Close ${v.ref} ${v.title}`)} disabled={signed.busy || v.closeProblem !== null} />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </>
      ) : null}
    </Section>
  );
}

function Cancel({ capaId }: { capaId: string }) {
  const qa = useOffered('QA');
  const cancel = useCommand(routes.capa.cancel, CAPA_READS);
  const [reason, setReason] = useState('');
  if (!qa) return null;
  return (
    <Section title="Cancellation" testId="capa-cancel">
      <Field name="capaCancelReason" label="Reason for the cancellation" value={reason} onChange={setReason} />
      <ActButton label="Cancel the CAPA" primary={false} onPress={() => (reason.trim() !== '' ? cancel.run({ params: { capaId }, body: { reason: reason.trim() } }) : undefined)} disabled={reason.trim() === '' || cancel.busy} />
      <ActResult error={cancel.error} done={cancel.done} label="Cancelled." />
    </Section>
  );
}
