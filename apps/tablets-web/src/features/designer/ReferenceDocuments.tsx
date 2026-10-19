/**
 * The reference documents an MBR may cite (slice 7g-5, decision 0025; route designer.referenceDocuments): each SOP or
 * specification of the document-management stand-in with its version, the hash of its content and its status today.
 * An MBR step cites one by code and version; the validator flags a citation that is not effective. Slice 7g WP3: the
 * master-data steward retires or withdraws a version from a date with the reason (marketConfig.retireReferenceDocument,
 * tab.retire_reference_document; MASTERDATA.CHANGE); the database refuses a date before the version took effect.
 */
import { useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field, floor, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
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
      {q.data && q.data.documents.length > 0 ? <RetireDocument documents={q.data.documents} /> : null}
    </section>
  );
}

function RetireDocument({ documents }: { documents: readonly { refId: string; code: string; version: string }[] }) {
  const retire = useCommand(routes.marketConfig.retireReferenceDocument, [routes.designer.referenceDocuments.id]);
  const [documentId, setDocumentId] = useState('');
  const [status, setStatus] = useState<'RETIRED' | 'WITHDRAWN'>('RETIRED');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [reason, setReason] = useState('');
  const ok = documentId !== '' && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom.trim()) && reason.trim() !== '';
  return (
    <div data-testid="reference-document-retire">
      <h3>Retire or withdraw a document version</h3>
      <floor.ChoiceGroup label="Document version" options={documents.map((d) => ({ value: d.refId, label: `${d.code} version ${d.version}` }))} value={documentId} onChange={setDocumentId} />
      <floor.ChoiceGroup label="Status" options={[{ value: 'RETIRED', label: 'Retired' }, { value: 'WITHDRAWN', label: 'Withdrawn' }]} value={status} onChange={(x) => setStatus(x as 'RETIRED' | 'WITHDRAWN')} />
      <Field name="retireFrom" label="From (YYYY-MM-DD)" value={effectiveFrom} onChange={setEffectiveFrom} />
      <Field name="retireReason" label="Reason" value={reason} onChange={setReason} />
      <ActButton
        label="Retire the document version"
        disabled={retire.busy || !ok}
        onPress={() => ok && retire.run({ params: { documentId }, body: { status, effectiveFrom: effectiveFrom.trim(), reason: reason.trim() } })}
      />
      <ActResult error={retire.error} done={retire.done} label="The document version is retired." />
    </div>
  );
}
