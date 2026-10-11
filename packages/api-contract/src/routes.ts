/**
 * The route table: one nested const object, one namespace per file (Phase 2 apps plan section 4).
 * Frozen by the lead at A0; changed only by the lead, and only additively.
 */
import { access } from './ns/access.ts';
import { audit } from './ns/audit.ts';
import { designer } from './ns/designer.ts';
import { devices } from './ns/devices.ts';
import { esig } from './ns/esig.ts';
import { execution } from './ns/execution.ts';
import { meta } from './ns/meta.ts';
import { quality } from './ns/quality.ts';
import { session } from './ns/session.ts';

export const routes = { meta, session, access, esig, audit, designer, execution, devices, quality } as const;
export type Routes = typeof routes;
export type NamespaceName = keyof Routes;

/** Which module owns each namespace's handlers (the stub feature files pass to these owners). */
export const NAMESPACE_OWNERS: Readonly<Record<NamespaceName, 'C0' | 'C1' | 'C2' | 'C3' | 'C5'>> = {
  meta: 'C0',
  session: 'C0',
  access: 'C1',
  esig: 'C1',
  audit: 'C1',
  designer: 'C2',
  execution: 'C3',
  devices: 'C5',
  quality: 'C3',
};
