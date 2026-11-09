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
 * - quality.startInvestigation and quality.recordFinding (lead decision D4-R5, option A), and with them (slice D4b)
 *   quality.deviationDetail, quality.recordDeviationImpact and quality.recordDeviationClosureBasis: invalidating a result
 *   for a laboratory error and reprocessing need a QA-concluded OOS record, and the database concludes only a record
 *   whose impact is assessed and whose closure basis is recorded (site.conclude_deviation). The web opens these only as
 *   one lot's OOS record from its lot page, until the Deviations product publishes its view (plan section 7, D4-R5).
 * - quality.deviation and the deviation screens (owner report item 2, G2, lead ruling of 7 November 2026): a GMP batch's
 *   exception links a deviation record of this installation (EBMR-EXE-600), and review and release read that record's
 *   state, so QA investigates, concludes and closes it on the deviation screens. Only reclassifying and cancelling a
 *   record stay with the Deviations product; the deviation page hides them when disconnected.
 */
export const DISCONNECTED_ROUTES: Readonly<Record<string, DisconnectedOwner>> = Object.fromEntries(
  [deviationRoutes.reclassifyDeviation, routes.quality.cancelDeviation].map((r) => [r.id, 'Deviations' as const]),
);

/**
 * MEDHANTA slice 2 (owner ruling, 9 November 2026; lead ruling of the same day, subject-scoped; replaces declutter
 * residual D4-R5): where the server has a Deviations link (DEVIATIONS_DATABASE_URL), a batch's deviation is managed in
 * the Deviations product and stored here only as its Deviations number. These routes then refuse a batch deviation
 * (410 DISCONNECTED, "Batch deviations are managed in Deviations; link its number"): a record of kind DEVIATION linked
 * to a batch or an output container, or a link of such a record to one. A lot's OOS record (IN-20), and the OOS and
 * investigation records the lab-error invalidation and reprocessing need, stay local and fully working. The signed acts
 * (QUALITY_ACT DEVIATION_IMPACT_ASSESS, DEVIATION_CONCLUDE, DEVIATION_CLOSE) are refused the same way. Without the link
 * nothing here applies: the batch-only deviation screens of G2 stay (standalone, unchanged).
 */
export const BATCH_DEVIATION_ROUTES_WHEN_LINKED: Readonly<Record<string, DisconnectedOwner>> = Object.fromEntries(
  [
    routes.quality.linkDeviation,
    routes.quality.startInvestigation,
    routes.quality.recordFinding,
    deviationRoutes.deviationDetail,
    deviationRoutes.recordDeviationImpact,
    deviationRoutes.recordDeviationClosureBasis,
  ].map((r) => [r.id, 'Deviations' as const]),
);

/** The signed deviation acts refused for a batch deviation where the server has a Deviations link (slice 2). */
export const DEVIATION_ACTS_WHEN_LINKED: readonly string[] = ['DEVIATION_IMPACT_ASSESS', 'DEVIATION_CONCLUDE', 'DEVIATION_CLOSE'];

/** Routes served only where the server has a Deviations link (slice 2); elsewhere 410 DISCONNECTED. */
export const LINKED_ONLY_ROUTE_IDS: ReadonlySet<string> = new Set([deviationRoutes.deviationNumbers.id, deviationRoutes.linkDeviationNumber.id]);

/** Every route id of a disconnected namespace, and every single disconnected route. */
export const DISCONNECTED_ROUTE_IDS: ReadonlySet<string> = new Set([
  ...DISCONNECTED_NAMESPACES.flatMap((ns) => Object.values(routes[ns] as Record<string, { id: string }>).map((r) => r.id)),
  ...Object.keys(DISCONNECTED_ROUTES),
]);

/** Is this route disconnected (by its route id, `namespace.name`)? */
export function isDisconnectedRoute(routeId: string): boolean {
  return DISCONNECTED_ROUTE_IDS.has(routeId);
}

/** Is this route refused whole because of the Deviations link (`linked`: the server has one)? Only the number routes, without it. */
export function isDisconnectedForDeviationsLink(routeId: string, linked: boolean): boolean {
  return !linked && LINKED_ONLY_ROUTE_IDS.has(routeId);
}
