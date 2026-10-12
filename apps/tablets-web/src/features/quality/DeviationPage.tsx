/**
 * One deviation record (Phase 3 slice 6; Phase 4 slice 2a, the full stand-in): link a batch, a lot or an output
 * container; QA classifies and starts the investigation (IN-02); record the finding; QA's signed impact assessment,
 * conclusion and closure (QUALITY_ACT, through the ceremony); cancel an OPEN record with the person's own reason. The
 * impact per market and the closure basis have their routes (contract ns/deviation.ts); their screens come with slice 2c. What may happen in which state, and by whom, is the database's: a refusal is shown in its words.
 */
import { useState } from 'react';
import { routes, type DeviationView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand, useSignedAct } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { DEVIATION_READS } from './DeviationsPage.tsx';

export function DeviationPage() {
  const deviationId = useRouteParams()['deviationId'] ?? '';
  const q = useApiQuery(routes.quality.deviation, { params: { deviationId } });
  if (q.isPending) return <p>Loading the record…</p>;
  if (!q.data) return q.error ? <RefusalMessage error={q.error.error} /> : null;
  return <DeviationRecord d={q.data} />;
}

function DeviationRecord({ d }: { d: DeviationView }) {
  const qa = useOffered('QA');
  const open = d.state !== 'CLOSED' && d.state !== 'CANCELLED';
  const investigating = d.state === 'UNDER_INVESTIGATION' || d.state === 'IMPACT_ASSESSED';
  return (
    <>
      <h1>
        {d.ref} {d.title}
      </h1>
      <p data-testid="deviation-state">
        <StatusChip tone={open ? 'warning' : 'neutral'} label={d.state} /> {d.kind} · {d.classification}
      </p>
      <Section title="Linked" testId="deviation-links">
        {d.links.length === 0 ? <p>Nothing linked yet.</p> : null}
        <ul>
          {d.links.map((l) => (
            <li key={`${l.subjectKind}:${l.subjectRef}`}>
              {l.subjectKind} {l.batchNumber ?? l.subjectRef}
            </li>
          ))}
        </ul>
        {open ? <LinkForm deviationId={d.deviationId} /> : null}
      </Section>
      {d.state === 'OPEN' ? <StartInvestigation deviationId={d.deviationId} /> : null}
      {investigating ? (
        <Section title="Finding" testId="finding">
          <DefineForm
            title="Record the finding"
            route={routes.quality.recordFinding}
            params={{ deviationId: d.deviationId }}
            refresh={DEVIATION_READS}
            submitLabel="Record the finding"
            fields={[
              { name: 'assignableCause', label: 'Assignable cause found', kind: 'yesno' },
              { name: 'cause', label: 'Cause', kind: 'text', description: 'At least 10 characters' },
              { name: 'rootCauseCategory', label: 'Root cause category', kind: 'choice', options: ['HUMAN_ERROR', 'EQUIPMENT', 'MATERIAL', 'METHOD', 'ENVIRONMENT', 'PROCESS', 'LABORATORY_ERROR', 'NOT_DETERMINED'] },
            ]}
          />
        </Section>
      ) : null}
      {qa && (investigating || d.state === 'PENDING_CLOSURE') ? <SignedActs d={d} /> : null}
      {qa && d.state === 'OPEN' ? <CancelForm deviationId={d.deviationId} /> : null}
    </>
  );
}

function LinkForm({ deviationId }: { deviationId: string }) {
  const [kind, setKind] = useState<'BATCH' | 'LOT' | 'CONTAINER' | null>(null);
  const [subject, setSubject] = useState('');
  const batches = useApiQuery(routes.batches.list, {}, { enabled: kind === 'BATCH' });
  const lots = useApiQuery(routes.quality.lots, {}, { enabled: kind === 'LOT' });
  const cmd = useCommand(routes.quality.linkDeviation, DEVIATION_READS);
  const options =
    kind === 'BATCH'
      ? (batches.data?.batches ?? []).map((b) => ({ value: b.runId, label: `${b.batchNumber} (${b.statusText})` }))
      : kind === 'LOT'
        ? (lots.data?.lots ?? []).map((l) => ({ value: l.lotId, label: `${l.lotCode} ${l.material.name} (${l.status})` }))
        : [];
  return (
    <div data-testid="link-form">
      <floor.ChoiceGroup
        label="Link"
        options={[
          { value: 'BATCH', label: 'A batch' },
          { value: 'LOT', label: 'A lot' },
          { value: 'CONTAINER', label: 'An output container' },
        ]}
        value={kind}
        onChange={(v) => {
          setKind(v === 'BATCH' || v === 'LOT' || v === 'CONTAINER' ? v : null);
          setSubject('');
        }}
      />
      {options.length > 0 ? <floor.ChoiceGroup label="Which" options={options} value={subject === '' ? null : subject} onChange={setSubject} /> : null}
      {kind === 'CONTAINER' ? <Field name="containerId" label="Container id" value={subject} onChange={setSubject} description="Scan the container label" /> : null}
      <ActButton label="Link it" onPress={() => (kind ? cmd.run({ params: { deviationId }, body: { subjectKind: kind, subjectId: subject.trim() } }) : undefined)} disabled={!kind || subject.trim() === '' || cmd.busy} />
      <ActResult error={cmd.error} done={cmd.done} label="Linked." />
    </div>
  );
}

function StartInvestigation({ deviationId }: { deviationId: string }) {
  return (
    <Section title="Investigation" testId="investigation">
      <DefineForm
        title="Classify and start the investigation"
        route={routes.quality.startInvestigation}
        params={{ deviationId }}
        refresh={DEVIATION_READS}
        submitLabel="Start the investigation"
        fields={[
          { name: 'classification', label: 'QA classification', kind: 'choice', options: ['MINOR', 'MAJOR', 'CRITICAL'] },
          { name: 'riskRationale', label: 'Risk rationale', kind: 'text', description: 'At least 10 characters' },
          { name: 'ownerPersonId', label: 'Owner (person id)', kind: 'text' },
          { name: 'dueDate', label: 'Due date', kind: 'text', description: 'YYYY-MM-DD' },
        ]}
      />
    </Section>
  );
}

function SignedActs({ d }: { d: DeviationView }) {
  const signed = useSignedAct(DEVIATION_READS);
  return (
    <Section title="QA decision" testId="qa-decision">
      {d.state === 'UNDER_INVESTIGATION' ? (
        <ActButton
          label="Sign the impact assessment (QA signature)"
          onPress={() => signed.sign({ kind: 'QUALITY_ACT', act: 'DEVIATION_IMPACT_ASSESS', subjectId: d.deviationId, input: {} }, `Impact of ${d.ref}: ${d.title}`)}
          disabled={signed.busy}
        />
      ) : null}
      {d.state === 'IMPACT_ASSESSED' ? (
        <ActButton label="Conclude (QA signature)" onPress={() => signed.sign({ kind: 'QUALITY_ACT', act: 'DEVIATION_CONCLUDE', subjectId: d.deviationId, input: {} }, `Conclude ${d.ref}: ${d.title}`)} disabled={signed.busy} />
      ) : null}
      {d.state === 'PENDING_CLOSURE' ? (
        <ActButton label="Close (QA signature)" onPress={() => signed.sign({ kind: 'QUALITY_ACT', act: 'DEVIATION_CLOSE', subjectId: d.deviationId, input: {} }, `Close ${d.ref}: ${d.title}`)} disabled={signed.busy} />
      ) : null}
      <ActResult error={signed.error} outcome={signed.outcome} />
    </Section>
  );
}

function CancelForm({ deviationId }: { deviationId: string }) {
  return (
    <Section title="Cancel" testId="cancel-deviation">
      <DefineForm
        title="Cancel the record"
        route={routes.quality.cancelDeviation}
        params={{ deviationId }}
        refresh={DEVIATION_READS}
        submitLabel="Cancel the record"
        fields={[{ name: 'reason', label: 'Reason for cancelling', kind: 'text' }]}
      />
    </Section>
  );
}
