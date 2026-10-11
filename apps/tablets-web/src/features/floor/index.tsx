/**
 * Web feature `floor` (module C4): the sandbox test-run screens and the shop-floor step screen.
 *
 * Routes: /packages and /test-packages (inbox and import; ?package=<hash> highlights one),
 * /packages/$packageId/issue (issue a TEST- batch), /runs, /runs/$runId (overview, record, replay),
 * /runs/$runId/steps/$stepKey (the step screen), /cockpit ("What you can do now").
 * Every route sits in the C0 shell, which shows the TEST, NOT GMP band and watermark on the sandbox (DI-05).
 *
 * The Provider supplies the floor's view of the session (who is signed in, tap per entry). It supplies no port:
 * the ceremony and badge tap come from C1, the scale slot from C5, through app/ports.tsx.
 */
import { createRoute, notFound, type AnyRootRoute, type AnyRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { HomeTile } from '../../app/feature.ts';
import { CockpitPage } from './pages/Cockpit.tsx';
import { IssueFormPage } from './pages/IssueForm.tsx';
import { PackagesPage } from './pages/Packages.tsx';
import { RunOverviewPage } from './pages/RunOverview.tsx';
import { RunsPage } from './pages/Runs.tsx';
import { StepScreenPage } from './pages/StepScreen.tsx';
import { RefreshReadsAfterUnlock } from './queries.ts';
import { FloorSessionProvider } from './session.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can be a run id (a UUID, as the contract requires). */
export function isRunId(id: string): boolean {
  return UUID.test(id);
}

/**
 * Whether `key` is a step key in the engine's own form, `<step>@<construct>=<index>/...`, read as the server reads it
 * and written back unchanged (the server answers 404 for any other: execution/views.ts, F65).
 */
export function isStepKey(key: string): boolean {
  const at = key.indexOf('@');
  if (at <= 0) return false;
  const frames: string[] = [];
  let rest = key.slice(at + 1);
  while (rest.length > 0) {
    const m = /^([^=]+)=(0|[1-9][0-9]{0,8})(?:\/(.*))?$/s.exec(rest);
    if (!m) return false;
    frames.push(`${m[1] ?? ''}=${m[2] ?? ''}`);
    rest = m[3] ?? '';
  }
  return `${key.slice(0, at)}@${frames.join('/')}` === key;
}

/**
 * A floor address that names no run or step, such as a link copied with a sentence's full stop ("/runs/<id>." or
 * ".../steps/p-disp-clear@."), is the not-found page, which offers the address without the punctuation; the server is
 * asked nothing about it (review F65; before, a run link got a refusal no reload could fix and a step link a step
 * screen for a key no step can have).
 */
const onlyIf =
  (names: (params: Record<string, string>) => boolean) =>
  ({ params }: { params: Record<string, string> }): void => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the router's notFound() is thrown by design: the router then shows the not-found page.
    if (!names(params)) throw notFound();
  };
const runParams = onlyIf((p) => isRunId(p['runId'] ?? ''));
const stepParams = onlyIf((p) => isRunId(p['runId'] ?? '') && isStepKey(p['stepKey'] ?? ''));

export function routes(root: AnyRootRoute): AnyRoute[] {
  return [
    createRoute({ getParentRoute: () => root, path: '/packages', component: PackagesPage }),
    // The GMP designer links here after an export: /test-packages?package=<packageHash> (same inbox).
    createRoute({ getParentRoute: () => root, path: '/test-packages', component: PackagesPage }),
    createRoute({ getParentRoute: () => root, path: '/packages/$packageId/issue', component: IssueFormPage }),
    createRoute({ getParentRoute: () => root, path: '/runs', component: RunsPage }),
    createRoute({ getParentRoute: () => root, path: '/runs/$runId', beforeLoad: runParams, component: RunOverviewPage }),
    createRoute({ getParentRoute: () => root, path: '/runs/$runId/steps/$stepKey', beforeLoad: stepParams, component: StepScreenPage }),
    createRoute({ getParentRoute: () => root, path: '/cockpit', component: CockpitPage }),
  ];
}

export const homeTiles: readonly HomeTile[] = [
  { id: 'packages', title: 'Test-run packages', description: 'Import MBR test packages sent from GMP and issue TEST- batches.', to: '/packages', installations: ['SANDBOX'], available: true },
  { id: 'runs', title: 'Test runs', description: 'Runs, their record and the replay check.', to: '/runs', installations: ['SANDBOX'], available: true },
  // Phase 3 slice 6 (D-S6-1): on GMP the same screens show the GMP batches, read from /api/batches.
  { id: 'gmp-runs', title: 'Shop floor', description: 'GMP batches: the batch overview and the step screens.', to: '/runs', installations: ['GMP'], available: true },
  { id: 'cockpit', title: 'What you can do now', description: 'The work queue of the room of this terminal.', to: '/cockpit', installations: ['SANDBOX'], available: true },
];

/**
 * The floor's session view for every floor screen (inside BootProvider, so the boot state is there), and the
 * reload of the floor's reads after an unlock.
 */
export function Provider({ children }: { children: ReactNode }) {
  return (
    <FloorSessionProvider>
      <RefreshReadsAfterUnlock />
      {children}
    </FloorSessionProvider>
  );
}
