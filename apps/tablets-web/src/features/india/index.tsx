/**
 * Web feature `india` (Phase 4 slice 6a, GMP): licences and export permissions (IN-30, D-6-1, D-6-2), the batch-number
 * allocation register (IN-18), and a batch's India-domestic label particulars with its Schedule H2 payload stub (IN-31,
 * PR-43, D-P4-14). Every state, gate and meaning is the server's; the browser computes none of them.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AllocationRegisterPage } from './AllocationRegisterPage.tsx';
import { BatchLabelPage } from './BatchLabelPage.tsx';
import { LicencesPage } from './LicencesPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/india', component: LicencesPage }),
    createRoute({ getParentRoute: () => root, path: '/india/register', component: AllocationRegisterPage }),
    createRoute({ getParentRoute: () => root, path: '/india/batches/$batchId', component: BatchLabelPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'india',
    title: 'Licences and export permissions',
    description: 'Manufacturing and loan licences, export permissions, and what the issue gate says for a product.',
    to: '/india',
    installations: ['GMP'],
    available: true,
  },
  {
    id: 'india-register',
    title: 'Batch-number register',
    description: 'Every allocated batch number with its date, product, batch size and use, voided numbers included.',
    to: '/india/register',
    installations: ['GMP'],
    available: true,
  },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
