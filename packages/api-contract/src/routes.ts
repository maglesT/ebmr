/**
 * The route table: one nested const object, one namespace per file (Phase 2 apps plan section 4).
 * Frozen by the lead at A0; changed only by the lead, and only additively.
 */
import { access } from './ns/access.ts';
import { archive } from './ns/archive.ts';
import { audit } from './ns/audit.ts';
import { batches } from './ns/batches.ts';
import { containers } from './ns/containers.ts';
import { designer } from './ns/designer.ts';
import { deviceReadings } from './ns/device-readings.ts';
import { devices } from './ns/devices.ts';
import { esig } from './ns/esig.ts';
import { execution } from './ns/execution.ts';
import { masterData } from './ns/master-data.ts';
import { meta } from './ns/meta.ts';
import { planning } from './ns/planning.ts';
import { plant } from './ns/plant.ts';
import { quality } from './ns/quality.ts';
import { notifications } from './ns/notifications.ts';
import { erpShipping, qpPackage } from './ns/qp-shipping.ts';
import { india } from './ns/india.ts';
import { integrations } from './ns/integrations.ts';
import { config } from './ns/config.ts';
import { capa } from './ns/capa.ts';
import { controlled } from './ns/controlled.ts';
import { labels } from './ns/labels.ts';
import { serialisation } from './ns/serialisation.ts';
import { alarms } from './ns/alarms.ts';
import { equipmentData, equipmentDisplays } from './ns/equipment-data.ts';
import { plantRules } from './ns/plant-rules.ts';
import { genealogy } from './ns/genealogy.ts';
import { changeImpact, dashboards, training } from './ns/dashboards.ts';
import { analytics } from './ns/analytics.ts';
import { analyticsConfig } from './ns/analytics-config.ts';
import { analyticsAudit } from './ns/analytics-audit.ts';
import { analyticsReview } from './ns/analytics-review.ts';
import { analyticsSpc } from './ns/analytics-spc.ts';
import { analyticsMspc } from './ns/analytics-mspc.ts';
import { analyticsProfile } from './ns/analytics-profile.ts';
import { recall } from './ns/recall.ts';
import { federation, transfers } from './ns/transfers.ts';
import { records } from './ns/records-lock.ts';
import { pqr } from './ns/pqr.ts';
import { release } from './ns/release.ts';
import { review } from './ns/review.ts';
import { samples } from './ns/samples.ts';
import { session } from './ns/session.ts';
import { specifications } from './ns/specifications.ts';
import { contractGiver, support } from './ns/support.ts';

export const routes = { meta, session, access, esig, audit, designer, execution, devices: { ...devices, ...deviceReadings }, quality, batches, planning, masterData, plant, review, containers, specifications, samples, release, notifications, qpPackage, erpShipping, records, pqr, archive, india, integrations, capa, alarms, equipmentData, equipmentDisplays, plantRules, config, support, contractGiver, controlled, labels, serialisation, genealogy, recall, transfers, federation, dashboards, changeImpact, training, analytics, analyticsConfig, analyticsAudit, analyticsSpc, analyticsMspc, analyticsReview, analyticsProfile } as const;export type Routes = typeof routes;
export type NamespaceName = keyof Routes;

/** Which module owns each namespace's handlers (the stub feature files pass to these owners). */
/** Phase 3 slice 6 (S6): batches over the execution handlers, planning, master data (formulas) and plant. Phase 4 (P4): review. Phase 6 (P6): integrations, capa, alarms, equipmentData, equipmentDisplays (the status displays of
 * slice 6b, appended to ns/equipment-data.ts as their own namespace so each builder's feature binds its own routes), plantRules; labels and serialisation (slice 6c); genealogy, recall, transfers, federation; slice 6g: dashboards, changeImpact, training. Phase 6A (P6A): analytics, bound by slice 6A-1 (D-6A-0-4), and its
 * configuration writes analyticsConfig (D-6A-1-1); the other analytics namespaces join with the slices that bind them (analyticsAudit: 6A-4; analyticsSpc: 6A-2; analyticsReview: 6A-5; analyticsProfile: 6A-6). */
export const NAMESPACE_OWNERS: Readonly<Record<NamespaceName, 'C0' | 'C1' | 'C2' | 'C3' | 'C5' | 'S6' | 'P4' | 'P6' | 'P6A'>> = {
  meta: 'C0',
  session: 'C0',
  access: 'C1',
  esig: 'C1',
  audit: 'C1',
  designer: 'C2',
  execution: 'C3',
  devices: 'C5',
  quality: 'C3',
  batches: 'C3',
  planning: 'S6',
  masterData: 'S6',
  plant: 'S6',
  review: 'P4',
  containers: 'P4',
  specifications: 'P4',
  samples: 'P4',
  release: 'P4',
  notifications: 'P4',
  qpPackage: 'P4',
  erpShipping: 'P4',
  records: 'P4',
  pqr: 'P4',
  archive: 'P4',
  india: 'P4',
  integrations: 'P6',
  capa: 'P6',
  alarms: 'P6',
  equipmentData: 'P6',
  equipmentDisplays: 'P6',
  plantRules: 'P6',
  config: 'P6',
  support: 'P6',
  contractGiver: 'P6',
  controlled: 'P6',
  labels: 'P6',
  serialisation: 'P6',
  genealogy: 'P6',
  recall: 'P6',
  transfers: 'P6',
  federation: 'P6',
  dashboards: 'P6',
  changeImpact: 'P6',
  training: 'P6',
  analytics: 'P6A',
  analyticsConfig: 'P6A',
  analyticsAudit: 'P6A',
  analyticsSpc: 'P6A',
  analyticsMspc: 'P6A',
  analyticsReview: 'P6A',
  analyticsProfile: 'P6A',
};
