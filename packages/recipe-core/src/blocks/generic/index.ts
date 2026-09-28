/**
 * The generic engine-level block versions of Phase 2 (outline 6.6): G-01..G-05, G-07, G-08, G-11..G-20,
 * G-22..G-24, and the SANDBOX_ONLY manual-attestation versions G-09@1 and G-10@1 (Phase 2 apps plan
 * section 7, decision D3: `defineBatch` refuses them for a GMP installation). G-06 (automated equipment
 * phase), G-21 (printed materials) and G-25 (sign-off, review, release) need database-backed status and
 * device interfaces and arrive in Phase 3/4; the registry reports them as unregistered. The database-backed
 * G-09 and G-10 (version 2) arrive in Phase 3.
 */
import type { BlockVersion } from '../contract.ts';
import { BlockRegistry } from '../registry.ts';
import { ENGINE_LEVEL_BLOCKS } from './engine-level.ts';
import { MATERIAL_BLOCKS } from './material.ts';
import { PROCESS_BLOCKS } from './process.ts';
import { RECORDING_BLOCKS } from './recording.ts';
import { STATUS_BLOCKS } from './status.ts';

export const GENERIC_BLOCK_VERSIONS: readonly BlockVersion[] = [...ENGINE_LEVEL_BLOCKS, ...RECORDING_BLOCKS, ...MATERIAL_BLOCKS, ...STATUS_BLOCKS, ...PROCESS_BLOCKS];

/** A registry with every generic block version of this release. */
export function genericBlockRegistry(): BlockRegistry {
  return new BlockRegistry(GENERIC_BLOCK_VERSIONS);
}

export { G01, G02, G17, G18, G19 } from './engine-level.ts';
export { G03, G04, G05, G11, G13, G14, G16, G20 } from './recording.ts';
export { G07, G08, G22, G23 } from './material.ts';
export { G12, G15, G24, samplingPlan } from './process.ts';
export { G09, G10, DEFAULT_CLEARANCE_CHECKLIST, DEFAULT_STATUS_CHECKS, checkedEquipment, clearanceChecklist, statusChecks, type ClearanceItem, type StatusCheck } from './status.ts';
export { expectedAnswer, isMassUnit, massItems, netOf } from './common.ts';
