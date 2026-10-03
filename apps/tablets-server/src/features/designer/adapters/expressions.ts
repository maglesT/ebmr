/**
 * The validation context of the designer (module C2; validator README; decision D10): the expression language
 * (@ebmr/expr through recipe-core's ExpressionService), the generic block catalogue, and the database-backed ports
 * (reference documents, market minima, the installation's engine roles), pre-loaded for one MBR at the site date. The same pure validator and
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
  minimaRequest: validator.MinimaRequest;
  minima: validator.ResolvedMinimum[];
  /** The engine roles of this installation (recipe.engine_role_permission), for FLOW-ROLES (review F49). */
  engineRoles: string[];
}

/**
 * The engine roles of this installation, as the database holds them (recipe.engine_role_permission): the roles a session
 * can carry on the floor. The validator checks every role an MBR names against them, and the database refuses content
 * naming another (recipe-core 0324, EBMR-RCP-123), so both read one list.
 */
export async function engineRoles(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ engine_role: string }>('select distinct engine_role from recipe.engine_role_permission order by engine_role');
  if (rows.length === 0) throw new Error('the database holds no engine roles');
  return rows.map((r) => r.engine_role);
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
  const roles = await engineRoles(db);
  return {
    context: { expressions: EXPRESSIONS, blocks: BLOCK_CATALOG, references: refs.port, market: market.port, roles: { engineRoles: roles }, asOf: date },
    asOf: date,
    references: refs.rows,
    minimaRequest: request,
    minima: market.minima,
    engineRoles: roles,
  };
}
