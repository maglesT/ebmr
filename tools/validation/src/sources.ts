/**
 * What the release is, from the repository (Phase 7 slice 7c; interfaces section 4, D-P7-0-5): its migration files
 * in the order the runner applies them, the ledger they give (namespace, file, SHA-256 of the file) and the schema
 * release computed from it exactly as `platform.schema_release()` computes it from the database's ledger; the product
 * version and the commit. The IQ compares the installation with these.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@ebmr/kernel';

export const ROOT = new URL('../../../', import.meta.url).pathname;

export interface ReleaseSource {
  namespace: string;
  directory: string;
}

/** The migrations of a Tablets installation, in the runner's order (test-kit editionMigrationSources with tablets). */
export const TABLETS_SOURCES: readonly ReleaseSource[] = [
  { namespace: 'kernel', directory: join(ROOT, 'packages/kernel/sql') },
  { namespace: 'site-services', directory: join(ROOT, 'packages/site-services/sql') },
  { namespace: 'recipe-core', directory: join(ROOT, 'packages/recipe-core/sql') },
  { namespace: 'tablets', directory: join(ROOT, 'apps/tablets-server/sql') },
  // The edition namespaces, in test-kit EDITION_NAMESPACES order: the API edition (plan A0), then injectables (I-1c2).
  { namespace: 'substance', directory: join(ROOT, 'editions/substance/sql') },
  { namespace: 'injectables', directory: join(ROOT, 'editions/injectables/sql') },
];

export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** The ledger the release's files give: one row per migration file with its SHA-256. */
export function ledgerOfFiles(sources: readonly ReleaseSource[] = TABLETS_SOURCES): config.LedgerRow[] {
  return sources.flatMap((s) =>
    readdirSync(s.directory)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => ({ namespace: s.namespace, name: f, checksum: sha256(readFileSync(join(s.directory, f), 'utf8')) })),
  );
}

/** The schema release of the release's files (platform.schema_release() of a database migrated with them). */
export function schemaReleaseOfFiles(sources: readonly ReleaseSource[] = TABLETS_SOURCES): string {
  return config.releaseOfLedger(ledgerOfFiles(sources));
}

/** The Tablets product version (D-P7-14: the two Tablets apps carry it). */
export function productVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, 'apps/tablets-server/package.json'), 'utf8')) as { version: string }).version;
}

/** The commit and its time (UTC, ISO 8601) of `ref` in the repository. */
export function commitOf(ref = 'HEAD'): { commit: string; commitTime: string } {
  const out = execFileSync('git', ['-C', ROOT, 'show', '-s', '--format=%H %ct', ref], { encoding: 'utf8' }).trim();
  const [commit = '', seconds = '0'] = out.split(' ');
  return { commit, commitTime: new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, 'Z') };
}
