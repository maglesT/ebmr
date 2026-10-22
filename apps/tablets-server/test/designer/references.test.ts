/**
 * The reference-document register (DMS stand-in, tab.reference_document) and the ReferencePort statuses the
 * validator reads (module C2; decision F2: every reference pinned by version and hash and effective at
 * validation), the palette, and the designer's absence from the sandbox (DI-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import { loadReferenceRows, referenceStatus, type ReferenceRow } from '../../src/features/designer/adapters/references.ts';
import { referenceContent, referenceHash, type ReferenceDocumentSeed } from '../../src/features/designer/reference-catalogue.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { refusalOf, startDesignerServer, stewardActor, valueOf } from './support.ts';

let server: TestServer;

beforeAll(async () => {
  server = await startDesignerServer();
});
afterAll(async () => {
  await server?.close();
});

async function record(doc: ReferenceDocumentSeed): Promise<string> {
  const content = referenceContent(doc);
  return withCommand(server.db.app, await stewardActor(server), async (c) => {
    const { rows } = await c.query<{ id: string }>('select tab.record_reference_document($1::jsonb, $2) as id', [JSON.stringify(content), referenceHash(content)]);
    return rows[0]?.id as string;
  });
}

const row = (over: Partial<ReferenceRow>): ReferenceRow => ({
  id: 'r1',
  kind: 'SOP',
  code: 'SOP-X',
  version: '1',
  title: 'x',
  contentHash: 'a'.repeat(64),
  effectiveFrom: '2025-01-01',
  retirement: null,
  ...over,
});

describe('reference documents (DMS stand-in)', () => {
  it('[PR-03][DI-04] lists the seeded DEMO-ONLY documents with their hash, all EFFECTIVE today', async () => {
    const author = await server.asPersona('author');
    const r = valueOf(await author.call(routes.designer.referenceDocuments));
    // 39, plus the references of the golden batches' masters (Phase 4 slice 7b, reference-catalogue.ts), plus the PPE
    // and decontamination SOPs of a hazardous product (Phase 6 slice 6f, IN-27), plus the 18 of the demo routes (slice 7l).
    expect(r.documents).toHaveLength(81);
    expect(r.documents.every((d) => d.status === 'EFFECTIVE' && /^[0-9a-f]{64}$/.test(d.hash))).toBe(true);
    expect(r.documents.map((d) => d.code)).toContain('SYS-WEIGH-01');
  });

  it('[DI-04] the status of a pinned reference: unknown, hash mismatch, not yet effective, superseded, retired, withdrawn', () => {
    const asOf = '2026-09-28';
    const v1 = row({ id: 'v1', version: '1', effectiveFrom: '2025-01-01' });
    const pin = { kind: 'SOP' as const, code: 'SOP-X', version: '1', hash: 'a'.repeat(64) };
    expect(referenceStatus(pin, [v1], asOf)).toBe('EFFECTIVE');
    expect(referenceStatus({ ...pin, version: '9' }, [v1], asOf)).toBe('UNKNOWN');
    expect(referenceStatus({ ...pin, kind: 'MATERIAL' }, [v1], asOf)).toBe('UNKNOWN');
    expect(referenceStatus({ ...pin, hash: 'b'.repeat(64) }, [v1], asOf)).toBe('HASH_MISMATCH');
    expect(referenceStatus(pin, [row({ effectiveFrom: '2026-10-01' })], asOf)).toBe('NOT_YET_EFFECTIVE');
    const v2 = row({ id: 'v2', version: '2', effectiveFrom: '2026-06-01', contentHash: 'c'.repeat(64) });
    expect(referenceStatus(pin, [v1, v2], asOf)).toBe('SUPERSEDED');
    expect(referenceStatus(pin, [v1, v2], '2026-05-31')).toBe('EFFECTIVE');
    const v2Withdrawn = { ...v2, retirement: { status: 'WITHDRAWN' as const, effectiveFrom: '2026-07-01', reason: 'issued in error' } };
    expect(referenceStatus(pin, [v1, v2Withdrawn], asOf)).toBe('EFFECTIVE');
    const v1Retired = { ...v1, retirement: { status: 'RETIRED' as const, effectiveFrom: '2026-09-01', reason: 'obsolete' } };
    expect(referenceStatus(pin, [v1Retired], asOf)).toBe('RETIRED');
    expect(referenceStatus(pin, [v1Retired], '2026-08-31')).toBe('EFFECTIVE');
  });

  it('[DI-04] a later registered version supersedes the pinned one, and a withdrawal is read from the register', async () => {
    const base: ReferenceDocumentSeed = { kind: 'SOP', code: 'SOP-TEST-900', version: '1', title: 'Test SOP', effectiveFrom: '2024-01-01', summary: 'first' };
    const firstId = await record(base);
    const pin = { kind: 'SOP' as const, code: base.code, version: '1', hash: referenceHash(referenceContent(base)) };
    expect(referenceStatus(pin, await loadReferenceRows(server.db.app, [base.code]), '2026-09-28')).toBe('EFFECTIVE');
    await record({ ...base, version: '2', effectiveFrom: '2025-01-01', summary: 'second' });
    expect(referenceStatus(pin, await loadReferenceRows(server.db.app, [base.code]), '2026-09-28')).toBe('SUPERSEDED');
    await withCommand(server.db.app, await stewardActor(server), (c) => c.query("select tab.retire_reference_document($1, 'WITHDRAWN', '2024-06-01', 'issued in error')", [firstId]));
    expect(referenceStatus(pin, await loadReferenceRows(server.db.app, [base.code]), '2026-09-28')).toBe('WITHDRAWN');
  });

  it('[DI-04] the register refuses a body that does not hash to the pinned value, and an author cannot record documents', async () => {
    const content = referenceContent({ kind: 'SOP', code: 'SOP-TEST-901', version: '1', title: 'T', effectiveFrom: '2024-01-01', summary: 's' });
    await expect(withCommand(server.db.app, await stewardActor(server), (c) => c.query('select tab.record_reference_document($1::jsonb, $2)', [JSON.stringify(content), 'f'.repeat(64)]))).rejects.toThrow(
      /EBMR-TAB-152/,
    );
    const { openPersonaSession } = await import('@ebmr/test-kit');
    const author = await openPersonaSession(server.db, server.seed, 'author');
    await expect(withCommand(server.db.app, author, (c) => c.query('select tab.record_reference_document($1::jsonb, $2)', [JSON.stringify(content), referenceHash(content)]))).rejects.toThrow(/EBMR-IAM-040/);
  });
});

describe('palette', () => {
  it('offers the insertable blocks with plain names; SANDBOX_ONLY versions badged; G-06, G-21 and non-steps hidden', async () => {
    const author = await server.asPersona('author');
    const { blocks } = valueOf(await author.call(routes.designer.palette));
    const keys = blocks.map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(['G-03@1', 'G-04@1', 'G-07@1', 'G-08@1', 'G-09@1', 'G-10@1', 'G-14@1', 'G-17@1', 'G-20@1', 'G-22@1']));
    for (const hidden of ['G-01@1', 'G-02@1', 'G-06@1', 'G-18@1', 'G-19@1', 'G-21@1']) expect(keys).not.toContain(hidden);
    const g10 = blocks.find((b) => b.key === 'G-10@1');
    expect(g10).toEqual(expect.objectContaining({ availability: 'SANDBOX_ONLY', badge: 'sandbox only until Phase 3', plainName: 'Clear the room or line', significant: true }));
    const g07 = blocks.find((b) => b.key === 'G-07@1');
    expect(g07?.availability).toBe('ALL');
    expect(g07?.badge).toBeNull();
    expect(g07?.defaultConfig).toEqual({});
    expect(JSON.stringify(g07?.configSchema)).toMatch(/tolerance/);
    expect(blocks.find((b) => b.key === 'G-17@1')?.level).toBe('HOLD_POINT');
  });
});

describe('installation', () => {
  it('[DI-05] the designer routes do not exist on the sandbox installation', async () => {
    const sbx = await startServer('SANDBOX');
    try {
      const issuer = await sbx.asPersona('issuer');
      const refusals = [refusalOf(await issuer.call(routes.designer.templates)), refusalOf(await issuer.call(routes.designer.families)), refusalOf(await issuer.call(routes.designer.palette))];
      for (const refused of refusals) {
        expect(refused.status).toBe(404);
        expect(refused.code).toBe('NOT_FOUND');
      }
    } finally {
      await sbx.close();
    }
  });
});
