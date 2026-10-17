/**
 * The audit-trail review panel's aid (slice 6A-4; DI-25, DI-53; D-6A-4-9): for a data-integrity reviewer, the entries
 * of the batch's review scope that audit-trail flags name are listed first and highlighted. Every entry is still listed,
 * in the server's order otherwise, and the review itself (its scope, mark, report hash and signature) is unchanged: the
 * ordering is display only, and nothing in the review reads a flag. Other persons see the panel as before, because
 * the flags are about persons and restricted to ANALYTICS.DI_REVIEW (the server refuses the read for anyone else).
 */
import { routes, type AuditFlaggedEntryView } from '@ebmr/api-contract';
import { useApiQuery } from '../../api/hooks.ts';
import { useSessionRole } from '../../app/roles.ts';
import { offeredDiReview, ruleLabel } from './shared.ts';

/** The flagged entries of the batch (empty for a person who is not a data-integrity reviewer, or when none). */
export function useFlaggedEntries(batchId: string): ReadonlyMap<string, AuditFlaggedEntryView> {
  const reviewer = offeredDiReview(useSessionRole());
  const q = useApiQuery(routes.analyticsAudit.entries, { params: { batchId } }, { enabled: reviewer, retry: false });
  return new Map((reviewer && q.data ? q.data.entries : []).map((e) => [`${e.chainKey}#${e.eventId}`, e]));
}

/** The events with the flagged ones first (each group in its given order); nothing is left out. */
export function flaggedFirst<E extends { eventId: string; chainKey: string }>(events: readonly E[], flagged: ReadonlyMap<string, unknown>): E[] {
  const isFlagged = (e: E): boolean => flagged.has(`${e.chainKey}#${e.eventId}`);
  return [...events.filter(isFlagged), ...events.filter((e) => !isFlagged(e))];
}

/** What a flagged entry's line says (advisory). */
export function flagNote(entry: AuditFlaggedEntryView): string {
  return `Audit-trail flag (advisory): ${entry.flags.map((f) => `${ruleLabel(f.rule)}${f.verdict ? `, ${f.verdict === 'FALSE_ALARM' ? 'false alarm' : f.verdict === 'TRUE_SIGNAL' ? 'real issue' : 'not assessable'}` : ', open'}`).join('; ')}`;
}
