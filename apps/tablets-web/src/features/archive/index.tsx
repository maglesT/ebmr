/**
 * Web feature `archive` (Phase 4 slice 6b, GMP): batch records as kept, copied and inspected (contract ns/archive.ts;
 * DI-40, DI-41, DI-43, DI-47, IN-08, IN-11, PR-16, PR-59). The batch list, one batch's retention, contingency forms,
 * PDF/A-3 true copy and evidence exports, and the read-only inspection workspace with the export verifier. Every date,
 * state and gate is the server's (the database's); the browser computes none of them.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ArchiveBatchPage } from './ArchiveBatchPage.tsx';
import { ArchivePage } from './ArchivePage.tsx';
import { InspectionPage } from './InspectionPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/archive', component: ArchivePage }),
    createRoute({ getParentRoute: () => root, path: '/archive/inspection', component: InspectionPage }),
    createRoute({ getParentRoute: () => root, path: '/archive/batches/$batchId', component: ArchiveBatchPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'archive', title: 'Archive and retention', description: 'Retention of batch records, contingency paper forms, PDF/A-3 true copies and certified evidence exports.', to: '/archive', installations: ['GMP'], available: true },
  { id: 'inspection', title: 'Inspection workspace', description: 'Certified evidence exports, read-only, with the offline verifier.', to: '/archive/inspection', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
