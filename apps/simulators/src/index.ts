/**
 * Simulators for equipment and external systems used in demos and tests.
 *
 * They never import the kernel or a database driver (.dependency-cruiser.cjs rule
 * gateway-and-simulators-no-db). The MT-SICS scale simulator arrives with module C5 (src/scale/main.ts); the tablet
 * press and film coater simulators (ebmr.sim-process.v1) with Phase 3 slice 3a (src/process/main.ts).
 */
import { PROCESS_CONTRACT } from '@ebmr/integration-sdk/process';
import { SCALE_CONTRACT } from '@ebmr/integration-sdk/scale';

export const PACKAGE = { name: '@ebmr/simulators', version: '0.1.0' } as const;

/** Exact versions of the shared contracts this module was built against (ADR 0015). */
export const BUILT_AGAINST = [SCALE_CONTRACT, PROCESS_CONTRACT] as const;
