/**
 * Namespace `analyticsAudit` (Phase 6A slice 6A-4; interfaces slice-6A-0-interfaces.md section 5): audit-trail anomaly
 * flags. GMP only, SESSION, advisory; every route needs ANALYTICS.DI_REVIEW (DI-53). A flag is never an accusation: it
 * shows its rule, its reasons and the audit entries behind them, and the entries carry no old or new values.
 *
 * Slice 6A-4 (additive): each run of the audit-trail methods assesses the whole window again, so the same hit is raised
 * again; the lists show one flag per key (method, rule, subject and the thing it is about; D-6A-4-5) with how often and
 * since when it was raised (`repeats`), and the key's current disposition. `entries` gives the entries of a batch's
 * audit-trail review scope that a flag names, so the review panel can order them first and highlight them (DI-25).
 */
import { z } from 'zod';
import { Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, AnalyticsDrill, DispositionView, FlagSeverity, FlagVerdict, FlagView } from './analytics.ts';

const SiteDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

export const AuditFlagEntryView = z.strictObject({
  eventId: z.string().min(1),
  chainKey: z.string().min(1),
  recordedAt: Instant,
  claimedAt: Instant.nullable(),
  action: z.string().min(1),
  tableName: z.string().min(1).nullable(),
  field: z.string().min(1).nullable(),
  isCorrection: z.boolean(),
  reasonCode: z.string().min(1).nullable(),
  terminal: z.string().min(1).nullable(),
  drill: AnalyticsDrill,
});
export type AuditFlagEntryView = z.infer<typeof AuditFlagEntryView>;

/** How often a flag's key was raised, and since when (one per listed flag). */
export const AuditFlagRepeat = z.strictObject({ flagId: Uuid, raisedCount: z.number().int().positive(), firstRaisedAt: Instant });
export type AuditFlagRepeat = z.infer<typeof AuditFlagRepeat>;

export const AuditFlagsView = z.strictObject({ ...AdvisoryEnvelope, flags: z.array(FlagView), repeats: z.array(AuditFlagRepeat).optional() });
export type AuditFlagsView = z.infer<typeof AuditFlagsView>;

export const AuditFlagDetailView = z.strictObject({
  ...AdvisoryEnvelope,
  flag: FlagView,
  entries: z.array(AuditFlagEntryView),
  dispositions: z.array(DispositionView),
  repeat: AuditFlagRepeat.optional(),
});
export type AuditFlagDetailView = z.infer<typeof AuditFlagDetailView>;

/** An entry of a batch's audit-trail review scope that audit-trail flags name (verdict null: the key is open). */
export const AuditFlaggedEntryView = z.strictObject({
  eventId: z.string().min(1),
  chainKey: z.string().min(1),
  flags: z.array(z.strictObject({ flagId: Uuid, rule: z.string().regex(/^[A-Z][A-Z0-9_]*$/), severity: FlagSeverity, verdict: FlagVerdict.nullable() })).min(1),
});
export type AuditFlaggedEntryView = z.infer<typeof AuditFlaggedEntryView>;

export const AuditFlaggedEntriesView = z.strictObject({ ...AdvisoryEnvelope, batchId: Uuid, entries: z.array(AuditFlaggedEntryView) });
export type AuditFlaggedEntriesView = z.infer<typeof AuditFlaggedEntriesView>;

export const analyticsAudit = {
  flags: defineRoute({
    id: 'analyticsAudit.flags',
    method: 'GET',
    path: '/api/analytics/audit-flags',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'Audit-trail anomaly flags in a period, for data-integrity review only (ANALYTICS.DI_REVIEW; DI-53; advisory)',
    query: z.strictObject({ from: SiteDate.optional(), to: SiteDate.optional() }),
    response: AuditFlagsView,
  }),
  flag: defineRoute({
    id: 'analyticsAudit.flag',
    method: 'GET',
    path: '/api/analytics/audit-flags/:flagId',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'One audit-trail flag with its reasons, its audit entries (no values) and its dispositions (ANALYTICS.DI_REVIEW; DI-53)',
    params: z.strictObject({ flagId: Uuid }),
    response: AuditFlagDetailView,
  }),
  entries: defineRoute({
    id: 'analyticsAudit.entries',
    method: 'GET',
    path: '/api/analytics/audit-flags/batches/:batchId/entries',
    installation: 'GMP',
    auth: 'SESSION',
    mutating: false,
    summary: 'The entries of a batch\'s audit-trail review scope that audit-trail flags name, for the review panel to order first and highlight; it hides none (ANALYTICS.DI_REVIEW; DI-53, DI-25)',
    params: z.strictObject({ batchId: Uuid }),
    response: AuditFlaggedEntriesView,
  }),
} as const;
