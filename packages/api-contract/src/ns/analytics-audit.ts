/**
 * Namespace `analyticsAudit` (Phase 6A slice 6A-4; interfaces slice-6A-0-interfaces.md section 5): audit-trail anomaly
 * flags. GMP only, SESSION, advisory; every route needs ANALYTICS.DI_REVIEW (DI-53). A flag is never an accusation: it
 * shows its rule, its reasons and the audit entries behind them, and the entries carry no old or new values.
 */
import { z } from 'zod';
import { Instant, Uuid } from '../common.ts';
import { defineRoute } from '../route.ts';
import { AdvisoryEnvelope, AnalyticsDrill, DispositionView, FlagView } from './analytics.ts';

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

export const AuditFlagsView = z.strictObject({ ...AdvisoryEnvelope, flags: z.array(FlagView) });
export type AuditFlagsView = z.infer<typeof AuditFlagsView>;

export const AuditFlagDetailView = z.strictObject({
  ...AdvisoryEnvelope,
  flag: FlagView,
  entries: z.array(AuditFlagEntryView),
  dispositions: z.array(DispositionView),
});
export type AuditFlagDetailView = z.infer<typeof AuditFlagDetailView>;

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
} as const;
