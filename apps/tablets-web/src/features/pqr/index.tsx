/**
 * Web feature `pqr` (Phase 4 slice 6c, GMP): the product quality review extract per product and period (IN-01 (b),
 * PR-58; D-P4-8, D-6-7). QA, the head of QC or the AP runs the extract; the list and the extract show its query version,
 * SHA-256, the reconciliation to the batch number, deviation and change registers, whether it still reproduces, every
 * batch (export-only SKUs and failed batches marked, market removals listed), the deviations with CAPA as recorded and
 * the change records; the AP signs it off. Every value and gate is the server's; the browser computes none of them.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { PqrExtractPage } from './PqrExtractPage.tsx';
import { PqrExtractsPage } from './PqrExtractsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/pqr', component: PqrExtractsPage }),
    createRoute({ getParentRoute: () => root, path: '/pqr/$extractId', component: PqrExtractPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'pqr', title: 'Product quality review', description: 'Run the PQR extract of a product and period, reconciled to the registers, and the authorised person\'s sign-off.', to: '/pqr', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
