/**
 * The reads the label and serialisation screens show, read again after every act (route ids, so `useRefresh`
 * invalidates each by its prefix).
 */
import { routes } from '@ebmr/api-contract';

export const LABEL_READS: readonly string[] = [routes.labels.templates.id, routes.labels.template.id, routes.labels.store.id, routes.labels.packaging.id, routes.labels.masterLabelling.id];
export const SERIAL_READS: readonly string[] = [routes.serialisation.batchPools.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');
