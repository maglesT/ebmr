/**
 * Web feature `analytics-review` (Phase 6A slice 6A-5, GMP; contract ns/analytics-review.ts; draft control PR-61): one
 * record's review priority (/analytics/review-priority/$batchId), and the priority note and band the review queue shows
 * (Priority.tsx, used by the review feature's ReviewQueuePage). Advisory: the priority orders the queue and never skips,
 * narrows or completes a review.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ReviewPriorityPage } from './ReviewPriorityPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/analytics/review-priority/$batchId', component: ReviewPriorityPage })];
}

export const homeTiles: readonly HomeTile[] = [];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
