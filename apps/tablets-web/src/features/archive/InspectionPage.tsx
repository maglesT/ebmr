/**
 * The read-only inspection workspace (Phase 4 slice 6b; DI-40, IN-11): certified evidence exports, each downloaded
 * through a logged read, and the verifier that checks an export file (one altered byte fails it). Nothing here writes a
 * record; the server refuses the list to a session without ARCHIVE.INSPECT.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { ARCHIVE_READS, saveFile } from './reads.ts';

export function InspectionPage() {
  const q = useApiQuery(routes.archive.inspection, {});
  const file = useCommand(routes.archive.exportFile, ARCHIVE_READS);
  const verify = useCommand(routes.archive.verify, []);
  const [text, setText] = useState('');
  return (
    <>
      <p>
        <Link to="/archive">Archive</Link>
      </p>
      <h1>Inspection workspace</h1>
      <p>Certified evidence exports of batch records, read-only. Every download is logged.</p>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && q.data.exports.length === 0 ? <p>No certified export yet.</p> : null}
      <ul data-testid="inspection-exports">
        {q.data?.exports.map((e) => (
          <li key={e.exportId} data-testid={`inspection-export-${e.exportId}`}>
            {e.label}, SHA-256 {e.exportSha256}, certified by {e.certifiedBy?.legalName ?? ''} {e.certifiedAt?.text ?? ''}
            <ActButton
              primary={false}
              label={`Download ${e.label}`}
              onPress={async () => {
                const r = await file.run({ params: { exportId: e.exportId } });
                if (r) {
                  setText(r.text);
                  saveFile(r.fileName, { text: r.text, type: 'application/json' });
                }
              }}
              disabled={file.busy}
            />
          </li>
        ))}
      </ul>
      <ActResult error={file.error} />
      <Section title="Verify an evidence export" testId="inspection-verify">
        <label>
          Export file
          <input
            type="file"
            accept="application/json"
            data-testid="verify-file"
            onChange={(ev) => {
              const f = ev.target.files?.[0];
              if (f) void f.text().then(setText);
            }}
          />
        </label>
        <ActButton label="Verify" onPress={() => text !== '' && verify.run({ body: { text } })} disabled={text === '' || verify.busy} />
        <ActResult error={verify.error} />
        {verify.done ? (
          <Banner tone={verify.done.ok ? 'ok' : 'error'} title={verify.done.ok ? 'Verified: the file is the registered export, unaltered.' : 'Verification failed.'}>
            <ul data-testid="verify-problems">
              {verify.done.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
      </Section>
    </>
  );
}
