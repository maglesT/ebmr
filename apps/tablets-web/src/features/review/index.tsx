/**
 * Web feature `review` (Phase 4 slice 1c, GMP): the review queue, the review of one batch record (production approval,
 * the audit-trail review with its high-water mark and delta review, the QA review, the reopen), its exception register
 * (keyboard "next item", item detail, per-item and grouped dispositions) and its output containers (close, the second
 * person's check of a typed net, sort, reject and QA's release with the reason a release is refused).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BatchReviewPage } from './BatchReviewPage.tsx';
import { ContainersPage } from './ContainersPage.tsx';
import { RegisterPage } from './RegisterPage.tsx';
import { ReviewQueuePage } from './ReviewQueuePage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/review', component: ReviewQueuePage }),
    createRoute({ getParentRoute: () => root, path: '/review/$batchId', component: BatchReviewPage }),
    createRoute({ getParentRoute: () => root, path: '/review/$batchId/register', component: RegisterPage }),
    createRoute({ getParentRoute: () => root, path: '/review/$batchId/containers', component: ContainersPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'review', title: 'Batch record review', description: 'Production approval, exception register, audit-trail and QA review, output containers.', to: '/review', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
