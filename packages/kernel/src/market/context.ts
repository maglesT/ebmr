/**
 * The ResolutionContextProvider port (build outline 3.3.2; ADR 0008 decision 6; L-59).
 *
 * The kernel knows rules; the editions know lines, rooms, equipment, lots and qualifications. An
 * edition implements this port so the kernel can ask "which markets and predicates apply to this
 * scope?" without importing anything from the edition. For Phase 1, StubResolutionContext answers
 * from the market.stub_* tables through market.scope_markets.
 *
 * Scope rules every implementation must honour:
 *  - PRODUCT (a batch) and PACK: the batch's market set; a PACK resolves PER_DESTINATION keys for its
 *    own destination only;
 *  - SITE: the site's markets plus those of every product qualified there;
 *  - LINE, ROOM, EQUIPMENT: the union of the markets of every product qualified there, and for
 *    sterile rules a PIC/S-member destination counts as EU; PERSON: the union over the lines and
 *    rooms the person is qualified for;
 *  - MATERIAL_LOT: the consuming batch's market set, resolved at each consumption;
 *  - India is always in the set (INV-28).
 */
import { MarketRuleError } from './errors.ts';
import type { Queryable, ScopeRef } from './repository.ts';
import { resolve } from './resolve.ts';
import type { Market, Predicates, Resolution, RuleTableCode, RuleTableSnapshot, StatedMethod } from './types.ts';

export interface MarketDerivation {
  source: string;
  markets?: Market[];
  [detail: string]: unknown;
}

export interface ScopeContext {
  scope: ScopeRef;
  markets: Market[];
  /** Why each market is in the set (stored with every evaluation). */
  derivation: MarketDerivation[];
  predicates: Predicates;
  siteId: string | null;
  edition: 'tablets' | 'injectables' | null;
  /** PACK scope: the pack's destination (used by PER_DESTINATION keys). */
  destination: Market | null;
}

export interface ResolutionContextProvider {
  /** Markets, predicates and site of a scope, for rules of the given table. */
  scopeContext(scope: ScopeRef, table: RuleTableCode): Promise<ScopeContext>;
}

/** The same port under the name used in the Phase 1 brief. */
export type ResolutionContext = ResolutionContextProvider;

/** Phase 1 provider backed by the market.stub_* tables. */
export class StubResolutionContext implements ResolutionContextProvider {
  constructor(private readonly db: Queryable) {}

  async scopeContext(scope: ScopeRef, table: RuleTableCode): Promise<ScopeContext> {
    try {
      const { rows } = await this.db.query<{ s: Record<string, unknown> }>('select market.scope_markets($1, $2, $3, $4) as s', [
        scope.kind,
        scope.id,
        table,
        scope.consumingBatchId ?? null,
      ]);
      const s = rows[0]?.s ?? {};
      return {
        scope,
        markets: s['markets'] as Market[],
        derivation: s['derivation'] as MarketDerivation[],
        predicates: s['predicates'] as Predicates,
        siteId: (s['siteId'] as string | null) ?? null,
        edition: (s['edition'] as ScopeContext['edition']) ?? null,
        destination: (s['destination'] as Market | null) ?? null,
      };
    } catch (error) {
      const message = (error as Error).message;
      const code = /^(EBMR-[A-Z]+-[0-9]{3})\s/.exec(message)?.[1];
      if (code) throw new MarketRuleError(code, message.slice(code.length + 1));
      throw error;
    }
  }
}

/**
 * Resolve a key for a scope with any provider and the pure engine (no storage). A PACK scope
 * resolves a PER_DESTINATION key for its own destination: a stated destination that differs is
 * refused (EBMR-MKT-057), as market.evaluate_stub_scope does.
 */
export async function resolveForScope(
  provider: ResolutionContextProvider,
  table: RuleTableSnapshot,
  key: string,
  scope: ScopeRef,
  asOf: string,
  options: { predicates?: Predicates; stated?: StatedMethod } = {},
): Promise<{ context: ScopeContext; resolution: Resolution }> {
  const context = await provider.scopeContext(scope, table.tableCode);
  if (options.stated && context.destination && options.stated.destination && options.stated.destination !== context.destination) {
    throw new MarketRuleError(
      'EBMR-MKT-057',
      `pack ${scope.id} goes to ${context.destination}; its label rules are resolved for that destination, not for ${options.stated.destination}`,
    );
  }
  const stated = options.stated && context.destination ? { ...options.stated, destination: context.destination } : options.stated;
  const resolution = resolve(table, { key, marketSet: context.markets, predicates: { ...options.predicates, ...context.predicates }, asOf, stated: stated ?? null });
  return { context, resolution };
}
