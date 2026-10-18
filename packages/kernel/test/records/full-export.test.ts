/**
 * The full export of the installation (kernel 1335; Phase 7 slice 7b-2; DI-08 clause 2) and the seeded readability
 * sample of the closed records (DI-44 clause 1). The export holds every closed record's archive package (its chains as
 * true-copy bundles), its signature chain and every seal key chain, with a manifest listing every file's SHA-256; the
 * database registers it with the manifest's SHA-256 and refuses an export that leaves out a closed record. Run as the
 * application role, with bypass attempts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { buildFullExport, fullExports, writeFullExport, type ExportedSeal, type FullExportManifest } from '../../src/records/full-export.ts';
import { verifyTrueCopyBundleText } from '../../src/records/true-copy.ts';
import { testKeyRing } from '../esig/helpers.ts';
import { seedAdministration } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { ExportWorld } from './export-world.ts';
import { again, testActor } from './helpers.ts';

let db: TestDatabase;
let w: ExportWorld;
let closedA: string;
let closedB: string;
let open: string;
let investigation: { id: string; signatureId: string };

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ExportWorld.create(db);
  closedA = await w.closedIncident('Balance B-17 interface lost');
  open = await w.openIncident('Printer P-2 offline');
  investigation = await w.closedInvestigation(w.edKey);
  closedB = await w.closedIncident('Scale S-4 interface lost');
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

describe('the closed records (kernel 1335)', () => {
  it('[DI-08][DI-44] closed incidents and closed DI investigations are the kernel\'s closed records, read through the reporting path; an open one is not', async () => {
    const { rows } = await w.report.query<{ record_type: string; record_id: string; chain_keys: string[]; closed_at: Date }>(
      'select record_type, record_id, chain_keys, closed_at from report.closed_record_v1',
    );
    const ids = rows.map((r) => `${r.record_type}:${r.record_id}`);
    expect(ids).toEqual(expect.arrayContaining([`incident:${closedA}`, `incident:${closedB}`, `di_investigation:${investigation.id}`]));
    expect(ids).not.toContain(`incident:${open}`);
    expect(rows.find((r) => r.record_id === closedA)?.chain_keys).toEqual([`incident:${closedA}`]);
    // The application role and the reporting role read it; neither can register a source.
    await expect(db.app.query("select report.register_closed_record_source('x', 'report.closed_record_rows_v1()', 'x')")).rejects.toThrow(/permission denied/);
    await expect(w.report.query("select report.register_closed_record_source('x', 'report.closed_record_rows_v1()', 'x')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('insert into report.closed_record_source (record_type, row_function, description) values ($1, $2, $3)', ['x', 'report.closed_record_rows_v1()', 'x'])).rejects.toThrow(/permission denied/);
  });

  it('[DI-44] the readability sample is seeded: the same seed gives the same records in the same order, another seed another order, and only records closed before the given time', async () => {
    const sample = async (seed: string, before: string, size = 10) =>
      (await w.report.query<{ rank: number; record_type: string; record_id: string; sample_key: string }>(
        'select rank, record_type, record_id, sample_key from report.readability_sample_rows_v1($1, $2::timestamptz, $3)', [seed, before, size],
      )).rows;
    const now = await w.now();
    const a = await sample('2026-Q3', now);
    expect(a.map((r) => r.rank)).toEqual(a.map((_, i) => i + 1));
    expect(await sample('2026-Q3', now)).toEqual(a);
    for (const r of a) expect(r.sample_key).toBe(sha(`2026-Q3:${r.record_type}:${r.record_id}`));
    expect([...a].sort((x, y) => (x.sample_key < y.sample_key ? -1 : 1))).toEqual(a);
    const b = await sample('another seed', now);
    expect(b.map((r) => r.record_id).sort()).toEqual(a.map((r) => r.record_id).sort());
    // A size limits the sample to the first of that order.
    expect(await sample('2026-Q3', now, 2)).toEqual(a.slice(0, 2));
    // Closed after the time given: not in the sample.
    const { rows } = await db.app.query<{ t: string }>("select to_char(closed_at - interval '1 microsecond', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t from records.incident_current where id = $1", [closedB]);
    expect((await sample('2026-Q3', rows[0]!.t)).map((r) => r.record_id)).not.toContain(closedB);
    await expect(sample(' ', now)).rejects.toThrow(/EBMR-REC-141/);
    await expect(sample('x', now, 0)).rejects.toThrow(/EBMR-REC-141/);
  });
});

describe('the full export (kernel 1335)', () => {
  it('[DI-08] a full export holds every closed record\'s archive package with its audit trail, its signatures with their seals and the seal keys, each file listed with its SHA-256, and is registered with the manifest\'s SHA-256', async () => {
    const exp = await buildFullExport(db.app, again(w.lead), { keyRing: testKeyRing });
    const manifest = JSON.parse(exp.manifest) as FullExportManifest;
    expect(manifest.format).toBe('ebmr.full-export/1');
    expect(exp.manifestSha256).toBe(sha(exp.manifest));
    // Every closed record, once; not the open incident.
    const listed = manifest.records.map((r) => `${r.recordType}:${r.recordId}`);
    expect(listed).toEqual(expect.arrayContaining([`incident:${closedA}`, `incident:${closedB}`, `di_investigation:${investigation.id}`]));
    expect(listed).not.toContain(`incident:${open}`);
    expect(new Set(listed).size).toBe(listed.length);
    // Every file is listed with its SHA-256 and size, and every bundle verifies against the manifest SHA-256 the export names.
    expect([...exp.files.keys()].sort()).toEqual(manifest.files.map((f) => f.path).sort());
    for (const f of manifest.files) {
      const text = exp.files.get(f.path)!;
      expect(sha(text)).toBe(f.sha256);
      expect(Buffer.byteLength(text, 'utf8')).toBe(f.bytes);
    }
    for (const r of manifest.records) {
      for (const c of [...r.chains, ...r.signatureChains]) {
        const report = verifyTrueCopyBundleText(exp.files.get(c.path)!, { manifestSha256: c.manifestSha256, headHash: c.headHash });
        expect(report.problems).toEqual([]);
        expect(report.summary.reference).toBe('MATCHED');
      }
    }
    // The investigation's archive package holds its chain and its signature chain, with the stored manifestation.
    const inv = manifest.records.find((r) => r.recordId === investigation.id)!;
    expect(inv.chains.map((c) => c.chainKey)).toEqual([`di_investigation:${investigation.id}`]);
    expect(inv.signatureChains.map((c) => c.chainKey)).toEqual([`esig_signature:di_investigation:${investigation.id}`]);
    const sigBundle = JSON.parse((JSON.parse(exp.files.get(inv.signatureChains[0]!.path)!) as { parts: Record<string, string> }).parts['records.json']!) as { tables: { table: string; rows: { content: string }[] }[] };
    const sigRow = JSON.parse(sigBundle.tables.find((t) => t.table === 'esig.signature')!.rows[0]!.content) as { id: string; manifestation: { printed_name: string; meaning_code: string } };
    expect(sigRow).toMatchObject({ id: investigation.signatureId, manifestation: { printed_name: 'Head of QA', meaning_code: 'DI_INVESTIGATION_CLOSED' } });
    // The seal payload of every signature, with the installation's check of its seal (Ed25519 here: the test ring has
    // only the HMAC key, so the installation reports it unknown; the viewer checks Ed25519 seals itself).
    const seals = (JSON.parse(exp.files.get('signatures.json')!) as { seals: ExportedSeal[] }).seals;
    const seal = seals.find((s) => s.signatureId === investigation.signatureId)!;
    expect(seal).toMatchObject({ keyId: w.edKey.keyId, algorithm: 'ED25519', installationCheck: 'UNKNOWN_KEY' });
    expect(JSON.parse(seal.payload)).toMatchObject({ signature_id: investigation.signatureId, aggregate_type: 'di_investigation', aggregate_id: investigation.id });
    // The seal key chains hold the Ed25519 public key.
    expect(manifest.sealKeys.map((k) => k.chainKey)).toEqual(expect.arrayContaining([`esig_seal_key:${w.edKey.keyId}`]));
    // Registered: the reference held outside the export.
    const reg = (await fullExports(db.app)).find((e) => e.id === exp.exportId);
    expect(reg).toMatchObject({ manifestSha256: exp.manifestSha256, recordCount: manifest.records.length, fileCount: manifest.files.length, exportedByPerson: w.lead.personId });
    const { rows } = await db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key = 'full_export:' || $1", [exp.exportId]);
    expect(rows[0]?.n).toBe('1');
  });

  it('[DI-08] the export is written into an empty folder as exactly the files of its manifest', async () => {
    const exp = await buildFullExport(db.app, again(w.lead));
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-export-'));
    try {
      writeFullExport(join(dir, 'out'), exp);
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(join(dir, 'out'), join(d, n))]));
      const files = walk(join(dir, 'out')).sort();
      expect(files).toEqual(['manifest.json', ...exp.files.keys()].sort());
      expect(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8')).toBe(exp.manifest);
      expect(() => writeFullExport(join(dir, 'out'), exp)).toThrow(/EBMR-REC-144/);
      // Without the installation's key ring every seal is NOT_CHECKED.
      expect((JSON.parse(exp.files.get('signatures.json')!) as { seals: ExportedSeal[] }).seals.every((s) => s.installationCheck === 'NOT_CHECKED')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('[DI-08] only RECORD.EXPORT exports; a chain outside the export, a manifest whose hash differs or one that leaves out a closed record is refused', async () => {
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    await expect(buildFullExport(db.app, again(operator))).rejects.toThrow(/EBMR-IAM-040/);
    const { admin } = await seedAdministration(db);
    await expect(buildFullExport(db.app, again(admin))).rejects.toThrow(/EBMR-IAM-04/);
    await expect(db.app.query('select records.full_export_index()')).rejects.toThrow(/EBMR-/);
    const asLead = <T>(sql: string, params: unknown[]) => withCommand(db.app, again(w.lead), async (c) => (await c.query<{ v: T }>(sql, params)).rows[0]?.v);
    // A chain that is no closed record's (an account's, with its credentials) is never handed out.
    await expect(asLead('select records.full_export_snapshot($1::text[]) as v', [[`account:${w.lead.accountId}`]])).rejects.toThrow(/EBMR-REC-143/);
    await expect(asLead('select records.full_export_snapshot($1::text[]) as v', [[`incident:${open}`]])).rejects.toThrow(/EBMR-REC-143/);
    await expect(asLead('select records.full_export_snapshot($1::text[]) as v', [[]])).rejects.toThrow(/EBMR-REC-142/);
    await expect(asLead('select records.full_export_snapshot($1::text[]) as v', [Array.from({ length: 201 }, () => `incident:${closedA}`)])).rejects.toThrow(/EBMR-REC-142/);
    const parts = await asLead<{ chainKey: string; snapshot: { aggregateId: string } }[]>('select records.full_export_snapshot($1::text[]) as v', [[`incident:${closedA}`]]);
    expect(parts?.[0]).toMatchObject({ chainKey: `incident:${closedA}`, snapshot: { aggregateId: closedA } });
    // Registration: the hash must be the manifest's, and the manifest must list every closed record.
    const exp = await buildFullExport(db.app, again(w.lead));
    const m = JSON.parse(exp.manifest) as FullExportManifest;
    const short = `${JSON.stringify({ ...m, records: m.records.slice(1) }, null, 2)}\n`;
    await expect(asLead('select records.register_full_export($1, $2) as v', [short, sha(short)])).rejects.toThrow(/EBMR-REC-145/);
    await expect(asLead('select records.register_full_export($1, $2) as v', [exp.manifest, sha(`${exp.manifest} `)])).rejects.toThrow(/EBMR-REC-144/);
    await expect(asLead('select records.register_full_export($1, $2) as v', ['{"format": "other"}', sha('{"format": "other"}')])).rejects.toThrow(/EBMR-REC-144/);
    // The register cannot be written or changed directly.
    await expect(db.app.query('insert into records.full_export (manifest_sha256, manifest, record_count, file_count, exported_by_person, exported_by_account) values ($1, $2, 0, 0, $3, $3)', [sha('x'), 'x', randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('update records.full_export set record_count = 0 where id = $1', [exp.exportId])).rejects.toThrow(/EBMR-|insert-only|not allowed/i);
  });
});
