/**
 * Web feature `transfers` (Phase 6 slice 6i, GMP; L-41, DI-31, DI-39): inter-site transfer packages (this installation
 * and its peers, packages sent and received, local QA's decision on a received lot, the alarms). The federated genealogy
 * is shown by the genealogy explorer and the mock-recall cockpit (feature genealogy).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ReceiptPage, TransfersPage } from './TransfersPages.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/transfers', component: TransfersPage }),
    createRoute({ getParentRoute: () => root, path: '/transfers/receipts/$receiptId', component: ReceiptPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'transfers', title: 'Inter-site transfers', description: 'Sealed lot-transfer packages to and from the other site installations; received lots wait for local QA.', to: '/transfers', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
