/**
 * Backup jobs and restore drills (control DI-45; build outline 4.2, 9.1 "restore drill with chain
 * verification"; ADR 0007).
 *
 * Restore drill: take a pg_dump of the source database under an exported snapshot, restore it into a
 * new, isolated database, verify the audit chains and anchors on both, and compare every table by an
 * ordered content hash (records, audit trail and signature tables), every sequence, and a sample of
 * records opened together with their audit trail. The source side is read in the same snapshot the
 * dump used, so the comparison is exact even while the source keeps working. The drill writes a JSON
 * and a Markdown report; its result can be recorded in the database (a failed drill raises an alarm).
 *
 * Backup job: pg_dump, encryption at rest (AES-256-GCM), SHA-256 fixity, a manifest, read-only files,
 * and a record of the run in continuity.backup_job_run / backup_catalogue. A failed run is recorded
 * and raises an alarm; the job report is written either way.
 *
 * Times come from the database clock (INV-16); elapsed durations use the monotonic process clock.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type TableCategory = 'RECORDS' | 'AUDIT_TRAIL' | 'SIGNATURES' | 'SYSTEM';

export interface TableComparison {
  table: string;
  category: TableCategory;
  sourceRows: number | null;
  restoredRows: number | null;
  sourceSha256: string | null;
  restoredSha256: string | null;
  match: boolean;
}

export interface SequenceComparison {
  sequence: string;
  sourceValue: string | null;
  restoredValue: string | null;
  status: 'MATCH' | 'ADVANCED_IN_SOURCE' | 'MISSING_IN_RESTORE' | 'AHEAD_IN_RESTORE';
}

export interface ChainVerification {
  available: boolean;
  chains: number;
  anchors: number;
  chainProblems: string[];
  anchorProblems: string[];
}

export interface SampleRecord {
  table: string;
  recordId: string;
  rowCompared: boolean;
  rowMatch: boolean;
  auditEvents: number;
  auditMatch: boolean;
}

export interface BackupArtefact {
  backupId: string;
  file: string;
  manifestFile: string;
  format: 'PG_DUMP_CUSTOM';
  encrypted: boolean;
  artefactSha256: string;
  dumpSha256: string;
  sizeBytes: number;
  toolVersion: string;
  snapshotTakenAt: string;
  fixityVerified: boolean;
}

export interface DrillReport {
  kind: 'ebmr.restore-drill';
  version: 1;
  drillId: string;
  result: 'PASS' | 'FAIL';
  failures: string[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  source: { database: string; serverVersion: string | null };
  backup: BackupArtefact | null;
  restore: { database: string; isolated: boolean; dropped: boolean; toolVersion: string | null } | null;
  verification: { source: ChainVerification | null; restored: ChainVerification | null };
  tables: TableComparison[];
  sequences: SequenceComparison[];
  samples: SampleRecord[];
  summary: {
    tablesCompared: number;
    tablesMatching: number;
    chainsVerified: number;
    byCategory: Record<TableCategory, { tables: number; matching: number; rows: number }>;
  };
}

export interface DrillOutcome {
  report: DrillReport;
  jsonPath: string;
  markdownPath: string;
  reportSha256: string;
}

export interface RestoreDrillOptions {
  /** Connection that can read every table and run the kernel verification functions (backup role). */
  sourceUrl: string;
  /** Superuser connection used to create, restore into and drop the isolated database. */
  adminUrl: string;
  /** Directory for the JSON and Markdown reports. */
  reportDir: string;
  /** Where the drill backup is written (default: a temporary directory removed afterwards). */
  backupDir?: string;
  /** 32-byte key: the drill backup is encrypted at rest and decrypted for the restore. */
  encryptionKey?: Buffer;
  /** Directory holding pg_dump and pg_restore (default: found on PATH). */
  pgBin?: string;
  keepRestoredDatabase?: boolean;
  /** Revoke CONNECT from PUBLIC on the restored database so no application can reach it (default true). */
  isolate?: boolean;
  /** Records opened with their audit trail on both sides (default 5). */
  sampleSize?: number;
  /** OQ and test hook, run after the restore and before the comparison (e.g. inject a deliberate difference). */
  beforeCompare?: (restoredDatabaseUrl: string) => Promise<void>;
}

export interface Recorder {
  pool: pg.Pool;
  ctx: ActorContext;
}

// ---------------------------------------------------------------------------------------------
// Process, URL and file helpers
// ---------------------------------------------------------------------------------------------

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(cmd: string, args: string[], env: Record<string, string> = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function tool(name: 'pg_dump' | 'pg_restore', pgBin?: string): string {
  return pgBin ? join(pgBin, name) : name;
}

async function toolVersion(bin: string): Promise<string | null> {
  const r = await runProcess(bin, ['--version']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Removes the password from a URL so it never appears in a process list; it goes in PGPASSWORD. */
function splitPassword(url: string): { url: string; env: Record<string, string> } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

const MAGIC = Buffer.from('EBMRENC1');

/** Encrypt a file with AES-256-GCM: MAGIC | iv(12) | ciphertext | tag(16). */
export async function encryptFile(src: string, dst: string, key: Buffer): Promise<void> {
  if (key.length !== 32) throw new Error('the backup encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  writeFileSync(dst, Buffer.concat([MAGIC, iv]), { mode: 0o600 });
  await pipeline(createReadStream(src), cipher, createWriteStream(dst, { flags: 'a' }));
  appendFileSync(dst, cipher.getAuthTag());
}

/** Decrypt a file written by encryptFile; fails if a single byte was changed (GCM tag). */
export async function decryptFile(src: string, dst: string, key: Buffer): Promise<void> {
  const size = statSync(src).size;
  const header = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  const fd = openSync(src, 'r');
  try {
    readSync(fd, header, 0, header.length, 0);
    readSync(fd, tag, 0, 16, size - 16);
  } finally {
    closeSync(fd);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${src} is not an encrypted eBMR backup`);
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(src, { start: header.length, end: size - 17 }), decipher, createWriteStream(dst, { mode: 0o600 }));
}

/** Reads a 32-byte key from a file holding 64 hex characters or base64. */
export function loadKeyFile(path: string): Buffer {
  const text = readFileSync(path, 'utf8').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error(`${path} must hold a 32-byte key as 64 hex characters or base64`);
  return key;
}

async function dbNow(client: pg.Client | pg.PoolClient | pg.Pool): Promise<{ iso: string; compact: string; date: string }> {
  const { rows } = await client.query<{ iso: string; compact: string; date: string }>(
    `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as iso,
            to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') as compact,
            to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as date`,
  );
  const r = rows[0];
  if (!r) throw new Error('database clock unavailable');
  return r;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

function elapsedMs(start: bigint): number {
  return Number((process.hrtime.bigint() - start) / 1_000_000n);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Dump and restore
// ---------------------------------------------------------------------------------------------

export interface DumpOptions {
  sourceUrl: string;
  directory: string;
  backupId: string;
  snapshotId?: string;
  encryptionKey?: Buffer;
  pgBin?: string;
  snapshotTakenAt: string;
}

/** pg_dump in custom format (optionally at an exported snapshot), encrypt, hash, write a manifest, make read-only. */
export async function dumpDatabase(opts: DumpOptions): Promise<BackupArtefact> {
  mkdirSync(opts.directory, { recursive: true });
  const bin = tool('pg_dump', opts.pgBin);
  const plain = join(opts.directory, `${opts.backupId}.dump`);
  const { url, env } = splitPassword(opts.sourceUrl);
  const args = ['--format=custom', '--no-password', `--file=${plain}`, `--dbname=${url}`];
  if (opts.snapshotId) args.push(`--snapshot=${opts.snapshotId}`);
  const r = await runProcess(bin, args, env);
  if (r.code !== 0) {
    rmSync(plain, { force: true });
    throw new Error(`pg_dump failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const dumpSha256 = await sha256File(plain);
  let file = plain;
  if (opts.encryptionKey) {
    file = `${plain}.enc`;
    await encryptFile(plain, file, opts.encryptionKey);
    rmSync(plain, { force: true });
  }
  const artefactSha256 = await sha256File(file);
  const artefact: BackupArtefact = {
    backupId: opts.backupId,
    file,
    manifestFile: join(opts.directory, `${opts.backupId}.manifest.json`),
    format: 'PG_DUMP_CUSTOM',
    encrypted: Boolean(opts.encryptionKey),
    artefactSha256,
    dumpSha256,
    sizeBytes: statSync(file).size,
    toolVersion: (await toolVersion(bin)) ?? 'unknown',
    snapshotTakenAt: opts.snapshotTakenAt,
    fixityVerified: false,
  };
  writeFileSync(artefact.manifestFile, `${JSON.stringify({ ...artefact, database: databaseOf(opts.sourceUrl) }, null, 2)}\n`, { mode: 0o600 });
  // Write-once intent at file level; the storage layer enforces it in production (object lock).
  chmodSync(file, 0o444);
  chmodSync(artefact.manifestFile, 0o444);
  return artefact;
}

/** Re-hash a stored artefact and compare it with its manifest. */
export async function verifyFixity(artefact: BackupArtefact): Promise<boolean> {
  const manifest = JSON.parse(readFileSync(artefact.manifestFile, 'utf8')) as { artefactSha256: string };
  return manifest.artefactSha256 === artefact.artefactSha256 && (await sha256File(artefact.file)) === artefact.artefactSha256;
}

/** Create an empty database with the source's encoding and locale; optionally closed to PUBLIC. */
async function createRestoreDatabase(adminUrl: string, name: string, sourceDatabase: string, isolate: boolean): Promise<void> {
  const admin = await connect(adminUrl);
  try {
    const { rows } = await admin.query<{ encoding: string; collate: string; ctype: string; provider: string; icu: string | null }>(
      `select pg_encoding_to_char(encoding) as encoding, datcollate as collate, datctype as ctype, datlocprovider as provider, daticulocale as icu
         from pg_database where datname = $1`,
      [sourceDatabase],
    );
    const src = rows[0];
    const locale = src
      ? ` encoding ${pg.escapeLiteral(src.encoding)} lc_collate ${pg.escapeLiteral(src.collate)} lc_ctype ${pg.escapeLiteral(src.ctype)}` +
        (src.provider === 'i' && src.icu ? ` locale_provider icu icu_locale ${pg.escapeLiteral(src.icu)}` : '')
      : '';
    await admin.query(`create database ${quoteIdent(name)} template template0${locale}`);
    if (isolate) await admin.query(`revoke connect, temporary on database ${quoteIdent(name)} from public`);
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  const admin = await connect(adminUrl);
  try {
    await admin.query(`drop database if exists ${quoteIdent(name)} with (force)`);
  } finally {
    await admin.end();
  }
}

export interface RestoreOptions {
  adminUrl: string;
  artefact: BackupArtefact;
  targetDatabase: string;
  sourceDatabase: string;
  isolate: boolean;
  encryptionKey?: Buffer;
  pgBin?: string;
  workDir: string;
}

/** Restore a backup artefact into a new database (created here). Returns the pg_restore version. */
export async function restoreDatabase(opts: RestoreOptions): Promise<string | null> {
  await createRestoreDatabase(opts.adminUrl, opts.targetDatabase, opts.sourceDatabase, opts.isolate);
  let input = opts.artefact.file;
  let tempPlain: string | null = null;
  if (opts.artefact.encrypted) {
    if (!opts.encryptionKey) throw new Error('the backup is encrypted and no key was given');
    tempPlain = join(opts.workDir, `${opts.artefact.backupId}.restore.dump`);
    await decryptFile(input, tempPlain, opts.encryptionKey);
    if ((await sha256File(tempPlain)) !== opts.artefact.dumpSha256) throw new Error('decrypted dump does not match the manifest hash');
    input = tempPlain;
  }
  try {
    const bin = tool('pg_restore', opts.pgBin);
    const { url, env } = splitPassword(withDatabase(opts.adminUrl, opts.targetDatabase));
    const r = await runProcess(bin, ['--exit-on-error', '--no-password', `--dbname=${url}`, input], env);
    if (r.code !== 0) throw new Error(`pg_restore failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return toolVersion(bin);
  } finally {
    if (tempPlain) rmSync(tempPlain, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison (runs inside a read-only transaction; the source side inside the dump's snapshot)
// ---------------------------------------------------------------------------------------------

const SESSION_SETTINGS = [
  "set local timezone = 'UTC'",
  "set local datestyle = 'ISO, YMD'",
  "set local intervalstyle = 'postgres'",
  'set local extra_float_digits = 3',
  "set local bytea_output = 'hex'",
  'set local search_path = pg_catalog, kernel',
];

async function beginComparison(client: pg.Client): Promise<void> {
  await client.query('begin isolation level repeatable read read only');
  for (const s of SESSION_SETTINGS) await client.query(s);
}

export function tableCategory(schema: string, table: string): TableCategory {
  if (schema === 'kernel' && (table.startsWith('audit_') || table === 'ddl_log' || table === 'audited_table')) return 'AUDIT_TRAIL';
  if (schema === 'esig') return 'SIGNATURES';
  if (schema === 'public' && table === 'schema_migration') return 'SYSTEM';
  return 'RECORDS';
}

interface TableHash {
  table: string;
  category: TableCategory;
  rows: number;
  sha256: string;
}

async function hashTables(client: pg.Client): Promise<Map<string, TableHash>> {
  const { rows } = await client.query<{ qualified: string; schema: string; name: string }>(
    `select format('%I.%I', n.nspname, c.relname) as qualified, n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'
      order by n.nspname, c.relname`,
  );
  const out = new Map<string, TableHash>();
  for (const t of rows) {
    const h = createHash('sha256');
    let count = 0;
    await client.query(`declare drill_cur no scroll cursor for select t::text as r from ${t.qualified} t order by (t::text) collate "C"`);
    for (;;) {
      const batch = await client.query<{ r: string }>('fetch forward 5000 from drill_cur');
      if (batch.rows.length === 0) break;
      for (const row of batch.rows) h.update(`${row.r}\n`);
      count += batch.rows.length;
    }
    await client.query('close drill_cur');
    out.set(t.qualified, { table: t.qualified, category: tableCategory(t.schema, t.name), rows: count, sha256: h.digest('hex') });
  }
  return out;
}

async function sequenceValues(client: pg.Client): Promise<Map<string, string | null>> {
  const { rows } = await client.query<{ name: string; last_value: string | null }>(
    `select format('%I.%I', schemaname, sequencename) as name, last_value::text
       from pg_sequences where schemaname not in ('pg_catalog', 'information_schema') order by 1`,
  );
  return new Map(rows.map((r) => [r.name, r.last_value]));
}

async function verifyKernel(client: pg.Client): Promise<ChainVerification> {
  const present = await client.query<{ ok: boolean }>("select to_regclass('kernel.audit_chain_head') is not null and to_regclass('kernel.audit_anchor') is not null as ok");
  if (!present.rows[0]?.ok) return { available: false, chains: 0, anchors: 0, chainProblems: [], anchorProblems: [] };
  const chains = await client.query<{ n: string }>('select count(*)::text as n from kernel.audit_chain_head');
  const anchors = await client.query<{ n: string }>('select count(*)::text as n from kernel.audit_anchor');
  const cp = await client.query<{ chain_key: string; seq: string; problem: string }>(
    'select h.chain_key, p.seq::text, p.problem from kernel.audit_chain_head h cross join lateral kernel.verify_chain(h.chain_key) p order by 1, 2',
  );
  const ap = await client.query<{ id: string; problem: string }>(
    'select a.id::text, p.problem from kernel.audit_anchor a cross join lateral kernel.verify_anchor(a.id) p order by a.id',
  );
  return {
    available: true,
    chains: Number(chains.rows[0]?.n ?? 0),
    anchors: Number(anchors.rows[0]?.n ?? 0),
    chainProblems: cp.rows.map((r) => `${r.chain_key} seq ${r.seq}: ${r.problem}`),
    anchorProblems: ap.rows.map((r) => `anchor ${r.id}: ${r.problem}`),
  };
}

interface SampleKey {
  table: string;
  recordId: string;
}

async function pickSamples(client: pg.Client, seed: string, size: number): Promise<SampleKey[]> {
  const present = await client.query<{ ok: boolean }>("select to_regclass('kernel.audit_event') is not null as ok");
  if (!present.rows[0]?.ok || size <= 0) return [];
  const { rows } = await client.query<{ table_name: string; record_id: string }>(
    `select table_name, record_id from (
       select distinct e.table_name, e.record_id from kernel.audit_event e where e.table_name is not null and e.record_id is not null) s
      order by md5($1 || table_name || ':' || record_id) limit $2`,
    [seed, size],
  );
  return rows.map((r) => ({ table: r.table_name, recordId: r.record_id }));
}

interface SampleRead {
  row: string | null;
  rowCompared: boolean;
  auditEvents: number;
  auditSha256: string;
}

async function readSample(client: pg.Client, s: SampleKey): Promise<SampleRead> {
  const meta = await client.query<{ sql: string | null }>(
    `select case when exists (select 1 from pg_attribute a where a.attrelid = to_regclass($1) and a.attname = 'id' and not a.attisdropped)
                 then format('select to_jsonb(t)::text as row from %s t where t.id::text = %L', to_regclass($1), $2::text) end as sql`,
    [s.table, s.recordId],
  );
  const sql = meta.rows[0]?.sql ?? null;
  let row: string | null = null;
  if (sql) row = (await client.query<{ row: string }>(sql)).rows[0]?.row ?? null;
  const events = await client.query<{ h: string }>(
    "select encode(hash, 'hex') as h from kernel.audit_event where table_name = $1 and record_id = $2 order by chain_key, seq",
    [s.table, s.recordId],
  );
  const h = createHash('sha256');
  for (const e of events.rows) h.update(`${e.h}\n`);
  return { row, rowCompared: sql !== null, auditEvents: events.rows.length, auditSha256: h.digest('hex') };
}

// ---------------------------------------------------------------------------------------------
// Restore drill
// ---------------------------------------------------------------------------------------------

function emptySummary(): DrillReport['summary'] {
  const zero = (): { tables: number; matching: number; rows: number } => ({ tables: 0, matching: 0, rows: 0 });
  return { tablesCompared: 0, tablesMatching: 0, chainsVerified: 0, byCategory: { RECORDS: zero(), AUDIT_TRAIL: zero(), SIGNATURES: zero(), SYSTEM: zero() } };
}

export async function runRestoreDrill(opts: RestoreDrillOptions): Promise<DrillOutcome> {
  const t0 = process.hrtime.bigint();
  const sourceDatabase = databaseOf(opts.sourceUrl);
  const failures: string[] = [];
  const workDir = mkdtempSync(join(tmpdir(), 'ebmr-drill-'));
  const backupDir = opts.backupDir ?? join(workDir, 'backup');
  const isolate = opts.isolate ?? true;
  const report: DrillReport = {
    kind: 'ebmr.restore-drill',
    version: 1,
    drillId: '',
    result: 'FAIL',
    failures,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    source: { database: sourceDatabase, serverVersion: null },
    backup: null,
    restore: null,
    verification: { source: null, restored: null },
    tables: [],
    sequences: [],
    samples: [],
    summary: emptySummary(),
  };

  let source: pg.Client | null = null;
  let restored: pg.Client | null = null;
  let restoreName: string | null = null;
  const sourceSamples: { key: SampleKey; read: SampleRead }[] = [];
  try {
    source = await connect(opts.sourceUrl);
    const start = await dbNow(source);
    report.startedAt = start.iso;
    report.drillId = `drill-${start.compact}-${randomBytes(3).toString('hex')}`;
    report.source.serverVersion = (await source.query<{ v: string }>('select version() as v')).rows[0]?.v ?? null;

    // 1. Backup at an exported snapshot; the source stays in that snapshot for the comparison.
    await beginComparison(source);
    const snap = await source.query<{ id: string }>('select pg_export_snapshot() as id');
    const backupId = `${sourceDatabase}-${start.compact}-${randomBytes(3).toString('hex')}`.replace(/[^A-Za-z0-9._:-]/g, '_');
    const dumpOptions: DumpOptions = { sourceUrl: opts.sourceUrl, directory: backupDir, backupId, snapshotTakenAt: start.iso };
    if (snap.rows[0]?.id) dumpOptions.snapshotId = snap.rows[0].id;
    if (opts.encryptionKey) dumpOptions.encryptionKey = opts.encryptionKey;
    if (opts.pgBin) dumpOptions.pgBin = opts.pgBin;
    const artefact = await dumpDatabase(dumpOptions);
    artefact.fixityVerified = await verifyFixity(artefact);
    report.backup = artefact;
    if (!artefact.fixityVerified) failures.push('backup: the stored artefact does not match its manifest hash');

    // 2. Source side, in the dump's snapshot.
    report.verification.source = await verifyKernel(source);
    const sourceTables = await hashTables(source);
    const sourceSequences = await sequenceValues(source);
    for (const key of await pickSamples(source, report.drillId, opts.sampleSize ?? 5)) sourceSamples.push({ key, read: await readSample(source, key) });
    await source.query('commit');

    // 3. Restore into a new, isolated database.
    restoreName = `${sourceDatabase}_rst_${randomBytes(4).toString('hex')}`.slice(-63);
    const restoreOptions: RestoreOptions = {
      adminUrl: opts.adminUrl,
      artefact,
      targetDatabase: restoreName,
      sourceDatabase,
      isolate,
      workDir,
    };
    if (opts.encryptionKey) restoreOptions.encryptionKey = opts.encryptionKey;
    if (opts.pgBin) restoreOptions.pgBin = opts.pgBin;
    report.restore = { database: restoreName, isolated: isolate, dropped: false, toolVersion: null };
    report.restore.toolVersion = await restoreDatabase(restoreOptions);
    const restoredUrl = withDatabase(opts.adminUrl, restoreName);
    if (opts.beforeCompare) await opts.beforeCompare(restoredUrl);

    // 4. Restored side.
    restored = await connect(restoredUrl);
    await beginComparison(restored);
    report.verification.restored = await verifyKernel(restored);
    const restoredTables = await hashTables(restored);
    const restoredSequences = await sequenceValues(restored);
    for (const { key, read } of sourceSamples) {
      const other = await readSample(restored, key);
      report.samples.push({
        table: key.table,
        recordId: key.recordId,
        rowCompared: read.rowCompared,
        rowMatch: read.row === other.row,
        auditEvents: read.auditEvents,
        auditMatch: read.auditEvents === other.auditEvents && read.auditSha256 === other.auditSha256,
      });
    }
    await restored.query('commit');

    // 5. Compare.
    for (const name of [...new Set([...sourceTables.keys(), ...restoredTables.keys()])].sort()) {
      const s = sourceTables.get(name);
      const r = restoredTables.get(name);
      const match = s !== undefined && r !== undefined && s.rows === r.rows && s.sha256 === r.sha256;
      report.tables.push({
        table: name,
        category: (s ?? r)?.category ?? 'RECORDS',
        sourceRows: s?.rows ?? null,
        restoredRows: r?.rows ?? null,
        sourceSha256: s?.sha256 ?? null,
        restoredSha256: r?.sha256 ?? null,
        match,
      });
      if (!match) failures.push(`table ${name}: ${s === undefined ? 'missing in the source' : r === undefined ? 'missing in the restore' : `rows ${s.rows}/${r.rows}, content hash differs`}`);
    }
    for (const name of [...new Set([...sourceSequences.keys(), ...restoredSequences.keys()])].sort()) {
      const s = sourceSequences.get(name) ?? null;
      const r = restoredSequences.has(name) ? (restoredSequences.get(name) ?? null) : undefined;
      let status: SequenceComparison['status'];
      if (r === undefined) status = 'MISSING_IN_RESTORE';
      else if (s === r) status = 'MATCH';
      else if (BigInt(s ?? '0') > BigInt(r ?? '0')) status = 'ADVANCED_IN_SOURCE'; // sequences are not transactional
      else status = 'AHEAD_IN_RESTORE';
      report.sequences.push({ sequence: name, sourceValue: s, restoredValue: r ?? null, status });
      if (status === 'MISSING_IN_RESTORE' || status === 'AHEAD_IN_RESTORE') failures.push(`sequence ${name}: ${status}`);
    }
    for (const side of ['source', 'restored'] as const) {
      const v = report.verification[side];
      if (v && (v.chainProblems.length > 0 || v.anchorProblems.length > 0)) {
        failures.push(`${side}: ${v.chainProblems.length} chain problem(s) and ${v.anchorProblems.length} anchor problem(s)`);
      }
    }
    if (report.verification.source && report.verification.restored && report.verification.source.chains !== report.verification.restored.chains) {
      failures.push(`chain count differs: ${report.verification.source.chains} in the source, ${report.verification.restored.chains} restored`);
    }
    for (const s of report.samples) {
      if ((s.rowCompared && !s.rowMatch) || !s.auditMatch) failures.push(`sample ${s.table} ${s.recordId}: record or audit trail differs`);
    }
  } catch (error) {
    failures.push(`drill aborted: ${errorText(error)}`);
    for (const c of [source, restored]) {
      if (c) await c.query('rollback').catch(() => undefined);
    }
  } finally {
    if (restored) await restored.end().catch(() => undefined);
    if (restoreName && report.restore && !opts.keepRestoredDatabase) {
      try {
        await dropDatabase(opts.adminUrl, restoreName);
        report.restore.dropped = true;
      } catch (error) {
        failures.push(`could not drop the restored database: ${errorText(error)}`);
      }
    }
    if (source) {
      try {
        report.finishedAt = (await dbNow(source)).iso;
      } catch {
        report.finishedAt = null;
      }
      await source.end().catch(() => undefined);
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  const summary = emptySummary();
  for (const t of report.tables) {
    summary.tablesCompared += 1;
    summary.byCategory[t.category].tables += 1;
    summary.byCategory[t.category].rows += t.sourceRows ?? 0;
    if (t.match) {
      summary.tablesMatching += 1;
      summary.byCategory[t.category].matching += 1;
    }
  }
  summary.chainsVerified = (report.verification.source?.chains ?? 0) + (report.verification.restored?.chains ?? 0);
  report.summary = summary;
  if (report.tables.length === 0 && failures.length === 0) failures.push('no tables were compared');
  report.result = failures.length === 0 ? 'PASS' : 'FAIL';
  report.durationMs = elapsedMs(t0);
  if (!report.drillId) report.drillId = `drill-unstarted-${randomBytes(4).toString('hex')}`;

  mkdirSync(opts.reportDir, { recursive: true });
  const jsonPath = join(opts.reportDir, `restore-drill-${report.drillId}.json`);
  const markdownPath = join(opts.reportDir, `restore-drill-${report.drillId}.md`);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(jsonPath, json);
  writeFileSync(markdownPath, renderDrillMarkdown(report));
  return { report, jsonPath, markdownPath, reportSha256: createHash('sha256').update(json).digest('hex') };
}

/** Record a drill result in the database (continuity.record_restore_drill); a FAIL raises an alarm. */
export async function recordRestoreDrill(recorder: Recorder, outcome: DrillOutcome): Promise<string> {
  const r = outcome.report;
  return withCommand(recorder.pool, recorder.ctx, async (c) => {
    const now = await dbNow(c);
    const { rows } = await c.query<{ id: string }>('select continuity.record_restore_drill($1::jsonb)::text as id', [
      JSON.stringify({
        drill_id: r.drillId,
        source_database: r.source.database,
        restored_database: r.restore?.database ?? '(not restored)',
        backup_sha256: r.backup?.artefactSha256 ?? null,
        result: r.result,
        failures: r.failures,
        tables_compared: r.summary.tablesCompared,
        tables_matching: r.summary.tablesMatching,
        chains_verified: r.summary.chainsVerified,
        report_sha256: outcome.reportSha256,
        report_uri: `file://${outcome.jsonPath}`,
        started_at: r.startedAt ?? now.iso,
        finished_at: r.finishedAt ?? now.iso,
      }),
    ]);
    return rows[0]?.id ?? '';
  });
}

// ---------------------------------------------------------------------------------------------
// Backup job
// ---------------------------------------------------------------------------------------------

export interface BackupJobOptions {
  sourceUrl: string;
  backupDir: string;
  reportDir: string;
  jobName: string;
  tier: 'RETENTION_GRADE' | 'OPERATIONAL';
  encryptionKey: Buffer;
  /** Identifier of the key in the key-management system (never the key itself). */
  encryptionKeyRef: string;
  /** Days the storage layer keeps the artefact write-once (required for RETENTION_GRADE). */
  immutableDays?: number;
  /** URI prefix of the backup store (default file://<backupDir>). */
  storageUriPrefix?: string;
  pgBin?: string;
  /** Database used for trusted time when the source is unreachable (default: the source, then its server's postgres database). */
  clockUrl?: string;
  recorder?: Recorder;
}

export interface BackupJobReport {
  kind: 'ebmr.backup-job';
  version: 1;
  jobName: string;
  tier: 'RETENTION_GRADE' | 'OPERATIONAL';
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  database: string;
  backup: (BackupArtefact & { storageUri: string; immutableUntil: string | null }) | null;
  jobRunId: string | null;
  recordError: string | null;
}

export interface BackupJobOutcome {
  report: BackupJobReport;
  jsonPath: string;
  markdownPath: string;
  reportSha256: string;
}

async function trustedNow(urls: string[]): Promise<{ iso: string; compact: string; date: string } | null> {
  for (const url of urls) {
    let c: pg.Client | null = null;
    try {
      c = await connect(url);
      return await dbNow(c);
    } catch {
      // try the next clock source
    } finally {
      if (c) await c.end().catch(() => undefined);
    }
  }
  return null;
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((x) => Number(x));
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return t.toISOString().slice(0, 10);
}

/** Run one backup; always writes a job report; records the run (and alarms on failure) when a recorder is given. */
export async function runBackupJob(opts: BackupJobOptions): Promise<BackupJobOutcome> {
  const t0 = process.hrtime.bigint();
  const database = databaseOf(opts.sourceUrl);
  const clocks = opts.clockUrl ? [opts.clockUrl] : [opts.sourceUrl, withDatabase(opts.sourceUrl, 'postgres')];
  const start = await trustedNow(clocks);
  const report: BackupJobReport = {
    kind: 'ebmr.backup-job',
    version: 1,
    jobName: opts.jobName,
    tier: opts.tier,
    status: 'FAILED',
    error: null,
    startedAt: start?.iso ?? null,
    finishedAt: null,
    durationMs: 0,
    database,
    backup: null,
    jobRunId: null,
    recordError: null,
  };
  try {
    if (opts.tier === 'RETENTION_GRADE' && !opts.immutableDays) throw new Error('a retention-grade backup needs a write-once retention period (immutableDays)');
    if (!start) throw new Error('no trusted database clock is reachable');
    const backupId = `${database}-${start.compact}-${randomBytes(3).toString('hex')}`.replace(/[^A-Za-z0-9._:-]/g, '_');
    const dumpOptions: DumpOptions = { sourceUrl: opts.sourceUrl, directory: opts.backupDir, backupId, encryptionKey: opts.encryptionKey, snapshotTakenAt: start.iso };
    if (opts.pgBin) dumpOptions.pgBin = opts.pgBin;
    const artefact = await dumpDatabase(dumpOptions);
    artefact.fixityVerified = await verifyFixity(artefact);
    if (!artefact.fixityVerified) throw new Error('the stored artefact does not match its manifest hash');
    const prefix = opts.storageUriPrefix ?? `file://${opts.backupDir}`;
    report.backup = {
      ...artefact,
      storageUri: `${prefix.replace(/\/$/, '')}/${artefact.file.split('/').pop() ?? ''}`,
      immutableUntil: opts.immutableDays ? addDays(start.date, opts.immutableDays) : null,
    };
    report.status = 'SUCCEEDED';
  } catch (error) {
    report.status = 'FAILED';
    report.error = errorText(error);
  }
  const end = await trustedNow(clocks);
  report.finishedAt = end?.iso ?? null;
  report.durationMs = elapsedMs(t0);

  const write = (): { jsonPath: string; markdownPath: string; reportSha256: string } => {
    mkdirSync(opts.reportDir, { recursive: true });
    const stem = `backup-job-${opts.jobName}-${start?.compact ?? 'noclock'}-${report.status.toLowerCase()}`;
    const jsonPath = join(opts.reportDir, `${stem}.json`);
    const markdownPath = join(opts.reportDir, `${stem}.md`);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(jsonPath, json);
    writeFileSync(markdownPath, renderBackupMarkdown(report));
    return { jsonPath, markdownPath, reportSha256: createHash('sha256').update(json).digest('hex') };
  };

  let files = write();
  if (opts.recorder) {
    try {
      report.jobRunId = await withCommand(opts.recorder.pool, opts.recorder.ctx, async (c) => {
        const now = await dbNow(c);
        const b = report.backup;
        const { rows } = await c.query<{ id: string }>('select continuity.record_backup_job($1::jsonb)::text as id', [
          JSON.stringify({
            job_name: opts.jobName,
            tier: opts.tier,
            status: report.status,
            started_at: report.startedAt ?? now.iso,
            finished_at: report.finishedAt ?? now.iso,
            error_text: report.error,
            report_sha256: files.reportSha256,
            backup: b
              ? {
                  backup_id: b.backupId,
                  method: 'PG_DUMP_CUSTOM',
                  database_name: database,
                  artefact_sha256: b.artefactSha256,
                  size_bytes: String(b.sizeBytes),
                  storage_uri: b.storageUri,
                  immutable_until: b.immutableUntil,
                  encryption_key_ref: opts.encryptionKeyRef,
                  tool_version: b.toolVersion,
                  snapshot_taken_at: b.snapshotTakenAt,
                }
              : null,
          }),
        ]);
        return rows[0]?.id ?? null;
      });
    } catch (error) {
      report.recordError = errorText(error);
    }
    files = write();
  }
  return { report, ...files };
}

// ---------------------------------------------------------------------------------------------
// Markdown reports (structure of docs/operations/restore-drill-report-template.md)
// ---------------------------------------------------------------------------------------------

function cell(v: string | number | boolean | null | undefined): string {
  return v === null || v === undefined ? '-' : String(v).replace(/\|/g, '\\|');
}

export function renderDrillMarkdown(r: DrillReport): string {
  const lines: string[] = [
    `# Restore drill report ${r.drillId}`,
    '',
    `**Result: ${r.result}**`,
    '',
    '## 1. Drill',
    '',
    '| Item | Value |',
    '|---|---|',
    `| Drill id | ${cell(r.drillId)} |`,
    `| Started (UTC, database clock) | ${cell(r.startedAt)} |`,
    `| Finished (UTC, database clock) | ${cell(r.finishedAt)} |`,
    `| Duration (ms) | ${r.durationMs} |`,
    `| Source database | ${cell(r.source.database)} |`,
    `| Server version | ${cell(r.source.serverVersion)} |`,
    '',
    '## 2. Backup used',
    '',
    '| Item | Value |',
    '|---|---|',
    `| Backup id | ${cell(r.backup?.backupId)} |`,
    `| Format | ${cell(r.backup?.format)} |`,
    `| Encrypted at rest | ${cell(r.backup?.encrypted)} |`,
    `| Artefact SHA-256 | ${cell(r.backup?.artefactSha256)} |`,
    `| Size (bytes) | ${cell(r.backup?.sizeBytes)} |`,
    `| Fixity verified | ${cell(r.backup?.fixityVerified)} |`,
    `| Tool | ${cell(r.backup?.toolVersion)} |`,
    '',
    '## 3. Restore',
    '',
    '| Item | Value |',
    '|---|---|',
    `| Restored database | ${cell(r.restore?.database)} |`,
    `| Isolated (no PUBLIC connect) | ${cell(r.restore?.isolated)} |`,
    `| Dropped after the drill | ${cell(r.restore?.dropped)} |`,
    `| Tool | ${cell(r.restore?.toolVersion)} |`,
    '',
    '## 4. Audit-trail verification',
    '',
    '| Side | Chains | Anchors | Chain problems | Anchor problems |',
    '|---|---|---|---|---|',
  ];
  for (const side of ['source', 'restored'] as const) {
    const v = r.verification[side];
    lines.push(
      v?.available
        ? `| ${side} | ${v.chains} | ${v.anchors} | ${v.chainProblems.length} | ${v.anchorProblems.length} |`
        : `| ${side} | - | - | not available | not available |`,
    );
  }
  lines.push('', '## 5. Content comparison by category', '', '| Category | Tables | Matching | Rows (source) |', '|---|---|---|---|');
  for (const [cat, v] of Object.entries(r.summary.byCategory)) lines.push(`| ${cat} | ${v.tables} | ${v.matching} | ${v.rows} |`);
  lines.push('', '### Tables', '', '| Table | Category | Rows source | Rows restored | Match | SHA-256 (source) |', '|---|---|---|---|---|---|');
  for (const t of r.tables) {
    lines.push(`| ${cell(t.table)} | ${t.category} | ${cell(t.sourceRows)} | ${cell(t.restoredRows)} | ${t.match ? 'yes' : '**NO**'} | ${cell(t.sourceSha256?.slice(0, 16))}... |`);
  }
  lines.push('', '### Sequences', '', '| Sequence | Source | Restored | Status |', '|---|---|---|---|');
  for (const s of r.sequences) lines.push(`| ${cell(s.sequence)} | ${cell(s.sourceValue)} | ${cell(s.restoredValue)} | ${s.status} |`);
  lines.push('', '## 6. Sample records opened with their audit trail', '', '| Table | Record | Record compared | Record matches | Audit events | Audit trail matches |', '|---|---|---|---|---|---|');
  for (const s of r.samples) {
    lines.push(`| ${cell(s.table)} | ${cell(s.recordId)} | ${s.rowCompared ? 'yes' : 'no id column'} | ${s.rowCompared ? (s.rowMatch ? 'yes' : '**NO**') : '-'} | ${s.auditEvents} | ${s.auditMatch ? 'yes' : '**NO**'} |`);
  }
  lines.push('', '## 7. Findings', '');
  if (r.failures.length === 0) lines.push('None.');
  else for (const f of r.failures) lines.push(`- ${f}`);
  lines.push(
    '',
    '## 8. Review and sign-off',
    '',
    'Reviewed by (name, role, date) and QA acceptance are recorded in the change or validation record that references this drill id.',
    '',
  );
  return lines.join('\n');
}

export function renderBackupMarkdown(r: BackupJobReport): string {
  const b = r.backup;
  return [
    `# Backup job report: ${r.jobName}`,
    '',
    `**Status: ${r.status}**`,
    '',
    '| Item | Value |',
    '|---|---|',
    `| Tier | ${r.tier} |`,
    `| Database | ${cell(r.database)} |`,
    `| Started (UTC, database clock) | ${cell(r.startedAt)} |`,
    `| Finished (UTC, database clock) | ${cell(r.finishedAt)} |`,
    `| Duration (ms) | ${r.durationMs} |`,
    `| Error | ${cell(r.error)} |`,
    `| Backup id | ${cell(b?.backupId)} |`,
    `| Artefact SHA-256 | ${cell(b?.artefactSha256)} |`,
    `| Size (bytes) | ${cell(b?.sizeBytes)} |`,
    `| Encrypted | ${cell(b?.encrypted)} |`,
    `| Storage URI | ${cell(b?.storageUri)} |`,
    `| Write-once until | ${cell(b?.immutableUntil)} |`,
    `| Recorded as job run | ${cell(r.jobRunId)} |`,
    `| Recording error | ${cell(r.recordError)} |`,
    '',
  ].join('\n');
}
