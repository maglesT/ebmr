/**
 * The reads the archive screens show, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix), and two display helpers.
 */
import { routes } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

export const ARCHIVE_READS: readonly string[] = [routes.archive.batches.id, routes.archive.batch.id, routes.archive.inspection.id];

/** Words of an enum value: "FINALLY_REJECTED" -> "Finally rejected". */
export function words(s: string): string {
  const w = s.toLowerCase().replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function formTone(state: string): StateTone {
  return state === 'VERIFIED' || state === 'VOIDED' || state === 'SIGNED' || state === 'NONE' ? 'ok' : state === 'MISSING' || state === 'OPEN' ? 'warning' : 'neutral';
}

/** Saves a file the server sent (base64 or text) through a temporary link. */
export function saveFile(name: string, data: { base64: string; type: string } | { text: string; type: string }): void {
  const blob =
    'base64' in data
      ? new Blob([Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))], { type: data.type })
      : new Blob([data.text], { type: data.type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
