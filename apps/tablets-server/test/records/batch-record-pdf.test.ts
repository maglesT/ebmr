/**
 * Owner request (8 November 2026): the "Batch record (PDF)" button on a batch's review and release pages calls the
 * existing archive.pdf route. With the extras disconnected (EBMR_DISCONNECT=1, the /archive screen off), the route stays
 * served, and it returns that batch's own PDF/A-3 true copy: named after the batch, verifiable, and carrying the content
 * the batch's evidence export names; another batch gives another content. Basis: 21 CFR 211.188 and 211.180(c), EU GMP
 * Annex 11 sections 8.1 and 8.2 (apps/tablets-web/src/features/archive/BatchRecordPdf.tsx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDisconnectedRoute, routes } from '@ebmr/api-contract';
import { records } from '@ebmr/kernel';
import { valueOf } from '../esig/support.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';

let w: GmpBatchWorld;

beforeAll(async () => {
  w = await startGmpBatchWorld(gmpContent(), { EBMR_DISCONNECT: '1' });
}, 600_000);
afterAll(async () => {
  await w?.close();
});

describe('the batch record PDF of the review and release pages (owner request)', () => {
  it('[DI-41][IN-11] with EBMR_DISCONNECT=1 the route stays served and returns that batch\'s own true copy; another batch gives another content', async () => {
    expect(isDisconnectedRoute(routes.archive.pdf.id)).toBe(false);
    const issuer = await w.gmp.asPersona('issuer');
    const qa = await w.gmp.asPersona('qaInvestigator');
    const first = await w.issued(issuer);
    const second = await w.issued(issuer);
    const copyOf = async (batchId: string) => {
      const batch = valueOf(await qa.call(routes.archive.batch, { params: { batchId } }));
      const pdf = valueOf(await qa.call(routes.archive.pdf, { params: { batchId } }));
      expect(pdf.fileName).toBe(`${batch.batchNumber}-true-copy.pdf`);
      const report = await records.verifyTrueCopyPdf(new Uint8Array(Buffer.from(pdf.pdfBase64, 'base64')));
      expect(report.problems).toEqual([]);
      expect(report.contentSha256).toBe(pdf.contentSha256);
      const exp = valueOf(await qa.call(routes.archive.assembleExport, { params: { batchId } }));
      expect(exp.pdfContentSha256).toBe(pdf.contentSha256);
      return pdf.contentSha256;
    };
    const a = await copyOf(first);
    const b = await copyOf(second);
    expect(a).not.toBe(b);
  }, 600_000);
});
