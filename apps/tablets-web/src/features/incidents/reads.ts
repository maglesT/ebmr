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
