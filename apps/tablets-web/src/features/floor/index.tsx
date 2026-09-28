/**
 * Web feature `floor` (module C4): the sandbox test-run screens and the shop-floor step screen.
 *
 * Routes: /packages (inbox and import), /packages/$packageId/issue (issue a TEST- batch), /runs, /runs/$runId
 * (overview, record, replay), /runs/$runId/steps/$stepKey (the step screen), /cockpit ("What you can do now").
 * Every route sits in the C0 shell, which shows the TEST, NOT GMP band and watermark on the sandbox (DI-05).
 *
 * The Provider supplies the floor's view of the session (who is signed in, tap per entry). It supplies no port:
 * the ceremony and badge tap come from C1, the scale slot from C5, through app/ports.tsx.
 */
import { createRoute, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { CockpitPage } from './pages/Cockpit.tsx';
import { IssueFormPage } from './pages/IssueForm.tsx';
import { PackagesPage } from './pages/Packages.tsx';
import { RunOverviewPage } from './pages/RunOverview.tsx';
import { RunsPage } from './pages/Runs.tsx';
import { StepScreenPage } from './pages/StepScreen.tsx';
import { FloorSessionProvider } from './session.tsx';

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/packages', component: PackagesPage }),
    createRoute({ getParentRoute: () => root, path: '/packages/$packageId/issue', component: IssueFormPage }),
    createRoute({ getParentRoute: () => root, path: '/runs', component: RunsPage }),
    createRoute({ getParentRoute: () => root, path: '/runs/$runId', component: RunOverviewPage }),
    createRoute({ getParentRoute: () => root, path: '/runs/$runId/steps/$stepKey', component: StepScreenPage }),
    createRoute({ getParentRoute: () => root, path: '/cockpit', component: CockpitPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'packages', title: 'Test-run packages', description: 'Import MBR test packages sent from GMP and issue TEST- batches.', to: '/packages', installations: ['SANDBOX'], available: true },
  { id: 'runs', title: 'Test runs', description: 'Runs, their record and the replay check.', to: '/runs', installations: ['SANDBOX'], available: true },
  { id: 'cockpit', title: 'What you can do now', description: 'The work queue of the room of this terminal.', to: '/cockpit', installations: ['SANDBOX'], available: true },
];

/** The floor's session view for every floor screen (inside BootProvider, so the boot state is there). */
export function Provider({ children }: { children: ReactNode }) {
  return <FloorSessionProvider>{children}</FloorSessionProvider>;
}
