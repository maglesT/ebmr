/**
 * Owner request (8 November 2026): one "Batch record (PDF)" button on a batch's review page and on its release page.
 * It saves the existing PDF/A-3 true copy (routes.archive.pdf: the record as stored, its changes after entry and its
 * audit trail, the record data embedded; the same bytes for the same record content). Basis, checked against the
 * official texts on 8 November 2026: 21 CFR 211.188 (a complete production and control record for each batch) and
 * 211.180(c) (records readily available for authorised inspection and open to reproduction); EU GMP Annex 11 section
 * 8.1 (clear printed copies of stored data can be obtained) and 8.2 (for records behind batch release, printouts show
 * whether data changed after the original entry). The /archive
 * screen itself stays off (app/disconnected.tsx); the button is shown only to a role that may make the read
 * (readOffered, the reviewed route-by-role matrix). Display only: the server stays the authority.
 */
import { routes } from '@ebmr/api-contract';
import { ActButton, ActResult, useCommand } from '../../app/acts.tsx';
import { useSessionRole } from '../../app/roles.ts';
import { readOffered } from '../../app/tile-access.ts';
import { saveFile } from './reads.ts';

export function BatchRecordPdfButton({ batchId }: { batchId: string }) {
  // The review and release pages, like archive.pdf, are the GMP installation's. Hidden until the session's role is known.
  const role = useSessionRole();
  const pdf = useCommand(routes.archive.pdf, []);
  if (role === null || !readOffered(routes.archive.pdf.id, 'GMP', role)) return null;
  return (
    <div data-testid="batch-record-pdf">
      <ActButton
        primary={false}
        label="Batch record (PDF)"
        onPress={async () => {
          const r = await pdf.run({ params: { batchId } });
          if (r) saveFile(r.fileName, { base64: r.pdfBase64, type: 'application/pdf' });
        }}
        disabled={pdf.busy}
      />
      <ActResult error={pdf.error} />
    </div>
  );
}
