/**
 * Export a batch and restore it into an isolated environment (DI-02 clause 1).
 *
 * The export: the record's evidence export (records.assembleEvidenceExport, the format the archive route registers):
 * its true-copy bundle, its PDF/A-3 true copy and a summary, written to a file. The isolated environment: a separate
 * Node process started with an empty environment (no database variables, no credentials, no network address of the
 * installation; isolated-restore.ts) that gets only the file. There the record is restored from the export alone: the
 * export and each true copy verify offline, the true copy is rendered again from the bundle it carries, and the
 * restored record's content hash, events and rows are reported back. The drill compares them with the source's.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { records } from '@ebmr/kernel';

export interface IsolatedRestore {
  ok: boolean;
  problems: string[];
  exportSha256: string | null;
  chainKey: string | null;
  contentSha256: string | null;
  pdfContentSha256: string | null;
  events: number;
  rows: number;
  /** The environment variables the isolated process saw (names only): proof that nothing of the installation reached it. */
  environment: string[];
}

export interface ExportRoundTrip {
  chainKey: string;
  file: string;
  bytes: number;
  exportSha256: string;
  sourceContentSha256: string;
  isolated: IsolatedRestore;
  same: boolean;
}

function asOwner(c: pg.Client): pg.PoolClient {
  const query = (text: string, values?: unknown[]) => c.query(text.replace('records.true_copy_snapshot($1)', 'records.true_copy_parts($1, null)'), values);
  return { query } as unknown as pg.PoolClient;
}

const ISOLATED = fileURLToPath(new URL('./isolated-restore.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url));

/** Runs the isolated restore of an export file in its own process with an empty environment. */
export function restoreInIsolation(file: string): Promise<IsolatedRestore> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', TSX, ISOLATED, file], { env: {}, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`the isolated restore failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as IsolatedRestore);
    });
  });
}

/** Exports `chainKey` from the database `c` reads (as its owner, in one snapshot) into `dir`, then restores it in isolation. */
export async function exportAndRestore(c: pg.Client, chainKey: string, dir: string, label: string): Promise<ExportRoundTrip> {
  await c.query('begin isolation level repeatable read read only');
  let bundle: records.TrueCopyBundle;
  let generatedAt: string;
  try {
    bundle = await records.trueCopyBundleFromSnapshot(asOwner(c), chainKey);
    generatedAt = (await c.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]?.t ?? '';
    await c.query('commit');
  } catch (error) {
    await c.query('rollback').catch(() => undefined);
    throw error;
  }
  const pdf = await records.renderTrueCopyPdf(bundle, { title: `True copy of ${chainKey}`, label });
  const [type = '', ...rest] = chainKey.split(':');
  const exp = records.assembleEvidenceExport({
    subject: { type, id: rest.join(':'), label },
    generatedAt,
    bundles: [{ name: 'record', title: `Record ${label}`, bundle }],
    pdfs: [{ name: 'record-pdf', title: `Record ${label} (PDF/A-3)`, chainKey, pdf: pdf.pdf, contentSha256: pdf.contentSha256 }],
    documents: [{ name: 'summary', title: 'What this export holds', mediaType: 'application/json', text: JSON.stringify({ chainKey, label, generatedAt }, null, 2) }],
  });
  const text = records.serializeEvidenceExport(exp);
  const file = join(dir, `export-${chainKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  writeFileSync(file, text);
  const isolated = await restoreInIsolation(file);
  return {
    chainKey,
    file,
    bytes: Buffer.byteLength(text),
    exportSha256: exp.exportSha256,
    sourceContentSha256: pdf.contentSha256,
    isolated,
    same: isolated.ok && isolated.contentSha256 === pdf.contentSha256 && isolated.pdfContentSha256 === pdf.contentSha256,
  };
}
