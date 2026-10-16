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
import { alarms } from './ns/alarms.ts';
import { equipmentData, equipmentDisplays } from './ns/equipment-data.ts';
import { plantRules } from './ns/plant-rules.ts';
import { records } from './ns/records-lock.ts';
import { pqr } from './ns/pqr.ts';
import { release } from './ns/release.ts';
import { review } from './ns/review.ts';
import { samples } from './ns/samples.ts';
import { session } from './ns/session.ts';
import { specifications } from './ns/specifications.ts';
import { contractGiver, support } from './ns/support.ts';

export const routes = { meta, session, access, esig, audit, designer, execution, devices: { ...devices, ...deviceReadings }, quality, batches, planning, masterData, plant, review, containers, specifications, samples, release, notifications, qpPackage, erpShipping, records, pqr, archive, india, integrations, capa, alarms, equipmentData, equipmentDisplays, plantRules, config, support, contractGiver } as const;
export type Routes = typeof routes;
export type NamespaceName = keyof Routes;

/** Which module owns each namespace's handlers (the stub feature files pass to these owners). */
/** Phase 3 slice 6 (S6): batches over the execution handlers, planning, master data (formulas) and plant. Phase 4 (P4): review. Phase 6 (P6): integrations, capa, alarms, equipmentData, equipmentDisplays (the status displays of
 * slice 6b, appended to ns/equipment-data.ts as their own namespace so each builder's feature binds its own routes), plantRules. */
export const NAMESPACE_OWNERS: Readonly<Record<NamespaceName, 'C0' | 'C1' | 'C2' | 'C3' | 'C5' | 'S6' | 'P4' | 'P6'>> = {
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
};
