/**
 * Web feature `integrations` (Phase 6 slice 6a, builder A; GMP; DI-31, DI-20): the integration health page (per adapter:
 * last message, data age, open alarms, last reconciliation; the mirrors with their age and bound) and one adapter's
 * messages, refusals and reconciliation reports. A person acknowledges an integration alarm with a note (FRESH_ON_SHARED:
 * a fresh badge tap on a shared terminal). Every value is the database's (contract ns/integrations.ts, kernel 1180).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { AdapterPage } from './AdapterPage.tsx';
import { IntegrationsPage } from './IntegrationsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/integrations', component: IntegrationsPage }),
    createRoute({ getParentRoute: () => root, path: '/integrations/$adapterCode', component: AdapterPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'integrations', title: 'Integration health', description: 'ERP/WMS, QMS, LIMS, LMS and CMMS adapters: last message, data age, open alarms, reconciliation, and how old each mirror is.', to: '/integrations', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
