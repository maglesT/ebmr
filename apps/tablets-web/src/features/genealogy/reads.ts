/**
 * The reads the genealogy and recall screens show (route ids, so `useRefresh` invalidates each by its prefix), and the
 * small display helpers they share. Display only: every value is the server's.
 */
import { routes, type GenealogyNodeView } from '@ebmr/api-contract';

export const RECALL_READS: readonly string[] = [routes.recall.mockRecalls.id, routes.recall.mockRecall.id];

/** A server code as words (display only). */
export const words = (code: string): string => code.charAt(0) + code.slice(1).toLowerCase().replaceAll('_', ' ');

/** A node as one line: its label, then what it is. */
export const nodeLine = (n: GenealogyNodeView): string =>
  [n.label, n.subKind ? words(n.subKind) : words(n.kind), n.code, n.name, n.state ? words(n.state) : null].filter((p) => p !== null && p !== '').join(' · ');

/** One CSV field, quoted when it holds a comma, a quote or a line break (RFC 4180). */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** A CSV document (header first) as a data: URL for a download link; the values are the server's text as shown. */
export function csvHref(rows: readonly (readonly string[])[]): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n')}`;
}
