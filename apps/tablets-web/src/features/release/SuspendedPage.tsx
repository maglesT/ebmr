/**
 * The suspension and recall cockpit's list (Phase 4 slice 5c; L-19, IN-29): finished lots with a market
 * RELEASE_SUSPENDED or an open recall-assessment task, oldest cause first, as the server lists them (release.suspended).
 * Each lot opens on its "After release" tab: the causes, the forward trace, the AP's acts per market and the disposal.
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { releaseTone, words } from './reads.ts';

export function SuspendedPage() {
  const q = useApiQuery(routes.release.suspended, {});
  return (
    <>
      <h1>Suspended lots and recall assessments</h1>
      <p>
        A lot is suspended by the database when a deviation, incident, data-integrity investigation, revised result, as-found calibration failure or record amendment is linked to it, or to a lot or
        batch upstream of it, after its release. Its stock is blocked in the ERP and a recall assessment is opened for the authorised person.
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.lots.length === 0 ? <p>No lot is suspended and no recall assessment is open.</p> : null}
      <ul data-testid="suspended-lots">
        {q.data?.lots.map((l) => (
          <li key={l.lotId} data-testid={`suspended-lot-${l.lotCode}`}>
            <Link to="/release/$lotId" params={{ lotId: l.lotId }} search={{ tab: 'AFTER' }}>
              {l.lotCode}
            </Link>{' '}
            {l.productCode}, batch {l.batchNumber} <StatusChip tone={releaseTone(l.manufacturerState)} label={words(l.manufacturerState)} />{' '}
            {l.suspendedMarkets.length > 0 ? `suspended for ${l.suspendedMarkets.join(', ')}` : 'no market suspended'}
            {l.openTask ? <StatusChip tone="warning" label="Recall assessment open" /> : null} since {l.since.text}
          </li>
        ))}
      </ul>
    </>
  );
}
