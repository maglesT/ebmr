/**
 * The full export of the installation for the stand-alone record viewer (Phase 7 slice 7b-2; DI-08 clause 2; kernel
 * 1335). It is the data return of the supplier agreements: every closed record's archive package, with its audit trail
 * and its signature manifestations in readable form, verifiable without the system.
 *
 * An export is a folder:
 *   manifest.json                      format ebmr.full-export/1: the installation (kind, schema release), every closed
 *                                      record with the chains of its archive package and its signature chains, the
 *                                      seal key chains, and every other file with its SHA-256 and size. The export
 *                                      SHA-256 is the SHA-256 of manifest.json; the database keeps it in
 *                                      records.full_export, the reference the viewer compares with.
 *   records/<nnnn>-<type>/<chain>.json the true-copy bundle (true-copy.ts) of each chain: the record's rows, its audit
 *                                      chain and the build-time verification; the signature chain holds the
 *                                      esig.signature rows (with the stored manifestation) and their seal rows.
 *   seal-keys/<key>.json               the true-copy bundle of each seal key chain (the Ed25519 public keys).
 *   signatures.json                    each signature's seal payload as the database computes it (esig.seal_payload),
 *                                      which the viewer checks against the payload SHA-256 of the audited seal row, and
 *                                      the installation's own check of the seal when the exporter holds the key ring
 *                                      (an HMAC seal can only be checked by the installation that holds its secret).
 *
 * The exporter (RECORD.EXPORT) reads the index, every chain and registers the export in one REPEATABLE READ
 * transaction, so the export is one consistent state; records.register_full_export refuses an export that does not list
 * exactly the closed records of that state. Nothing is written but the export's register row and its audit entry.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import { toDbContext, type ActorContext } from '../db/command.ts';
import { sealMessage, type SealAlgorithm, type SealCheck, type SealKeyRing } from '../esig/keys.ts';
import { trueCopyBundleOfParts, type SnapshotJson } from './qp-package.ts';
import { serializeBundle, type Manifest as BundleManifest, type RecordsPart, type TrueCopyBundle } from './true-copy.ts';

export const FULL_EXPORT_FORMAT = 'ebmr.full-export/1';
export const FULL_EXPORT_SEALS_FORMAT = 'ebmr.full-export-seals/1';
export const FULL_EXPORT_MANIFEST = 'manifest.json';
export const FULL_EXPORT_SEALS = 'signatures.json';

/** One chain of the export: its bundle file and the references the viewer checks the bundle against. */
export interface ExportedChain {
  chainKey: string;
  path: string;
  manifestSha256: string;
  headSeq: string;
  headHash: string;
}

export interface ExportedRecord {
  recordType: string;
  recordId: string;
  label: string;
  closedAt: string;
  chains: ExportedChain[];
  signatureChains: ExportedChain[];
}

export interface FullExportManifest {
  format: string;
  generatedAt: string;
  installation: { kind: string; schemaRelease: string };
  hashAlgorithm: 'SHA-256';
  records: ExportedRecord[];
  sealKeys: ExportedChain[];
  seals: string;
  files: { path: string; kind: 'TRUE_COPY' | 'SEALS'; bytes: number; sha256: string }[];
}

/** The installation's check of a seal at export: its result with the exporter's key ring, or NOT_CHECKED without one. */
export type InstallationSealCheck = SealCheck | 'NOT_CHECKED';

export interface ExportedSeal {
  signatureId: string;
  chainKey: string;
  keyId: string;
  algorithm: SealAlgorithm;
  /** The seal payload exactly as esig.seal_payload computed it (canonical JSON text). */
  payload: string;
  installationCheck: InstallationSealCheck;
}

export interface FullExport {
  exportId: string;
  manifestSha256: string;
  /** manifest.json, exactly as hashed. */
  manifest: string;
  /** Every other file of the export by its path, exactly as listed in the manifest. */
  files: Map<string, string>;
}

interface IndexJson {
  generatedAt: string;
  installation: { kind: string; schemaRelease: string };
  records: { recordType: string; recordId: string; label: string; closedAt: string; chainKeys: string[]; signatureChainKeys: string[] }[];
  sealKeyChainKeys: string[];
}

interface SnapshotEntry {
  chainKey: string;
  snapshot: SnapshotJson;
  sealPayloads: { signatureId: string; payload: string }[];
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** A file-name-safe form of a chain key or id (letters, digits, dot, underscore and hyphen). */
export const exportFileName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** The chains of the full export's index, read in one call of up to `batch` chains each. */
async function snapshots(client: pg.PoolClient, keys: string[], batch: number): Promise<Map<string, SnapshotEntry>> {
  const out = new Map<string, SnapshotEntry>();
  for (let i = 0; i < keys.length; i += batch) {
    const { rows } = await client.query<{ s: SnapshotEntry[] }>('select records.full_export_snapshot($1::text[]) as s', [keys.slice(i, i + batch)]);
    for (const e of rows[0]?.s ?? []) out.set(e.chainKey, e);
  }
  return out;
}

/** The seal rows (esig.signature_seal) of a signature chain's bundle. */
function sealRows(bundle: TrueCopyBundle): Map<string, { keyId: string; algorithm: SealAlgorithm; seal: string }> {
  const records = JSON.parse(bundle.parts['records.json'] ?? '{"tables": []}') as RecordsPart;
  const out = new Map<string, { keyId: string; algorithm: SealAlgorithm; seal: string }>();
  for (const t of records.tables) {
    if (t.table !== 'esig.signature_seal') continue;
    for (const r of t.rows) {
      const row = JSON.parse(r.content) as { signature_id: string; key_id: string; algorithm: SealAlgorithm; seal: string };
      out.set(row.signature_id, { keyId: row.key_id, algorithm: row.algorithm, seal: row.seal });
    }
  }
  return out;
}

/**
 * Builds the full export as `ctx` (a person holding RECORD.EXPORT) and registers it. With `keyRing` (the installation's
 * trusted seal keys) every seal is also checked here and the result recorded in signatures.json.
 */
export async function buildFullExport(pool: pg.Pool, ctx: ActorContext, opts: { keyRing?: SealKeyRing; batch?: number } = {}): Promise<FullExport> {
  const batch = opts.batch ?? 100;
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const index = (await client.query<{ i: IndexJson }>('select records.full_export_index() as i')).rows[0]?.i;
    if (!index) throw new Error('EBMR-REC-142 the full export index could not be read');
    const keys = [...index.records.flatMap((r) => [...r.chainKeys, ...r.signatureChainKeys]), ...index.sealKeyChainKeys];
    const parts = await snapshots(client, keys, batch);
    const files = new Map<string, string>();
    const listed: FullExportManifest['files'] = [];
    const seals: ExportedSeal[] = [];
    const add = (path: string, kind: 'TRUE_COPY' | 'SEALS', text: string) => {
      files.set(path, text);
      listed.push({ path, kind, bytes: utf8Bytes(text), sha256: sha256Hex(text) });
    };
    const chainFile = async (dir: string, chainKey: string): Promise<ExportedChain> => {
      const entry = parts.get(chainKey);
      if (!entry) throw new Error(`EBMR-REC-142 the export has no snapshot of ${chainKey}`);
      const bundle = trueCopyBundleOfParts(chainKey, entry.snapshot);
      const head = (JSON.parse(bundle.manifest) as BundleManifest).head;
      if (!head) throw new Error(`EBMR-REC-142 ${chainKey} has no audit event`);
      const path = `${dir}/${exportFileName(chainKey)}.json`;
      add(path, 'TRUE_COPY', serializeBundle(bundle));
      if (chainKey.startsWith('esig_signature:')) {
        const byId = sealRows(bundle);
        for (const p of entry.sealPayloads) {
          const s = byId.get(p.signatureId);
          if (!s) continue; // an unsealed signature: the viewer reports it from the signature rows
          const installationCheck: InstallationSealCheck = opts.keyRing
            ? await opts.keyRing.verify(s.keyId, s.algorithm, sealMessage(s.keyId, s.algorithm, p.payload), Buffer.from(s.seal, 'base64'))
            : 'NOT_CHECKED';
          seals.push({ signatureId: p.signatureId, chainKey, keyId: s.keyId, algorithm: s.algorithm, payload: p.payload, installationCheck });
        }
      }
      return { chainKey, path, manifestSha256: bundle.manifestSha256, headSeq: head.seq, headHash: head.hash };
    };
    const records: ExportedRecord[] = [];
    for (const [i, r] of index.records.entries()) {
      const dir = `records/${String(i + 1).padStart(4, '0')}-${exportFileName(r.recordType)}`;
      const chains: ExportedChain[] = [];
      for (const k of r.chainKeys) chains.push(await chainFile(dir, k));
      const signatureChains: ExportedChain[] = [];
      for (const k of r.signatureChainKeys) signatureChains.push(await chainFile(dir, k));
      records.push({ recordType: r.recordType, recordId: r.recordId, label: r.label, closedAt: r.closedAt, chains, signatureChains });
    }
    const sealKeys: ExportedChain[] = [];
    for (const k of index.sealKeyChainKeys) sealKeys.push(await chainFile('seal-keys', k));
    add(FULL_EXPORT_SEALS, 'SEALS', `${JSON.stringify({ format: FULL_EXPORT_SEALS_FORMAT, seals }, null, 2)}\n`);
    const manifest: FullExportManifest = {
      format: FULL_EXPORT_FORMAT,
      generatedAt: index.generatedAt,
      installation: index.installation,
      hashAlgorithm: 'SHA-256',
      records,
      sealKeys,
      seals: FULL_EXPORT_SEALS,
      files: listed,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = sha256Hex(manifestText);
    const exportId = (await client.query<{ id: string }>('select records.register_full_export($1, $2) as id', [manifestText, manifestSha256])).rows[0]?.id;
    if (!exportId) throw new Error('EBMR-REC-144 the full export was not registered');
    await client.query('commit');
    return { exportId, manifestSha256, manifest: manifestText, files };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Writes an export into `dir`, which must be empty or not exist yet (an export is never mixed with other files). */
export function writeFullExport(dir: string, exp: FullExport): void {
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`EBMR-REC-144 ${dir} is not empty: an export is written into an empty folder`);
  for (const [path, text] of exp.files) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { flag: 'wx' });
  }
  writeFileSync(join(dir, FULL_EXPORT_MANIFEST), exp.manifest, { flag: 'wx' });
}

/** The register of full exports: who exported what, and the SHA-256 to compare an export with (records.full_export). */
export async function fullExports(db: pg.Pool | pg.PoolClient): Promise<{ id: string; manifestSha256: string; recordCount: number; fileCount: number; exportedByPerson: string; recordedAt: Date }[]> {
  const { rows } = await db.query<{ id: string; manifest_sha256: string; record_count: number; file_count: number; exported_by_person: string; recorded_at: Date }>(
    'select id::text, manifest_sha256, record_count, file_count, exported_by_person::text, recorded_at from records.full_export order by recorded_at, id',
  );
  return rows.map((r) => ({ id: r.id, manifestSha256: r.manifest_sha256, recordCount: r.record_count, fileCount: r.file_count, exportedByPerson: r.exported_by_person, recordedAt: r.recorded_at }));
}
