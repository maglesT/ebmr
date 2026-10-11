/** The GMP batches of the site with their states (Phase 3 slice 6): filter by state; each opens the batch overview. */
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';

const STATES = ['ISSUED', 'IN_PROGRESS', 'ON_HOLD', 'EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED'] as const;
type State = (typeof STATES)[number];

export function BatchesPage() {
  const [state, setState] = useState<State | null>(null);
  const batches = useApiQuery(routes.batches.list, state ? { query: { status: state } } : {});
  return (
    <>
      <h1>Batches</h1>
      <floor.ChoiceGroup label="State" options={[{ value: '', label: 'All' }, ...STATES.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))]} value={state ?? ''} onChange={(v) => setState(v === '' ? null : (v as State))} />
      {batches.error ? <RefusalMessage error={batches.error.error} /> : null}
      {batches.data && batches.data.batches.length === 0 ? <p>No batch in this state.</p> : null}
      <table aria-label="Batches">
        <thead>
          <tr>
            <th scope="col">Batch</th>
            <th scope="col">Product</th>
            <th scope="col">State</th>
            <th scope="col">Issued</th>
            <th scope="col">Open exceptions</th>
          </tr>
        </thead>
        <tbody>
          {batches.data?.batches.map((b) => (
            <tr key={b.runId} data-testid={`batch-${b.batchNumber}`}>
              <td>
                <Link to="/runs/$runId" params={{ runId: b.runId }}>
                  {b.batchNumber}
                </Link>
              </td>
              <td>{b.product.name}</td>
              <td>
                <StatusChip tone={floor.stepTone(b.status)} label={b.statusText} />
              </td>
              <td>{b.issuedAt.text}</td>
              <td>{b.openExceptions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
