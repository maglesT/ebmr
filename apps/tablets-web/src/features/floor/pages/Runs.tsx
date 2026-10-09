/** Test runs (module C4; plan section 12, screen 13): every TEST- batch of this sandbox with its status. */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';

export function RunsPage() {
  const runs = useApiQuery(routes.execution.runs);
  return (
    <>
      <h1>{st('runs.title')}</h1>
      {runs.isPending ? <p>{st('loading')}</p> : null}
      {runs.error ? <RefusalMessage error={runs.error.error} /> : null}
      {runs.data && runs.data.runs.length === 0 ? <p>{st('runs.empty')}</p> : null}
      <ul className={wcls('list')} aria-label={st('runs.title')}>
        {runs.data?.runs.map((r) => (
          <li key={r.runId} className={wcls('item')} data-testid={`run-${r.batchNumber}`}>
            <h2 className={wcls('itemTitle')}>
              <span>{r.batchNumber}</span>
              <StatusChip tone={floor.stepTone(r.status)} label={r.statusText} />
              {r.markets.map((m) => (
                <StatusChip key={m} tone="neutral" label={m} />
              ))}
            </h2>
            <p>
              {r.product.name} · {st('runs.issued', { at: r.issuedAt.text })}
              {r.openExceptions > 0 ? ` · ${st('runs.openExceptions', { count: r.openExceptions })}` : ''}
            </p>
            <Link to="/runs/$runId" params={{ runId: r.runId }} className={wcls('link')}>
              {st('runs.open', { batch: r.batchNumber })}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
