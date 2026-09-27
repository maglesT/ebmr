import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { buildTrueCopyBundle, registerTrueCopy, serializeBundle, verifyTrueCopyBundle, verifyTrueCopyBundleText } from '../../src/records/true-copy.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { again, correctEntry, createStubTables, insertEntry, insertReading, testActor } from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let dir: string;

const CLI = new URL('../../src/records/verify-true-copy.ts', import.meta.url).pathname;
const TSX = new URL('../../../../node_modules/.bin/tsx', import.meta.url).pathname;

beforeAll(async () => {
  db = await createTestDatabase();
  await createStubTables(db);
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA' });
  dir = mkdtempSync(join(tmpdir(), 'ebmr-true-copy-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.drop();
});

/** A batch with a corrected entry (mutable table), insert-only readings, a business entry and a checkpoint. */
async function realBatch(): Promise<{ batch: string; entry: string }> {
  const batch = randomUUID();
  const entry = await insertEntry(db, operator, batch, '12.5030000000000000001');
  await correctEntry(db, operator, entry, '12.5300');
  await insertEntry(db, operator, batch, '0.000', 'S2');
  await insertReading(db, operator, batch, '7.10');
  await insertReading(db, operator, batch, '7.1');
  await withCommand(db.app, again(operator), async (c) => {
    await c.query("select kernel.audit_business_event($1, 'weighing recorded, 12.530 kg, balance B-17 — émis ✓')", [`batch:${batch}`]);
    await c.query("select kernel.checkpoint_chain($1, 'stage closed')", [`batch:${batch}`]);
  });
  return { batch, entry };
}

describe('true-copy bundle and offline verifier (groundwork for DI-40, DI-41, DI-46)', () => {
  it('[INV-08] a bundle of a real chain from the database verifies offline, with every part hashed and listed in the manifest', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` });
    const report = verifyTrueCopyBundleText(serializeBundle(bundle));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ chainKey: `batch:${batch}`, events: 6, rows: 4, headSeq: '6' });
    const manifest = JSON.parse(bundle.manifest) as { parts: { name: string; sha256: string }[]; tables: string[] };
    expect(manifest.parts.map((p) => p.name)).toEqual(['records.json', 'audit-chain.json', 'verification.json']);
    // Every registered table of the aggregate type is included (other modules register 'batch' tables too).
    expect(manifest.tables).toEqual(expect.arrayContaining(['stub_b4.batch_entry', 'stub_b4.batch_reading', 'testgmp.reading', 'testgmp.sample']));
    expect(manifest.tables).toEqual([...manifest.tables].sort());
    // Exact decimals survive: the corrected value keeps its scale, the original stays in the chain.
    const records = JSON.parse(bundle.parts['records.json'] as string) as { tables: { table: string; rows: { content: string }[] }[] };
    const entries = records.tables.find((t) => t.table === 'stub_b4.batch_entry');
    expect(entries?.rows.map((r) => r.content).join()).toContain('"value": 12.5300');
    expect(bundle.parts['audit-chain.json']).toContain('12.5030000000000000001');
  });

  it('[INV-08] changing any single byte of the bundle file is reported by the verifier', async () => {
    const { batch } = await realBatch();
    const text = serializeBundle(await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` }));
    const bytes = Buffer.from(text, 'utf8');
    expect(verifyTrueCopyBundleText(bytes).ok).toBe(true);
    const positions = new Set<number>();
    for (let i = 0; i < bytes.length; i += 5) positions.add(i);
    for (const needle of ['"manifestSha256"', '12.5300', 'row_hash', '"seq', 'émis', '"hash']) {
      const at = text.indexOf(needle);
      if (at >= 0) for (let k = 0; k < needle.length + 4; k++) positions.add(Buffer.byteLength(text.slice(0, at), 'utf8') + k);
    }
    positions.add(bytes.length - 1);
    let checked = 0;
    for (const i of positions) {
      if (i >= bytes.length) continue;
      const tampered = Buffer.from(bytes);
      tampered[i] = (tampered[i] as number) ^ 0x01;
      const report = verifyTrueCopyBundleText(tampered);
      if (report.ok) throw new Error(`a change at byte ${i} was not detected`);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('[INV-08] a consistent edit of a part plus its manifest entry is still caught by the manifest hash, and a recomputed manifest hash by the chain', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` });
    const records = (bundle.parts['records.json'] as string).replace('12.5300', '12.5310');
    const edited = { ...bundle, parts: { ...bundle.parts, 'records.json': records } };
    expect(verifyTrueCopyBundle(edited).problems.join('\n')).toContain('part records.json: SHA-256 does not match');
    // An attacker recomputes the part hash, the manifest and its hash: the rows no longer match the chain.
    const { createHash } = await import('node:crypto');
    const h = (s: string) => createHash('sha256').update(s).digest('hex');
    const manifest = JSON.parse(bundle.manifest) as { parts: { name: string; sha256: string; bytes: number }[] };
    for (const p of manifest.parts) if (p.name === 'records.json') Object.assign(p, { sha256: h(records), bytes: Buffer.byteLength(records) });
    const forgedManifest = JSON.stringify(manifest, null, 2);
    const forged = { ...edited, manifest: forgedManifest, manifestSha256: h(forgedManifest) };
    const problems = verifyTrueCopyBundle(forged).problems.join('\n');
    expect(problems).toContain('content does not match its SHA-256');
  });

  it('[INV-08] a record changed or deleted in the database without the audit trail makes the new bundle fail verification', async () => {
    const { batch, entry } = await realBatch();
    await db.admin.query('alter table stub_b4.batch_entry disable trigger zz_audit_stub_b4_batch_entry');
    try {
      await db.admin.query("update stub_b4.batch_entry set value = 99.9 where id = $1", [entry]);
    } finally {
      await db.admin.query('alter table stub_b4.batch_entry enable trigger zz_audit_stub_b4_batch_entry');
    }
    await db.admin.query('alter table stub_b4.batch_reading disable trigger user');
    try {
      // 7.1 and 7.10 are equal numbers, so select by exact text: the scale is part of the record.
      await db.admin.query("delete from stub_b4.batch_reading where batch_id = $1 and value::text = '7.1'", [batch]);
      await db.admin.query("update stub_b4.batch_reading set value = 7.100 where batch_id = $1 and value::text = '7.10'", [batch]);
    } finally {
      await db.admin.query('alter table stub_b4.batch_reading enable trigger user');
    }
    const report = verifyTrueCopyBundle(await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` }));
    const text = report.problems.join('\n');
    expect(report.ok).toBe(false);
    expect(text).toContain(`stub_b4.batch_entry row ${entry}: row differs from the state recorded in the audit trail`);
    expect(text).toMatch(/stub_b4\.batch_reading row .*: row differs from the hash recorded when it was inserted/);
    expect(text).toMatch(/stub_b4\.batch_reading row .*: in the audit trail but missing from the bundle \(incomplete copy\)/);
  });

  it('[INV-08] an audit event altered in the database is reported both by the source verification and offline', async () => {
    const { batch } = await realBatch();
    await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{reason_text}', '\"typo\"') where chain_key = $1 and seq = 2", [`batch:${batch}`]);
    const report = verifyTrueCopyBundle(await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` }));
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'event seq 2: hash does not match the payload (event altered)',
        'source database reported at build time: seq 2: hash does not match the payload (event altered)',
      ]),
    );
  });

  it('[INV-08] the command-line verifier works offline on a bundle file and exits non-zero on a tampered one', async () => {
    const { batch } = await realBatch();
    const text = serializeBundle(await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` }));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(good, text);
    expect(text).toContain('12.5300');
    writeFileSync(bad, text.replace('12.5300', '12.5301'));
    const ok = spawnSync(TSX, [CLI, good], { encoding: 'utf8', env: { ...process.env, PGHOST: 'invalid.invalid' } });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('VERIFIED: every hash, link, checkpoint and row matches');
    const nok = spawnSync(TSX, [CLI, bad, '--json'], { encoding: 'utf8' });
    expect(nok.status).toBe(1);
    const report = JSON.parse(nok.stdout) as { ok: boolean; problems: string[] };
    expect(report.ok).toBe(false);
    expect(spawnSync(TSX, [CLI], { encoding: 'utf8' }).status).toBe(2);
  });

  it('[INV-08] a bundle is recorded in the true-copy register against the chain head it covers', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}` });
    const id = await withCommand(db.app, again(qa), (c) => registerTrueCopy(c, bundle, 'archive before disposal'));
    const { rows } = await db.app.query<{ manifest_sha256: string; head_seq: string; created_by_person: string }>(
      'select manifest_sha256, head_seq::text as head_seq, created_by_person from records.true_copy where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ manifest_sha256: bundle.manifestSha256, head_seq: '6', created_by_person: qa.personId });
    const forged = { ...bundle, manifest: bundle.manifest.replace(/"hash": "[0-9a-f]{64}"/, `"hash": "${'0'.repeat(64)}"`) };
    await expect(withCommand(db.app, again(qa), (c) => registerTrueCopy(c, forged, 'x'))).rejects.toThrow('EBMR-REC-070');
  });

  it('[INV-08] a bundle can be limited to chosen tables, and completeness is checked for them', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}`, tables: ['stub_b4.batch_reading'] });
    const report = verifyTrueCopyBundle(bundle);
    expect(report.ok).toBe(true);
    expect(report.summary.rows).toBe(2);
    await expect(buildTrueCopyBundle(db.app, { chainKey: `batch:${batch}`, tables: ['stub_b4.lot_record'] })).rejects.toThrow('EBMR-REC-070');
  });
});
