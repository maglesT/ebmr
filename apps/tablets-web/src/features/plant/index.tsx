/**
 * Web feature `plant` (Phase 3 slice 6, GMP; on the sandbox too since slice 7o, D-7o-1): cleaning start, complete and
 * verify; clearance; equipment events.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { PlantPage } from './PlantPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [createRoute({ getParentRoute: () => root, path: '/plant', component: PlantPage })];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'plant', title: 'Plant', description: 'Cleaning, line clearance, equipment logbook and their verification.', to: '/plant', installations: ['GMP', 'SANDBOX'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
