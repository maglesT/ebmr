/**
 * Publishing the installation's rule tables (kernel, tablets and sterile, from compliance/rule-tables) for demo and
 * E2E installations. The set-up CLI runs it on both installations before the feature seeds (the designer's
 * MarketMinimaPort and the sandbox runs need the published tables; both fail closed without them, decision F12).
 * Written by C2, moved here by the lead.
 *
 * Idempotent: a version already published with the same content is skipped; one published with other content is
 * an error (published versions never change, kernel EBMR-MKT-035). The actor must hold MARKET.RULE_TABLE_PUBLISH
 * (the master-data steward); each version is published in its own command (kernel publishRuleTable).
 */
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { market, withCommand, type ActorContext } from '@ebmr/kernel';

/** compliance/rule-tables at the repository root (demo and E2E set-up run from the source tree). */
export const RULE_TABLE_ROOT = fileURLToPath(new URL('../../../../compliance/rule-tables', import.meta.url));

/**
 * The rule tables an installation publishes: kernel, tablets and, since injectables slice I-1, sterile. The market engine
 * resolves a key only for a scope of its edition (EBMR-MKT-054), so the sterile table serves injectables masters and
 * batches alone, and a Tablets scope never reads it.
 */
export const INSTALLATION_RULE_TABLES: readonly market.RuleTableCode[] = ['kernel', 'tablets', 'sterile'];

/** The part of a feature seed context this needs (FeatureSeedContext satisfies it). */
export interface RuleTableSeedContext {
  pools: { app: pg.Pool };
  log?: (message: string) => void;
}

export async function publishRuleTables(
  ctx: RuleTableSeedContext,
  actor: ActorContext,
  options: { root?: string; tables?: readonly market.RuleTableCode[] } = {},
): Promise<market.SyncOutcome[]> {
  const root = options.root ?? RULE_TABLE_ROOT;
  const pool = ctx.pools.app;
  const outcomes: market.SyncOutcome[] = [];
  const files = market.readRuleTableDirectory(root);
  for (const table of options.tables ?? INSTALLATION_RULE_TABLES) {
    for (const file of files.get(table) ?? []) {
      const { rows } = await pool.query<{ id: string; hash: string; file_hash: string }>(
        `select v.id, encode(v.content_hash, 'hex') as hash, encode(market.document_content_hash($3::jsonb), 'hex') as file_hash
           from market.rule_table_version v where v.table_code = $1 and v.version = $2`,
        [table, file.document.version, JSON.stringify(file.document)],
      );
      const published = rows[0];
      if (published) {
        if (published.hash !== published.file_hash) {
          throw new market.MarketRuleError('EBMR-MKT-035', `${file.path}: ${table} v${file.document.version} is published with different content; published versions are immutable`);
        }
        outcomes.push({ table, version: file.document.version, action: 'ALREADY_PUBLISHED', versionId: published.id });
        continue;
      }
      const result = await withCommand(pool, actor, (c) => market.publishRuleTable(c, file, {}, root));
      outcomes.push({ table, version: result.version, action: 'PUBLISHED', versionId: result.versionId });
    }
  }
  ctx.log?.(`rule tables: ${outcomes.map((o) => `${o.table} v${o.version} ${o.action === 'PUBLISHED' ? 'published' : 'already published'}`).join(', ')}`);
  return outcomes;
}
