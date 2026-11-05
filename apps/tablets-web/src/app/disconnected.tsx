/**
 * Declutter slice D2 (docs/build-plan/declutter/plan.md sections 1 and 3): the screens that are not part of Batchwright
 * for now. Where the server refuses the disconnected functions (meta.disconnected: the platform build, or a server
 * started with EBMR_DISCONNECT=1) the home and the links skip these screens and a deep link shows a short page instead.
 * On a standalone server without the switch every screen stays as it was. Tables and records are unchanged.
 */
import { Link, useRouterState } from '@tanstack/react-router';
import { DISCONNECTED_NAMESPACES } from '@ebmr/api-contract';
import { useDisconnectedServer, usePlatformBuild } from './boot.tsx';

/**
 * The screens of each namespace the contract disconnects (packages/api-contract/src/disconnected.ts, plan section 3's one
 * list): the paths whose screens read that namespace. The keys must be exactly the contract's (a [DI-17] test checks), so
 * a namespace disconnected there is mapped here or the test fails. A namespace with no screen maps to none.
 */
export const NAMESPACE_SCREENS: Readonly<Record<string, readonly string[]>> = {
  capa: ['/capa'],
  incidents: ['/incidents'],
  pqr: ['/pqr'],
  recall: ['/recall'],
  genealogy: ['/genealogy'],
  config: ['/config'], // change records, history, review-by-exception rules
  notifications: ['/notifications'],
  qpPackage: ['/qp'], // QP batch packages (owner)
  serialisation: ['/serialisation'],
  controlled: ['/controlled'],
  federation: [],
  support: ['/governance'], // vendor support, digital signature certificates, contract givers
  contractGiver: ['/contract-giver'],
  plantRules: ['/plant-rules', '/rooms', '/reagent-lots'], // the penicillin and beta-lactam check at issue stays
  equipmentData: ['/equipment-records', '/trends'],
  equipmentDisplays: ['/status-board'],
  validation: ['/validation'],
  training: ['/training'],
  dashboards: ['/dashboards'],
  changeImpact: ['/change-impact'],
  analytics: ['/analytics'],
  analyticsConfig: [],
  analyticsAudit: [],
  analyticsReview: [],
  analyticsSpc: [],
  analyticsMspc: [],
  analyticsProfile: [],
};

/**
 * Screens off the platform that only leave the home: their functions stay connected for the screens that keep them (the
 * batch's alarm log on the step and review screens, the values in force), or they are later work with no namespace of
 * their own in the contract's list.
 */
export const WEB_ONLY_OFF_PATHS: readonly string[] = [
  '/mbr/specimens', // labelling specimens: later
  '/release/suspended', // suspension and recall: QMS
  '/archive', // archive and the inspection workspace: later
  '/alarms', // plant alarms (the batch's alarm log stays on the step and review screens): later
  '/area-authorisations', // later
  '/integrations', // later (integration health)
  '/transfers', // later
  '/developer/api', // later (still served for integrators)
  '/market/policies', // later; the values stay in force
  '/qp-register', // later
  '/compendial-rule-sets', // later
  '/plant/configuration', // later
  '/india/product-rules', // shelf-life bases and hazard classes: later (licences and the batch-number register stay)
  '/admin/qualifications', // Qual
  '/admin/us-esig-certification', // core
];

/** Screen paths off the platform (each covers its sub-paths): the contract's namespaces' screens and the web-only ones. */
export const DISCONNECTED_PATHS: readonly string[] = [
  ...DISCONNECTED_NAMESPACES.flatMap((ns) => NAMESPACE_SCREENS[ns] ?? []),
  ...WEB_ONLY_OFF_PATHS,
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
