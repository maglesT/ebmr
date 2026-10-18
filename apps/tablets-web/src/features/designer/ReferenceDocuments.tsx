/**
 * The reference documents an MBR may cite (slice 7g-5, decision 0025; route designer.referenceDocuments): each SOP or
 * specification of the document-management stand-in with its version, the hash of its content and its status today.
 * An MBR step cites one by code and version; the validator flags a citation that is not effective.
 */
import { routes } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { dcls } from './classes.ts';

export function ReferenceDocuments() {
  const q = useApiQuery(routes.designer.referenceDocuments);
  return (
    <section aria-label="Reference documents" data-testid="reference-documents">
      <h2>Reference documents</h2>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.documents.length === 0 ? <p>No reference document is registered.</p> : null}
      {q.data && q.data.documents.length > 0 ? (
        <table className={dcls('grid')} aria-label="Reference documents with version and hash">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Kind</th>
              <th scope="col">Title</th>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Content hash</th>
            </tr>
          </thead>
          <tbody>
            {q.data.documents.map((d) => (
              <tr key={d.refId} data-testid={`reference-document-${d.code}`}>
                <td className={dcls('mono')}>{d.code}</td>
                <td>{d.kind}</td>
                <td>{d.title}</td>
                <td>{d.version}</td>
                <td>
                  <StatusChip tone={d.status === 'EFFECTIVE' ? 'ok' : d.status === 'HASH_MISMATCH' ? 'error' : 'neutral'} label={d.status} />
                </td>
                <td className={dcls('mono')}>{d.hash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
