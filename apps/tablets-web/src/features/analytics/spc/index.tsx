/**
 * Web feature `analytics-spc` (Phase 6A slice 6A-2, GMP; contract ns/analytics-spc.ts; ADR 0020): the control charts
 * with the capability panel (/analytics/spc) and the deviation rates with their funnel (/analytics/rates). Every screen
 * shows the advisory band. The sandbox has no analytics.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../../app/feature.ts';
import { RatesPage } from './RatesPage.tsx';
import { SpcPage } from './SpcPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/analytics/spc', component: SpcPage }),
    createRoute({ getParentRoute: () => root, path: '/analytics/rates', component: RatesPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'analytics-spc', title: 'Control charts and deviation rates', description: 'Advisory control charts, capability, drift alerts and deviation-rate comparisons for CPV support; never for GMP decisions.', to: '/analytics/spc', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
