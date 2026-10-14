/** The reads the integration screens show, read again after an acknowledgment (route ids, so `useRefresh` invalidates each). */
import { routes, type MirrorFreshnessView } from '@ebmr/api-contract';

export const INTEGRATION_READS: readonly string[] = [routes.integrations.adapters.id, routes.integrations.adapter.id, routes.integrations.alarms.id, routes.integrations.mirrors.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** Seconds as the largest whole unit (display only; the value is the server's). */
export function age(seconds: string | null): string {
  if (seconds === null) return 'never';
  const s = BigInt(seconds);
  if (s < 120n) return `${s.toString()} s`;
  if (s < 7200n) return `${(s / 60n).toString()} min`;
  if (s < 172800n) return `${(s / 3600n).toString()} h`;
  return `${(s / 86400n).toString()} days`;
}

/** The freshness of a mirror in words: built-in register, fresh, flagged or stale (blocking). */
export function freshnessText(m: MirrorFreshnessView): string {
  if (m.mode === 'STAND_IN') return 'Built-in register (no bound)';
  const last = m.asOf ? `synchronised ${age(m.ageSeconds)} ago` : 'never synchronised';
  if (!m.stale) return `Fresh: ${last} (bound ${age(m.boundSeconds)})`;
  return m.blocking ? `Stale, blocking: ${last}, more than its bound of ${age(m.boundSeconds)}` : `Old, flagged: ${last}, more than ${age(m.boundSeconds)}`;
}
