/**
 * The full export of the installation for the stand-alone record viewer (Phase 7 slice 7b-2; DI-08 clause 2; kernel
 * 1335). It is the data return of the supplier agreements: every closed record's archive package, with its audit trail
 * and its signature manifestations in readable form, verifiable without the system.
 *
 * An export is a folder:
 *   manifest.json                      format ebmr.full-export/1: the installation (kind, schema release), every closed
 *                                      record in order with the chains of its archive package and its signature chains
 *                                      (each with its file, bundle manifest SHA-256 and head), the seal key chains, and
 *                                      every other file with its SHA-256 and size. The export SHA-256 is the SHA-256 of
 *                                      manifest.json; the database keeps it in records.full_export, the reference the
 *                                      viewer compares with.
 *   records/<nnnnnn>-<type>/<chain>.json the true-copy bundle (true-copy.ts) of each chain.
 *   seal-keys/<key>.json               the true-copy bundle of each seal key chain (the Ed25519 public keys).
 *   signatures.json                    each signature's seal payload as the database computes it (esig.seal_payload),
 *                                      and the installation's own check of the seal when the exporter holds the key ring.
 *
 * One run in one REPEATABLE READ transaction (RECORD.EXPORT, and CONTROLLED.READ when controlled records are exported):
 * records.begin_full_export fixes the scope once; the records are read page by page (records.full_export_records), each
 * record's chains in calls of up to `batch` chains, and every file is written to the folder as it is made, so only the
 * manifest's entries stay in memory. records.register_full_export checks the manifest against the run's scope and the
 * chain heads of the same snapshot and registers its SHA-256. On any failure nothing is registered and the folder is
 * removed.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
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
  runId: string;
  manifestSha256: string;
  /** manifest.json, exactly as hashed and written. */
  manifest: string;
  /** The folder the export was written into. */
  dir: string;
}

interface BeginJson {
  runId: string;
  generatedAt: string;
  installation: { kind: string; schemaRelease: string };
  records: number;
  chains: number;
  sealKeyChainKeys: string[];
}

interface PageRecord {
  ordinal: number;
  recordType: string;
  recordId: string;
  label: string;
  closedAt: string;
  chainKeys: string[];
  signatureChainKeys: string[];
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
 * Makes the full export as `ctx` (a person holding RECORD.EXPORT) into the folder `dir` (empty or new) and registers
 * it. With `keyRing` (the installation's trusted seal keys) every seal is also checked here and the result recorded in
 * signatures.json. `page` records are read per call (default 100) and their chains in calls of `batch` (default 100).
 */
export async function buildFullExport(pool: pg.Pool, ctx: ActorContext, dir: string, opts: { keyRing?: SealKeyRing; batch?: number; page?: number } = {}): Promise<FullExport> {
  const batch = opts.batch ?? 100;
  const pageSize = opts.page ?? 100;
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`EBMR-REC-144 ${dir} is not empty: an export is written into an empty folder`);
  mkdirSync(dir, { recursive: true });
  const client = await pool.connect();
  let sealsFd: number | null = null;
  try {
    await client.query('begin isolation level repeatable read');
    await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const begun = (await client.query<{ b: BeginJson }>('select records.begin_full_export() as b')).rows[0]?.b;
    if (!begun) throw new Error('EBMR-REC-142 the full export could not be started');
    const listed: FullExportManifest['files'] = [];
    const writeFile = (path: string, text: string) => {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { flag: 'wx' });
      listed.push({ path, kind: 'TRUE_COPY', bytes: utf8Bytes(text), sha256: sha256Hex(text) });
    };
    // signatures.json is written entry by entry, its hash and size kept as it grows.
    sealsFd = openSync(join(dir, FULL_EXPORT_SEALS), 'wx');
    const fd = sealsFd;
    const sealsHash = createHash('sha256');
    let sealsBytes = 0;
    let firstSeal = true;
    const writeSeals = (text: string) => {
      writeSync(fd, text);
      sealsHash.update(text, 'utf8');
      sealsBytes += utf8Bytes(text);
    };
    writeSeals(`{\n  "format": "${FULL_EXPORT_SEALS_FORMAT}",\n  "seals": [`);

    const snapshots = async (keys: string[]): Promise<Map<string, SnapshotEntry>> => {
      const out = new Map<string, SnapshotEntry>();
      for (let i = 0; i < keys.length; i += batch) {
        const { rows } = await client.query<{ s: SnapshotEntry[] }>('select records.full_export_snapshot($1, $2::text[]) as s', [begun.runId, keys.slice(i, i + batch)]);
        for (const e of rows[0]?.s ?? []) out.set(e.chainKey, e);
      }
      return out;
    };
    const chainFile = async (folder: string, chainKey: string, entry: SnapshotEntry | undefined): Promise<ExportedChain> => {
      if (!entry) throw new Error(`EBMR-REC-142 the export has no snapshot of ${chainKey}`);
      const bundle = trueCopyBundleOfParts(chainKey, entry.snapshot);
      const head = (JSON.parse(bundle.manifest) as BundleManifest).head;
      if (!head) throw new Error(`EBMR-REC-142 ${chainKey} has no audit event`);
      const path = `${folder}/${exportFileName(chainKey)}.json`;
      writeFile(path, serializeBundle(bundle));
      if (chainKey.startsWith('esig_signature:')) {
        const byId = sealRows(bundle);
        for (const p of entry.sealPayloads) {
          const s = byId.get(p.signatureId);
          if (!s) continue; // an unsealed signature: the viewer reports it from the signature rows
          const installationCheck: InstallationSealCheck = opts.keyRing
            ? await opts.keyRing.verify(s.keyId, s.algorithm, sealMessage(s.keyId, s.algorithm, p.payload), Buffer.from(s.seal, 'base64'))
            : 'NOT_CHECKED';
          const seal: ExportedSeal = { signatureId: p.signatureId, chainKey, keyId: s.keyId, algorithm: s.algorithm, payload: p.payload, installationCheck };
          writeSeals(`${firstSeal ? '' : ','}\n    ${JSON.stringify(seal)}`);
          firstSeal = false;
        }
      }
      return { chainKey, path, manifestSha256: bundle.manifestSha256, headSeq: head.seq, headHash: head.hash };
    };

    const records: ExportedRecord[] = [];
    for (let after = 0; ; ) {
      const page = (await client.query<{ p: PageRecord[] }>('select records.full_export_records($1, $2, $3) as p', [begun.runId, after, pageSize])).rows[0]?.p ?? [];
      if (page.length === 0) break;
      for (const r of page) {
        const folder = `records/${String(r.ordinal).padStart(6, '0')}-${exportFileName(r.recordType)}`;
        const parts = await snapshots([...r.chainKeys, ...r.signatureChainKeys]);
        const chains: ExportedChain[] = [];
        for (const k of r.chainKeys) chains.push(await chainFile(folder, k, parts.get(k)));
        const signatureChains: ExportedChain[] = [];
        for (const k of r.signatureChainKeys) signatureChains.push(await chainFile(folder, k, parts.get(k)));
        records.push({ recordType: r.recordType, recordId: r.recordId, label: r.label, closedAt: r.closedAt, chains, signatureChains });
        after = r.ordinal;
      }
    }
    const keyParts = begun.sealKeyChainKeys.length > 0 ? await snapshots(begun.sealKeyChainKeys) : new Map<string, SnapshotEntry>();
    const sealKeys: ExportedChain[] = [];
    for (const k of begun.sealKeyChainKeys) sealKeys.push(await chainFile('seal-keys', k, keyParts.get(k)));
    writeSeals('\n  ]\n}\n');
    closeSync(fd);
    sealsFd = null;
    listed.push({ path: FULL_EXPORT_SEALS, kind: 'SEALS', bytes: sealsBytes, sha256: sealsHash.digest('hex') });

    const manifest: FullExportManifest = {
      format: FULL_EXPORT_FORMAT,
      generatedAt: begun.generatedAt,
      installation: begun.installation,
      hashAlgorithm: 'SHA-256',
      records,
      sealKeys,
      seals: FULL_EXPORT_SEALS,
      files: listed,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestSha256 = sha256Hex(manifestText);
    writeFileSync(join(dir, FULL_EXPORT_MANIFEST), manifestText, { flag: 'wx' });
    const exportId = (await client.query<{ id: string }>('select records.register_full_export($1, $2, $3) as id', [begun.runId, manifestText, manifestSha256])).rows[0]?.id;
    if (!exportId) throw new Error('EBMR-REC-144 the full export was not registered');
    await client.query('commit');
    return { exportId, runId: begun.runId, manifestSha256, manifest: manifestText, dir };
  } catch (error) {
    await client.query('rollback');
    if (sealsFd !== null) closeSync(sealsFd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    client.release();
  }
}

export async function fullExports(db: pg.Pool | pg.PoolClient): Promise<{ id: string; manifestSha256: string; recordCount: number; fileCount: number; exportedByPerson: string; recordedAt: Date }[]> {
  const { rows } = await db.query<{ id: string; manifest_sha256: string; record_count: number; file_count: number; exported_by_person: string; recorded_at: Date }>(
    'select id::text, manifest_sha256, record_count, file_count, exported_by_person::text, recorded_at from records.full_export order by recorded_at, id',
  );
  return rows.map((r) => ({ id: r.id, manifestSha256: r.manifest_sha256, recordCount: r.record_count, fileCount: r.file_count, exportedByPerson: r.exported_by_person, recordedAt: r.recorded_at }));
}
