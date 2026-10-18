/**
 * Web feature `incidents` (Phase 7 slice 7g-2, decision 0025; GMP): the incident register (/incidents) and one incident
 * with its investigation, impact assessments, CERT-In step and closure (/incidents/$incidentId); DI-12, kernel 0410.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { IncidentPage } from './IncidentPage.tsx';
import { IncidentsPage } from './IncidentsPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/incidents', component: IncidentsPage }),
    createRoute({ getParentRoute: () => root, path: '/incidents/$incidentId', component: IncidentPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'incidents', title: 'Incident register', description: 'Incidents, their investigation and impact on records, and the CERT-In reporting step.', to: '/incidents', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
