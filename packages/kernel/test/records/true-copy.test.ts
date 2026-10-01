import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { buildTrueCopyBundle, registerTrueCopy, serializeBundle, verifyTrueCopyBundle, verifyTrueCopyBundleText } from '../../src/records/true-copy.ts';
import { endPool, openPool } from '../harness/pools.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { again, testActor, withReason } from './helpers.ts';

let db: TestDatabase;
let operator: ActorContext;
let qa: ActorContext;
let dir: string;

const CLI = new URL('../../src/records/verify-true-copy.ts', import.meta.url).pathname;
const TSX = new URL('../../../../node_modules/.bin/tsx', import.meta.url).pathname;

beforeAll(async () => {
  db = await createTestDatabase();
  // Own stub tables under an aggregate type no other module uses, so a bundle holds only what this file creates.
  await db.admin.query(`
    create schema stub_tc authorization ebmr_owner;
    set role ebmr_owner;
    grant usage on schema stub_tc to ebmr_app;
    create table stub_tc.entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null, step_ref text not null, value numeric not null);
    create table stub_tc.reading (id uuid primary key default gen_random_uuid(), batch_id uuid not null, value numeric not null);
    grant select, insert, update on stub_tc.entry to ebmr_app;
    grant select, insert on stub_tc.reading to ebmr_app;
    select kernel.register_audited_table('stub_tc.entry', 'tc_batch', 'batch_id', false);
    select kernel.register_audited_table('stub_tc.reading', 'tc_batch', 'batch_id', true);
    -- Column types whose text form follows the session settings (time zone, date style, interval style, bytea, float).
    create table stub_tc.timed_entry (id uuid primary key default gen_random_uuid(), batch_id uuid not null, taken_at timestamptz not null,
      on_day date not null, span interval not null, ratio double precision not null, raw bytea not null);
    create table stub_tc.timed_reading (id uuid primary key default gen_random_uuid(), batch_id uuid not null, taken_at timestamptz not null,
      on_day date not null, span interval not null, ratio double precision not null, raw bytea not null);
    grant select, insert, update on stub_tc.timed_entry to ebmr_app;
    grant select, insert on stub_tc.timed_reading to ebmr_app;
    select kernel.register_audited_table('stub_tc.timed_entry', 'tc_timed', 'batch_id', false);
    select kernel.register_audited_table('stub_tc.timed_reading', 'tc_timed', 'batch_id', true);
    reset role;
  `);
  operator = await testActor(db, { roleCode: 'OPERATOR' });
  qa = await testActor(db, { roleCode: 'QA_REVIEWER' });
  dir = mkdtempSync(join(tmpdir(), 'ebmr-true-copy-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await db.drop();
});

const key = (batch: string) => `tc_batch:${batch}`;

async function insertEntry(batch: string, value: string, stepRef = 'S1'): Promise<string> {
  return withCommand(db.app, again(operator), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into stub_tc.entry (batch_id, step_ref, value) values ($1, $2, $3) returning id', [batch, stepRef, value]);
    return rows[0]?.id ?? '';
  });
}

/** A batch with a corrected entry (mutable table), insert-only readings, a business entry and a checkpoint. */
async function realBatch(): Promise<{ batch: string; entry: string }> {
  const batch = randomUUID();
  const entry = await insertEntry(batch, '12.5030000000000000001');
  await withCommand(db.app, withReason(operator, 'TRANSCRIPTION_ERROR', 'wrong digit'), (c) => c.query('update stub_tc.entry set value = $2 where id = $1', [entry, '12.5300']));
  await insertEntry(batch, '0.000', 'S2');
  await withCommand(db.app, again(operator), async (c) => {
    await c.query('insert into stub_tc.reading (batch_id, value) values ($1, $2)', [batch, '7.10']);
    await c.query('insert into stub_tc.reading (batch_id, value) values ($1, $2)', [batch, '7.1']);
  });
  await withCommand(db.app, again(operator), async (c) => {
    await c.query("select kernel.audit_business_event($1, 'weighing recorded, 12.530 kg, balance B-17 — émis ✓')", [key(batch)]);
    await c.query("select kernel.checkpoint_chain($1, 'stage closed')", [key(batch)]);
  });
  return { batch, entry };
}

describe('true-copy bundle and offline verifier (groundwork for DI-40, DI-41, DI-46)', () => {
  it('[INV-08] a bundle of a real chain from the database verifies offline, with every part hashed and listed in the manifest', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch) });
    const report = verifyTrueCopyBundleText(serializeBundle(bundle));
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({ chainKey: key(batch), events: 6, rows: 4, headSeq: '6' });
    const manifest = JSON.parse(bundle.manifest) as { parts: { name: string; sha256: string }[]; tables: string[] };
    expect(manifest.parts.map((p) => p.name)).toEqual(['records.json', 'audit-chain.json', 'verification.json']);
    // Every registered table of the aggregate type is included.
    expect(manifest.tables).toEqual(['stub_tc.entry', 'stub_tc.reading']);
    // Exact decimals survive: the corrected value keeps its scale, the original stays in the chain.
    const records = JSON.parse(bundle.parts['records.json'] as string) as { tables: { table: string; rows: { content: string }[] }[] };
    const entries = records.tables.find((t) => t.table === 'stub_tc.entry');
    expect(entries?.rows.map((r) => r.content).join()).toContain('"value": 12.5300');
    expect(bundle.parts['audit-chain.json']).toContain('12.5030000000000000001');
  });

  it('[INV-08] changing any single byte of the bundle file is reported by the verifier', async () => {
    const { batch } = await realBatch();
    const text = serializeBundle(await buildTrueCopyBundle(db.app, { chainKey: key(batch) }));
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
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch) });
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
    await db.admin.query('alter table stub_tc.entry disable trigger zz_audit_stub_tc_entry');
    try {
      await db.admin.query('update stub_tc.entry set value = 99.9 where id = $1', [entry]);
    } finally {
      await db.admin.query('alter table stub_tc.entry enable trigger zz_audit_stub_tc_entry');
    }
    await db.admin.query('alter table stub_tc.reading disable trigger user');
    try {
      // 7.1 and 7.10 are equal numbers, so select by exact text: the scale is part of the record.
      await db.admin.query("delete from stub_tc.reading where batch_id = $1 and value::text = '7.1'", [batch]);
      await db.admin.query("update stub_tc.reading set value = 7.100 where batch_id = $1 and value::text = '7.10'", [batch]);
    } finally {
      await db.admin.query('alter table stub_tc.reading enable trigger user');
    }
    const report = verifyTrueCopyBundle(await buildTrueCopyBundle(db.app, { chainKey: key(batch) }));
    const text = report.problems.join('\n');
    expect(report.ok).toBe(false);
    expect(text).toContain(`stub_tc.entry row ${entry}: row differs from the state recorded in the audit trail`);
    expect(text).toMatch(/stub_tc\.reading row .*: row differs from the hash recorded when it was inserted/);
    expect(text).toMatch(/stub_tc\.reading row .*: in the audit trail but missing from the bundle \(incomplete copy\)/);
  });

  it('[INV-08] an audit event altered in the database is reported both by the source verification and offline', async () => {
    const { batch } = await realBatch();
    await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{reason_text}', '\"typo\"') where chain_key = $1 and seq = 2", [key(batch)]);
    const report = verifyTrueCopyBundle(await buildTrueCopyBundle(db.app, { chainKey: key(batch) }));
    expect(report.problems).toEqual(
      expect.arrayContaining([
        'event seq 2: hash does not match the payload (event altered)',
        'source database reported at build time: seq 2: hash does not match the payload (event altered)',
      ]),
    );
  });

  it('[INV-08] the command-line verifier works offline on a bundle file and exits non-zero on a tampered one', async () => {
    const { batch } = await realBatch();
    const text = serializeBundle(await buildTrueCopyBundle(db.app, { chainKey: key(batch) }));
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
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch) });
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
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch), tables: ['stub_tc.reading'] });
    const report = verifyTrueCopyBundle(bundle);
    expect(report.ok).toBe(true);
    expect(report.summary.rows).toBe(2);
    await expect(buildTrueCopyBundle(db.app, { chainKey: key(batch), tables: ['testgmp.sample'] })).rejects.toThrow('EBMR-REC-070');
  });
});

describe('true copies after the Phase 1 exit review (F34, critic: session settings)', () => {
  const oddSession = '-c TimeZone=Pacific/Kiritimati -c DateStyle=SQL,DMY -c IntervalStyle=sql_standard -c extra_float_digits=-3 -c bytea_output=escape';

  it('[INV-08][DI-47] a bundle of rows with time stamps, dates, intervals, floats and bytes verifies and is identical whatever the session settings of the writer and the builder', async () => {
    const odd = openPool({ connectionString: urlFor(db.name, { name: 'ebmr_app', password: 'ebmr_app' }), max: 1, options: oddSession });
    try {
      const batch = randomUUID();
      const values = "($1, '2026-01-02T03:04:05.123456Z', '2026-01-02', interval '5 hours 30 minutes', 0.1::float8 + 0.2::float8, '\\x00ff'::bytea)";
      const entry = await withCommand(odd, again(operator), async (c) => {
        await c.query(`insert into stub_tc.timed_reading (batch_id, taken_at, on_day, span, ratio, raw) values ${values}`, [batch]);
        const { rows } = await c.query<{ id: string }>(`insert into stub_tc.timed_entry (batch_id, taken_at, on_day, span, ratio, raw) values ${values} returning id`, [batch]);
        return rows[0]?.id ?? '';
      });
      await withCommand(odd, withReason(operator, 'TRANSCRIPTION_ERROR', 'wrong time'), (c) =>
        c.query("update stub_tc.timed_entry set taken_at = '2026-01-02T04:04:05Z', span = interval '1 day 2 hours' where id = $1", [entry]),
      );
      const fromOdd = await buildTrueCopyBundle(odd, { chainKey: `tc_timed:${batch}` });
      const fromDefault = await buildTrueCopyBundle(db.app, { chainKey: `tc_timed:${batch}` });
      for (const bundle of [fromOdd, fromDefault]) {
        const report = verifyTrueCopyBundleText(serializeBundle(bundle));
        expect(report.problems).toEqual([]);
        expect(report.summary).toMatchObject({ rows: 2, events: 3, omittedTables: [] });
      }
      expect(fromOdd.parts['records.json']).toBe(fromDefault.parts['records.json']);
      expect(fromOdd.parts['audit-chain.json']).toBe(fromDefault.parts['audit-chain.json']);
      expect(fromOdd.parts['records.json']).toContain('2026-01-02T04:04:05+00:00');
    } finally {
      await endPool(odd);
    }
  });

  it('[INV-08][DI-47] a self-consistent bundle is proven to be the registered copy only against the manifest SHA-256 of the register; without it the verifier says so (UNANCHORED)', async () => {
    const { batch } = await realBatch();
    const { batch: otherBatch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch) });
    const substitute = await buildTrueCopyBundle(db.app, { chainKey: key(otherBatch) });
    const id = await withCommand(db.app, again(qa), (c) => registerTrueCopy(c, bundle, 'archive before disposal'));
    const registered = await db.app.query<{ manifest_sha256: string; head_hash: Buffer; tables: string[] }>(
      'select manifest_sha256, head_hash, tables from records.true_copy where id = $1',
      [id],
    );
    const reference = { manifestSha256: registered.rows[0]?.manifest_sha256 ?? '' };
    expect(registered.rows[0]?.tables).toEqual(['stub_tc.entry', 'stub_tc.reading']);
    // The substitute agrees with itself; only the comparison with the register shows it is another record.
    expect(verifyTrueCopyBundleText(serializeBundle(substitute)).summary.reference).toBe('NONE');
    expect(verifyTrueCopyBundleText(serializeBundle(substitute)).ok).toBe(true);
    const mismatch = verifyTrueCopyBundleText(serializeBundle(substitute), reference);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.problems).toContain('manifest SHA-256 differs from the expected reference (this is not the registered copy)');
    expect(verifyTrueCopyBundleText(serializeBundle(bundle), reference)).toMatchObject({ ok: true, summary: { reference: 'MATCHED' } });
    const head = { headHash: registered.rows[0]?.head_hash.toString('hex') ?? '' };
    expect(verifyTrueCopyBundleText(serializeBundle(bundle), head).summary.reference).toBe('MATCHED');
    expect(verifyTrueCopyBundleText(serializeBundle(substitute), head).problems).toContain('chain head differs from the expected reference (this is not the anchored record)');

    // The command line: UNANCHORED without a reference, ANCHORED with the registered one, exit 1 with another.
    const file = join(dir, 'anchored.json');
    writeFileSync(file, serializeBundle(bundle));
    const plain = spawnSync(TSX, [CLI, file], { encoding: 'utf8' });
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('UNANCHORED: the bundle agrees with itself only');
    const anchored = spawnSync(TSX, [CLI, file, '--expect-manifest-sha256', reference.manifestSha256], { encoding: 'utf8' });
    expect(anchored.status).toBe(0);
    expect(anchored.stdout).toContain('ANCHORED: the bundle matches the expected reference');
    const other = spawnSync(TSX, [CLI, file, '--expect-manifest-sha256', substitute.manifestSha256], { encoding: 'utf8' });
    expect(other.status).toBe(1);
    expect(other.stdout).toContain('manifest SHA-256 differs from the expected reference');
    expect(spawnSync(TSX, [CLI, file, '--expect-manifest-sha256', 'xyz'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('[INV-08][DI-47] a bundle limited to some tables is reported as partial, and the register records which tables a copy holds', async () => {
    const { batch } = await realBatch();
    const subset = await buildTrueCopyBundle(db.app, { chainKey: key(batch), tables: ['stub_tc.reading'] });
    const report = verifyTrueCopyBundleText(serializeBundle(subset));
    expect(report.ok).toBe(true);
    expect(report.summary.omittedTables).toEqual(['stub_tc.entry']);
    const file = join(dir, 'partial.json');
    writeFileSync(file, serializeBundle(subset));
    expect(spawnSync(TSX, [CLI, file], { encoding: 'utf8' }).stdout).toContain('PARTIAL: the copy leaves out stub_tc.entry');
    const id = await withCommand(db.app, again(qa), (c) => registerTrueCopy(c, subset, 'extract for an inspector'));
    expect(await db.app.query<{ tables: string[] }>('select tables from records.true_copy where id = $1', [id]).then((r) => r.rows[0]?.tables)).toEqual(['stub_tc.reading']);
  });

  it('[INV-08] the register computes the manifest SHA-256 itself and refuses a manifest whose hash, head or tables do not fit the record', async () => {
    const { batch } = await realBatch();
    const bundle = await buildTrueCopyBundle(db.app, { chainKey: key(batch) });
    const register = (manifest: string, sha: string) =>
      withCommand(db.app, again(qa), (c) => c.query('select records.register_true_copy($1, $2, $3) as id', [manifest, sha, 'archive before disposal']));
    await expect(register(bundle.manifest, bundle.manifestSha256.replace(/^./, (ch) => (ch === '0' ? '1' : '0')))).rejects.toThrow(
      'EBMR-REC-070 the manifest SHA-256 does not match the manifest',
    );
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const foreignTable = bundle.manifest.replace('"stub_tc.entry"', '"stub_b4.batch_entry"');
    await expect(register(foreignTable, sha(foreignTable))).rejects.toThrow('EBMR-REC-070 stub_b4.batch_entry is not a registered table of aggregate type tc_batch');
    const otherChain = bundle.manifest.replace(`"chainKey": "${key(batch)}"`, `"chainKey": "tc_batch:${randomUUID()}"`);
    await expect(register(otherChain, sha(otherChain))).rejects.toThrow('EBMR-REC-070');
    await expect(register(bundle.manifest, bundle.manifestSha256)).resolves.toBeDefined();
  });
});
