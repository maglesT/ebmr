/**
 * Designer seed for demo and E2E installations (module C2; never production: the set-up CLI refuses
 * EBMR_ENV=production). GMP only.
 *
 *  1. The DEMO-ONLY reference documents (reference-catalogue.ts) into tab.reference_document, recorded by the
 *     master-data steward (MASTERDATA.CHANGE) on PC-QA-01. Idempotent: a document already registered with the same
 *     body is skipped; one registered with another body is an error (registered documents never change).
 *  The kernel and tablets rule tables are published by the set-up CLI on both installations before the feature
 *  seeds run (platform/rule-tables.ts); the designer's MarketMinimaPort fails closed without them (decision F12).
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import type { FeatureSeedContext } from '../types.ts';
import { DEMO_REFERENCE_DOCUMENTS, referenceContent, referenceHash, type ReferenceDocumentSeed } from './reference-catalogue.ts';

export interface SeededReference {
  code: string;
  version: string;
  hash: string;
  action: 'RECORDED' | 'ALREADY_RECORDED';
}

/** Records reference documents that are not registered yet (each in a command of `actor`). */
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

/** The feature seed (features/types.ts): GMP installations only (the designer is GMP-only). */
export async function seed(ctx: FeatureSeedContext): Promise<void> {
  if (ctx.installation !== 'GMP') return;
  const refs = await seedReferenceDocuments(ctx.pools.app, await ctx.actorFor('steward'));
  ctx.log(`designer: ${refs.filter((r) => r.action === 'RECORDED').length} DEMO-ONLY reference documents recorded, ${refs.filter((r) => r.action !== 'RECORDED').length} already present`);
}
