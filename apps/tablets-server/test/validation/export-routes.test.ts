/**
 * The full export and the periodic evaluation pack from the screens (Phase 7 slice 7g-3, WP1; contract ns/validation.ts;
 * kernel 1335, 1336). The CSV / DI lead starts the full export, which runs as a background job of the server (the
 * operations job runner of 7g-4) and is registered with its SHA-256 (DI-08: the data return with audit trails and
 * signatures); the lead generates the evaluation pack of an ended period through the reporting role, with its
 * readability report (DI-11, DI-44); QA signs it off with a signature bound to the pack (DI-37), never the person who
 * generated it. A person without the right is refused by the database.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { codeIn, dbNow, okOf, signAs, type Signed, signedIn } from './acts-support.ts';

const EXPORTS = mkdtempSync(join(tmpdir(), 'ebmr-7g3-export-'));

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
let csv: Signed;

beforeAll(async () => {
  server = await startSigningServer('GMP', { env: { EBMR_EXPORT_DIR: EXPORTS } });
  [steward, qa] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator')]);
  csv = await signedIn(server, 'CSV_DI_LEAD', 'Kavya Iyer');
}, 600_000);
afterAll(async () => {
  await server?.close();
});

describe('the full export (kernel 1335)', () => {
  it('[DI-08] the CSV lead starts the full export as a background job; it is registered with the SHA-256 of its manifest, which the folder holds', async () => {
    expect(codeIn(await steward.call(routes.validation.startFullExport, { body: { reason: 'supplier exit test' } }))).toBe('EBMR-IAM-040');
    const started = valueOf(await csv.browser.call(routes.validation.startFullExport, { body: { reason: 'supplier exit test' } }));
    expect(['RUNNING', 'DONE']).toContain(started.job.state);
    let view = valueOf(await csv.browser.call(routes.validation.fullExports));
    for (let i = 0; i < 600 && view.job.state === 'RUNNING'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      view = valueOf(await csv.browser.call(routes.validation.fullExports));
    }
    expect(view.job).toMatchObject({ state: 'DONE', error: null });
    expect(view.exports).toHaveLength(1);
    const e = view.exports[0]!;
    expect(e.by).toBe('Kavya Iyer');
    const m = valueOf(await qa.call(routes.validation.fullExportManifest, { params: { exportId: e.exportId } }));
    expect(createHash('sha256').update(m.manifest).digest('hex')).toBe(e.manifestSha256);
    const [folder] = readdirSync(EXPORTS);
    if (!folder) throw new Error('the export folder was written');
    expect(readFileSync(join(EXPORTS, folder, 'manifest.json'), 'utf8')).toBe(m.manifest);
    expect((JSON.parse(m.manifest) as { format: string }).format).toBe('ebmr.full-export/1');
    // The folder is the server's: a second export goes into a new folder.
    expect(view.folder).toBe(EXPORTS);
  });
});

describe('the periodic evaluation pack (kernel 1336)', () => {
  it('[DI-11][DI-44][DI-37] the CSV lead generates the pack of an ended period with its readability report; QA signs it off, never the person who generated it', async () => {
    const from = '2026-01-01T00:00:00Z';
    const to = await dbNow(server, '-1 second');
    // The steward holds neither VALIDATION.MANAGE nor RECORD.EXPORT: the database refuses to store a pack.
    expect(codeIn(await steward.call(routes.validation.runEvaluationPack, { body: { from, to, seed: 'test-seed' } }))).toBe('EBMR-IAM-040');
    const pack = valueOf(await csv.browser.call(routes.validation.runEvaluationPack, { body: { from, to, seed: 'test-seed', sampleSize: '3' } }));
    expect(pack).toMatchObject({ readabilitySeed: 'test-seed', sampleSize: '3', generatedBy: 'Kavya Iyer', approval: null });
    const file = valueOf(await qa.call(routes.validation.evaluationPackFile, { params: { packId: pack.packId } }));
    expect(createHash('sha256').update(file.content).digest('hex')).toBe(pack.packSha256);
    const body = JSON.parse(file.content) as { readThrough: string; readability: { seed: string; sampleSize: number }; topics: { topic: string }[] };
    expect(body.readThrough).toBe('ebmr_report');
    expect(body.readability).toMatchObject({ seed: 'test-seed', sampleSize: 3 });
    expect(body.topics.length).toBeGreaterThan(5);

    // The lead holds no VALIDATION.APPROVE_EVALUATION; QA signs off.
    expect((await signAs(server, csv, { kind: 'EVALUATION_PACK_APPROVE', packId: pack.packId })).ok).toBe(false);
    expect(okOf(await signAction(server, qa, 'qaInvestigator', { kind: 'EVALUATION_PACK_APPROVE', packId: pack.packId }))).toBe(true);
    const listed = valueOf(await qa.call(routes.validation.evaluationPacks)).packs.find((p) => p.packId === pack.packId);
    expect(listed?.approval).toMatchObject({ approvedBy: 'Divya Menon' });
    const { rows } = await server.db.admin.query<{ meaning_code: string }>("select meaning_code from esig.signature where aggregate_type = 'evaluation_pack' and aggregate_id = $1", [pack.packId]);
    expect(rows).toEqual([{ meaning_code: 'PERIODIC_EVALUATION_APPROVED' }]);
    // Signed off once: a second sign-off is refused and signs nothing.
    expect((await signAction(server, qa, 'qaInvestigator', { kind: 'EVALUATION_PACK_APPROVE', packId: pack.packId })).ok).toBe(false);
  });

  it('[DI-11] a period that has not ended is refused by the database; nothing is stored', async () => {
    const before = valueOf(await qa.call(routes.validation.evaluationPacks)).packs.length;
    const r = await csv.browser.call(routes.validation.runEvaluationPack, { body: { from: '2026-01-01T00:00:00Z', to: await dbNow(server, '1 day'), seed: 'later' } });
    expect(r.ok).toBe(false);
    expect(valueOf(await qa.call(routes.validation.evaluationPacks)).packs).toHaveLength(before);
  });
});
