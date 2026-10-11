/**
 * The route table: one nested const object, one namespace per file (Phase 2 apps plan section 4).
 * Frozen by the lead at A0; changed only by the lead, and only additively.
 */
import { access } from './ns/access.ts';
import { audit } from './ns/audit.ts';
import { batches } from './ns/batches.ts';
import { designer } from './ns/designer.ts';
import { devices } from './ns/devices.ts';
import { esig } from './ns/esig.ts';
import { execution } from './ns/execution.ts';
import { masterData } from './ns/master-data.ts';
import { meta } from './ns/meta.ts';
import { planning } from './ns/planning.ts';
import { plant } from './ns/plant.ts';
import { quality } from './ns/quality.ts';
import { session } from './ns/session.ts';

export const routes = { meta, session, access, esig, audit, designer, execution, devices, quality, batches, planning, masterData, plant } as const;
export type Routes = typeof routes;
export type NamespaceName = keyof Routes;

/** Which module owns each namespace's handlers (the stub feature files pass to these owners). */
/** Phase 3 slice 6 (S6): batches over the execution handlers, planning, master data (formulas) and plant. */
export const NAMESPACE_OWNERS: Readonly<Record<NamespaceName, 'C0' | 'C1' | 'C2' | 'C3' | 'C5' | 'S6'>> = {
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
};
