/**
 * Web feature `labels` (Phase 6 slice 6c, GMP): packaging line completion and serialisation L3/L4 (contract
 * ns/labels.ts and ns/serialisation.ts; IN-16, IN-31, PR-16, PR-32, PR-34, PR-36, PR-39, PR-42). The label template
 * designer and its approval, the label store, the completion evidence of a packaging order (start, middle and end
 * coding specimens, label specimens, the post-use inspection, line stops, the reconciliation waiver) and the serial
 * lookup with the pools of an order. Every value and gate is the server's: why a template cannot be approved, the
 * coding the record gives, the gap that blocks completion and the release problem are the database's words.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { PackagingCompletionPage } from './PackagingCompletionPage.tsx';
import { BatchPoolsPage, SerialLookupPage } from './SerialisationPages.tsx';
import { StorePage } from './StorePage.tsx';
import { TemplatesPage } from './TemplatesPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/labels/templates', component: TemplatesPage }),
    createRoute({ getParentRoute: () => root, path: '/labels/store', component: StorePage }),
    createRoute({ getParentRoute: () => root, path: '/labels/packaging/$batchId', component: PackagingCompletionPage }),
    createRoute({ getParentRoute: () => root, path: '/serialisation/serials', component: SerialLookupPage }),
    createRoute({ getParentRoute: () => root, path: '/serialisation/batches/$batchId', component: BatchPoolsPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'label-templates', title: 'Label templates', description: 'Design label templates from record fields only and approve them (a second person); an India-domestic label must bind every India particular.', to: '/labels/templates', installations: ['GMP'], available: true },
  { id: 'label-store', title: 'Label store', description: 'Receipts, issues to packaging orders, returns and destructions of printed material, by the label store only.', to: '/labels/store', installations: ['GMP'], available: true },
  { id: 'serial-lookup', title: 'Serial lookup', description: 'Ask the L3 system for a serial: its lot, expiry and status as the record holds them.', to: '/serialisation/serials', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
