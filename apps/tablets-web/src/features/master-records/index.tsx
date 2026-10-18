/**
 * Web feature `master-records` (Phase 7 slice 7g-2, decision 0025; GMP): the acts on master records that had no screen.
 * Routes: the life-cycle signatures and market authorisations of a version (/mbr/versions/$versionId/signing) and the
 * labelling specimens (/mbr/specimens). Every rule, state and refusal is the server's; signatures go through C1's
 * ceremony (MBR_TRANSITION, MBR_MARKET_ACT, SPECIMEN_ACT).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { MbrSigningPage } from './MbrSigningPage.tsx';
import { SpecimensPage } from './SpecimensPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/mbr/versions/$versionId/signing', component: MbrSigningPage }),
    createRoute({ getParentRoute: () => root, path: '/mbr/specimens', component: SpecimensPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'labelling-specimens', title: 'Labelling specimens', description: 'The label and printed packaging specimens and their QA approval.', to: '/mbr/specimens', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
