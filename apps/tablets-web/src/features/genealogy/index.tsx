/**
 * Web feature `genealogy` (Phase 6 slice 6d, GMP; PR-57, IN-07, IN-29, PR-50, PR-49): the genealogy explorer (tree and
 * table both ways, node-kind filter, as-of instant, CSV export), the complaint lookup, the API supply-chain report of a
 * finished lot, the deviation impact query and the mock-recall cockpit with the authorised person's sign-off. The
 * recurrence warning (PR-49) is shown on the release (certification) screen (RecurrenceWarning.tsx). Read-only except the
 * mock recall's run and sign-off; every value and gate is the server's.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { GenealogyExplorerPage } from './GenealogyExplorerPage.tsx';
import { ComplaintLookupPage, DeviationImpactPage, SupplyChainPage } from './LookupPages.tsx';
import { MockRecallPage, MockRecallsPage } from './MockRecallPages.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/genealogy', component: GenealogyExplorerPage }),
    createRoute({ getParentRoute: () => root, path: '/genealogy/lookup', component: ComplaintLookupPage }),
    createRoute({ getParentRoute: () => root, path: '/genealogy/lots/$lotId/supply-chain', component: SupplyChainPage }),
    createRoute({ getParentRoute: () => root, path: '/genealogy/deviations/$deviationId/impact', component: DeviationImpactPage }),
    createRoute({ getParentRoute: () => root, path: '/recall', component: MockRecallsPage }),
    createRoute({ getParentRoute: () => root, path: '/recall/$mockRecallId', component: MockRecallPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'genealogy', title: 'Genealogy explorer', description: 'Where a lot, batch, container or shipment came from or went, at any depth, as of an instant; tree, table and export.', to: '/genealogy', installations: ['GMP'], available: true },
  { id: 'genealogy-lookup', title: 'Complaint lookup', description: 'From a lot, batch or shipment number to the lot, its records, deviations, shipments and genealogy.', to: '/genealogy/lookup', installations: ['GMP'], available: true },
  { id: 'recall', title: 'Mock recalls', description: 'Run a mock recall from a lot or a deviation: affected lots, consignees, delivered against returned; the authorised person signs it off.', to: '/recall', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
