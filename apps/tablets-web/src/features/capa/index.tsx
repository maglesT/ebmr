/**
 * Web feature `capa` (Phase 6 slice 6a, builder B, GMP): the CAPA register and one CAPA (IN-01 (d), PR-51; D-P6a-6).
 * QA raises a CAPA from its source with an owner, a due date and an effectiveness check, links deviations and the
 * master version it waits for, records the implementation and the check's result, and another QA person closes it
 * through the ceremony (CAPA_ACT). With a QMS integrated the register shows the QMS's CAPAs with their version tokens and
 * offers no act. Every value and gate is the server's: the overdue flags, the checks' due dates and why a CAPA cannot
 * close are the database's.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { CapaDetailPage } from './CapaDetailPage.tsx';
import { CapaRegisterPage } from './CapaRegisterPage.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/capa', component: CapaRegisterPage }),
    createRoute({ getParentRoute: () => root, path: '/capa/$capaId', component: CapaDetailPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'capa', title: 'CAPA register', description: 'Corrective and preventive actions: owner, due date, effectiveness checks (overdue flagged), links to deviations and the master change they wait for.', to: '/capa', installations: ['GMP'], available: true },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
