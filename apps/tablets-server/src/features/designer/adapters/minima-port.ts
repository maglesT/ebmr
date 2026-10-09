/**
 * The synchronous MarketMinimaPort over minima resolved beforehand (market-minima.ts). Pure (no database, no
 * kernel), so the simulation worker can rebuild it from plain data. A request other than the pre-loaded one (another
 * market set, predicates, date or rule key) fails closed with UNRESOLVED (decision F12).
 */
import type { validator } from '@ebmr/recipe-core/pure';

export const unresolved = (ruleKey: string, problem: string): validator.ResolvedMinimum => ({ kind: 'UNRESOLVED', ruleKey, problem });

export function requestKey(r: Pick<validator.MinimaRequest, 'edition' | 'marketSet' | 'predicates' | 'asOf'>): string {
  return JSON.stringify([r.edition, [...r.marketSet].sort(), Object.entries(r.predicates).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), r.asOf]);
}

/** A port answering exactly the pre-loaded request; any other request fails closed. */
export function marketMinimaPortFrom(request: validator.MinimaRequest, minima: readonly validator.ResolvedMinimum[]): validator.MarketMinimaPort {
  const loadedFor = requestKey(request);
  const loadedKeys = new Set(request.ruleKeys);
  return {
    minima(req) {
      if (requestKey(req) !== loadedFor) return [unresolved('market-set', 'the content minima were resolved for another market set, predicates or date; validate again')];
      const missing = req.ruleKeys.filter((k) => !loadedKeys.has(k));
      return [...minima, ...missing.map((k) => unresolved(k, `${k} was not resolved before validation; validate again`))];
    },
  };
}
