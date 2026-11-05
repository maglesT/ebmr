/**
 * Declutter slice D1 (docs/build-plan/declutter/plan.md, owner request of 5 November 2026): the route namespaces that
 * are not part of Batchwright for now. One list, read by the server (bind.ts answers 410 DISCONNECTED) and the web
 * (the home and the menus skip their screens, slice D2). The plugins stay registered and their tables and records
 * stay; only the routes are refused. Each entry names the product it belongs to, or "later" for the owner's keep decision.
 *
 * Owner decisions of 5 November: records and amendments and the formulary stay connected; QP batch packages and the
 * penicillin and beta-lactam rules (plantRules, all of it) are disconnected (later). For plantRules the owner accepted
 * the risk (plan.md): the classifications and facility rules already recorded stay in force and the segregation check
 * at batch issue (recipe-core 1655, PR-27, IN-27) still runs in the database, but no new classification can be recorded
 * until the owner reconnects it. Release,
 * packaging orders, label issuance and reconciliation stay (release needs a finished lot of a packaging batch,
 * EBMR-REL-010).
 *
 * A namespace a kept screen reads stays connected (plan section 1: any read a kept screen needs stays): integrations
 * and transfers (the operator's set-up page), erpShipping (the lot's shipments on the release page) and alarms (the
 * batch's alarm log on the step screen and the batch review, DI-49). D2 takes their own tiles off the home.
 */
import { deviationRoutes } from './ns/deviation.ts';
import { routes, type NamespaceName } from './routes.ts';

export type DisconnectedOwner = 'QMS' | 'Deviations' | 'Logbook' | 'MMS' | 'Qual' | 'analytics' | 'later';

export const DISCONNECTED: Readonly<Partial<Record<NamespaceName, DisconnectedOwner>>> = {
  capa: 'QMS',
  incidents: 'QMS',
  pqr: 'QMS',
  recall: 'QMS',
  genealogy: 'QMS',
  config: 'QMS',
  notifications: 'later',
  qpPackage: 'later',
  serialisation: 'later',
  controlled: 'later',
  federation: 'later',
  support: 'later',
  contractGiver: 'later',
  plantRules: 'later',
  equipmentData: 'Logbook',
  equipmentDisplays: 'Logbook',
  validation: 'Qual',
  training: 'Qual',
  dashboards: 'analytics',
  changeImpact: 'analytics',
  analytics: 'analytics',
  analyticsConfig: 'analytics',
  analyticsAudit: 'analytics',
  analyticsReview: 'analytics',
  analyticsSpc: 'analytics',
  analyticsMspc: 'analytics',
  analyticsProfile: 'analytics',
};

export const DISCONNECTED_NAMESPACES = Object.keys(DISCONNECTED) as readonly NamespaceName[];

/**
 * Declutter slice D4 (plan section 2): single routes disconnected inside a namespace that stays connected (route id →
 * owner). Full deviation records belong to the Deviations product; a batch exception keeps only its `deviation_ref`
 * (recipe-core 0440). The deviation routes live in `quality`, which the kept path uses, so they are listed one by one.
 *
 * Kept connected, because a kept screen or the kept path needs them:
 * - quality.deviations: the record lock page and the release page's market tabs list the batch's deviations.
 * - quality.deviationRelease: the lot page shows the deviations that block release (the release checklist).
 * - quality.raiseDeviation and quality.linkDeviation: the lot page raises and links the OOS record of a failing result
 *   (IN-20), and a review disposition or exception link names a deviation reference that the database checks is a
 *   record of this installation linked to the batch (site.deviation_ref_problem, PR-49).
 */
export const DISCONNECTED_ROUTES: Readonly<Record<string, DisconnectedOwner>> = Object.fromEntries(
  [
    deviationRoutes.deviationDetail,
    deviationRoutes.reclassifyDeviation,
    deviationRoutes.recordDeviationImpact,
    deviationRoutes.recordDeviationClosureBasis,
    routes.quality.deviation,
    routes.quality.startInvestigation,
    routes.quality.recordFinding,
    routes.quality.cancelDeviation,
  ].map((r) => [r.id, 'Deviations' as const]),
);

/** Every route id of a disconnected namespace, and every single disconnected route. */
export const DISCONNECTED_ROUTE_IDS: ReadonlySet<string> = new Set([
  ...DISCONNECTED_NAMESPACES.flatMap((ns) => Object.values(routes[ns] as Record<string, { id: string }>).map((r) => r.id)),
  ...Object.keys(DISCONNECTED_ROUTES),
]);

/** Is this route disconnected (by its route id, `namespace.name`)? */
export function isDisconnectedRoute(routeId: string): boolean {
  return DISCONNECTED_ROUTE_IDS.has(routeId);
}
