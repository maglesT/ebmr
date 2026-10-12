/**
 * The batch records of the archive (Phase 4 slice 6b): each GMP batch with the state of its contingency forms and its
 * evidence exports, as the server lists them (archive.batches).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { formTone, words } from './reads.ts';

export function ArchivePage() {
  const q = useApiQuery(routes.archive.batches, {});
  return (
    <>
      <h1>Archive and retention</h1>
      <p>
        Each batch record is kept at least until the date the database computes from its markets, expiry and certification; nothing is deleted here. Paper forms issued for a batch are
        reconciled before it completes. A certified evidence export holds the record, its audit trail and its PDF/A-3 true copy. <Link to="/archive/inspection">Inspection workspace</Link>
      </p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.batches.length === 0 ? <p>No batch yet.</p> : null}
      <ul data-testid="archive-batches">
        {q.data?.batches.map((b) => (
          <li key={b.batchId} data-testid={`archive-batch-${b.batchNumber}`}>
            <Link to="/archive/batches/$batchId" params={{ batchId: b.batchId }}>
              {b.batchNumber}
            </Link>{' '}
            {words(b.status)}, paper forms <StatusChip tone={formTone(b.formsState)} label={words(b.formsState)} />, exports {b.exports} ({b.certifiedExports} certified)
          </li>
        ))}
      </ul>
    </>
  );
}
