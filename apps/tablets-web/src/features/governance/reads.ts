/**
 * The reads the governance screens show, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix).
 */
import { routes } from '@ebmr/api-contract';

export const SUPPORT_READS: readonly string[] = [routes.support.grants.id];
export const DSC_READS: readonly string[] = [routes.esig.dscConfiguration.id];
export const CONTRACT_GIVER_READS: readonly string[] = [routes.contractGiver.accesses.id, routes.contractGiver.batches.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');
