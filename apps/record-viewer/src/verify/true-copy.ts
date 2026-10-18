/**
 * The viewer's verifier of a true-copy bundle (format ebmr.true-copy-bundle/1), independent of the kernel's
 * (packages/kernel/src/records/true-copy.ts), which the viewer may not import; the tests run both on the same files and
 * require the same verdicts. Every check of the kernel's offline verifier is made here:
 * - the file is its own canonical serialisation (a change to any byte is reported), valid UTF-8 without a byte order mark;
 * - the manifest's SHA-256, each part's SHA-256 and size, no part missing or unlisted;
 * - the audit chain from its genesis value: sequence, previous-hash links, each event's hash over its payload, the
 *   payload's indexed fields, the head and the checkpoints;
 * - every row against its SHA-256 and against the chain (the INSERT row hash of an insert-only row, the state rebuilt from
 *   INSERT and UPDATE events otherwise), and that no row the chain says exists is missing;
 * - what the source database and the builder reported at build time;
 * - the expected references held outside the bundle (here: the export manifest's SHA-256 of the bundle manifest and the
 *   chain head).
 */
import { chainHashHex, sha256Hex, utf8Bytes } from './crypto.ts';
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
  payload: string;
}

export interface AuditChainPart {
  chainKey: string;
  genesisPrevHash: string;
  events: BundleEvent[];
  head: { seq: string; hash: string } | null;
  checkpoints: { seq: string; hash: string; eventCount: string; sealedAt: string; reason: string }[];
}

export interface RecordTable {
  table: string;
  aggregateColumn: string;
  insertOnly: boolean;
  rows: { recordId: string; sha256: string; content: string }[];
}

export interface RecordsPart {
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  tables: RecordTable[];
}

interface VerificationPart {
  verifiedAt: string;
  database: { seq: string; problem: string }[];
  offline: { ok: boolean; problems: string[] };
}

interface Manifest {
  chainKey?: string;
  head?: { seq: string; hash: string } | null;
  parts?: { name: string; sha256: string; bytes: number }[];
}

interface Bundle {
  format: string;
  manifestSha256: string;
  manifest: string;
  parts: Record<string, string>;
}

export interface BundleReport {
  ok: boolean;
  problems: string[];
  chainKey: string | null;
  /** The parsed parts, for display; present only when the bundle's parts are intact. */
  chain: AuditChainPart | null;
  records: RecordsPart | null;
}

/** A reference held outside the bundle: the bundle manifest's SHA-256 and the chain head the export manifest names. */
export interface ExpectedReference {
  manifestSha256?: string;
  headHash?: string;
}

const failed = (problems: string[]): BundleReport => ({ ok: false, problems, chainKey: null, chain: null, records: null });

function serialize(bundle: Bundle): string {
  const parts: Record<string, string> = {};
  for (const name of Object.keys(bundle.parts)) parts[name] = bundle.parts[name] as string;
  return `${JSON.stringify({ format: bundle.format, manifestSha256: bundle.manifestSha256, manifest: bundle.manifest, parts })}\n`;
}

function shapeProblem(v: unknown): string | undefined {
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

/** Verifies a bundle file's bytes against the references the export holds for it. */
export async function verifyBundleBytes(input: Uint8Array | string, expected: ExpectedReference = {}): Promise<BundleReport> {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return failed(['bundle is not valid UTF-8 (bytes altered)']);
    }
  }
  if (text.startsWith('﻿')) return failed(['bundle starts with a byte order mark, which its serialisation never has (the file was altered)']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failed([`bundle is not valid JSON: ${(error as Error).message}`]);
  }
  const shape = shapeProblem(parsed);
  if (shape) return failed([shape]);
  const bundle = parsed as Bundle;
  const report = await verifyBundle(bundle, expected);
  if (serialize(bundle) !== text) {
    report.problems.unshift('bundle bytes differ from its canonical serialisation (the file was altered)');
    report.ok = false;
  }
  return report;
}

async function verifyBundle(bundle: Bundle, expected: ExpectedReference): Promise<BundleReport> {
  const problems: string[] = [];
  const manifestSha = await sha256Hex(bundle.manifest);
  if (manifestSha !== bundle.manifestSha256) problems.push('manifest SHA-256 does not match the manifest (manifest or its hash altered)');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(bundle.manifest) as Manifest;
  } catch {
    return failed([...problems, 'manifest is not valid JSON']);
  }
  if (expected.manifestSha256 !== undefined && expected.manifestSha256.toLowerCase() !== manifestSha) {
    problems.push('manifest SHA-256 differs from the one the export lists (this is not the exported copy)');
  }
  if (expected.headHash !== undefined && manifest.head?.hash !== expected.headHash.toLowerCase()) {
    problems.push('chain head differs from the one the export lists (this is not the exported record)');
  }
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
    if ((await sha256Hex(content)) !== p.sha256) {
      problems.push(`part ${p.name}: SHA-256 does not match the manifest (content altered)`);
      partsIntact = false;
    }
    if (utf8Bytes(content).length !== p.bytes) problems.push(`part ${p.name}: size differs from the manifest`);
  }
  for (const name of Object.keys(bundle.parts)) if (!listed.has(name)) problems.push(`part ${name} is not listed in the manifest`);
  for (const name of PART_NAMES) if (!listed.has(name)) problems.push(`manifest does not list the required part ${name}`);
  if (!partsIntact) return { ...failed(problems), chainKey: manifest.chainKey ?? null };

  let chain: AuditChainPart;
  let records: RecordsPart;
  let verification: VerificationPart;
  try {
    chain = JSON.parse(bundle.parts['audit-chain.json'] as string) as AuditChainPart;
    records = JSON.parse(bundle.parts['records.json'] as string) as RecordsPart;
    verification = JSON.parse(bundle.parts['verification.json'] as string) as VerificationPart;
  } catch {
    return { ...failed([...problems, 'a part is not valid JSON']), chainKey: manifest.chainKey ?? null };
  }
  if (chain.chainKey !== manifest.chainKey || records.chainKey !== manifest.chainKey) problems.push('parts describe a different chain than the manifest');
  if (JSON.stringify(manifest.head) !== JSON.stringify(chain.head)) problems.push('manifest head differs from the chain head');
  problems.push(...(await verifyChainPart(chain)), ...(await verifyRecordsPart(records, chain)));
  const omitted = omittedTables(records, chain);
  if (omitted.length > 0) problems.push(`the copy leaves out tables its audit trail names: ${omitted.join(', ')} (a partial copy is no archive)`);
  for (const p of verification.database) problems.push(`source database reported at build time: seq ${p.seq}: ${p.problem}`);
  if (!verification.offline.ok) problems.push(...verification.offline.problems.map((p) => `builder reported at build time: ${p}`));
  return { ok: problems.length === 0, problems, chainKey: manifest.chainKey ?? null, chain, records };
}

export function payloadOf(e: BundleEvent): JsonObject | undefined {
  try {
    const v = parseLossless(e.payload);
    return v instanceof Map ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Offline re-computation of the chain: genesis, links, hashes, sequence, indexed fields, head, checkpoints. */
export async function verifyChainPart(chain: AuditChainPart): Promise<string[]> {
  const problems: string[] = [];
  const genesis = await sha256Hex(`genesis:${chain.chainKey}`);
  if (chain.genesisPrevHash !== genesis) problems.push('genesis value does not belong to this chain key');
  let prev = genesis;
  let expected = 1n;
  const bySeq = new Map<string, BundleEvent>();
  for (const e of chain.events) {
    const where = `event seq ${e.seq}`;
    if (!/^[0-9]+$/.test(e.seq) || BigInt(e.seq) !== expected) problems.push(`${where}: expected seq ${expected} (gap or reordering)`);
    if (e.prevHash !== prev) problems.push(`${where}: previous-hash link broken`);
    if ((await chainHashHex(e.prevHash, e.payload)) !== e.hash) problems.push(`${where}: hash does not match the payload (event altered)`);
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
export async function verifyRecordsPart(records: RecordsPart, chain: AuditChainPart): Promise<string[]> {
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
    const unclaimed = new Map<string, string[]>();
    const rowsPerRecord = new Map<string, number>();
    for (const row of table.rows) rowsPerRecord.set(row.recordId, (rowsPerRecord.get(row.recordId) ?? 0) + 1);
    for (const row of table.rows) {
      const where = `${table.table} row ${row.recordId}`;
      present.add(row.recordId);
      if ((await sha256Hex(row.content)) !== row.sha256) problems.push(`${where}: content does not match its SHA-256 (row altered)`);
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
        const key = `${table.table}\u0000${row.recordId}`;
        let hashes = unclaimed.get(key);
        if (!hashes) {
          hashes = events.filter((e) => e.action === 'INSERT').map((e) => jsonText(field(field(payloadOf(e), 'body'), 'row_hash')) ?? '');
          unclaimed.set(key, hashes);
        }
        const at = hashes.indexOf(row.sha256);
        if (at < 0) problems.push(`${where}: row differs from the hash recorded when it was inserted`);
        else hashes.splice(at, 1);
        if (events.some((e) => e.action === 'UPDATE')) problems.push(`${where}: insert-only row has an UPDATE event`);
      } else {
        const state = rebuildState(events);
        if (!state) problems.push(`${where}: its audit events cannot be read`);
        else if (!jsonEquals(state, content)) problems.push(`${where}: row differs from the state recorded in the audit trail`);
      }
    }
    for (const [k, events] of eventsByRecord) {
      const [tableName, recordId] = k.split('\u0000') as [string, string];
      if (tableName !== table.table) continue;
      if (present.has(recordId)) {
        const inserts = events.filter((e) => e.action === 'INSERT').length;
        if (table.insertOnly && inserts > (rowsPerRecord.get(recordId) ?? 0) && !events.some((e) => e.action === 'DELETE')) {
          problems.push(`${table.table} row ${recordId}: ${inserts - (rowsPerRecord.get(recordId) ?? 0)} inserted row(s) of this key missing from the bundle (incomplete copy)`);
        }
        continue;
      }
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
  return [...named].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

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
