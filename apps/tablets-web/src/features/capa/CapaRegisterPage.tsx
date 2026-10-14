/**
 * The CAPA register (Phase 6 slice 6a; IN-01 (d), PR-51): open CAPAs first, the overdue ones and those with an overdue
 * effectiveness check flagged (the ageing report), and QA's form to raise a CAPA from its source. With a QMS integrated
 * the rows are the QMS's (with their version tokens) and nothing is raised here.
 */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { routes, type CapaSummaryView } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { CAPA_READS, words } from './reads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['DEVIATION', 'OOS', 'COMPLAINT', 'PQR', 'SELF_INSPECTION', 'MANAGEMENT_REVIEW'] as const;

export function CapaRegisterPage() {
  const [overdueOnly, setOverdueOnly] = useState(false);
  const q = useApiQuery(routes.capa.register, { query: overdueOnly ? { overdue: 'true' } : {} });
  const mirror = q.data?.mode === 'MIRROR';
  return (
    <>
      <h1>CAPA register</h1>
      <p>
        {mirror
          ? 'This site keeps its CAPAs in the QMS: the rows below are mirrored from it with their version tokens, and they are changed in the QMS.'
          : 'Every CAPA names its source, an owner, a due date and an effectiveness check whose due date the database computes. A CAPA that needs a master change closes only once that master version is effective.'}
      </p>
      {mirror ? null : <RaiseCapa />}
      <Section title="CAPAs" testId="capa-register">
        <floor.ChoiceGroup
          label="Show"
          options={[
            { value: 'ALL', label: 'All' },
            { value: 'OVERDUE', label: 'Overdue only' },
          ]}
          value={overdueOnly ? 'OVERDUE' : 'ALL'}
          onChange={(v) => setOverdueOnly(v === 'OVERDUE')}
        />
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data && q.data.capas.length === 0 ? <p>No CAPA.</p> : null}
        <table>
          <thead>
            <tr>
              <th scope="col">CAPA</th>
              <th scope="col">Source</th>
              <th scope="col">Owner</th>
              <th scope="col">Due</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.capas.map((c) => <Row key={c.capaId} c={c} />)}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function Row({ c }: { c: CapaSummaryView }) {
  return (
    <tr data-testid={`capa-${c.ref}`} data-overdue={String(c.overdue)}>
      <th scope="row">
        <Link to="/capa/$capaId" params={{ capaId: c.capaId }}>
          {c.ref}
        </Link>{' '}
        {c.title}
        {c.versionToken ? ` (QMS version ${c.versionToken})` : ''}
      </th>
      <td>{c.sourceKind ? `${words(c.sourceKind)} ${c.sourceRef ?? ''}` : 'QMS'}</td>
      <td>{c.ownerName ?? 'in the QMS'}</td>
      <td>
        {c.dueOn ?? 'in the QMS'} {c.overdue ? <StatusChip tone="error" label="Overdue" /> : null}
        {c.overdueChecks > 0 ? <StatusChip tone="warning" label={`${c.overdueChecks.toString()} effectiveness check(s) overdue`} /> : null}
      </td>
      <td>
        {words(c.state)}
        {c.needsMasterChange ? ', needs a master change' : ''}
      </td>
    </tr>
  );
}

function RaiseCapa() {
  const qa = useOffered('QA');
  const raise = useCommand(routes.capa.raise, CAPA_READS);
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [source, setSource] = useState<(typeof SOURCES)[number] | null>(null);
  const [sourceRef, setSourceRef] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [master, setMaster] = useState(false);
  const [criteria, setCriteria] = useState('');
  const [days, setDays] = useState('90');
  if (!qa) return null;
  const fromDeviation = source === 'DEVIATION' || source === 'OOS';
  const ok =
    title.trim() !== '' && source !== null && (fromDeviation ? UUID.test(sourceRef.trim()) : sourceRef.trim() !== '') && UUID.test(owner.trim()) && DAY.test(due.trim()) &&
    criteria.trim() !== '' && /^[1-9][0-9]{0,3}$/.test(days.trim());
  return (
    <Section title="Raise a CAPA" testId="capa-raise">
      <Field name="capaTitle" label="Title" value={title} onChange={setTitle} />
      <floor.ChoiceGroup label="Source" options={SOURCES.map((s) => ({ value: s, label: words(s) }))} value={source} onChange={(v) => setSource(SOURCES.find((s) => s === v) ?? null)} />
      <Field name="capaSourceRef" label={fromDeviation ? 'Deviation record (id)' : 'Source reference'} value={sourceRef} onChange={setSourceRef} />
      <Field name="capaOwner" label="Owner (person id)" value={owner} onChange={setOwner} />
      <Field name="capaDue" label="Due date (YYYY-MM-DD)" value={due} onChange={setDue} />
      <floor.ChoiceGroup
        label="Master change"
        options={[
          { value: 'NO', label: 'No master change' },
          { value: 'YES', label: 'Needs a master change' },
        ]}
        value={master ? 'YES' : 'NO'}
        onChange={(v) => setMaster(v === 'YES')}
      />
      <Field name="capaCriteria" label="Effectiveness check: what is measured" value={criteria} onChange={setCriteria} />
      <Field name="capaDays" label="Effectiveness check: after how many days" value={days} onChange={setDays} />
      <ActButton
        label="Raise the CAPA"
        onPress={async () => {
          if (!ok || !source) return;
          const c = await raise.run({
            body: {
              title: title.trim(), sourceKind: source, ...(fromDeviation ? { deviationId: sourceRef.trim() } : { sourceRef: sourceRef.trim() }), ownerPersonId: owner.trim(),
              dueOn: due.trim(), needsMasterChange: master, effectivenessCheck: { criteria: criteria.trim(), periodDays: Number(days.trim()) },
            },
          });
          if (c) await navigate({ to: '/capa/$capaId', params: { capaId: c.capaId } });
        }}
        disabled={!ok || raise.busy}
      />
      <ActResult error={raise.error} done={raise.done} label="The CAPA is raised." />
    </Section>
  );
}
