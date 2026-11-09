/**
 * G2 (owner ruling, 8 November 2026): in Batchwright a deviation exists only for a batch record. It is raised or linked
 * from the batch, shown in its review and on its release checklist, and QA investigates, concludes and closes it there.
 * So the deviation record opens only from a batch: at /review/$batchId/deviations/$deviationId, and only when the
 * deviation is one of that batch's (the server's own batch list, quality.deviations with batchId). There is no list
 * or search across batches (/quality/deviations stays off; the server refuses the list without a batch when
 * disconnected), no CAPA, and reclassifying and cancelling stay with the Deviations product.
 */
import { Link } from '@tanstack/react-router';
import { createContext, useContext, type ReactNode } from 'react';
import { routes } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { Section } from '../../app/acts.tsx';
import { useDeviationsLinked } from '../../app/boot.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteParams } from '../floor/params.ts';
import { DeviationPage } from './DeviationPage.tsx';

const BatchOfPage = createContext<string | null>(null);

/** The batch a page shows (review, release, record lock), so a deviation it names opens as that batch's record. */
export function DeviationBatch({ batchId, children }: { batchId: string | null; children: ReactNode }) {
  return <BatchOfPage.Provider value={batchId}>{children}</BatchOfPage.Provider>;
}

/** A deviation named on a batch's page: a link to that batch's deviation record, or its label where no batch is known. */
export function DeviationRef({ deviationId, label, batchId }: { deviationId: string; label?: string; batchId?: string }) {
  const ofPage = useContext(BatchOfPage);
  const batch = batchId ?? ofPage;
  const text = label ?? deviationId;
  if (batch === null || batch === '') return <>{text}</>;
  return (
    <Link to="/review/$batchId/deviations/$deviationId" params={{ batchId: batch, deviationId }}>
      {text}
    </Link>
  );
}

/**
 * MEDHANTA slice 2: with a Deviations link, the batch's deviations are its Deviations numbers, each with the status the
 * Deviations product publishes (closed or rejected: resolved; anything else keeps release blocked).
 */
function LinkedBatchDeviations({ batchId }: { batchId: string }) {
  const q = useApiQuery(routes.quality.deviationNumbers, { params: { batchId } });
  if (q.error) return <RefusalMessage error={q.error.error} />;
  const list = q.data?.deviations ?? [];
  return (
    <Section title="Deviations of this batch (Deviations product)" testId="batch-deviations">
      {list.length === 0 ? <p>No deviation is linked to this batch.</p> : null}
      <ul>
        {list.map((d) => (
          <li key={d.number}>
            {d.number} · {d.status ?? 'not in Deviations'}
            {d.classification ? ` · ${d.classification}` : ''}
            {d.blocking ? ' · blocks release' : ''}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The batch review's list of the batch's deviations, each opening as the batch's record. */
export function BatchDeviations({ batchId }: { batchId: string }) {
  return useDeviationsLinked() ? <LinkedBatchDeviations batchId={batchId} /> : <LocalBatchDeviations batchId={batchId} />;
}

function LocalBatchDeviations({ batchId }: { batchId: string }) {
  const q = useApiQuery(routes.quality.deviations, { query: { batchId } });
  const list = q.data?.deviations ?? [];
  if (q.error) return <RefusalMessage error={q.error.error} />;
  return (
    <Section title="Deviations of this batch" testId="batch-deviations">
      {list.length === 0 ? <p>No deviation is linked to this batch.</p> : null}
      <ul>
        {list.map((d) => (
          <li key={d.deviationId}>
            <DeviationRef deviationId={d.deviationId} batchId={batchId} label={`${d.ref} ${d.title}`} /> · {d.state} · {d.classification}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** One batch's deviation record; a deviation that is not this batch's is not shown. */
export function BatchDeviationPage() {
  const p = useRouteParams();
  const batchId = p['batchId'] ?? '';
  const deviationId = p['deviationId'] ?? '';
  const q = useApiQuery(routes.quality.deviations, { query: { batchId } });
  if (q.isPending) return <p>Loading the record…</p>;
  if (!q.data) return q.error ? <RefusalMessage error={q.error.error} /> : null;
  const back = (
    <p>
      <Link to="/review/$batchId" params={{ batchId }}>
        Back to the batch
      </Link>
    </p>
  );
  if (!q.data.deviations.some((d) => d.deviationId === deviationId)) {
    return (
      <>
        <p data-testid="batch-deviation-not-this-batch">This deviation is not linked to this batch.</p>
        {back}
      </>
    );
  }
  return (
    <DeviationBatch batchId={batchId}>
      {back}
      <DeviationPage />
    </DeviationBatch>
  );
}
