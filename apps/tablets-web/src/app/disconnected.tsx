/**
 * Declutter slice D2 (docs/build-plan/declutter/plan.md sections 1 and 3): the screens that are not part of Batchwright
 * for now. Where the server refuses the disconnected functions (meta.disconnected: the platform build, or a server
 * started with EBMR_DISCONNECT=1) the home and the links skip these screens and a deep link shows a short page instead.
 * On a standalone server without the switch every screen stays as it was. Tables and records are unchanged.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { useDisconnectedServer, usePlatformBuild } from './boot.tsx';

/** Screen paths off the platform (each covers its sub-paths), by the plan's tile table and the owner's decisions. */
export const DISCONNECTED_PATHS: readonly string[] = [
  '/mbr/specimens', // labelling specimens: later
  '/qp', // QP batch packages: later (owner)
  '/release/suspended', // suspension and recall: QMS
  '/notifications', // later
  '/pqr', // QMS
  '/archive', // archive and the inspection workspace: later
  '/capa', // QMS
  '/incidents', // QMS
  '/serialisation', // later
  '/config', // change records, history, review-by-exception rules: QMS or later
  '/governance', // vendor support, digital signature certificates, contract givers: later
  '/contract-giver', // later
  '/integrations', // later
  '/controlled', // later
  '/alarms', // plant alarms (the batch's alarm log stays on the step and review screens): later
  '/status-board', // Logbook
  '/area-authorisations', // later
  '/trends', // analytics
  '/rooms', // Logbook
  '/reagent-lots', // MMS
  '/equipment-records', // Logbook
  '/genealogy', // QMS (complaints)
  '/recall', // QMS
  '/transfers', // later
  '/dashboards', // analytics
  '/change-impact', // analytics
  '/training', // Qual
  '/analytics', // analytics
  '/plant-rules', // penicillin and beta-lactam rules screen: later (owner); the check at issue stays
  '/developer/api', // later (still served for integrators)
  '/validation', // Qual or later
  '/market/policies', // later; the values stay in force
  '/qp-register', // later
  '/compendial-rule-sets', // later
  '/plant/configuration', // later
  '/india/product-rules', // shelf-life bases and hazard classes: later (licences and the batch-number register stay)
  '/admin/qualifications', // Qual
  '/admin/us-esig-certification', // core
];

/** People, accounts and grants: kept by the platform's core (they answer 410 MANAGED_IN_PLATFORM there). */
export const PLATFORM_MANAGED_PATHS: readonly string[] = [
  '/admin/people', '/admin/grants', '/admin/recertification', '/admin/break-glass', '/admin/role-permissions', '/admin/delegations',
];

const under = (path: string, p: string): boolean => path === p || path.startsWith(`${p}/`);

/** Is the screen at this path off (the server refuses its functions, or the platform's core keeps it)? */
export function screenOff(path: string, disconnected: boolean, platform: boolean): boolean {
  return (disconnected && DISCONNECTED_PATHS.some((p) => under(path, p))) || (platform && PLATFORM_MANAGED_PATHS.some((p) => under(path, p)));
}

/** Whether screens are switched off here: [the server refuses the disconnected functions, this is the platform build]. */
export function useScreensOff(): (path: string) => boolean {
  const disconnected = useDisconnectedServer();
  const platform = usePlatformBuild();
  return (path) => screenOff(path, disconnected, platform);
}

/** The page a deep link to a switched-off screen shows. */
export function NotPartPage() {
  return (
    <section aria-labelledby="not-part-title" data-testid="not-part-of-batchwright">
      <h1 id="not-part-title">Not part of Batchwright</h1>
      <p>This screen is not connected in Batchwright. Its records are kept.</p>
      <p>
        <Link to="/">Home</Link>
      </p>
    </section>
  );
}

/** Wraps the current route: a switched-off screen shows NotPartPage instead. */
export function ScreenGate({ children }: { children: React.ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const off = useScreensOff();
  return off(path) ? <NotPartPage /> : <>{children}</>;
}
