/**
 * The reads the PQR screens show, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix).
 */
import { routes } from '@ebmr/api-contract';

export const PQR_READS: readonly string[] = [routes.pqr.extracts.id, routes.pqr.extract.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');
