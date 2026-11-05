/**
 * Declutter slice D1 (docs/build-plan/declutter/plan.md, owner request of 5 November 2026): the route namespaces that
 * are not part of Batchwright for now. One list, read by the server (bind.ts answers 410 DISCONNECTED) and the web
 * (the home and the menus skip their screens, slice D2). The plugins stay registered and their tables and records
 * stay; only the routes are refused. Each entry names the product it belongs to, or "later" for the owner's keep decision.
 *
 * Owner decisions of 5 November: records and amendments and the formulary stay connected; QP batch packages and the
 * penicillin and beta-lactam rules screen are disconnected (later). The beta-lactam check at batch issue runs in the
 * database (recipe-core 1655, PR-27), not through these routes, so it and the rule data stay in force. Release,
 * packaging orders, label issuance and reconciliation stay (release needs a finished lot of a packaging batch,
 * EBMR-REL-010).
 *
 * A namespace a kept screen reads stays connected (plan section 1: any read a kept screen needs stays): integrations
 * and transfers (the operator's set-up page), erpShipping (the lot's shipments on the release page) and alarms (the
 * batch's alarm log on the step screen and the batch review, DI-49). D2 takes their own tiles off the home.
 */
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

/** Every route id of a disconnected namespace. */
export const DISCONNECTED_ROUTE_IDS: ReadonlySet<string> = new Set(
  DISCONNECTED_NAMESPACES.flatMap((ns) => Object.values(routes[ns] as Record<string, { id: string }>).map((r) => r.id)),
);

/** Is this route disconnected (by its route id, `namespace.name`)? */
export function isDisconnectedRoute(routeId: string): boolean {
  return DISCONNECTED_ROUTE_IDS.has(routeId);
}
