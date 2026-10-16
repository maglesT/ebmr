/** The reads the configuration screens show, read again after every act (route ids, so `useRefresh` invalidates each by its prefix). */
import { routes } from '@ebmr/api-contract';

export const CONFIG_READS: readonly string[] = [routes.config.changeRecords.id, routes.config.asOf.id, routes.config.diff.id, routes.config.settings.id, routes.config.rbeRules.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** A configuration value (the database's value columns) as one line of text. */
export const valueText = (v: Record<string, unknown> | null): string =>
  v === null ? '(none)' : Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('; ');

/** A local date-time field (YYYY-MM-DDTHH:MM) with the browser's offset, as the ISO instant the server reads. */
export function isoWithOffset(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return null;
  const d = new Date(`${local}:00`);
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${local}:00${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
