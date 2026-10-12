/**
 * The release queue (Phase 4 slice 3): finished lots with their manufacturer release state, as the server lists them
 * (release.queue); a state filter narrows the list on the server. READY is the database's G-REL answer, never set here.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ManufacturerReleaseState, routes } from '@ebmr/api-contract';
import { floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { releaseTone, words } from './reads.ts';

const FILTERS = ['ALL', 'NOT_READY', 'READY', 'RELEASED', 'REJECTED', 'RELEASE_SUSPENDED', 'RECALLED', 'REJECTED_AFTER_RELEASE'] as const;

export function ReleaseQueuePage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const state = ManufacturerReleaseState.safeParse(filter);
  const q = useApiQuery(routes.release.queue, { query: state.success ? { state: state.data } : {} });
  return (
    <>
      <h1>Release cockpit</h1>
      <p>
        <Link to="/release/suspended">Suspended lots and recall assessments</Link>
      </p>
      <floor.ChoiceGroup label="Show" options={FILTERS.map((f) => ({ value: f, label: f === 'ALL' ? 'All' : words(f) }))} value={filter} onChange={(v) => setFilter(FILTERS.find((f) => f === v) ?? 'ALL')} />
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.lots.length === 0 ? <p>No finished lot is listed.</p> : null}
      <ul data-testid="release-queue">
        {q.data?.lots.map((l) => (
          <li key={l.lotId} data-testid={`release-lot-${l.lotCode}`}>
            <Link to="/release/$lotId" params={{ lotId: l.lotId }}>
              {l.lotCode}
            </Link>{' '}
            {l.productCode} {l.strength}, batch {l.batchNumber}, markets {l.markets.join(', ')}, lot {words(l.lotStatus)} <StatusChip tone={releaseTone(l.state)} label={words(l.state)} />
          </li>
        ))}
      </ul>
    </>
  );
}
