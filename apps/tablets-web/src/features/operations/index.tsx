/**
 * Web feature `operations` (Phase 7 slice 7g-4; decision 0025 point 2: developers and pharma professionals operate and
 * test the installation from the web app, never from a terminal). The first-run set-up is shown by the shell before
 * any route (app/App.tsx, when the server's meta says the installation awaits it); the routes here are the operations
 * console and its pages (demo and test data, backups, the background workers, the simulators' test console) and the
 * developers' API reference. Every act is the server's and the database's: a screen never loosens a check, and a
 * refusal is shown in their words (contract ns/operations.ts).
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { ApiReferencePage } from './ApiReferencePage.tsx';
import { BackupsPage } from './BackupsPage.tsx';
import { DemoDataPage } from './DemoDataPage.tsx';
import { OperationsPage } from './OperationsPage.tsx';
import { SimulatorsPage } from './SimulatorsPage.tsx';
import { WorkersPage } from './WorkersPanel.tsx';

export { SetupWizard } from './SetupWizard.tsx';
export { WorkersPanel } from './WorkersPanel.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/operations', component: OperationsPage }),
    createRoute({ getParentRoute: () => root, path: '/operations/demo', component: DemoDataPage }),
    createRoute({ getParentRoute: () => root, path: '/operations/backups', component: BackupsPage }),
    createRoute({ getParentRoute: () => root, path: '/operations/workers', component: WorkersPage }),
    createRoute({ getParentRoute: () => root, path: '/operations/simulators', component: SimulatorsPage }),
    createRoute({ getParentRoute: () => root, path: '/developer/api', component: ApiReferencePage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  {
    id: 'operations',
    title: 'Operations',
    description: 'Run the installation without a terminal: backups, the background workers, and on demo and sandbox installations the demo data, a reset and the simulators.',
    to: '/operations',
    installations: ['GMP', 'SANDBOX'],
    available: true,
  },
  {
    id: 'api-reference',
    title: 'API reference',
    description: 'For developers: every route of the API contract with its request and answer (the OpenAPI document).',
    to: '/developer/api',
    installations: ['GMP', 'SANDBOX'],
    available: true,
  },
];

export function Provider({ children }: { children: ReactNode }) {
  return children;
}
