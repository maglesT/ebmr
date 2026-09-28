/**
 * Designer seed for demo and E2E installations (module C2; never production: the set-up CLI refuses
 * EBMR_ENV=production).
 *
 *  1. The DEMO-ONLY reference documents (reference-catalogue.ts) into tab.reference_document, recorded by the
 *     master-data steward (MASTERDATA.CHANGE) on PC-QA-01. Idempotent: a document already registered with the same
 *     body is skipped; one registered with another body is an error (published documents never change).
 *  2. The kernel and tablets rule tables (compliance/rule-tables), published by the steward
 *     (MARKET.RULE_TABLE_PUBLISH) when they are not yet published, because the designer's MarketMinimaPort fails
 *     closed without the edition's table (decision F12). Idempotent in the same way (kernel EBMR-MKT-035).
 */
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { market, withCommand, type ActorContext } from '@ebmr/kernel';
import type { FeatureSeedContext } from '../types.ts';
import { DEMO_REFERENCE_DOCUMENTS, referenceContent, referenceHash, type ReferenceDocumentSeed } from './reference-catalogue.ts';

/** compliance/rule-tables at the repository root (the seed runs from the source tree). */
export const RULE_TABLE_ROOT = fileURLToPath(new URL('../../../../../compliance/rule-tables', import.meta.url));

/** The rule tables a tablets installation needs (the sterile table belongs to the deferred injectables edition). */
export const TABLETS_RULE_TABLES: readonly market.RuleTableCode[] = ['kernel', 'tablets'];

export interface SeededReference {
  code: string;
  version: string;
  hash: string;
  action: 'RECORDED' | 'ALREADY_RECORDED';
}

/** Records reference documents that are not registered yet (inside commands of `actor`). */
export async function seedReferenceDocuments(pool: pg.Pool, actor: ActorContext, docs: readonly ReferenceDocumentSeed[] = DEMO_REFERENCE_DOCUMENTS): Promise<SeededReference[]> {
  const out: SeededReference[] = [];
  for (const doc of docs) {
    const content = referenceContent(doc);
    const hash = referenceHash(content);
    const { rows } = await pool.query<{ content_hash: string }>('select content_hash from tab.reference_document where kind = $1 and code = $2 and version = $3', [doc.kind, doc.code, doc.version]);
    const existing = rows[0];
    if (existing) {
      if (existing.content_hash !== hash) throw new Error(`reference document ${doc.code} v${doc.version} is registered with another body (hash ${existing.content_hash}); registered documents never change`);
      out.push({ code: doc.code, version: doc.version, hash, action: 'ALREADY_RECORDED' });
      continue;
    }
    await withCommand(pool, actor, (c) => c.query('select tab.record_reference_document($1::jsonb, $2)', [JSON.stringify(content), hash]));
    out.push({ code: doc.code, version: doc.version, hash, action: 'RECORDED' });
  }
  return out;
}

/** Publishes the kernel and tablets rule-table files that are not published yet (kernel publishRuleTable). */
export async function seedRuleTables(pool: pg.Pool, actor: ActorContext, root: string = RULE_TABLE_ROOT): Promise<market.SyncOutcome[]> {
  const outcomes: market.SyncOutcome[] = [];
  const files = market.readRuleTableDirectory(root);
  for (const table of TABLETS_RULE_TABLES) {
    for (const file of files.get(table) ?? []) {
      const { rows } = await pool.query<{ id: string; hash: string; file_hash: string }>(
        `select v.id, encode(v.content_hash, 'hex') as hash, encode(market.document_content_hash($3::jsonb), 'hex') as file_hash
           from market.rule_table_version v where v.table_code = $1 and v.version = $2`,
        [table, file.document.version, JSON.stringify(file.document)],
      );
      const published = rows[0];
      if (published) {
        if (published.hash !== published.file_hash) throw new Error(`${table} v${file.document.version} is published with different content (EBMR-MKT-035)`);
        outcomes.push({ table, version: file.document.version, action: 'ALREADY_PUBLISHED', versionId: published.id });
        continue;
      }
      const result = await withCommand(pool, actor, (c) => market.publishRuleTable(c, file, {}, root));
      outcomes.push({ table, version: result.version, action: 'PUBLISHED', versionId: result.versionId });
    }
  }
  return outcomes;
}

/** The feature seed (features/types.ts): GMP installations only (the designer is GMP-only). */
export async function seed(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'GMP') return;
  const steward = await ctx.actorFor('steward');
  const refs = await seedReferenceDocuments(ctx.pools.app, steward);
  ctx.log(`designer: ${refs.filter((r) => r.action === 'RECORDED').length} DEMO-ONLY reference documents recorded, ${refs.filter((r) => r.action !== 'RECORDED').length} already present`);
  const tables = await seedRuleTables(ctx.pools.app, await ctx.actorFor('steward'));
  ctx.log(`designer: rule tables ${tables.map((t) => `${t.table} v${t.version} ${t.action.toLowerCase().replace('_', ' ')}`).join(', ')}`);
}
