/**
 * Web feature `dashboards` (Phase 6 slice 6g, GMP): the dashboards over the report views (outline 7.3: never used for
 * GMP decisions; each tile shows its data age and drills to the record) and the change-impact explorer. Read-only.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ChangeImpactPage } from './ChangeImpactPage.tsx';
import { DashboardsPage } from './DashboardsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/dashboards', component: DashboardsPage }),
    createRoute({ getParentRoute: () => root, path: '/change-impact', component: ChangeImpactPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'dashboards', title: 'Dashboards', description: 'Right first time, exceptions, review cycle time, deviation ageing, hold times, overdue reviews, press OEE and alarm trends; for information, never for GMP decisions.', to: '/dashboards', installations: ['GMP'], available: true },
  { id: 'change-impact', title: 'Change impact', description: 'What a proposed change to a material, specification, equipment, MBR version, site value or supplier would reach; exportable for the change record.', to: '/change-impact', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
