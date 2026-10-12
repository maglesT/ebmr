/**
 * The EU QP's own read-only view (Phase 4 slice 4c, on slice 4b's routes /api/qp/*): the issued packages of the one lot
 * a live, time-boxed access names, and the download of a package file (each read is logged by the server) with its
 * hashes, to verify offline with the kernel's package verifier. Nothing here changes any record.
 */
import { useState } from 'react';
import { routes, type QpPackageFileView } from '@ebmr/api-contract';
import { Banner } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, Section } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import type { CallError } from '@ebmr/api-contract';

export function QpReaderPage() {
  const q = useApiQuery(routes.qpPackage.readerPackages, {});
  const [file, setFile] = useState<QpPackageFileView | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async (packageId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.call(routes.qpPackage.readerFile, { params: { packageId } });
      if (r.ok) setFile(r.value);
      else setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  const packages = q.data?.packages ?? [];
  return (
    <>
      <h1>QP batch packages</h1>
      <Banner tone="info" title="Read-only access">
        You see the issued packages of the one lot your access names, until the access ends. Every download is recorded.
      </Banner>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data && packages.length === 0 ? <p>No package is open to you now.</p> : null}
      <ul aria-label="Packages open to you">
        {packages.map((p) => (
          <li key={p.packageId} data-testid={`qp-reader-${p.packageId}`}>
            {p.label}: package SHA-256 {p.packageSha256}, {p.contentBytes} bytes, issued {p.issuedAt.text}; your access ends {p.accessValidTo.text}{' '}
            <ActButton primary={false} label={`Download ${p.label}`} onPress={() => download(p.packageId)} disabled={busy} />
          </li>
        ))}
      </ul>
      {error ? <RefusalMessage error={error} /> : null}
      {file ? (
        <Section title="Downloaded package" testId="qp-reader-file">
          <p>
            Package SHA-256 {file.packageSha256}; file SHA-256 {file.contentSha256}. Verify it offline with the package verifier before you rely on it.
          </p>
          <a href={`data:application/json;charset=utf-8,${encodeURIComponent(file.content)}`} download={`qp-package-${file.packageId}.json`}>
            Save the package file
          </a>
        </Section>
      ) : null}
    </>
  );
}
