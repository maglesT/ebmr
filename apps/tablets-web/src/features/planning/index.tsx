/**
 * Web feature `planning` (Phase 3 slice 6, GMP): open ERP orders, plan a batch from an order, issue it with the
 * GMP_BATCH_ISSUE ceremony (/planning), and the batch list with states (/planning/batches). Phase 4 slice 2c: packaging
 * orders planned from a processing batch (/planning), their list (/planning/packaging) and the bulk issue of one
 * (/planning/packaging/$batchId). Phase 7 slice 7g (WP4): the batch-number register and its acts (/planning/batch-numbers).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BatchesPage } from './BatchesPage.tsx';
import { BatchNumbersPage } from './BatchNumbersPage.tsx';
import { BulkIssuePage } from './BulkIssuePage.tsx';
import { PackagingOrdersPage } from './PackagingOrdersPage.tsx';
import { PlanningPage } from './PlanningPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/planning', component: PlanningPage }),
    createRoute({ getParentRoute: () => root, path: '/planning/batches', component: BatchesPage }),
    createRoute({ getParentRoute: () => root, path: '/planning/batch-numbers', component: BatchNumbersPage }),
    createRoute({ getParentRoute: () => root, path: '/planning/packaging', component: PackagingOrdersPage }),
    createRoute({ getParentRoute: () => root, path: '/planning/packaging/$batchId', component: BulkIssuePage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'planning', title: 'Planning', description: 'Open production orders, plan and issue batches.', to: '/planning', installations: ['GMP'], available: true },
  { id: 'packaging-orders', title: 'Packaging orders', description: 'Packaging orders, their processing batch and the bulk issue.', to: '/planning/packaging', installations: ['GMP'], available: true },
  { id: 'batches', title: 'Batches', description: 'GMP batches of the site and their states.', to: '/planning/batches', installations: ['GMP'], available: true },
  { id: 'batch-numbers', title: 'Batch numbers', description: 'The batch-number register: register, void and recover numbers.', to: '/planning/batch-numbers', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
