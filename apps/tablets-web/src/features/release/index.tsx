/**
 * Web feature `release` (Phase 4 slice 3c, GMP): the release cockpit, manufacturer tab: the release queue of finished
 * lots and one lot's release checklist (G-REL for market IN) with its evidence, the "since review" acknowledgements, the
 * QA acts the release may wait for and the signed manufacturer release or rejection. Slice 4c: the US, EU and India tabs
 * (dispositions, the two-row release, the EU certification intake) and market add and removal of a lot or a batch.
 * Slice 5c: the suspension and recall cockpit (suspended lots; a lot's "After release" tab with the forward trace, the
 * AP's acts per market and the disposal).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { BatchMarketsPage } from './BatchMarketsPage.tsx';
import { LotReleasePage } from './LotReleasePage.tsx';
import { QpReaderPage } from './QpReaderPage.tsx';
import { ReleaseQueuePage } from './ReleaseQueuePage.tsx';
import { SuspendedPage } from './SuspendedPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/release', component: ReleaseQueuePage }),
    createRoute({ getParentRoute: () => root, path: '/release/suspended', component: SuspendedPage }),
    createRoute({ getParentRoute: () => root, path: '/release/$lotId', component: LotReleasePage }),
    createRoute({ getParentRoute: () => root, path: '/release/batches/$batchId', component: BatchMarketsPage }),
    createRoute({ getParentRoute: () => root, path: '/qp', component: QpReaderPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'qp', title: 'QP batch packages', description: 'The EU QP\'s read-only view of the issued packages of one lot, while the access lasts.', to: '/qp', installations: ['GMP'], available: true },
  { id: 'release-suspended', title: 'Suspension and recall', description: 'Lots suspended after release, what suspended them, the lots affected downstream, re-confirmation, recall, rejection and disposal.', to: '/release/suspended', installations: ['GMP'], available: true },
  { id: 'release', title: 'Release cockpit', description: 'Finished lots, the release checklist with its evidence, and the manufacturer release.', to: '/release', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
