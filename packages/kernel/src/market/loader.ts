/**
 * Rule-table loader (build outline 3.3.1, 3.6; ADR 0008 decision 5).
 *
 * Reads versioned rule-table files (compliance/rule-tables/<table>/<table>.v<N>.yaml or .json),
 * validates them, and publishes each as the next version of its table through
 * market.publish_rule_table, which validates again and is the only writer of rule data. A file
 * whose version is already published must still match the published content hash exactly, so a
 * published table can never be edited in place, not even in its source file.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type pg from 'pg';
import { parse as parseYaml } from 'yaml';
import type { ActorContext } from '../db/command.ts';
import { withCommand } from '../db/command.ts';
import { MarketRuleError } from './errors.ts';
import type { RuleTableCode, RuleTableDocument } from './types.ts';
import { RULE_TABLES } from './types.ts';
import { validateRuleTableDocument } from './validate.ts';

type Queryable = pg.Pool | pg.PoolClient | pg.Client;

export interface RuleTableFile {
  path: string;
  /** SHA-256 of the file bytes. */
  sha256: string;
  document: RuleTableDocument;
}

const FILE_NAME = /^([a-z][a-z0-9]*)\.v([1-9][0-9]*)\.(ya?ml|json)$/;

/** Parse one rule-table file. Throws EBMR-MKT-010 on a malformed or invalid file. */
export function readRuleTableFile(path: string): RuleTableFile {
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const match = FILE_NAME.exec(basename(path));
  if (!match) throw new MarketRuleError('EBMR-MKT-010', `${path}: rule-table files are named <table>.v<N>.yaml or .json`);
  let parsed: unknown;
  try {
    // YAML 1.2 core schema: dates stay strings; numbers become numbers and are refused as values.
    parsed = match[3] === 'json' ? JSON.parse(text) : parseYaml(text, { schema: 'core', uniqueKeys: true });
  } catch (error) {
    throw new MarketRuleError('EBMR-MKT-010', `${path}: cannot be parsed: ${(error as Error).message}`);
  }
  const problems = validateRuleTableDocument(parsed);
  if (problems.length > 0) {
    const [first] = problems;
    throw new MarketRuleError(first?.code ?? 'EBMR-MKT-010', `${path}: ${first?.message ?? 'invalid'}${problems.length > 1 ? ` (and ${problems.length - 1} more problems)` : ''}`);
  }
  const document = parsed as RuleTableDocument;
  if (document.table !== match[1] || String(document.version) !== match[2]) {
    throw new MarketRuleError('EBMR-MKT-010', `${path}: the file name says ${match[1]} v${match[2]} but the content says ${document.table} v${document.version}`);
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), document };
}

/** Every rule-table file under root, grouped by table and sorted by version. */
export function readRuleTableDirectory(root: string): Map<RuleTableCode, RuleTableFile[]> {
  const out = new Map<RuleTableCode, RuleTableFile[]>();
  for (const table of RULE_TABLES) {
    const dir = join(root, table);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const files = names
      .filter((n) => FILE_NAME.test(n))
      .map((n) => readRuleTableFile(join(dir, n)))
      .sort((a, b) => a.document.version - b.document.version);
    for (const f of files) {
      if (f.document.table !== table) throw new MarketRuleError('EBMR-MKT-010', `${f.path}: a ${f.document.table} table in the ${table} folder`);
    }
    files.forEach((f, i) => {
      if (f.document.version !== i + 1) throw new MarketRuleError('EBMR-MKT-012', `${table}: versions must run 1, 2, 3 ... without gaps (found v${f.document.version} at position ${i + 1})`);
    });
    out.set(table, files);
  }
  return out;
}

export interface PublishChange {
  kind?: 'INITIAL' | 'UPDATE' | 'SOURCE_CORRECTION';
  description?: string;
  citation?: string;
  /** Two approval-record ids for a SOURCE_CORRECTION (the signing module supplies them later). */
  approverIds?: string[];
  vendorNoticeRef?: string;
}

export interface PublishResult {
  versionId: string;
  table: RuleTableCode;
  version: number;
  contentHash: string;
  changeKind: string;
  loosening: unknown[];
  impactCount: number;
}

/** Publish one document as the next version of its table. Run inside a command (withCommand). */
export async function publishRuleTable(client: Queryable, file: RuleTableFile, change: PublishChange = {}, sourceRoot?: string): Promise<PublishResult> {
  const { rows } = await client.query<{ result: PublishResult }>('select market.publish_rule_table($1::jsonb, $2::jsonb) as result', [
    JSON.stringify(file.document),
    JSON.stringify({ ...change, sourceFile: sourceRoot ? relative(sourceRoot, file.path) : file.path, sourceSha256: file.sha256 }),
  ]);
  const result = rows[0]?.result;
  if (!result) throw new MarketRuleError('EBMR-MKT-034', 'publish returned no result');
  return result;
}

export interface SyncOutcome {
  table: RuleTableCode;
  version: number;
  action: 'PUBLISHED' | 'ALREADY_PUBLISHED';
  versionId: string;
}

/**
 * Bring the database up to date with the rule-table files: already-published versions must match
 * their stored content hash exactly; newer files are published in order, each in its own command.
 */
export async function syncRuleTables(pool: pg.Pool, actor: ActorContext, root: string, changes: Partial<Record<string, PublishChange>> = {}): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const [table, files] of readRuleTableDirectory(root)) {
    for (const file of files) {
      const { rows } = await pool.query<{ id: string; hash: string; file_hash: string }>(
        `select v.id, encode(v.content_hash, 'hex') as hash, encode(market.document_content_hash($3::jsonb), 'hex') as file_hash
           from market.rule_table_version v where v.table_code = $1 and v.version = $2`,
        [table, file.document.version, JSON.stringify(file.document)],
      );
      const published = rows[0];
      if (published) {
        if (published.hash !== published.file_hash) {
          throw new MarketRuleError('EBMR-MKT-035', `${file.path}: ${table} v${file.document.version} is published with different content; published versions are immutable, add a new version instead`);
        }
        outcomes.push({ table, version: file.document.version, action: 'ALREADY_PUBLISHED', versionId: published.id });
        continue;
      }
      const result = await withCommand(pool, actor, (c) => publishRuleTable(c, file, changes[`${table}.v${file.document.version}`] ?? {}, root));
      outcomes.push({ table, version: result.version, action: 'PUBLISHED', versionId: result.versionId });
    }
  }
  return outcomes;
}
