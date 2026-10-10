/**
 * The validation context of the designer (module C2; validator README; decision D10): the expression language
 * (@ebmr/expr through recipe-core's ExpressionService), the generic block catalogue, and the database-backed ports
 * (reference documents, market minima, the installation's engine roles and checker roles), pre-loaded for one MBR at the site date. The same pure validator and
 * simulator run in the designer's Web Worker later (A2); the server stays authoritative.
 */
import type pg from 'pg';
import { flow, validator } from '@ebmr/recipe-core/pure';
import { tabletsBlockCatalog } from '../../edition-blocks.ts';
import { loadMarketMinimaPort } from './market-minima.ts';
import { loadReferencePort, type ReferenceRow } from './references.ts';

type Db = pg.Pool | pg.PoolClient;

/** One expression service per process: pure, deterministic, and costly enough to build that it is shared. */
export const EXPRESSIONS: flow.ExpressionService = flow.createExprService();

/** The block catalogue the validator reads: the generic blocks and the Tablets edition's own (Phase 3 slice 3b on). */
export const BLOCK_CATALOG: flow.BlockCatalog = tabletsBlockCatalog;

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
  /** Of them, those in which a person may give a witness and a later review (T12.DOC round 4; `checkerRoles`). */
  checkers: flow.CheckerRoles;
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

/**
 * The engine roles of this installation in which a person may give each kind of second-person check (Phase 2 exit
 * follow-up T12.DOC round 4), as the run decides it: a kernel role carries the engine role (tab.engine_role_map, holding
 * the permission named there) and holds the permission the kernel signs the check with (flow CHECK_PERMISSIONS:
 * STEP.WITNESS for a witness, STEP.VERIFY for a later review; esig catalogue, recipe.require_command_permission), now
 * (iam.role_permissions_at). The floor's list of who may give a step's check reads the same (execution views
 * checkersOf). The validator names the people the run accepts from these and refuses a check no one may give.
 */
export async function checkerRoles(db: Db): Promise<flow.CheckerRoles> {
  const { rows } = await db.query<{ engine_role: string; witness: boolean; review: boolean }>(
    `select m.engine_role, bool_or($1 = any (h.held)) as witness, bool_or($2 = any (h.held)) as review
       from tab.engine_role_map m
       cross join lateral (select iam.role_permissions_at(m.kernel_role, clock_timestamp()) as held) h
      where m.via_permission = any (h.held)
      group by m.engine_role
      order by m.engine_role`,
    [flow.CHECK_PERMISSIONS.witness, flow.CHECK_PERMISSIONS.review],
  );
  return { witness: rows.filter((r) => r.witness).map((r) => r.engine_role), review: rows.filter((r) => r.review).map((r) => r.engine_role) };
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
  const checkers = await checkerRoles(db);
  return {
    context: { expressions: EXPRESSIONS, blocks: BLOCK_CATALOG, references: refs.port, market: market.port, roles: { engineRoles: roles, checkers }, asOf: date },
    asOf: date,
    references: refs.rows,
    minimaRequest: request,
    minima: market.minima,
    engineRoles: roles,
    checkers,
  };
}
