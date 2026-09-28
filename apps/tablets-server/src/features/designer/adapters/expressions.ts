/**
 * The validation context of the designer (module C2; validator README; decision D10): the expression language
 * (@ebmr/expr through recipe-core's ExpressionService), the generic block catalogue, and the two database-backed
 * ports (reference documents, market minima), pre-loaded for one MBR at the site date. The same pure validator and
 * simulator run in the designer's Web Worker later (A2); the server stays authoritative.
 */
import type pg from 'pg';
import { flow, validator } from '@ebmr/recipe-core/pure';
import { loadMarketMinimaPort } from './market-minima.ts';
import { loadReferencePort, type ReferenceRow } from './references.ts';

type Db = pg.Pool | pg.PoolClient;

/** One expression service per process: pure, deterministic, and costly enough to build that it is shared. */
export const EXPRESSIONS: flow.ExpressionService = flow.createExprService();

/** The block catalogue the validator reads (editions extend it in Phase 3 with the tablets blocks). */
export const BLOCK_CATALOG: flow.BlockCatalog = flow.genericBlockCatalog;

/** The site calendar date now (YYYY-MM-DD), from the database clock and the site zone policy. */
export async function siteToday(db: Db): Promise<string> {
  const { rows } = await db.query<{ d: string }>("select to_char(recipe.site_today(), 'YYYY-MM-DD') as d");
  const d = rows[0]?.d;
  if (!d) throw new Error('the database returned no site date');
  return d;
}

export interface LoadedContext {
  context: validator.ValidationContext;
  asOf: string;
  references: ReferenceRow[];
  minima: validator.ResolvedMinimum[];
}

/** Pre-loads every port the validator needs for this MBR (validator.requiredLookups) at the site date. */
export async function loadValidationContext(db: Db, mbr: flow.MbrContent, asOf?: string): Promise<LoadedContext> {
  const date = asOf ?? (await siteToday(db));
  const lookups = validator.requiredLookups(mbr);
  const refs = await loadReferencePort(db, lookups.references, date);
  const request: validator.MinimaRequest = {
    edition: mbr.header.edition,
    recordKind: mbr.header.recordKind,
    marketSet: [...mbr.header.marketSet],
    predicates: { ...mbr.header.predicates },
    asOf: date,
    ruleKeys: lookups.ruleKeys,
  };
  const market = await loadMarketMinimaPort(db, request);
  return {
    context: { expressions: EXPRESSIONS, blocks: BLOCK_CATALOG, references: refs.port, market: market.port, asOf: date },
    asOf: date,
    references: refs.rows,
    minima: market.minima,
  };
}
