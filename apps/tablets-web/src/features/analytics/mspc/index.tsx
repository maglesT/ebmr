/**
 * Web feature `analytics-mspc` (Phase 6A slice 6A-3, GMP; contract ns/analytics-mspc.ts; ADR 0020): multivariate
 * monitoring. /analytics/mspc shows the T-squared and Q charts and the scores plot of a product and MBR family against
 * its reference set in force, and the model candidates QA can make the reference set under a change record;
 * /analytics/mspc/batches/:batchId shows a batch's contributions and drills to its batch record. Every screen shows the
 * advisory band. The sandbox has no analytics.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../../app/feature.ts';
import { MspcBatchPage } from './MspcBatchPage.tsx';
import { MspcPage } from './MspcPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/analytics/mspc', component: MspcPage }),
    createRoute({ getParentRoute: () => root, path: '/analytics/mspc/batches/$batchId', component: MspcBatchPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'analytics-mspc', title: 'Multivariate monitoring', description: 'Advisory T-squared and Q charts: batches whose combination of critical values departs from the reference batches; never for GMP decisions.', to: '/analytics/mspc', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
