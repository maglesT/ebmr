/**
 * Storing an evidence document (slice 7g-5, decision 0025; route quality.registerEvidenceDocument): an investigation
 * report, a risk assessment or a certificate is stored in the database with its title and type; the database computes
 * its SHA-256 and size (nothing is self-attested), and the answer gives the document's id, by which a deviation's
 * classification or closure cites it. At most 4 MB; the bytes travel once, in the storing call.
 */
import { useId, useState } from 'react';
import { routes } from '@ebmr/api-contract';
import { Field } from '@ebmr/ui-kit';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';

const TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv', 'application/json', 'application/xml'] as const;
const MAX_BYTES = 4_194_304;

/** The file's bytes as standard base64. */
async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function EvidenceDocumentSection() {
  const store = useCommand(routes.quality.registerEvidenceDocument, [], 'storing the document');
  const inputId = useId();
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const type = TYPES.find((t) => t === file?.type) ?? null;
  const problem = file === null ? null : type === null ? `A ${file.type || 'file of unknown type'} cannot be stored: PDF, PNG, JPEG, TIFF, text, CSV, JSON or XML only.` : file.size === 0 || file.size > MAX_BYTES ? 'The document must hold between 1 byte and 4 MB.' : null;
  const ok = title.trim() !== '' && file !== null && type !== null && problem === null;
  const done = store.done;
  return (
    <Section title="Store an evidence document" testId="evidence-document">
      <p>An investigation report, a risk assessment or a certificate is stored here; the database computes its fingerprint (SHA-256) and size, and its id is what a record cites.</p>
      <Field name="evidenceTitle" label="Title" value={title} onChange={setTitle} />
      <div style={{ marginBlock: '0.5rem' }}>
        <label htmlFor={inputId} style={{ display: 'block' }}>
          Document (at most 4 MB)
        </label>
        <input id={inputId} name="evidenceFile" type="file" accept={TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ minHeight: '2.75rem' }} />
      </div>
      {problem ? <p role="alert">{problem}</p> : null}
      <ActButton
        label="Store the document"
        disabled={!ok || store.busy}
        onPress={async () => {
          if (!ok || !file || !type) return;
          await store.run({ body: { title: title.trim(), mediaType: type, contentBase64: await base64Of(file) } });
        }}
      />
      <ActResult error={store.error} done={done} label="The document is stored." />
      {done ? (
        <p data-testid="evidence-document-stored">
          Stored as <code>{done.documentId}</code>: {done.title} ({done.mediaType}, {done.sizeBytes} bytes), SHA-256 <code>{done.sha256}</code>, by {done.uploadedBy.legalName} on {done.uploadedAt.text}.
        </p>
      ) : null}
    </Section>
  );
}
