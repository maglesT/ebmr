/**
 * The reads the market, plant and compendial configuration screens show, read again after every act (route ids, so
 * `useRefresh` invalidates each by prefix).
 */
import { routes } from '@ebmr/api-contract';

export const MARKET_READS: readonly string[] = [
  routes.marketConfig.policies.id,
  routes.marketConfig.batchPolicies.id,
  routes.marketConfig.siteValues.id,
  routes.marketConfig.previewSiteValue.id,
  routes.esig.signatures.id,
];

export const QP_READS: readonly string[] = [routes.marketConfig.qpRegister.id];
export const RULE_SET_READS: readonly string[] = [routes.marketConfig.ruleSets.id];
export const PLANT_READS: readonly string[] = [routes.marketConfig.plantConfig.id];

/** Words for a code. */
export function words(code: string): string {
  const w = code.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
