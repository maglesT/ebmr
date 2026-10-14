/**
 * The reads the CAPA screens show, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix).
 */
import { routes } from '@ebmr/api-contract';

export const CAPA_READS: readonly string[] = [routes.capa.register.id, routes.capa.detail.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');
