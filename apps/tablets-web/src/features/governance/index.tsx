/**
 * Web feature `governance` (Phase 6 slice 6f, builder B, GMP): vendor support grants (DI-08), the India DSC option
 * (IN-10) and the contract giver's read-only access (IN-30). The DSC step of a signature is in the ceremony
 * (features/access/ceremony.tsx and the ui-kit SignatureDialog).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ContractGiverAccessPage, ContractGiverBatchesPage, ContractGiverRecordPage } from './ContractGiverPages.tsx';
import { DscPage } from './DscPage.tsx';
import { SupportGrantsPage } from './SupportGrantsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/governance/support', component: SupportGrantsPage }),
    createRoute({ getParentRoute: () => root, path: '/governance/dsc', component: DscPage }),
    createRoute({ getParentRoute: () => root, path: '/governance/contract-givers', component: ContractGiverAccessPage }),
    createRoute({ getParentRoute: () => root, path: '/contract-giver', component: ContractGiverBatchesPage }),
    createRoute({ getParentRoute: () => root, path: '/contract-giver/$batchId', component: ContractGiverRecordPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'support-grants', title: 'Vendor support grants', description: 'Time-boxed vendor support access, approved by QA and IT; refused and logged outside a grant.', to: '/governance/support', installations: ['GMP'], available: true },
  { id: 'india-dsc', title: 'Digital signature certificates', description: 'The India DSC option: mode, trust anchor (a test CA in v1, not legally valid) and the meanings that need one.', to: '/governance/dsc', installations: ['GMP'], available: true },
  { id: 'contract-givers', title: 'Contract givers', description: 'Read-only access of a contract giver\'s reviewer to the batches of its loan licence; the reviewer\'s own batch list.', to: '/governance/contract-givers', installations: ['GMP'], available: true },
  { id: 'contract-giver-batches', title: 'Batches made for you', description: 'For a contract giver\'s reviewer: the records of the batches made under your loan licence, read-only.', to: '/contract-giver', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
