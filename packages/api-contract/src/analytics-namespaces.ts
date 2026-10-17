/**
 * The analytics namespaces of Phase 6A (interfaces slice-6A-0-interfaces.md section 5), declared in 6A-0 so every
 * slice builds against them. Each joins the route table (routes.ts, NAMESPACE_OWNERS) in the slice that binds it on
 * the server, because the server's contract coverage requires every route of the table to be served (D-6A-0-4).
 */
import { analytics } from './ns/analytics.ts';
import { analyticsAudit } from './ns/analytics-audit.ts';
import { analyticsMspc } from './ns/analytics-mspc.ts';
import { analyticsProfile } from './ns/analytics-profile.ts';
import { analyticsReview } from './ns/analytics-review.ts';
import { analyticsSpc } from './ns/analytics-spc.ts';

export const ANALYTICS_NAMESPACES = { analytics, analyticsSpc, analyticsMspc, analyticsAudit, analyticsReview, analyticsProfile } as const;
export type AnalyticsNamespaceName = keyof typeof ANALYTICS_NAMESPACES;

/** The slice that binds each namespace on the server (decision 0017 point 3: one owner per contract file). */
export const ANALYTICS_NAMESPACE_SLICES: Readonly<Record<AnalyticsNamespaceName, string>> = {
  analytics: '6A-1',
  analyticsSpc: '6A-2',
  analyticsMspc: '6A-3',
  analyticsAudit: '6A-4',
  analyticsReview: '6A-5',
  analyticsProfile: '6A-6',
};
