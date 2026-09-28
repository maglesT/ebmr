/**
 * MarketMinimaPort over the kernel market-profile engine (module C2; validator README "Market minima"; outline 3.3.5;
 * IN-52, INV-28; decision F12: fail closed).
 *
 * The validator is synchronous, so the minima are resolved first, in the database (market.resolve over the
 * published rule-table version), and the port answers from the result. For the MBR's market set, predicates and
 * validation date:
 *  - the edition's rule table (tablets) must be published and must verify (content and row hashes); otherwise
 *    every answer carries an UNRESOLVED item, so no MBR passes on an installation without its rule table;
 *  - India must be in the market set (INV-28);
 *  - each rule key the MBR binds (parameters and time constraints with a `marketRule`) is resolved in its own table
 *    (`kernel.*` or the edition's); a decimal key compared SMALLER_STRICTER is a maximum (HIGH), LARGER_STRICTER a
 *    minimum (LOW), and becomes a LIMIT minimum with its governing markets and table version;
 *  - anything else (an unknown or foreign key, a key no market in the set governs, a key that is not a decimal
 *    limit, any resolution error) is UNRESOLVED with the engine's own reason.
 * A request the port was not pre-loaded for (another market set, date or key) is answered UNRESOLVED too.
 */
import type pg from 'pg';
import { market } from '@ebmr/kernel';
import type { flow, validator } from '@ebmr/recipe-core/pure';
import { marketMinimaPortFrom, unresolved } from './minima-port.ts';

type Db = pg.Pool | pg.PoolClient;

const EDITION_TABLE: Readonly<Record<flow.Edition, market.RuleTableCode>> = { tablets: 'tablets', injectables: 'sterile' };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves every minimum the request needs (async, in the database). */
export async function resolveMinima(db: Db, request: validator.MinimaRequest): Promise<validator.ResolvedMinimum[]> {
  const out: validator.ResolvedMinimum[] = [];
  const editionTable = EDITION_TABLE[request.edition];
  const tables = new Map<string, market.TableVersionInfo | null>();
  const tableProblem = new Map<string, string>();
  const loadTable = async (code: market.RuleTableCode): Promise<market.TableVersionInfo | null> => {
    if (tables.has(code)) return tables.get(code) ?? null;
    let info: market.TableVersionInfo | null;
    try {
      info = await market.currentRuleTableVersion(db, code);
      if (!info) tableProblem.set(code, `the ${code} rule table is not published on this installation, so the content minima of the market set cannot be resolved`);
      else {
        const problems = await market.verifyRuleTableVersion(db, info.id);
        if (problems.length > 0) {
          tableProblem.set(code, `the published ${code} rule table v${info.version} does not verify (${problems.join('; ')})`);
          info = null;
        }
      }
    } catch (error) {
      tableProblem.set(code, `the ${code} rule table could not be read (${messageOf(error)})`);
      info = null;
    }
    tables.set(code, info);
    return info;
  };

  if (!(await loadTable(editionTable))) out.push(unresolved(`${editionTable}.*`, tableProblem.get(editionTable) ?? `the ${editionTable} rule table is not available`));
  if (!request.marketSet.includes('IN')) out.push(unresolved('market-set', 'India (IN) must be in every market set: every batch is made under an Indian licence (INV-28)'));

  for (const key of [...new Set(request.ruleKeys)].sort()) {
    const prefix = key.split('.')[0] ?? '';
    if (prefix !== 'kernel' && prefix !== editionTable) {
      out.push(unresolved(key, `${key} is not a key of the kernel or ${editionTable} rule table, so it cannot bind a ${request.edition} MBR`));
      continue;
    }
    const table = await loadTable(prefix);
    if (!table) {
      out.push(unresolved(key, tableProblem.get(prefix) ?? `the ${prefix} rule table is not available`));
      continue;
    }
    let r: market.Resolution;
    try {
      r = await market.resolveInDatabase(db, table.id, { key, marketSet: [...request.marketSet], predicates: { ...request.predicates }, asOf: request.asOf });
    } catch (error) {
      out.push(unresolved(key, messageOf(error)));
      continue;
    }
    if (!r || !r.applicable) {
      out.push(unresolved(key, `no market in ${request.marketSet.join(', ')} has a value for ${key} on ${request.asOf}`));
      continue;
    }
    if (r.valueType !== 'DECIMAL' || typeof r.value !== 'string' || (r.method !== 'SMALLER_STRICTER' && r.method !== 'LARGER_STRICTER')) {
      out.push(unresolved(key, `${key} is compared ${r.method} over ${r.valueType} values; only a decimal maximum or minimum can bind a parameter or time limit`));
      continue;
    }
    out.push({
      kind: 'LIMIT',
      ruleKey: key,
      bound: r.method === 'SMALLER_STRICTER' ? 'HIGH' : 'LOW',
      value: r.value,
      unit: r.unit,
      governingMarkets: [...r.governingMarkets],
      tableVersion: `${r.tableCode} v${r.tableVersion}`,
    });
  }
  return out;
}

/** Resolves the minima the request needs and returns the synchronous port. */
export async function loadMarketMinimaPort(db: Db, request: validator.MinimaRequest): Promise<{ port: validator.MarketMinimaPort; minima: validator.ResolvedMinimum[] }> {
  const minima = await resolveMinima(db, request);
  return { port: marketMinimaPortFrom(request, minima), minima };
}
