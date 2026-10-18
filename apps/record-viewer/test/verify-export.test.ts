/**
 * The stand-alone viewer's verifier (apps/record-viewer/src/verify; Phase 7 slice 7b-2; DI-08 clause 2) on a real full
 * export of a test database with closed records: incidents, and DI investigations closed with QA's signature sealed with
 * an Ed25519 key and with the test HMAC key. The viewer's verifier is its own code (it may import no server package);
 * here it must pass the intact export, find every alteration, and agree with the kernel's verifier on every bundle.
 * The browser test (tools/e2e/specs/records/record-viewer.spec.ts) opens such an export in the built page.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFullExport, type FullExport, type FullExportManifest } from '../../../packages/kernel/src/records/full-export.ts';
import { verifyTrueCopyBundleText } from '../../../packages/kernel/src/records/true-copy.ts';
import { testKeyRing } from '../../../packages/kernel/test/esig/helpers.ts';
import { ExportWorld } from '../../../packages/kernel/test/records/export-world.ts';
import { again } from '../../../packages/kernel/test/records/helpers.ts';
import { createTestDatabase, type TestDatabase } from '../../../packages/kernel/test/support/db.ts';
import { sealMessage, verifyEd25519, fromBase64 } from '../src/verify/crypto.ts';
import { verifyBundleBytes, verifyExport, type ExportFile } from '../src/verify/index.ts';

let db: TestDatabase;
let w: ExportWorld;
let exp: FullExport;
let manifest: FullExportManifest;
let edInvestigation: { id: string; signatureId: string };
let hmacInvestigation: { id: string; signatureId: string };
let incident: string;

const enc = new TextEncoder();
const sha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** The export as a folder picker gives it: every path under the folder's name. */
function folder(files: Map<string, string>, manifestText: string): ExportFile[] {
  return [...files.entries(), ['manifest.json', manifestText] as const].map(([path, text]) => ({ path: `export-2026/${path}`, bytes: enc.encode(text) }));
}
const intact = (): ExportFile[] => folder(exp.files, exp.manifest);

/** The export with one file changed and, when `rehash`, the manifest's SHA-256 and size of that file recomputed. */
function altered(path: string, change: (text: string) => string, rehash = false): ExportFile[] {
  const files = new Map(exp.files);
  const text = change(files.get(path)!);
  files.set(path, text);
  let m = exp.manifest;
  if (rehash) {
    const parsed = JSON.parse(exp.manifest) as FullExportManifest;
    const f = parsed.files.find((x) => x.path === path)!;
    f.sha256 = sha(text);
    f.bytes = Buffer.byteLength(text, 'utf8');
    m = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return folder(files, m);
}

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ExportWorld.create(db);
  incident = await w.closedIncident('Balance B-17 interface lost');
  edInvestigation = await w.closedInvestigation(w.edKey);
  hmacInvestigation = await w.closedInvestigation();
  exp = await buildFullExport(db.app, again(w.lead), { keyRing: testKeyRing });
  manifest = JSON.parse(exp.manifest) as FullExportManifest;
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

const recordOf = (report: Awaited<ReturnType<typeof verifyExport>>, id: string) => report.records.find((r) => r.recordId === id)!;

describe('the record viewer verifies a full export before it shows anything (DI-08)', () => {
  it('[DI-08] an intact export passes every check: each record with its audit trail and its signature manifestations, an Ed25519 seal verified offline, an HMAC seal with the installation\'s check', async () => {
    const report = await verifyExport(intact(), { manifestSha256: exp.manifestSha256 });
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ ok: true, readable: true, reference: 'MATCHED', manifestSha256: exp.manifestSha256 });
    expect(report.records.map((r) => r.recordId).sort()).toEqual(manifest.records.map((r) => r.recordId).sort());
    for (const r of report.records) {
      expect(r.problems, r.label).toEqual([]);
      expect(r.chains[0]!.chain!.events.length).toBeGreaterThan(0);
    }
    const ed = recordOf(report, edInvestigation.id);
    expect(ed.signatures).toHaveLength(1);
    expect(ed.signatures[0]).toMatchObject({ signatureId: edInvestigation.signatureId, meaningCode: 'DI_INVESTIGATION_CLOSED', seal: { algorithm: 'ED25519', result: 'VERIFIED' } });
    expect(ed.signatures[0]!.manifestation['printed_name']).toBe('Head of QA');
    expect(ed.signatures[0]!.manifestationText).toContain('Head of QA');
    const hmac = recordOf(report, hmacInvestigation.id);
    expect(hmac.signatures[0]).toMatchObject({ seal: { algorithm: 'HMAC-SHA256', result: 'NOT_CHECKABLE_OFFLINE', installationCheck: 'VALID' } });
    expect(recordOf(report, incident).signatures).toEqual([]);
    expect(report.counts).toMatchObject({ records: manifest.records.length, sealsVerified: 1, sealsNotCheckable: 1 });
    // Without a reference the export only agrees with itself, and says so.
    expect((await verifyExport(intact())).reference).toBe('NONE');
  });

  it('[DI-08] a tampered file is shown as failed: the altered record fails with its finding and is not shown, the others stay verified', async () => {
    const path = manifest.records.find((r) => r.recordId === incident)!.chains[0]!.path;
    // One byte of the record file changed: its SHA-256 no longer matches the manifest.
    const r1 = await verifyExport(altered(path, (t) => t.replace('Balance B-17', 'Balance B-18')));
    expect(r1.ok).toBe(false);
    expect(r1.readable).toBe(true);
    expect(r1.problems.join('\n')).toContain(`${path}: SHA-256 differs from the manifest (the file was altered)`);
    expect(recordOf(r1, incident)).toMatchObject({ ok: false });
    expect(recordOf(r1, edInvestigation.id).ok).toBe(true);
    // The same change with the manifest's file hash recomputed: the bundle's own checks find it.
    const r2 = await verifyExport(altered(path, (t) => t.replace('Balance B-17', 'Balance B-18'), true));
    expect(recordOf(r2, incident).ok).toBe(false);
    expect(recordOf(r2, incident).problems.join('\n')).toMatch(/SHA-256 does not match the manifest \(content altered\)|differs from its canonical serialisation/);
    // With the export register's SHA-256 given, a re-hashed manifest is not the registered export: nothing is shown.
    const r3 = await verifyExport(altered(path, (t) => t.replace('Balance B-17', 'Balance B-18'), true), { manifestSha256: exp.manifestSha256 });
    expect(r3).toMatchObject({ ok: false, readable: false, reference: 'MISMATCHED', records: [] });
  });

  it('[DI-08] a row changed and re-hashed inside its bundle, a seal payload swapped, a missing or an extra file, an unreadable manifest: each is reported', async () => {
    // A row's content and its SHA-256 changed, the bundle's part hashes and manifest recomputed: the audit trail's
    // INSERT row hash still finds it.
    const path = manifest.records.find((r) => r.recordId === incident)!.chains[0]!.path;
    const deep = altered(path, (t) => {
      const b = JSON.parse(t) as { format: string; manifestSha256: string; manifest: string; parts: Record<string, string> };
      const recs = JSON.parse(b.parts['records.json']!) as { tables: { table: string; rows: { content: string; sha256: string }[] }[] };
      const row = recs.tables.find((x) => x.table === 'records.incident')!.rows[0]!;
      row.content = row.content.replace('Balance B-17', 'Balance B-18');
      row.sha256 = sha(row.content);
      b.parts['records.json'] = JSON.stringify(recs, null, 2);
      const m = JSON.parse(b.manifest) as { parts: { name: string; sha256: string; bytes: number }[] };
      for (const p of m.parts) {
        p.sha256 = sha(b.parts[p.name]!);
        p.bytes = Buffer.byteLength(b.parts[p.name]!, 'utf8');
      }
      b.manifest = JSON.stringify(m, null, 2);
      b.manifestSha256 = sha(b.manifest);
      return `${JSON.stringify({ format: b.format, manifestSha256: b.manifestSha256, manifest: b.manifest, parts: b.parts })}\n`;
    }, true);
    const r1 = await verifyExport(deep);
    expect(recordOf(r1, incident).problems.join('\n')).toMatch(/row differs from the hash recorded when it was inserted/);
    expect(recordOf(r1, incident).problems.join('\n')).toMatch(/manifest SHA-256 differs from the one the export lists/);
    // A seal payload changed in signatures.json (its file hash recomputed): it is not the payload the seal was made over.
    const swapped = altered('signatures.json', (t) => t.replaceAll('"meaning_code\\":\\"DI_INVESTIGATION_CLOSED', '"meaning_code\\":\\"DI_INVESTIGATION_OPENED'), true);
    const r2 = await verifyExport(swapped);
    expect(r2.ok).toBe(false);
    for (const id of [edInvestigation.id, hmacInvestigation.id]) {
      expect(recordOf(r2, id).problems.join('\n')).toMatch(/seal payload differs from the one the seal was made over/);
    }
    // A missing file and a file nobody listed.
    const missing = intact().filter((f) => !f.path.endsWith(path));
    expect((await verifyExport(missing)).problems.join('\n')).toContain(`${path} is listed in the manifest but missing`);
    const extra = [...intact(), { path: 'export-2026/records/0099-batch/batch_x.json', bytes: enc.encode('{}') }];
    expect((await verifyExport(extra)).problems).toContain('records/0099-batch/batch_x.json is in the folder but not listed in the manifest');
    // A manifest that cannot be read, or none: nothing is shown.
    const badManifest = folder(exp.files, exp.manifest.replace('"format": "ebmr.full-export/1"', '"format": "other"'));
    expect(await verifyExport(badManifest)).toMatchObject({ ok: false, readable: false, records: [] });
    expect(await verifyExport(intact().filter((f) => !f.path.endsWith('manifest.json')))).toMatchObject({ ok: false, readable: false });
  });

  it('[DI-08] the Ed25519 seal check is the browser\'s own: the sealed message verifies, the same seal over a changed payload does not', async () => {
    const seals = (JSON.parse(exp.files.get('signatures.json')!) as { seals: { signatureId: string; keyId: string; algorithm: string; payload: string }[] }).seals;
    const s = seals.find((x) => x.signatureId === edInvestigation.signatureId)!;
    const sigPath = manifest.records.find((r) => r.recordId === edInvestigation.id)!.signatureChains[0]!.path;
    const recs = JSON.parse((JSON.parse(exp.files.get(sigPath)!) as { parts: Record<string, string> }).parts['records.json']!) as { tables: { table: string; rows: { content: string }[] }[] };
    const sealRow = JSON.parse(recs.tables.find((t) => t.table === 'esig.signature_seal')!.rows[0]!.content) as { seal: string };
    const seal = fromBase64(sealRow.seal)!;
    expect(await verifyEd25519(w.edKey.publicKeyPem, sealMessage(s.keyId, s.algorithm, s.payload), seal)).toBe('VALID');
    expect(await verifyEd25519(w.edKey.publicKeyPem, sealMessage(s.keyId, s.algorithm, s.payload.replace('DI_INVESTIGATION_CLOSED', 'DI_INVESTIGATION_CLOSEX')), seal)).toBe('INVALID');
    const other = (await import('../../../packages/kernel/src/esig/keys.ts')).generateEd25519SealKey('other-key-1');
    expect(await verifyEd25519(other.publicKeyPem, sealMessage(s.keyId, s.algorithm, s.payload), seal)).toBe('INVALID');
  });

  it('[DI-08] the viewer\'s verifier and the kernel\'s agree on every bundle of the export and on altered copies of each', async () => {
    const paths = manifest.files.filter((f) => f.kind === 'TRUE_COPY').map((f) => f.path);
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const path of paths) {
      const text = exp.files.get(path)!;
      const kernel = verifyTrueCopyBundleText(text);
      const viewer = await verifyBundleBytes(enc.encode(text));
      expect([path, viewer.ok, viewer.problems]).toEqual([path, kernel.ok, kernel.problems]);
      expect(viewer.ok).toBe(true);
      // Altered copies: a byte in the middle, an audit event's payload, the last byte.
      const mid = Math.floor(text.length / 2);
      const variants = [
        text.slice(0, mid) + (text[mid] === 'a' ? 'b' : 'a') + text.slice(mid + 1),
        text.replace('\\"action\\": \\"INSERT\\"', '\\"action\\": \\"UPDATE\\"'),
        `${text.slice(0, -1)} `,
      ];
      for (const v of variants) {
        if (v === text) continue;
        const k = verifyTrueCopyBundleText(v);
        const b = await verifyBundleBytes(enc.encode(v));
        expect([path, b.ok]).toEqual([path, false]);
        expect(k.ok).toBe(false);
      }
    }
  });
});
