/**
 * Deviation-lite (Phase 3 slice 6, IN-02, PR-49): the site's deviation, OOS and investigation records, newest first,
 * filtered by state or kind, and a new record raised with its classification and the risk rationale the database
 * requires (a MINOR record without one is refused by the route and the database). The reference is the database's.
 */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { DefineForm } from '../../app/define-form.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';

const STATES = ['OPEN', 'UNDER_INVESTIGATION', 'IMPACT_ASSESSED', 'PENDING_CLOSURE', 'CLOSED', 'CANCELLED'] as const;
const KINDS = ['DEVIATION', 'OOS', 'INVESTIGATION'] as const;
export const DEVIATION_READS = [routes.quality.deviations.id, routes.quality.deviation.id];

export function DeviationsPage() {
  const [state, setState] = useState<(typeof STATES)[number] | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number] | null>(null);
  const q = useApiQuery(routes.quality.deviations, { query: { ...(state ? { state } : {}), ...(kind ? { kind } : {}) } });
  return (
    <>
      <h1>Deviations</h1>
      <floor.ChoiceGroup label="State" options={[{ value: '', label: 'All' }, ...STATES.map((s) => ({ value: s, label: s }))]} value={state ?? ''} onChange={(v) => setState(STATES.find((s) => s === v) ?? null)} />
      <floor.ChoiceGroup label="Kind" options={[{ value: '', label: 'All' }, ...KINDS.map((s) => ({ value: s, label: s }))]} value={kind ?? ''} onChange={(v) => setKind(KINDS.find((s) => s === v) ?? null)} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.deviations.length === 0 ? <p>No record.</p> : null}
      <ul aria-label="Deviation records">
        {q.data?.deviations.map((d) => (
          <li key={d.deviationId} data-testid={`deviation-${d.ref}`}>
            <Link to="/quality/deviations/$deviationId" params={{ deviationId: d.deviationId }}>
              {d.ref}
            </Link>{' '}
            <StatusChip tone={d.state === 'CLOSED' || d.state === 'CANCELLED' ? 'neutral' : 'warning'} label={d.state} /> {d.kind} · {d.classification} · {d.title}
            {d.links.length > 0 ? ` · ${d.links.map((l) => l.batchNumber ?? l.subjectRef).join(', ')}` : ''}
          </li>
        ))}
      </ul>
      <Section title="Raise a record" testId="raise-deviation">
        <DefineForm
          title="Raise a deviation"
          route={routes.quality.raiseDeviation}
          refresh={DEVIATION_READS}
          submitLabel="Raise the record"
          fields={[
            { name: 'kind', label: 'Kind', kind: 'choice', options: KINDS },
            { name: 'title', label: 'Title', kind: 'text' },
            { name: 'description', label: 'Description', kind: 'text', optional: true },
            { name: 'classification', label: 'Classification', kind: 'choice', options: ['MINOR', 'MAJOR', 'CRITICAL'] },
            { name: 'riskRationale', label: 'Risk rationale', kind: 'text', description: 'Why this classification (at least 10 characters)' },
          ]}
        />
      </Section>
    </>
  );
}
