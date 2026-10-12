/**
 * The reads the India screens show, read again after every act (route ids, so `useRefresh` invalidates each by prefix).
 */
import { routes, type LicenceState } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

export const INDIA_READS: readonly string[] = [
  routes.india.licences.id,
  routes.india.exportPermissions.id,
  routes.india.check.id,
  routes.india.allocationRegister.id,
  routes.india.label.id,
  routes.india.shelfLifeBases.id,
  routes.india.hazards.id,
];

/** The chip tone of a licence's or permission's state (display only; whether it counts is the server's `current`). */
export function licenceTone(state: LicenceState, current: boolean): StateTone {
  if (state === 'SUSPENDED') return 'error';
  if (state === 'DRAFT') return 'neutral';
  return current ? 'ok' : 'warning';
}

/** Words for a state code. */
export function words(code: string): string {
  const w = code.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** A local ISO date written as an instant at the start of that day in India (the licence's own date). */
export function dateInstant(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00+05:30` : null;
}
