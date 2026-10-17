/**
 * Web feature `analytics` (Phase 6A slice 6A-1, GMP; contract ns/analytics.ts and ns/analytics-config.ts; ADR 0020):
 * the overview (/analytics), the methods with their versions, change records and monitoring (/analytics/methods) and
 * the flags with QA's disposition (/analytics/flags). Every screen shows the advisory band. The sandbox has no analytics.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AnalyticsPage } from './AnalyticsPage.tsx';
import { FlagsPage } from './FlagsPage.tsx';
import { MethodsPage } from './MethodsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/analytics', component: AnalyticsPage }),
    createRoute({ getParentRoute: () => root, path: '/analytics/methods', component: MethodsPage }),
    createRoute({ getParentRoute: () => root, path: '/analytics/flags', component: FlagsPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'analytics', title: 'Analytics', description: 'Advisory trends and flags for QA attention, with the methods in force and their monitoring; never for GMP decisions.', to: '/analytics', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
