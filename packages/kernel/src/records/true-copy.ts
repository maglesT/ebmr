/**
 * True-copy bundles and their offline verifier (ADR 0007 archival; groundwork for DI-40, DI-41, DI-46;
 * PDF/A-3 rendering arrives in Phase 4).
 *
 * A bundle holds, for one aggregate (one audit chain):
 * - records.json: every row of the aggregate in the chosen registered tables, in the canonical form
 *   of kernel.row_json (exactly what the audit trigger hashes: jsonb text with the session's TimeZone,
 *   DateStyle, IntervalStyle, bytea and float output pinned) with the SHA-256 of each row;
 * - audit-chain.json: the chain's events (payload text exactly as hashed), head and checkpoints;
 * - verification.json: the database's chain verification and this module's offline check at build time;
 * - a manifest listing every part with its SHA-256 and size, and the SHA-256 of the manifest itself.
 *
 * The verifier needs no database: it recomputes every part hash, every event hash and link from the
 * genesis value, the head and checkpoints, and checks every row against the chain (the row hash of
 * insert-only rows; the state rebuilt from INSERT and UPDATE events for other rows) and that no row
 * the chain says exists is missing. The bundle file must also equal its canonical serialisation, so a
 * change to any single byte is reported.
 *
 * A bundle that agrees with itself is not yet proven to be the record's copy: anyone can assemble a
 * self-consistent bundle. The proof is the manifest SHA-256 (or head hash) held outside the bundle, in
 * the true-copy register, the tombstone or an anchor; the verifier compares against it when given one
 * and otherwise says the result is unanchored (F34). A bundle limited to some tables verifies, and the
 * report lists the tables its audit trail names but it leaves out (a partial copy is no archive).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { field, jsonEquals, jsonText, parseLossless, JsonNumber, type JsonObject, type JsonValue } from './lossless-json.ts';

export const BUNDLE_FORMAT = 'ebmr.true-copy-bundle/1';
const PART_NAMES = ['records.json', 'audit-chain.json', 'verification.json'] as const;

export interface BundleEvent {
  seq: string;
  prevHash: string;
  hash: string;
  recordedAt: string;
  correlationId: string;
  action: string;
  tableName: string | null;
  recordId: string | null;
  /** The payload exactly as hashed (PostgreSQL jsonb text). */
  payload: string;
}

export interface AuditChainPart {
  chainKey: string;
  genesisPrevHash: string;
  events: BundleEvent[];
  head: { seq: string; hash: string } | null;
  checkpoints: { seq: string; hash: string; eventCount: string; sealedAt: string; reason: string }[];
}

export interface RecordRow {
  recordId: string;
  sha256: string;
  /** The row as PostgreSQL canonical jsonb text. */
  content: string;
}

export interface RecordTable {
  table: string;
  aggregateColumn: string;
  insertOnly: boolean;
  rows: RecordRow[];
}

export interface RecordsPart {
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  tables: RecordTable[];
}

export interface VerificationPart {
  verifiedAt: string;
  database: { seq: string; problem: string }[];
  offline: { ok: boolean; problems: string[] };
}

export interface Manifest {
  format: string;
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  generatedAt: string;
  head: { seq: string; hash: string } | null;
  tables: string[];
  parts: { name: string; mediaType: string; bytes: number; sha256: string }[];
  hashAlgorithm: 'SHA-256';
  canonicalForm: string;
  rendering: string;
}

export interface TrueCopyBundle {
  format: string;
  manifestSha256: string;
  manifest: string;
  parts: Record<string, string>;
}

/** A reference held outside the bundle (true-copy register, tombstone, anchor) to compare it with. */
export interface ExpectedReference {
  manifestSha256?: string;
  headHash?: string;
}

export interface VerificationReport {
  ok: boolean;
  problems: string[];
  summary: {
    chainKey: string | null;
    events: number;
    rows: number;
    headSeq: string | null;
    manifestSha256: string | null;
    /** Tables with row events in the bundle's audit trail that the bundle does not hold (partial copy). */
    omittedTables: string[];
    /** MATCHED: equal to the expected reference; NONE: no reference given, the bundle only agrees with itself. */
    reference: 'MATCHED' | 'MISMATCHED' | 'NONE';
  };
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

function splitChainKey(chainKey: string): { aggregateType: string; aggregateId: string } {
  const i = chainKey.indexOf(':');
  if (i <= 0 || i === chainKey.length - 1) throw new Error(`EBMR-REC-070 ${chainKey} is not an aggregate chain key`);
  return { aggregateType: chainKey.slice(0, i), aggregateId: chainKey.slice(i + 1) };
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/**
 * Reads one consistent snapshot (REPEATABLE READ, READ ONLY) of the aggregate's rows and chain and
 * assembles the bundle. `tables` narrows the registered tables included (default: all of the
 * aggregate type). Register the result with registerTrueCopy inside a command.
 */
export async function buildTrueCopyBundle(pool: pg.Pool, opts: { chainKey: string; tables?: string[] }): Promise<TrueCopyBundle> {
  const { aggregateType, aggregateId } = splitChainKey(opts.chainKey);
  const client = await pool.connect();
  let records: RecordsPart;
  let chain: AuditChainPart;
  let database: VerificationPart['database'];
  let generatedAt: string;
  try {
    await client.query('begin transaction isolation level repeatable read read only');
    generatedAt = (
      await client.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)
    ).rows[0]?.t as string;
    const { rows: registered } = await client.query<{ table_name: string; aggregate_column: string; insert_only: boolean; sql: string }>(
      `select table_name::text as table_name, aggregate_column, insert_only,
              format('select q.* from (select coalesce(r.j ->> ''id'', r.j ->> %L) as record_id, r.j::text as content,
                             encode(sha256(convert_to(r.j::text, ''UTF8'')), ''hex'') as sha256
                        from (select kernel.row_json(x) as j from %s x where x.%I::text = $1) r) q
                       order by q.record_id collate "C", q.content collate "C"', aggregate_column, table_name, aggregate_column) as sql
         from kernel.audited_table where aggregate_type = $1 order by table_name::text collate "C"`,
      [aggregateType],
    );
    const wanted = opts.tables ? new Set(opts.tables) : undefined;
    if (wanted) {
      const known = new Set(registered.map((r) => r.table_name));
      for (const t of wanted) if (!known.has(t)) throw new Error(`EBMR-REC-070 ${t} is not a registered table of aggregate type ${aggregateType}`);
    }
    const tables: RecordTable[] = [];
    for (const r of registered) {
      if (wanted && !wanted.has(r.table_name)) continue;
      const { rows } = await client.query<{ record_id: string; content: string; sha256: string }>(r.sql, [aggregateId]);
      tables.push({
        table: r.table_name,
        aggregateColumn: r.aggregate_column,
        insertOnly: r.insert_only,
        rows: rows.map((x) => ({ recordId: x.record_id, sha256: x.sha256, content: x.content })),
      });
    }
    records = { chainKey: opts.chainKey, aggregateType, aggregateId, tables };
    const { rows: events } = await client.query<{
      seq: string;
      prev_hash: string;
      hash: string;
      recorded_at: string;
      correlation_id: string;
      action: string;
      table_name: string | null;
      record_id: string | null;
      payload: string;
    }>(
      `select seq::text as seq, encode(prev_hash, 'hex') as prev_hash, encode(hash, 'hex') as hash,
              to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
              correlation_id::text as correlation_id, action, table_name, record_id, payload::text as payload
         from kernel.audit_event where chain_key = $1 order by seq`,
      [opts.chainKey],
    );
    const head = (
      await client.query<{ seq: string; hash: string }>(
        `select last_seq::text as seq, encode(last_hash, 'hex') as hash from kernel.audit_chain_head where chain_key = $1`,
        [opts.chainKey],
      )
    ).rows[0];
    const { rows: checkpoints } = await client.query<{ seq: string; hash: string; event_count: string; sealed_at: string; reason: string }>(
      `select seq::text as seq, encode(hash, 'hex') as hash, event_count::text as event_count,
              to_char(sealed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sealed_at, reason
         from kernel.audit_checkpoint where chain_key = $1 order by seq`,
      [opts.chainKey],
    );
    chain = {
      chainKey: opts.chainKey,
      genesisPrevHash: sha256Hex(`genesis:${opts.chainKey}`),
      events: events.map((e) => ({
        seq: e.seq,
        prevHash: e.prev_hash,
        hash: e.hash,
        recordedAt: e.recorded_at,
        correlationId: e.correlation_id,
        action: e.action,
        tableName: e.table_name,
        recordId: e.record_id,
        payload: e.payload,
      })),
      head: head ? { seq: head.seq, hash: head.hash } : null,
      checkpoints: checkpoints.map((c) => ({ seq: c.seq, hash: c.hash, eventCount: c.event_count, sealedAt: c.sealed_at, reason: c.reason })),
    };
    database = (await client.query<{ seq: string; problem: string }>('select seq::text as seq, problem from kernel.verify_chain($1)', [opts.chainKey])).rows;
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  const offlineProblems = [...verifyChainPart(chain), ...verifyRecordsPart(records, chain)];
  const verification: VerificationPart = { verifiedAt: generatedAt, database, offline: { ok: offlineProblems.length === 0, problems: offlineProblems } };
  const parts: Record<string, string> = {
    'records.json': JSON.stringify(records, null, 2),
    'audit-chain.json': JSON.stringify(chain, null, 2),
    'verification.json': JSON.stringify(verification, null, 2),
  };
  const manifest: Manifest = {
    format: BUNDLE_FORMAT,
    chainKey: opts.chainKey,
    aggregateType,
    aggregateId,
    generatedAt,
    head: chain.head,
    tables: records.tables.map((t) => t.table),
    parts: PART_NAMES.map((name) => ({ name, mediaType: 'application/json', bytes: utf8Bytes(parts[name] as string), sha256: sha256Hex(parts[name] as string) })),
    hashAlgorithm: 'SHA-256',
    canonicalForm: 'PostgreSQL jsonb text output, UTF-8; event hash = SHA-256(previous hash bytes || payload bytes)',
    rendering: 'JSON only; the PDF/A-3 rendering is added in Phase 4',
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  return { format: BUNDLE_FORMAT, manifestSha256: sha256Hex(manifestText), manifest: manifestText, parts };
}

/** The bundle file: one canonical JSON document and a final newline. */
export function serializeBundle(bundle: TrueCopyBundle): string {
  const parts: Record<string, string> = {};
  for (const name of Object.keys(bundle.parts)) parts[name] = bundle.parts[name] as string;
  return `${JSON.stringify({ format: bundle.format, manifestSha256: bundle.manifestSha256, manifest: bundle.manifest, parts })}\n`;
}

/**
 * Records the bundle in the true-copy register (records.true_copy); call inside withCommand. The
 * database receives the manifest itself, computes its SHA-256 and reads the chain head and the tables
 * the copy holds from it.
 */
export async function registerTrueCopy(db: pg.Pool | pg.PoolClient, bundle: TrueCopyBundle, purpose: string): Promise<string> {
  const manifest = JSON.parse(bundle.manifest) as Manifest;
  if (!manifest.head) throw new Error('EBMR-REC-070 an empty chain cannot be registered as a true copy');
  const { rows } = await db.query<{ id: string }>('select records.register_true_copy($1, $2, $3) as id', [bundle.manifest, bundle.manifestSha256, purpose]);
  return rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------------------------
// Verify (offline)
// ---------------------------------------------------------------------------------------------

/**
 * Verifies a bundle file's bytes (or text) without any database. With `expected` (the manifest SHA-256
 * from the true-copy register or the tombstone, or the head hash from an anchor) it also proves the
 * bundle is that copy; without it the report says the bundle only agrees with itself (reference NONE).
 */
export function verifyTrueCopyBundleText(input: string | Uint8Array, expected?: ExpectedReference): VerificationReport {
  const empty: VerificationReport['summary'] = { chainKey: null, events: 0, rows: 0, headSeq: null, manifestSha256: null, omittedTables: [], reference: 'NONE' };
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return { ok: false, problems: ['bundle is not valid UTF-8 (bytes altered)'], summary: empty };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`bundle is not valid JSON: ${(error as Error).message}`], summary: empty };
  }
  const shape = bundleShapeProblem(parsed);
  if (shape) return { ok: false, problems: [shape], summary: empty };
  const bundle = parsed as TrueCopyBundle;
  const report = verifyTrueCopyBundle(bundle, expected);
  if (serializeBundle(bundle) !== text) {
    report.problems.unshift('bundle bytes differ from its canonical serialisation (the file was altered)');
    report.ok = false;
  }
  return report;
}

function bundleShapeProblem(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'bundle is not a JSON object';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).join(',');
  if (keys !== 'format,manifestSha256,manifest,parts') return `bundle has unexpected top-level fields (${keys})`;
  if (o['format'] !== BUNDLE_FORMAT) return `unknown bundle format ${String(o['format'])}`;
  if (typeof o['manifestSha256'] !== 'string' || typeof o['manifest'] !== 'string') return 'bundle manifest or manifest hash missing';
  const parts = o['parts'];
  if (typeof parts !== 'object' || parts === null || Array.isArray(parts)) return 'bundle parts missing';
  for (const [k, p] of Object.entries(parts as Record<string, unknown>)) if (typeof p !== 'string') return `bundle part ${k} is not text`;
  return undefined;
}

/** Verifies a parsed bundle (every hash, the chain and the records against the chain; the expected reference when given). */
export function verifyTrueCopyBundle(bundle: TrueCopyBundle, expected?: ExpectedReference): VerificationReport {
  const problems: string[] = [];
  const summary: VerificationReport['summary'] = {
    chainKey: null,
    events: 0,
    rows: 0,
    headSeq: null,
    manifestSha256: bundle.manifestSha256,
    omittedTables: [],
    reference: 'NONE',
  };
  if (sha256Hex(bundle.manifest) !== bundle.manifestSha256) problems.push('manifest SHA-256 does not match the manifest (manifest or its hash altered)');
  if (expected?.manifestSha256 !== undefined || expected?.headHash !== undefined) {
    const manifestMatches = expected.manifestSha256 === undefined || expected.manifestSha256.toLowerCase() === sha256Hex(bundle.manifest);
    let headMatches = true;
    if (expected.headHash !== undefined) {
      try {
        headMatches = (JSON.parse(bundle.manifest) as Manifest).head?.hash === expected.headHash.toLowerCase();
      } catch {
        headMatches = false;
      }
    }
    if (!manifestMatches) problems.push('manifest SHA-256 differs from the expected reference (this is not the registered copy)');
    if (!headMatches) problems.push('chain head differs from the expected reference (this is not the anchored record)');
    summary.reference = manifestMatches && headMatches ? 'MATCHED' : 'MISMATCHED';
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(bundle.manifest) as Manifest;
  } catch {
    problems.push('manifest is not valid JSON');
    return { ok: false, problems, summary };
  }
  summary.chainKey = manifest.chainKey ?? null;
  const listed = new Set<string>();
  let partsIntact = true;
  for (const p of manifest.parts ?? []) {
    listed.add(p.name);
    const content = bundle.parts[p.name];
    if (content === undefined) {
      problems.push(`part ${p.name} listed in the manifest is missing`);
      partsIntact = false;
      continue;
    }
    if (sha256Hex(content) !== p.sha256) {
      problems.push(`part ${p.name}: SHA-256 does not match the manifest (content altered)`);
      partsIntact = false;
    }
    if (utf8Bytes(content) !== p.bytes) problems.push(`part ${p.name}: size differs from the manifest`);
  }
  for (const name of Object.keys(bundle.parts)) if (!listed.has(name)) problems.push(`part ${name} is not listed in the manifest`);
  for (const name of PART_NAMES) if (!listed.has(name)) problems.push(`manifest does not list the required part ${name}`);
  if (!partsIntact) return { ok: false, problems, summary };

  let chain: AuditChainPart;
  let records: RecordsPart;
  let verification: VerificationPart;
  try {
    chain = JSON.parse(bundle.parts['audit-chain.json'] as string) as AuditChainPart;
    records = JSON.parse(bundle.parts['records.json'] as string) as RecordsPart;
    verification = JSON.parse(bundle.parts['verification.json'] as string) as VerificationPart;
  } catch {
    problems.push('a part is not valid JSON');
    return { ok: false, problems, summary };
  }
  summary.events = chain.events.length;
  summary.rows = records.tables.reduce((n, t) => n + t.rows.length, 0);
  summary.headSeq = chain.head?.seq ?? null;
  if (chain.chainKey !== manifest.chainKey || records.chainKey !== manifest.chainKey) problems.push('parts describe a different chain than the manifest');
  if (JSON.stringify(manifest.head) !== JSON.stringify(chain.head)) problems.push('manifest head differs from the chain head');
  problems.push(...verifyChainPart(chain), ...verifyRecordsPart(records, chain));
  summary.omittedTables = omittedTables(records, chain);
  for (const p of verification.database) problems.push(`source database reported at build time: seq ${p.seq}: ${p.problem}`);
  if (!verification.offline.ok) problems.push(...verification.offline.problems.map((p) => `builder reported at build time: ${p}`));
  return { ok: problems.length === 0, problems, summary };
}

function payloadOf(e: BundleEvent): JsonObject | undefined {
  try {
    const v = parseLossless(e.payload);
    return v instanceof Map ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Offline re-computation of the chain: genesis, links, hashes, sequence, indexed columns, head, checkpoints. */
export function verifyChainPart(chain: AuditChainPart): string[] {
  const problems: string[] = [];
  if (chain.genesisPrevHash !== sha256Hex(`genesis:${chain.chainKey}`)) problems.push('genesis value does not belong to this chain key');
  let prev = sha256Hex(`genesis:${chain.chainKey}`);
  let expected = 1n;
  const bySeq = new Map<string, BundleEvent>();
  for (const e of chain.events) {
    const where = `event seq ${e.seq}`;
    if (!/^[0-9]+$/.test(e.seq) || BigInt(e.seq) !== expected) problems.push(`${where}: expected seq ${expected} (gap or reordering)`);
    if (e.prevHash !== prev) problems.push(`${where}: previous-hash link broken`);
    const recomputed = createHash('sha256').update(Buffer.from(e.prevHash, 'hex')).update(e.payload, 'utf8').digest('hex');
    if (recomputed !== e.hash) problems.push(`${where}: hash does not match the payload (event altered)`);
    const p = payloadOf(e);
    if (!p) {
      problems.push(`${where}: payload is not a JSON object`);
    } else {
      const seq = field(p, 'seq');
      if (!(seq instanceof JsonNumber) || seq.raw !== e.seq) problems.push(`${where}: payload seq differs`);
      if (jsonText(field(p, 'chain_key')) !== chain.chainKey) problems.push(`${where}: payload chain key differs`);
      if (jsonText(field(p, 'action')) !== e.action) problems.push(`${where}: payload action differs`);
      if (jsonText(field(p, 'correlation_id')) !== e.correlationId) problems.push(`${where}: payload correlation id differs`);
      if (jsonText(field(p, 'recorded_at')) !== e.recordedAt) problems.push(`${where}: payload time differs from the recorded time`);
      if (jsonText(field(p, 'table')) !== e.tableName) problems.push(`${where}: payload table differs`);
      if (jsonText(field(p, 'record_id')) !== e.recordId) problems.push(`${where}: payload record id differs`);
    }
    bySeq.set(e.seq, e);
    prev = e.hash;
    expected += 1n;
  }
  const last = chain.events[chain.events.length - 1];
  if (last && (!chain.head || chain.head.seq !== last.seq || chain.head.hash !== last.hash)) problems.push('chain head does not match the last event');
  if (!last && chain.head) problems.push('chain head present but no events');
  for (const c of chain.checkpoints) {
    const e = bySeq.get(c.seq);
    if (!e || e.hash !== c.hash) problems.push(`checkpoint at seq ${c.seq} does not match the chain`);
    if (c.eventCount !== c.seq) problems.push(`checkpoint at seq ${c.seq} has a wrong event count`);
  }
  return problems;
}

/** Every row against its hash and against the chain; every row the chain says exists must be present. */
export function verifyRecordsPart(records: RecordsPart, chain: AuditChainPart): string[] {
  const problems: string[] = [];
  const eventsByRecord = new Map<string, BundleEvent[]>();
  for (const e of chain.events) {
    if (e.tableName === null || e.recordId === null) continue;
    const k = `${e.tableName}\u0000${e.recordId}`;
    const list = eventsByRecord.get(k) ?? [];
    list.push(e);
    eventsByRecord.set(k, list);
  }
  for (const table of records.tables) {
    const present = new Set<string>();
    for (const row of table.rows) {
      const where = `${table.table} row ${row.recordId}`;
      present.add(row.recordId);
      if (sha256Hex(row.content) !== row.sha256) problems.push(`${where}: content does not match its SHA-256 (row altered)`);
      let content: JsonValue;
      try {
        content = parseLossless(row.content);
      } catch {
        problems.push(`${where}: content is not valid JSON`);
        continue;
      }
      if (!(content instanceof Map)) {
        problems.push(`${where}: content is not a row object`);
        continue;
      }
      const id = jsonText(content.get('id')) ?? jsonText(content.get(table.aggregateColumn));
      if (id !== row.recordId) problems.push(`${where}: record id differs from the row content`);
      if (jsonText(content.get(table.aggregateColumn)) !== records.aggregateId) problems.push(`${where}: row belongs to another aggregate`);
      const events = eventsByRecord.get(`${table.table}\u0000${row.recordId}`) ?? [];
      const insert = events.find((e) => e.action === 'INSERT');
      if (!insert) {
        problems.push(`${where}: no INSERT event in the chain (row not captured by the audit trail)`);
        continue;
      }
      if (events.some((e) => e.action === 'DELETE')) problems.push(`${where}: the chain records this row as deleted`);
      if (table.insertOnly) {
        const rowHash = jsonText(field(field(payloadOf(insert), 'body'), 'row_hash'));
        if (rowHash !== row.sha256) problems.push(`${where}: row differs from the hash recorded when it was inserted`);
        if (events.some((e) => e.action === 'UPDATE')) problems.push(`${where}: insert-only row has an UPDATE event`);
      } else {
        const state = rebuildState(events);
        if (!state) problems.push(`${where}: its audit events cannot be read`);
        else if (!jsonEquals(state, content)) problems.push(`${where}: row differs from the state recorded in the audit trail`);
      }
    }
    // Completeness: every row inserted in this table and never deleted must be in the bundle.
    for (const [k, events] of eventsByRecord) {
      const [tableName, recordId] = k.split('\u0000') as [string, string];
      if (tableName !== table.table || present.has(recordId)) continue;
      if (events.some((e) => e.action === 'INSERT') && !events.some((e) => e.action === 'DELETE')) {
        problems.push(`${table.table} row ${recordId}: in the audit trail but missing from the bundle (incomplete copy)`);
      }
    }
  }
  return problems;
}

/** Tables whose row events are in the chain but which the bundle does not hold (a partial copy). */
export function omittedTables(records: RecordsPart, chain: AuditChainPart): string[] {
  const held = new Set(records.tables.map((t) => t.table));
  const named = new Set<string>();
  for (const e of chain.events) if (e.tableName !== null && !held.has(e.tableName)) named.add(e.tableName);
  return [...named].sort(byCodeUnit);
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Row state from its INSERT event (body.new) and UPDATE diffs (body.new), in chain order. */
function rebuildState(events: BundleEvent[]): JsonObject | undefined {
  let state: JsonObject | undefined;
  for (const e of events) {
    const body = field(payloadOf(e), 'body');
    const next = field(body, 'new');
    if (e.action === 'INSERT') {
      if (!(next instanceof Map)) return undefined;
      state = new Map(next);
    } else if (e.action === 'UPDATE' && state) {
      if (next instanceof Map) for (const [k, v] of next) state.set(k, v);
    }
  }
  return state;
}
