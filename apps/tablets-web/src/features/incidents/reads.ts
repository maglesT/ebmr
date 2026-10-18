/**
 * The reads the incident screens show, read again after every act, and the words and tones of their codes (display only:
 * every state and rule is the database's).
 */
import { routes, type IncidentSummaryView } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

export const INCIDENT_READS: readonly string[] = [routes.incidents.register.id, routes.incidents.detail.id];

export const SOURCES = ['INTERFACE_FAILURE', 'CONNECTION_LOSS', 'CRASH', 'SIGNATURE_FAILURE', 'TIME_SYNC', 'PRINT_FAILURE', 'INTEGRITY_CHECK', 'SECURITY', 'DATA_INTEGRITY', 'OTHER'] as const;
export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL'] as const;

export function statusTone(s: IncidentSummaryView['status']): StateTone {
  return s === 'CLOSED' ? 'neutral' : s === 'UNDER_INVESTIGATION' ? 'pending' : 'warning';
}

export function severityTone(s: IncidentSummaryView['severity']): StateTone {
  return s === 'CRITICAL' ? 'error' : s === 'MAJOR' ? 'warning' : 'info';
}

/** Words for a code. */
export function words(code: string): string {
  const w = code.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * A claimed time as typed (e.g. 2026-10-18T10:15+05:30) in the form the contract takes: seconds added when left out,
 * null when it is not a date and time with its offset. Only the form changes; whether the time lies between the occurrence
 * and now is the database's check, against its own clock (kernel 0410; the browser's clock decides nothing).
 */
export function claimedTime(typed: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.exec(typed.trim());
  return m ? `${m[1]}${m[2] ?? ':00'}${m[3]}` : null;
}
