/**
 * The release's evidence bundle as shipped, the validation pack generated from it, and the IQ run against it (Phase 7
 * slice 7g-3; slice 7c; decision D-P7R-5). The bundle is the file EBMR_VALIDATION_BUNDLE names (bundle.json of
 * `pnpm validation:bundle`); the validation kit reads it (parseBundle: a bundle that does not validate is refused,
 * EBMR-VAL-002), generates the pack from it (generatePack, the same bytes as `pnpm validation:generate`) and runs the IQ
 * checks (runIq, the same code as `pnpm validation:iq`). The IQ record is stored by the database (platform.record_iq,
 * kernel 1381: VALIDATION.MANAGE, the SHA-256 recomputed).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { bundleSha256, generatePack, hostOfThisMachine, parseBundle, runIq, type Bundle, type Pack } from '@ebmr/validation-kit';
import type { RouteResponse, routes } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';

type R<K extends keyof typeof routes.validation> = RouteResponse<(typeof routes.validation)[K]>;

export const BUNDLE_FILE = 'bundle.json';
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export interface ShippedEvidence {
  fileName: string;
  text: string;
  bundle: Bundle;
  sha256: string;
  pack: Pack;
}

let cache: { key: string; value: ShippedEvidence } | null = null;

/** The shipped bundle and its pack, or why there is none (read again when the file changes). */
export function shippedEvidence(app: AppContext): { evidence: ShippedEvidence | null; problem: string | null } {
  const file = app.config.validation.bundleFile;
  if (!file) return { evidence: null, problem: 'No evidence bundle is configured on this server (EBMR_VALIDATION_BUNDLE, the bundle.json shipped with the release).' };
  let key: string;
  try {
    const st = statSync(file);
    key = `${file}|${String(st.size)}|${String(st.mtimeMs)}`;
  } catch {
    return { evidence: null, problem: `The evidence bundle ${file} cannot be read on this server.` };
  }
  if (cache?.key === key) return { evidence: cache.value, problem: null };
  try {
    const text = readFileSync(file, 'utf8');
    const bundle = parseBundle(JSON.parse(text) as unknown);
    const value = { fileName: basename(file), text, bundle, sha256: bundleSha256(bundle), pack: generatePack(bundle) };
    cache = { key, value };
    return { evidence: value, problem: null };
  } catch (e) {
    return { evidence: null, problem: `The file ${basename(file)} is not an evidence bundle of this product: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function evidenceView(app: AppContext, running: string): R<'evidence'> {
  const { evidence, problem } = shippedEvidence(app);
  const b = evidence?.bundle;
  return {
    configured: evidence !== null,
    problem,
    fileName: evidence?.fileName ?? null,
    bundleSha256: evidence?.sha256 ?? null,
    release: b ? { product: b.release.product, version: b.release.version, commit: b.release.commit, schemaRelease: b.release.schemaRelease, edition: b.edition } : null,
    runningRelease: running,
    documents: (evidence?.pack.manifest.documents ?? []).map((d) => ({ id: d.id, title: d.title, status: d.status, files: d.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: String(f.bytes) })) })),
  };
}

const notHere = (why: string) =>
  refusal(404, { code: 'EVIDENCE_NOT_HERE', kind: 'NOT_ENABLED', whatHappened: 'The file is not on this server.', why, controls: ['DI-03'], whoCanHelp: ['The system administrator'] });

export function evidenceFile(app: AppContext, path: string): R<'evidenceFile'> {
  const { evidence, problem } = shippedEvidence(app);
  if (!evidence) throw notHere(problem ?? 'No evidence bundle.');
  if (path === BUNDLE_FILE) return { path, mediaType: 'application/json', sha256: sha256(evidence.text), content: evidence.text };
  const f = evidence.pack.files.find((x) => x.path === path);
  if (!f) throw notHere(`The validation pack has no document ${path}.`);
  return { path, mediaType: path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'text/markdown', sha256: sha256(f.content), content: f.content };
}

/** The validation summary document of the pack (its Markdown file), or why there is none. */
export function summaryDocument(app: AppContext, running: string): { document: R<'summary'>['document']; problem: string | null } {
  const { evidence, problem } = shippedEvidence(app);
  if (!evidence) return { document: null, problem };
  const entry = evidence.pack.manifest.documents.find((d) => d.id === 'validation-summary');
  const md = entry?.files.find((f) => f.path.endsWith('.md'));
  const file = md ? evidence.pack.files.find((f) => f.path === md.path) : undefined;
  if (!entry || !md || !file) return { document: null, problem: 'The validation pack of the shipped bundle has no validation summary.' };
  const forRunning = evidence.bundle.release.schemaRelease === running;
  return {
    document: { title: entry.title, path: md.path, sha256: md.sha256, schemaRelease: evidence.bundle.release.schemaRelease, markdown: file.content, forRunningRelease: forRunning },
    problem: forRunning ? null : `The shipped bundle is for release ${evidence.bundle.release.schemaRelease}; this database runs ${running}. Only the running release's summary is approved here.`,
  };
}

/** Runs the IQ checks on a connection of this server's database, the server's own meta read in process. */
export async function runIqHere(app: AppContext, scope: FastifyInstance, client: pg.PoolClient, evidence: ShippedEvidence): Promise<{ text: string; sha256: string }> {
  const postgres = (await client.query<{ v: string }>('show server_version')).rows[0]?.v ?? null;
  const record = await runIq({
    db: client,
    bundle: evidence.bundle,
    server: app.config.publicOrigin,
    host: hostOfThisMachine(postgres),
    fetchFn: async (url: string) => {
      const res = await scope.inject({ method: 'GET', url: new URL(url).pathname });
      return { status: res.statusCode, json: () => Promise.resolve(JSON.parse(res.body) as unknown) };
    },
  });
  const text = `${JSON.stringify(record, null, 2)}\n`;
  return { text, sha256: sha256(text) };
}
