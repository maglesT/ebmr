/**
 * Web feature `release` (Phase 4 slice 3c, GMP): the release cockpit, manufacturer tab: the release queue of finished
 * lots and one lot's release checklist (G-REL for market IN) with its evidence, the "since review" acknowledgements, the
 * QA acts the release may wait for and the signed manufacturer release or rejection. Slice 4c: the US, EU and India tabs
 * (dispositions, the two-row release, the EU certification intake) and market add and removal of a lot or a batch.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BatchMarketsPage } from './BatchMarketsPage.tsx';
import { LotReleasePage } from './LotReleasePage.tsx';
import { ReleaseQueuePage } from './ReleaseQueuePage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/release', component: ReleaseQueuePage }),
    createRoute({ getParentRoute: () => root, path: '/release/$lotId', component: LotReleasePage }),
    createRoute({ getParentRoute: () => root, path: '/release/batches/$batchId', component: BatchMarketsPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'release', title: 'Release cockpit', description: 'Finished lots, the release checklist with its evidence, and the manufacturer release.', to: '/release', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
