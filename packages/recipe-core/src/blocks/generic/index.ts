/**
 * The generic block versions (outline 6.6): G-01..G-05, G-07, G-08, G-11..G-20, G-22..G-24 (Phase 2), the
 * SANDBOX_ONLY manual-attestation versions G-09@1 and G-10@1 (Phase 2 apps plan section 7, decision D3:
 * `defineBatch` refuses them for a GMP installation), and from Phase 3 slice 3a G-06@1 (automated equipment
 * phase) and the database-backed G-09@2 and G-10@2 (status from site services), and from slice 4a G-21@1 (printed
 * materials, coding, challenges, serialisation). G-25 (sign-off, review, release) arrives in Phase 4; the registry
 * reports it as unregistered.
 */
import type { BlockVersion } from '../contract.ts';
import { BlockRegistry } from '../registry.ts';
import { AUTOMATED_BLOCKS } from './automated.ts';
import { ENGINE_LEVEL_BLOCKS } from './engine-level.ts';
import { MATERIAL_BLOCKS } from './material.ts';
import { PRINTED_BLOCKS } from './printed.ts';
import { PROCESS_BLOCKS } from './process.ts';
import { RECORDING_BLOCKS } from './recording.ts';
import { STATUS_BLOCKS } from './status.ts';

export const GENERIC_BLOCK_VERSIONS: readonly BlockVersion[] = [...ENGINE_LEVEL_BLOCKS, ...RECORDING_BLOCKS, ...MATERIAL_BLOCKS, ...STATUS_BLOCKS, ...PROCESS_BLOCKS, ...AUTOMATED_BLOCKS, ...PRINTED_BLOCKS];

/** A registry with every generic block version of this release. */
export function genericBlockRegistry(): BlockRegistry {
  return new BlockRegistry(GENERIC_BLOCK_VERSIONS);
}

export { G01, G02, G17, G18, G19 } from './engine-level.ts';
export { G03, G04, G05, G11, G13, G14, G16, G20 } from './recording.ts';
export { computedItemsOf, G07, G08, G22, G23, MATERIAL_BLOCKS } from './material.ts';
export { G12, G15, G24, samplingPlan } from './process.ts';
export * as reprocessing from './reprocessing.ts';
export { G24V2 } from './reprocessing.ts';
export { G06, actualsOf, setpointsOf, criticalAlarmTags, interfaceConfigured, maxAgeMicros, DEFAULT_MAX_AGE_SECONDS } from './automated.ts';
export { G09, G10, G09V2, G10V2, DEFAULT_CLEARANCE_CHECKLIST, DEFAULT_STATUS_CHECKS, checkedEquipment, clearanceChecklist, statusChecks, type ClearanceItem, type StatusCheck } from './status.ts';
export { expectedAnswer, isMassUnit, massItems, netOf } from './common.ts';
export { G21, PRINTED_BLOCKS, COUNTING_METHODS, DEVICE_KINDS, CHALLENGE_TRIGGERS, RECONCILIATION_PARTS, printedItems, lineDevices, serialisedMarkets, withinLimits, type PrintedItem, type LineDevice } from './printed.ts';
