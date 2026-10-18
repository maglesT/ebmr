/**
 * Verification of a full export of the installation (format ebmr.full-export/1; the kernel's records/full-export.ts
 * writes it). Everything is checked before anything is shown:
 * 1. manifest.json is valid UTF-8 JSON of the known format; its SHA-256 is the export SHA-256, compared with the
 *    reference the reader gives (the export register's value) when one is given. A manifest that cannot be read or does
 *    not match the reference stops everything: nothing of the export is shown.
 * 2. every file the manifest lists is there with its SHA-256 and size; a file that is not listed is reported.
 * 3. every chain's true-copy bundle verifies (true-copy.ts) against the bundle manifest SHA-256 and the head the export
 *    lists for it.
 * 4. every signature of a record: its seal row, the seal payload (signatures.json) against the payload SHA-256 of the
 *    audited seal row, the payload's fields against the signature row, the manifestation shown against the
 *    manifestation SHA-256 sealed in the payload, and the seal itself: an Ed25519 seal with the public key of the export's
 *    seal key chain; an HMAC seal needs the installation's secret, so it is reported as not checkable offline, with the
 *    installation's own check at export.
 * A record is shown only when all of its checks pass; a record that fails is listed with its findings and nothing else.
 */
import { canonicalJson } from './canonical.ts';
import { fromBase64, sealMessage, sha256Hex, verifyEd25519 } from './crypto.ts';
import { jsonText, parseLossless, type JsonObject, type JsonValue } from './lossless-json.ts';
import { verifyBundleBytes, type AuditChainPart, type RecordsPart } from './true-copy.ts';

export const FULL_EXPORT_FORMAT = 'ebmr.full-export/1';
export const FULL_EXPORT_SEALS_FORMAT = 'ebmr.full-export-seals/1';
const MANIFEST = 'manifest.json';

export interface ExportFile {
  /** The path inside the export folder (a leading folder name, as a folder picker gives it, is removed). */
  path: string;
  bytes: Uint8Array;
}

interface ManifestChain {
  chainKey: string;
  path: string;
  manifestSha256: string;
  headSeq: string;
  headHash: string;
}

interface Manifest {
  format: string;
  generatedAt: string;
  installation: { kind: string; schemaRelease: string };
  records: { recordType: string; recordId: string; label: string; closedAt: string; chains: ManifestChain[]; signatureChains: ManifestChain[] }[];
  sealKeys: ManifestChain[];
  seals: string;
  files: { path: string; kind: string; bytes: number; sha256: string }[];
}

interface SealEntry {
  signatureId: string;
  chainKey: string;
  keyId: string;
  algorithm: string;
  payload: string;
  installationCheck: string;
}

export interface VerifiedChain {
  chainKey: string;
  path: string;
  ok: boolean;
  problems: string[];
  chain: AuditChainPart | null;
  records: RecordsPart | null;
}

export type SealResult = 'VERIFIED' | 'FAILED' | 'NOT_CHECKABLE_OFFLINE';

export interface VerifiedSignature {
  signatureId: string;
  /** The signed record's aggregate reference (type:id). */
  record: string;
  meaningCode: string;
  meaningTitle: string;
  /** The manifestation exactly as stored with the signature (printed name, user ID, role, meaning, date and time). */
  manifestationText: string;
  manifestation: Record<string, string>;
  contentHash: string;
  invalidated: boolean;
  seal: { keyId: string; algorithm: string; result: SealResult; installationCheck: string } | null;
  problems: string[];
}

export interface VerifiedRecord {
  recordType: string;
  recordId: string;
  label: string;
  closedAt: string;
  ok: boolean;
  problems: string[];
  chains: VerifiedChain[];
  signatures: VerifiedSignature[];
}

export interface ExportReport {
  /** Every check passed. */
  ok: boolean;
  /** False when the manifest cannot be read or is not the expected one: nothing of the export is shown. */
  readable: boolean;
  problems: string[];
  manifestSha256: string | null;
  reference: 'MATCHED' | 'MISMATCHED' | 'NONE';
  installation: { kind: string; schemaRelease: string } | null;
  generatedAt: string | null;
  records: VerifiedRecord[];
  sealKeys: VerifiedChain[];
  counts: { files: number; records: number; signatures: number; sealsVerified: number; sealsNotCheckable: number };
}

const text = (v: JsonValue | undefined): string => jsonText(v) ?? '';
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Removes the folder name a folder picker puts in front of every path (the folder that holds manifest.json). */
export function normalisePaths(files: ExportFile[]): ExportFile[] {
  const manifest = files.map((f) => f.path).filter((p) => p === MANIFEST || p.endsWith(`/${MANIFEST}`)).sort((a, b) => a.length - b.length)[0];
  if (!manifest || manifest === MANIFEST) return files;
  const prefix = manifest.slice(0, manifest.length - MANIFEST.length);
  return files.map((f) => ({ ...f, path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : `../${f.path}` }));
}

function manifestShape(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'manifest.json is not a JSON object';
  const m = v as Partial<Manifest>;
  if (m.format !== FULL_EXPORT_FORMAT) return `manifest.json is of an unknown format (${String(m.format)}): this viewer reads ${FULL_EXPORT_FORMAT}`;
  if (!Array.isArray(m.records) || !Array.isArray(m.files) || !Array.isArray(m.sealKeys) || typeof m.seals !== 'string') return 'manifest.json lacks its records, files, seal keys or seals';
  return undefined;
}

const rowsOf = (records: RecordsPart | null, table: string): JsonObject[] => {
  const t = records?.tables.find((x) => x.table === table);
  if (!t) return [];
  const out: JsonObject[] = [];
  for (const r of t.rows) {
    try {
      const v = parseLossless(r.content);
      if (v instanceof Map) out.push(v);
    } catch {
      // the bundle verifier has reported the row
    }
  }
  return out;
};

/** Verifies an export given as its files. `expected.manifestSha256` is the export SHA-256 held outside the export. */
export async function verifyExport(input: ExportFile[], expected: { manifestSha256?: string } = {}): Promise<ExportReport> {
  const files = new Map(normalisePaths(input).map((f) => [f.path, f.bytes]));
  const report: ExportReport = {
    ok: false,
    readable: false,
    problems: [],
    manifestSha256: null,
    reference: 'NONE',
    installation: null,
    generatedAt: null,
    records: [],
    sealKeys: [],
    counts: { files: files.size, records: 0, signatures: 0, sealsVerified: 0, sealsNotCheckable: 0 },
  };
  const manifestBytes = files.get(MANIFEST);
  if (!manifestBytes) {
    report.problems.push('the folder holds no manifest.json: it is not a full export');
    return report;
  }
  report.manifestSha256 = await sha256Hex(manifestBytes);
  const want = expected.manifestSha256?.trim().toLowerCase();
  if (want) {
    report.reference = want === report.manifestSha256 ? 'MATCHED' : 'MISMATCHED';
    if (report.reference === 'MISMATCHED') {
      report.problems.push(`the export SHA-256 ${report.manifestSha256} is not the expected ${want}: this is not the registered export, so nothing of it is shown`);
      return report;
    }
  }
  let manifest: Manifest;
  try {
    const parsed: unknown = JSON.parse(decoder().decode(manifestBytes));
    const shape = manifestShape(parsed);
    if (shape) {
      report.problems.push(shape);
      return report;
    }
    manifest = parsed as Manifest;
  } catch (error) {
    report.problems.push(`manifest.json cannot be read: ${(error as Error).message}`);
    return report;
  }
  report.readable = true;
  report.installation = manifest.installation;
  report.generatedAt = manifest.generatedAt;

  // 2. Every listed file with its hash and size; nothing unlisted.
  const fileProblem = new Map<string, string>();
  const listed = new Set<string>([MANIFEST]);
  for (const f of manifest.files) {
    listed.add(f.path);
    const bytes = files.get(f.path);
    if (!bytes) fileProblem.set(f.path, `${f.path} is listed in the manifest but missing`);
    else if ((await sha256Hex(bytes)) !== f.sha256) fileProblem.set(f.path, `${f.path}: SHA-256 differs from the manifest (the file was altered)`);
    else if (bytes.length !== f.bytes) fileProblem.set(f.path, `${f.path}: size differs from the manifest`);
  }
  for (const p of fileProblem.values()) report.problems.push(p);
  for (const p of [...files.keys()].sort()) if (!listed.has(p)) report.problems.push(`${p} is in the folder but not listed in the manifest`);

  // 3. Every chain.
  const verifyChain = async (c: ManifestChain): Promise<VerifiedChain> => {
    const listedProblem = fileProblem.get(c.path);
    const bytes = files.get(c.path);
    if (listedProblem || !bytes || !manifest.files.some((f) => f.path === c.path)) {
      return { chainKey: c.chainKey, path: c.path, ok: false, problems: [listedProblem ?? `${c.path} is not a listed file of the export`], chain: null, records: null };
    }
    const r = await verifyBundleBytes(bytes, { manifestSha256: c.manifestSha256, headHash: c.headHash });
    const problems = [...r.problems];
    if (r.chainKey !== null && r.chainKey !== c.chainKey) problems.push(`${c.path} holds chain ${r.chainKey}, not ${c.chainKey}`);
    if (r.chain?.head && r.chain.head.seq !== c.headSeq) problems.push(`${c.path}: the chain head is at seq ${r.chain.head.seq}, the export lists ${c.headSeq}`);
    return { chainKey: c.chainKey, path: c.path, ok: problems.length === 0, problems, chain: r.chain, records: r.records };
  };

  for (const k of manifest.sealKeys) report.sealKeys.push(await verifyChain(k));
  const sealKeys = new Map<string, { algorithm: string; publicKey: string | null }>();
  for (const k of report.sealKeys) {
    if (!k.ok) continue;
    for (const row of rowsOf(k.records, 'esig.seal_key')) sealKeys.set(text(row.get('key_id')), { algorithm: text(row.get('algorithm')), publicKey: jsonText(row.get('public_key')) });
  }
  for (const k of report.sealKeys) for (const p of k.problems) report.problems.push(`seal key chain ${k.chainKey}: ${p}`);

  // The seal payloads.
  const seals = new Map<string, SealEntry>();
  let sealsReadable = false;
  const sealsBytes = files.get(manifest.seals);
  if (fileProblem.has(manifest.seals)) {
    // reported with the files
  } else if (!sealsBytes || !manifest.files.some((f) => f.path === manifest.seals)) {
    report.problems.push(`${manifest.seals} is not a listed file of the export`);
  } else {
    try {
      const s = JSON.parse(decoder().decode(sealsBytes)) as { format?: string; seals?: SealEntry[] };
      if (s.format !== FULL_EXPORT_SEALS_FORMAT || !Array.isArray(s.seals)) {
        report.problems.push(`${manifest.seals} is of an unknown format`);
      } else {
        for (const e of s.seals) seals.set(e.signatureId, e);
        sealsReadable = true;
      }
    } catch {
      report.problems.push(`${manifest.seals} cannot be read`);
    }
  }

  // 4. Every record with its signatures.
  for (const r of manifest.records) {
    const chains: VerifiedChain[] = [];
    for (const c of r.chains) chains.push(await verifyChain(c));
    const signatureChains: VerifiedChain[] = [];
    for (const c of r.signatureChains) signatureChains.push(await verifyChain(c));
    const signatures: VerifiedSignature[] = [];
    for (const sc of signatureChains) {
      if (!sc.ok) continue;
      const seal = new Map(rowsOf(sc.records, 'esig.signature_seal').map((row) => [text(row.get('signature_id')), row]));
      const invalidated = new Set(rowsOf(sc.records, 'esig.signature_invalidation').map((row) => text(row.get('signature_id'))));
      for (const row of rowsOf(sc.records, 'esig.signature')) {
        signatures.push(await verifySignature(row, sc.chainKey, seal, invalidated, sealsReadable ? seals : null, sealKeys));
      }
    }
    const problems = [
      ...chains.flatMap((c) => c.problems.map((p) => `${c.chainKey}: ${p}`)),
      ...signatureChains.flatMap((c) => c.problems.map((p) => `${c.chainKey}: ${p}`)),
      ...signatures.flatMap((s) => s.problems.map((p) => `signature ${s.signatureId}: ${p}`)),
    ];
    if (chains.length === 0) problems.push('the record has no chain in the export');
    report.records.push({ recordType: r.recordType, recordId: r.recordId, label: r.label, closedAt: r.closedAt, ok: problems.length === 0, problems, chains: [...chains, ...signatureChains], signatures });
  }
  report.counts.records = report.records.length;
  report.counts.signatures = report.records.reduce((n, r) => n + r.signatures.length, 0);
  report.counts.sealsVerified = report.records.reduce((n, r) => n + r.signatures.filter((s) => s.seal?.result === 'VERIFIED').length, 0);
  report.counts.sealsNotCheckable = report.records.reduce((n, r) => n + r.signatures.filter((s) => s.seal?.result === 'NOT_CHECKABLE_OFFLINE').length, 0);
  report.ok = report.problems.length === 0 && report.records.every((r) => r.ok);
  return report;
}

async function verifySignature(
  row: JsonObject,
  signatureChain: string,
  sealRows: Map<string, JsonObject>,
  invalidated: Set<string>,
  seals: Map<string, SealEntry> | null,
  sealKeys: Map<string, { algorithm: string; publicKey: string | null }>,
): Promise<VerifiedSignature> {
  const id = text(row.get('id'));
  const problems: string[] = [];
  const manifestationValue = row.get('manifestation');
  const manifestation: Record<string, string> = {};
  if (manifestationValue instanceof Map) for (const [k, v] of manifestationValue) manifestation[k] = jsonText(v) ?? (v === null ? '' : canonicalJson(v));
  const out: VerifiedSignature = {
    signatureId: id,
    record: text(row.get('aggregate_ref')),
    meaningCode: text(row.get('meaning_code')),
    meaningTitle: text(row.get('meaning_title')),
    manifestationText: text(row.get('manifestation_text')),
    manifestation,
    contentHash: text(row.get('content_hash')),
    invalidated: invalidated.has(id),
    seal: null,
    problems,
  };
  // A signature chain holds the signatures of one signed aggregate; the export manifest names the chains of a record.
  if (`esig_signature:${out.record}` !== signatureChain) problems.push(`the signature is of ${out.record}, not of the chain ${signatureChain} that holds it`);
  const sealRow = sealRows.get(id);
  if (!sealRow) {
    problems.push('the signature has no seal');
    return out;
  }
  const keyId = text(sealRow.get('key_id'));
  const algorithm = text(sealRow.get('algorithm'));
  const entry = seals?.get(id);
  if (!seals) {
    problems.push('the seal payloads of the export cannot be read, so the seal cannot be checked');
    return out;
  }
  if (!entry) {
    problems.push('the export holds no seal payload of the signature');
    return out;
  }
  out.seal = { keyId, algorithm, result: 'FAILED', installationCheck: entry.installationCheck };
  // The payload is the one the audited seal row was made over, and it names this signature, record, meaning and signer.
  if ((await sha256Hex(entry.payload)) !== text(sealRow.get('payload_sha256'))) problems.push('the seal payload differs from the one the seal was made over (payload altered)');
  if (entry.keyId !== keyId || entry.algorithm !== algorithm) problems.push('the seal payload names another key than the seal row');
  let payload: JsonObject | undefined;
  try {
    const v = parseLossless(entry.payload);
    payload = v instanceof Map ? v : undefined;
  } catch {
    payload = undefined;
  }
  if (!payload) {
    problems.push('the seal payload is not a JSON object');
    return out;
  }
  for (const [p, r] of [['signature_id', 'id'], ['aggregate_type', 'aggregate_type'], ['aggregate_id', 'aggregate_id'], ['content_hash', 'content_hash'], ['meaning_code', 'meaning_code'], ['signer_person', 'signer_person'], ['signer_role_code', 'signer_role_code']] as const) {
    if (text(payload.get(p)) !== text(row.get(r))) problems.push(`the sealed ${p} differs from the signature row`);
  }
  const manifestationSha = manifestationValue === undefined ? '' : await sha256Hex(canonicalJson(manifestationValue));
  if (text(payload.get('manifestation_sha256')) !== manifestationSha) problems.push('the manifestation shown is not the one that was sealed (manifestation altered)');
  // The seal itself.
  const seal = fromBase64(text(sealRow.get('seal')));
  if (!seal) {
    problems.push('the seal is not base64');
    return out;
  }
  if (algorithm === 'ED25519') {
    const key = sealKeys.get(keyId);
    if (!key || key.algorithm !== 'ED25519' || !key.publicKey) {
      problems.push(`the seal key ${keyId} is not in the export's verified seal keys`);
      return out;
    }
    const r = await verifyEd25519(key.publicKey, sealMessage(keyId, algorithm, entry.payload), seal);
    if (r === 'VALID') out.seal.result = 'VERIFIED';
    else if (r === 'UNSUPPORTED') problems.push('this browser cannot check Ed25519 seals; open the export in a current browser');
    else problems.push(`the seal does not verify with key ${keyId} (seal or payload altered)`);
  } else if (algorithm === 'HMAC-SHA256') {
    out.seal.result = 'NOT_CHECKABLE_OFFLINE';
    if (entry.installationCheck === 'INVALID') problems.push('the installation found the seal invalid when it made the export');
  } else {
    problems.push(`unknown seal algorithm ${algorithm}`);
  }
  return out;
}
