/**
 * The full export of the installation (kernel 1335; Phase 7 slice 7b-2; DI-08 clause 2) and the seeded readability
 * sample of the closed records (DI-44 clause 1). The export holds every closed record's archive package (its chains as
 * true-copy bundles), its signature chains and every seal key chain, written file by file into a folder, with a manifest
 * listing every file's SHA-256; the database registers it only when the manifest is exactly the run's records, chains,
 * heads and files. Run as the application role, with bypass attempts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { buildFullExport, fullExports, type ExportedSeal, type FullExportManifest } from '../../src/records/full-export.ts';
import { verifyTrueCopyBundleText } from '../../src/records/true-copy.ts';
import { testKeyRing } from '../esig/helpers.ts';
import { seedAdministration } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { ExportWorld } from './export-world.ts';
import { again, signerActor, testActor } from './helpers.ts';

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
  w?.cleanUp();
  await db?.drop();
});

/** In one command of `ctx`: begin a run, then `work` with the run id. */
async function inRun<T>(ctx: ActorContext, work: (run: string, q: <R>(sql: string, params: unknown[]) => Promise<R | undefined>) => Promise<T>): Promise<T> {
  return withCommand(db.app, again(ctx), async (c) => {
    const run = (await c.query<{ b: { runId: string } }>('select records.begin_full_export() as b')).rows[0]!.b.runId;
    return work(run, async <R,>(sql: string, params: unknown[]) => (await c.query<{ v: R }>(sql, params)).rows[0]?.v);
  });
}

describe('the closed records (kernel 1335)', () => {
  it('[DI-08][DI-44] closed incidents and closed DI investigations are the kernel\'s closed records, read through the reporting path; an open one is not', async () => {
    const { rows } = await w.report.query<{ record_type: string; record_id: string; chain_keys: string[]; closed_at: Date }>(
      'select record_type, record_id, chain_keys, closed_at from report.closed_record_v1',
    );
    const ids = rows.map((r) => `${r.record_type}:${r.record_id}`);
    expect(ids).toEqual(expect.arrayContaining([`incident:${closedA}`, `incident:${closedB}`, `di_investigation:${investigation.id}`]));
    expect(ids).not.toContain(`incident:${open}`);
    expect(rows.find((r) => r.record_id === closedA)?.chain_keys).toEqual([`incident:${closedA}`]);
    await expect(db.app.query("select report.register_closed_record_source('x', 'report.closed_record_rows_v1()', 'x')")).rejects.toThrow(/permission denied/);
    await expect(w.report.query("select report.register_closed_record_source('x', 'report.closed_record_rows_v1()', 'x')")).rejects.toThrow(/permission denied/);
    await expect(db.app.query('insert into report.closed_record_source (record_type, row_function, description) values ($1, $2, $3)', ['x', 'report.closed_record_rows_v1()', 'x'])).rejects.toThrow(/permission denied/);
    await expect(db.app.query("select records.register_export_restricted_table('records.incident', 'RECORD.READ', 'x')")).rejects.toThrow(/permission denied/);
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
    expect(await sample('2026-Q3', now, 2)).toEqual(a.slice(0, 2));
    const { rows } = await db.app.query<{ t: string }>("select to_char(closed_at - interval '1 microsecond', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t from records.incident_current where id = $1", [closedB]);
    expect((await sample('2026-Q3', rows[0]!.t)).map((r) => r.record_id)).not.toContain(closedB);
    await expect(sample(' ', now)).rejects.toThrow(/EBMR-REC-141/);
    await expect(sample('x', now, 0)).rejects.toThrow(/EBMR-REC-141/);
  });
});

describe('the full export (kernel 1335)', () => {
  it('[DI-08] a full export holds every closed record\'s archive package with its audit trail, its signatures with their seals and the seal keys, each file listed with its SHA-256, and is registered with the manifest\'s SHA-256', async () => {
    const { exp, manifest, files } = await w.export({ keyRing: testKeyRing, page: 1, batch: 1 });
    expect(manifest.format).toBe('ebmr.full-export/1');
    expect(exp.manifestSha256).toBe(sha(exp.manifest));
    const listed = manifest.records.map((r) => `${r.recordType}:${r.recordId}`);
    expect(listed).toEqual(expect.arrayContaining([`incident:${closedA}`, `incident:${closedB}`, `di_investigation:${investigation.id}`]));
    expect(listed).not.toContain(`incident:${open}`);
    expect(new Set(listed).size).toBe(listed.length);
    for (const f of manifest.files) {
      const text = files.get(f.path)!;
      expect(sha(text)).toBe(f.sha256);
      expect(Buffer.byteLength(text, 'utf8')).toBe(f.bytes);
    }
    for (const r of manifest.records) {
      for (const c of [...r.chains, ...r.signatureChains]) {
        const report = verifyTrueCopyBundleText(files.get(c.path)!, { manifestSha256: c.manifestSha256, headHash: c.headHash });
        expect(report.problems).toEqual([]);
        expect(report.summary.reference).toBe('MATCHED');
      }
    }
    const inv = manifest.records.find((r) => r.recordId === investigation.id)!;
    expect(inv.chains.map((c) => c.chainKey)).toEqual([`di_investigation:${investigation.id}`]);
    expect(inv.signatureChains.map((c) => c.chainKey)).toEqual([`esig_signature:di_investigation:${investigation.id}`]);
    const sigBundle = JSON.parse((JSON.parse(files.get(inv.signatureChains[0]!.path)!) as { parts: Record<string, string> }).parts['records.json']!) as { tables: { table: string; rows: { content: string }[] }[] };
    const sigRow = JSON.parse(sigBundle.tables.find((t) => t.table === 'esig.signature')!.rows[0]!.content) as { id: string; manifestation: { printed_name: string; meaning_code: string } };
    expect(sigRow).toMatchObject({ id: investigation.signatureId, manifestation: { printed_name: 'Head of QA', meaning_code: 'DI_INVESTIGATION_CLOSED' } });
    const seals = (JSON.parse(files.get('signatures.json')!) as { seals: ExportedSeal[] }).seals;
    const seal = seals.find((s) => s.signatureId === investigation.signatureId)!;
    expect(seal).toMatchObject({ keyId: w.edKey.keyId, algorithm: 'ED25519', installationCheck: 'UNKNOWN_KEY' });
    expect(JSON.parse(seal.payload)).toMatchObject({ signature_id: investigation.signatureId, aggregate_type: 'di_investigation', aggregate_id: investigation.id });
    expect(manifest.sealKeys.map((k) => k.chainKey)).toEqual(expect.arrayContaining([`esig_seal_key:${w.edKey.keyId}`]));
    const reg = (await fullExports(db.app)).find((e) => e.id === exp.exportId);
    expect(reg).toMatchObject({ manifestSha256: exp.manifestSha256, recordCount: manifest.records.length, fileCount: manifest.files.length, exportedByPerson: w.lead.personId });
    const { rows } = await db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key = 'full_export:' || $1", [exp.exportId]);
    expect(rows[0]?.n).toBe('1');
    // The same export page by page or all at once.
    const again2 = await w.export({ page: 500, batch: 200 });
    expect(again2.manifest.records.map((r) => r.chains.map((c) => [c.chainKey, c.headHash]))).toEqual(manifest.records.map((r) => r.chains.map((c) => [c.chainKey, c.headHash])));
  });

  it('[DI-08] the export is written file by file into an empty folder, exactly the files of its manifest; a refused export leaves no folder', async () => {
    const { exp, manifest } = await w.export();
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(exp.dir, join(d, n))]));
    expect(walk(exp.dir).sort()).toEqual(['manifest.json', ...manifest.files.map((f) => f.path)].sort());
    await expect(buildFullExport(db.app, again(w.lead), exp.dir)).rejects.toThrow(/EBMR-REC-144/);
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    const dir = w.folder();
    await expect(buildFullExport(db.app, again(operator), dir)).rejects.toThrow(/EBMR-IAM-040/);
    expect(existsSync(dir)).toBe(false);
    const busy = w.folder();
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'other.txt'), 'x');
    await expect(buildFullExport(db.app, again(w.lead), busy)).rejects.toThrow(/EBMR-REC-144/);
  });

  it('[DI-08] only RECORD.EXPORT exports; a chain outside the run, another person\'s run, or a page out of bounds is refused', async () => {
    const operator = await testActor(db, { roleCode: 'OPERATOR' });
    await expect(inRun(operator, () => Promise.resolve(1))).rejects.toThrow(/EBMR-IAM-040/);
    const { admin } = await seedAdministration(db);
    await expect(inRun(admin, () => Promise.resolve(1))).rejects.toThrow(/EBMR-IAM-04/);
    await expect(db.app.query('select records.begin_full_export()')).rejects.toThrow(/EBMR-/);
    await inRun(w.lead, async (run, q) => {
      await expect(q('select records.full_export_snapshot($1, $2::text[]) as v', [run, [`account:${w.lead.accountId}`]])).rejects.toThrow(/EBMR-REC-143/);
      return 1;
    });
    await inRun(w.lead, async (run, q) => {
      await expect(q('select records.full_export_snapshot($1, $2::text[]) as v', [run, [`incident:${open}`]])).rejects.toThrow(/EBMR-REC-143/);
      return 1;
    });
    await inRun(w.lead, async (run, q) => {
      await expect(q('select records.full_export_records($1, 0, 501) as v', [run])).rejects.toThrow(/EBMR-REC-142/);
      return 1;
    });
    await inRun(w.lead, async (run, q) => {
      const parts = await q<{ chainKey: string; snapshot: { aggregateId: string } }[]>('select records.full_export_snapshot($1, $2::text[]) as v', [run, [`incident:${closedA}`]]);
      expect(parts?.[0]).toMatchObject({ chainKey: `incident:${closedA}`, snapshot: { aggregateId: closedA } });
      const page = await q<{ ordinal: number }[]>('select records.full_export_records($1, 0, 2) as v', [run]);
      expect(page?.map((p) => p.ordinal)).toEqual([1, 2]);
      return 1;
    });
    // Another person's run is not theirs to read.
    const other = await inRun(w.lead, (run) => Promise.resolve(run));
    const lead2 = await signerActor(db, 'CSV_DI_LEAD', 'Second CSV lead');
    await expect(withCommand(db.app, again(lead2), (c) => c.query('select records.full_export_records($1, 0, 10)', [other]))).rejects.toThrow(/EBMR-REC-146/);
  });

  it('[DI-08] the database registers only a manifest that is exactly the run\'s records, chains, heads and files', async () => {
    const { exp, manifest } = await w.export();
    const variant = (change: (m: FullExportManifest) => void): string => {
      const m = JSON.parse(exp.manifest) as FullExportManifest;
      change(m);
      return `${JSON.stringify(m, null, 2)}\n`;
    };
    const register = (text: string) => inRun(w.lead, (run, q) => q<string>('select records.register_full_export($1, $2, $3) as v', [run, text, sha(text)]));
    // The genuine content registers (another generation time makes another SHA-256).
    await expect(register(variant((m) => { m.generatedAt = 'regenerated'; }))).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await expect(register(variant((m) => { m.records = m.records.slice(1); }))).rejects.toThrow(/EBMR-REC-145/);
    await expect(register(variant((m) => { m.records.reverse(); }))).rejects.toThrow(/EBMR-REC-145/);
    await expect(register(variant((m) => { m.records[0]!.label = 'another label'; }))).rejects.toThrow(/EBMR-REC-145/);
    const inv = manifest.records.findIndex((r) => r.recordId === investigation.id);
    await expect(register(variant((m) => { m.records[inv]!.signatureChains = []; }))).rejects.toThrow(/EBMR-REC-145/);
    await expect(register(variant((m) => { m.sealKeys = m.sealKeys.slice(1); }))).rejects.toThrow(/EBMR-REC-145/);
    await expect(register(variant((m) => { m.records[0]!.chains[0]!.headHash = sha('another head'); }))).rejects.toThrow(/EBMR-REC-147/);
    await expect(register(variant((m) => { m.records[0]!.chains[0]!.headSeq = '1'; m.records[0]!.chains[0]!.headHash = sha('x'); }))).rejects.toThrow(/EBMR-REC-147/);
    await expect(register(variant((m) => { m.files = m.files.filter((f) => f.path !== m.records[0]!.chains[0]!.path); }))).rejects.toThrow(/EBMR-REC-148/);
    await expect(register(variant((m) => { m.files = m.files.filter((f) => f.kind !== 'SEALS'); }))).rejects.toThrow(/EBMR-REC-148/);
    await expect(register(variant((m) => { m.files.push(m.files[0]!); }))).rejects.toThrow(/EBMR-REC-148/);
    await expect(register(variant((m) => { m.files[0]!.sha256 = 'x'; }))).rejects.toThrow(/EBMR-REC-148/);
    await expect(inRun(w.lead, (run, q) => q('select records.register_full_export($1, $2, $3) as v', [run, exp.manifest, sha(`${exp.manifest} `)]))).rejects.toThrow(/EBMR-REC-144/);
    await expect(register('{"format": "other"}')).rejects.toThrow(/EBMR-REC-144/);
    // A run is registered once.
    await expect(inRun(w.lead, async (run, q) => {
      const t = variant((m) => { m.generatedAt = 'first'; });
      await q('select records.register_full_export($1, $2, $3) as v', [run, t, sha(t)]);
      const u = variant((m) => { m.generatedAt = 'second'; });
      return q('select records.register_full_export($1, $2, $3) as v', [run, u, sha(u)]);
    })).rejects.toThrow(/EBMR-REC-146/);
    await expect(db.app.query('insert into records.full_export (run_id, manifest_sha256, manifest, record_count, file_count, exported_by_person, exported_by_account) values ($1, $2, $3, 0, 0, $1, $1)', [randomUUID(), sha('x'), 'x'])).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('update records.full_export set record_count = 0 where id = $1', [exp.exportId])).rejects.toThrow(/EBMR-|insert-only|not allowed/i);
    await expect(db.app.query('select * from records.full_export_scope limit 1')).rejects.toThrow(/permission denied/);
  });
});

// Mutation campaign at the Phase 7 exit (D-P7-1 item 4): the bounds of each export read, the manifest's shape, and the
// registration guards the migrations call.
describe('the bounds and the registration guards of the full export (kernel 1335)', () => {
  /** `sql` refused with `re` inside the open command `c`, which goes on (a savepoint). */
  async function refusedIn(c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, sql: string, params: unknown[], re: RegExp): Promise<void> {
    await c.query('savepoint t1');
    await expect(c.query(sql, params), sql).rejects.toThrow(re);
    await c.query('rollback to savepoint t1');
  }

  it('[DI-08][DI-44] a page, a snapshot, a readability sample and a readability snapshot are refused outside their bounds and served at their edges', async () => {
    for (const [after, limit] of [[-1, 10], [null, 10], [0, 0], [0, null]]) {
      await expect(inRun(w.lead, (run, q) => q('select records.full_export_records($1, $2, $3) as v', [run, after, limit])), `${String(after)},${String(limit)}`).rejects.toThrow(/EBMR-REC-142/);
    }
    await inRun(w.lead, async (run, q) => {
      const page = await q<unknown[]>('select records.full_export_records($1, 0, 500) as v', [run]);
      expect(page?.length).toBeGreaterThan(0);
      return 1;
    });
    for (const keys of [null, [], [`incident:${closedA}`, null]]) {
      await expect(inRun(w.lead, (run, q) => q('select records.full_export_snapshot($1, $2::text[]) as v', [run, keys])), JSON.stringify(keys)).rejects.toThrow(/EBMR-REC-142/);
    }
    await expect(inRun(w.lead, (run, q) => q('select records.full_export_snapshot($1, $2::text[]) as v', [run, Array.from({ length: 201 }, () => `incident:${closedA}`)]))).rejects.toThrow(/EBMR-REC-142/);
    const edge = await inRun(w.lead, (run, q) => q<unknown[]>('select records.full_export_snapshot($1, $2::text[]) as v', [run, Array.from({ length: 200 }, () => `incident:${closedA}`)]));
    expect(edge?.length).toBe(200);
    // The run's summary counts the run's own records, not those of every run.
    const summary = await withCommand(db.app, again(w.lead), async (c) => {
      const b = (await c.query<{ b: { runId: string; records: number } }>('select records.begin_full_export() as b')).rows[0]!.b;
      const all = (await c.query<{ v: unknown[] }>('select records.full_export_records($1, 0, 500) as v', [b.runId])).rows[0]!.v;
      return { records: b.records, listed: all.length };
    });
    expect(summary.records).toBe(summary.listed);

    const now = await w.now();
    const sample = (seed: string, before: string | null, size: number | null) =>
      w.report.query('select rank from report.readability_sample_rows_v1($1, $2::timestamptz, $3)', [seed, before, size]);
    expect((await sample('s'.repeat(200), now, 1)).rows).toEqual([{ rank: 1 }]);
    await expect(sample('s'.repeat(201), now, 1)).rejects.toThrow(/EBMR-REC-141/);
    await expect(sample('s', null, 1)).rejects.toThrow(/EBMR-REC-141/);
    await expect(sample('s', now, 1001)).rejects.toThrow(/EBMR-REC-141/);
    // Closed before the given time: a record closed at that very instant is not in the sample.
    const { rows } = await db.app.query<{ t: string }>("select to_char(closed_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as t from records.incident_current where id = $1", [closedB]);
    const at = (await w.report.query<{ record_id: string }>('select record_id from report.readability_sample_rows_v1($1, $2::timestamptz, 1000)', ['s', rows[0]!.t])).rows;
    expect(at.map((r) => r.record_id)).not.toContain(closedB);
    for (const rank of [0, 999]) {
      await expect(withCommand(db.app, again(w.lead), (c) => c.query('select records.readability_snapshot($1, $2::timestamptz, 10, $3)', ['s', now, rank])))
        .rejects.toThrow(new RegExp(`EBMR-REC-149 the readability sample has no record of rank ${rank.toString()}`));
    }
  });

  it('[DI-08] a manifest without its text, or without the arrays and the seals path of its format, or with a file of another kind or the seals file not where it says, is refused', async () => {
    const { exp } = await w.export();
    const variant = (change: (m: Record<string, unknown>) => void): string => {
      const m = JSON.parse(exp.manifest) as Record<string, unknown>;
      change(m);
      return `${JSON.stringify(m, null, 2)}\n`;
    };
    const register = (text: string | null, hash: string) => inRun(w.lead, (run, q) => q<string>('select records.register_full_export($1, $2, $3) as v', [run, text, hash]));
    await expect(register(null, sha('x'))).rejects.toThrow(/EBMR-REC-144 a full export is registered with its manifest and the manifest's SHA-256/);
    const shape = /EBMR-REC-144 the manifest is no ebmr.full-export\/1 manifest/;
    for (const [field, value] of [['records', 'x'], ['files', 'x'], ['sealKeys', 'x'], ['seals', 1]] as const) {
      const t = variant((m) => { m[field] = value; });
      await expect(register(t, sha(t)), field).rejects.toThrow(shape);
    }
    const files = (m: Record<string, unknown>) => m['files'] as { path: string; kind: string; sha256: string; bytes: number }[];
    const extra = variant((m) => { files(m).push({ path: 'extra/notes.txt', kind: 'NOTES', sha256: sha('notes'), bytes: 5 }); });
    await expect(register(extra, sha(extra))).rejects.toThrow(/EBMR-REC-148/);
    const elsewhere = variant((m) => { m['seals'] = 'seals/elsewhere.json'; });
    await expect(register(elsewhere, sha(elsewhere))).rejects.toThrow(/EBMR-REC-148/);
  });

  it('[DI-08] the export lists the seal keys that have their audit chain: a key row written around the audit trail is not listed as a chain', async () => {
    class Rollback extends Error {}
    let listed: string[] = [];
    await expect(withCommand(db.admin, again(w.lead), async (c) => {
      await c.query("set local session_replication_role = 'replica'");
      await c.query("insert into esig.seal_key (key_id, algorithm, description, registered_by_person, registered_by_account) values ('t1-no-chain', 'HMAC-SHA256', 'a key row without its audit chain', gen_random_uuid(), gen_random_uuid())");
      await c.query("set local session_replication_role = 'origin'");
      listed = (await c.query<{ b: { sealKeyChainKeys: string[] } }>('select records.begin_full_export() as b')).rows[0]!.b.sealKeyChainKeys;
      throw new Rollback('rolled back on purpose');
    })).rejects.toThrow(Rollback);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).not.toContain('esig_seal_key:t1-no-chain');
  });

  it('[DI-08][DI-44] the owner registers only a STABLE argument-free closed-record source of the agreed columns, and only an audited table with a known permission as restricted', async () => {
    const cols = 'record_id text, label text, closed_at timestamptz, chain_keys text[]';
    const free = (await db.admin.query<{ t: string }>(
      'select a.table_name::text as t from kernel.audited_table a where not exists (select 1 from records.export_restricted_table r where r.table_name = a.table_name) order by 1 limit 1')).rows[0]!.t;
    class Rollback extends Error {}
    await expect(withCommand(db.admin, again(w.lead), async (c) => {
      await c.query(`create function report.t1_src_good() returns table (${cols}) language sql stable as $f$ select null::text, null::text, null::timestamptz, null::text[] where false $f$`);
      await c.query(`create function report.t1_src_volatile() returns table (${cols}) language sql volatile as $f$ select null::text, null::text, null::timestamptz, null::text[] where false $f$`);
      await c.query(`create function report.t1_src_arg(p integer) returns table (${cols}) language sql stable as $f$ select null::text, null::text, null::timestamptz, null::text[] where false $f$`);
      await c.query("create function report.t1_src_cols() returns table (record_id text, label text, closed_at timestamptz, chain_keys text) language sql stable as $f$ select null::text, null::text, null::timestamptz, null::text where false $f$");
      for (const f of ['report.t1_src_volatile()', 'report.t1_src_arg(integer)', 'report.t1_src_cols()']) {
        await refusedIn(c, 'select report.register_closed_record_source($1, $2::regprocedure, $3)', ['t1_bad', f, 'refused source'], /EBMR-REC-140/);
      }
      await c.query("select report.register_closed_record_source('t1_good', 'report.t1_src_good()'::regprocedure, 'a well-formed source')");
      await refusedIn(c, 'select records.register_export_restricted_table($1::regclass, $2, $3)', ['pg_catalog.pg_class', 'RECORD.READ', 'not audited'], /EBMR-REC-140/);
      await refusedIn(c, 'select records.register_export_restricted_table($1::regclass, $2, $3)', [free, 'NO.SUCH_PERMISSION', 'unknown permission'], /EBMR-REC-140/);
      await c.query('select records.register_export_restricted_table($1::regclass, $2, $3)', [free, 'RECORD.READ', 'an audited table with a known permission']);
      throw new Rollback('rolled back on purpose');
    })).rejects.toThrow(Rollback);
  });
});
