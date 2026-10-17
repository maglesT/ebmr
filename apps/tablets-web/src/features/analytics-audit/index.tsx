/**
 * Web feature `analytics-audit` (Phase 6A slice 6A-4, GMP; contract ns/analytics-audit.ts; draft controls DI-53,
 * DI-25): the audit-trail anomaly flags for QA data-integrity review (/analytics/audit-flags) and one flag with its
 * reasons, the audit entries behind it and QA's disposition (/analytics/audit-flags/$flagId). The flags are about
 * persons: the server and the database give them only to holders of ANALYTICS.DI_REVIEW. The review panel's highlight
 * of flagged entries (DI-25) is FlaggedEntries.tsx, used by the review feature's audit-trail panel.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AuditFlagPage } from './AuditFlagPage.tsx';
import { AuditFlagsPage } from './AuditFlagsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/analytics/audit-flags', component: AuditFlagsPage }),
    createRoute({ getParentRoute: () => root, path: '/analytics/audit-flags/$flagId', component: AuditFlagPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'analytics-audit', title: 'Audit-trail flags', description: 'Advisory audit-trail patterns for data-integrity review, with the entries behind each; never an automatic finding.',
    to: '/analytics/audit-flags', installations: ['GMP'], available: true,
  },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
