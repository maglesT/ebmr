/**
 * Send to sandbox (module C2; decision D5; DI-05): the write-once ebmr.mbr-test-package v1 file in the exchange
 * directory, its GMP stamp and hashes, the export recorded on the version's audit chain, and the sandbox import's
 * own check (defineBatch for the SANDBOX) on the exported content.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '@ebmr/kernel';
import { routes } from '@ebmr/api-contract';
import { blocks, engine, flow } from '@ebmr/recipe-core/pure';
import { execution } from '@ebmr/recipe-core';
import type { TestPackage } from '../../src/features/designer/package-export.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createFamily, edited, findPhase, refusalOf, removeNode, saveContent, startDesignerServer, valueOf } from './support.ts';

let server: TestServer;
let author: TestBrowser;
let exchange: string;

beforeAll(async () => {
  exchange = mkdtempSync(join(tmpdir(), 'ebmr-c2-exchange-'));
  server = await startDesignerServer({ env: { EBMR_EXCHANGE_DIR: exchange, EBMR_OTHER_INSTALLATION_URL: 'http://localhost:3011' } });
  author = await server.asPersona('author');
});
afterAll(async () => {
  await server?.close();
  rmSync(exchange, { recursive: true, force: true });
});

describe('send to sandbox (test package)', () => {
  it('[DI-05] writes a write-once package with the GMP stamp, both hashes and the justifications, and records it on the audit chain', async () => {
    const v0 = await createFamily(author);
    const v = valueOf(await saveContent(author, v0, edited(v0, (j) => (findPhase(j, 'p-disp-exc').config = {})), 'excipient tolerance removed'));
    const key = 'G07-TOLERANCE-MISSING@p-disp-exc';
    valueOf(await author.call(routes.designer.justify, { params: { versionId: v.versionId }, body: { findingKey: key, text: 'Checked at reconciliation.' } }));

    const r = valueOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {} }));
    expect(r.fileName).toBe(`${r.packageHash}.json`);
    expect(r.packageId).toBe(r.packageHash);
    expect(r.sandboxUrl).toBe(`http://localhost:3011/test-packages?package=${r.packageHash}`);

    const dir = join(exchange, 'to-sandbox');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([r.fileName]);
    expect(readdirSync(join(dir, '.staging'))).toEqual([]);
    const raw: unknown = JSON.parse(readFileSync(join(dir, r.fileName), 'utf8'));
    // The sandbox importer's own strict parser (C3) accepts the file: exact members, both hashes, the file name.
    const parsedPkg = execution.parseTestPackage(raw, r.fileName);
    expect(parsedPkg.ok ? [] : parsedPkg.problems).toEqual([]);
    const pkg = raw as TestPackage;
    expect(Object.keys(pkg).sort()).toEqual(['content', 'contentHash', 'exportedAtUs', 'exporter', 'family', 'format', 'formatVersion', 'justifications', 'packageHash', 'source', 'version'].sort());
    expect(pkg.format).toBe('ebmr.mbr-test-package');
    expect(pkg.formatVersion).toBe(1);
    expect(pkg.source).toEqual({ installationKind: 'GMP', watermark: null });
    expect(pkg.packageHash).toBe(execution.packageHashOf(pkg));
    expect(pkg.contentHash).toBe(v.contentHash);
    const parsed = flow.parseMbr(pkg.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(flow.mbrContentHash(parsed.mbr)).toBe(pkg.contentHash);
    expect(pkg.family).toEqual({ familyId: v.familyId, familyCode: 'PCM500-DC', product: { code: 'PCM500', name: 'Paracetamol tablets', strength: '500 mg' } });
    expect(pkg.version).toEqual({ versionId: v.versionId, number: '1', revision: v.revision, state: 'DRAFT' });
    expect(pkg.exporter).toEqual(expect.objectContaining({ legalName: 'Asha Rao', loginName: 'asha.rao' }));
    expect(pkg.exportedAtUs).toMatch(/^[0-9]{16}$/);
    expect(pkg.justifications).toEqual([expect.objectContaining({ key, text: 'Checked at reconciliation.' })]);

    // The sandbox import's own check: the exported content defines for the SANDBOX with the carried justifications.
    if (parsed.ok) {
      const def = engine.defineBatch(parsed.mbr, { registry: blocks.genericBlockRegistry(), installation: 'SANDBOX', justifications: pkg.justifications });
      expect(def.steps.size).toBe(14);
    }

    // Recorded on the version's audit chain (row and plain-language entry), and the chain verifies.
    const { rows } = await server.db.admin.query<{ action: string; message: string | null }>(
      "select action, payload -> 'body' ->> 'message' as message from kernel.audit_event where chain_key = $1 order by seq",
      [v.auditChain],
    );
    expect(rows.some((e) => e.action === 'BUSINESS' && /Test package [0-9a-f]{12} exported/.test(e.message ?? ''))).toBe(true);
    expect(await verifyChain(server.db.admin, v.auditChain)).toEqual([]);
    const exp = await server.db.admin.query('select package_hash, content_hash, content_revision from tab.mbr_test_package_export where version_id = $1', [v.versionId]);
    expect(exp.rows).toEqual([{ package_hash: r.packageHash, content_hash: v.contentHash, content_revision: v.revision }]);
  });

  it('[DI-05] a version that does not pass its checks is not sent to the sandbox, and nothing is written', async () => {
    const v0 = await createFamily(author, { familyCode: 'PCM500-NOPKG', batchSizes: [{ quantity: '12', unit: 'kg' }] });
    const v = valueOf(await saveContent(author, v0, edited(v0, (j) => removeNode(j, 'p-disp-clear')), 'clearance removed'));
    const before = readdirSync(join(exchange, 'to-sandbox')).length;
    const r = refusalOf(await author.call(routes.designer.testPackage, { params: { versionId: v.versionId }, body: {} }));
    expect(r.status).toBe(422);
    expect(r.code).toBe('DESIGNER_GATE_FAILED');
    expect(readdirSync(join(exchange, 'to-sandbox')).length).toBe(before);
  });

  it('[DI-18] the application role cannot write the designer tables directly (only through the checked functions)', async () => {
    for (const sql of [
      "insert into tab.mbr_test_package_export (version_id, content_revision, content_hash, package_hash, file_name, person_id, account_id, role_code) values (gen_random_uuid(), 1, repeat('a', 64), repeat('b', 64), repeat('b', 64) || '.json', gen_random_uuid(), gen_random_uuid(), 'X')",
      "insert into tab.designer_justification (version_id, finding_key, text, content_revision, content_hash, person_id, account_id, role_code) values (gen_random_uuid(), 'A@b', 't', 1, repeat('a', 64), gen_random_uuid(), gen_random_uuid(), 'X')",
      "insert into tab.reference_document (kind, code, version, title, content, content_hash, effective_from, recorded_by_person, recorded_by_account, recorded_role) values ('SOP', 'X', '1', 'x', '{}', repeat('a', 64), current_date, gen_random_uuid(), gen_random_uuid(), 'X')",
      'delete from tab.reference_document',
      'update tab.designer_justification set text = text',
    ]) {
      await expect(server.db.app.query(sql)).rejects.toThrow(/permission denied/);
    }
  });
});
