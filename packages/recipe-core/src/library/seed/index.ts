/**
 * The ready-made catalogue of library blocks (decision 0026, S7 and S8), by group. See types.ts.
 */
import { CAPSULE_RELEASE_SEEDS, CAPSULE_SEEDS } from './capsules.ts';
import { COATING_SEEDS } from './coating.ts';
import { CONTROL_SEEDS } from './controls.ts';
import { PACKAGING_SEEDS } from './packaging.ts';
import { PROCESS_SEEDS } from './process.ts';
import { SOFTGEL_SEEDS } from './softgels.ts';
import { IPC_TEST_SEEDS } from './tests-ipc.ts';
import { RELEASE_TEST_SEEDS } from './tests-release.ts';
import type { SeedItem } from './types.ts';

export type { SeedItem } from './types.ts';

export const SEED_GROUPS: Readonly<Record<string, readonly SeedItem[]>> = {
  process: PROCESS_SEEDS,
  controls: CONTROL_SEEDS,
  packaging: PACKAGING_SEEDS,
  coating: COATING_SEEDS,
  'ipc tests': IPC_TEST_SEEDS,
  // Hard capsules (Capsules edition plan, approved 4 November 2026): they load with the rest; the deferral of
  // 3 November (R3-CAT-4) is lifted.
  capsules: CAPSULE_SEEDS,
  // Capsules C6: soft gels I (gel mass, rotary die encapsulation, drying to the end point, their IPC tests).
  'soft gels': SOFTGEL_SEEDS,
  'release tests': [...RELEASE_TEST_SEEDS, ...CAPSULE_RELEASE_SEEDS],
};

/** Every item of the catalogue. */
export const SEED_CATALOGUE: readonly SeedItem[] = Object.values(SEED_GROUPS).flat();

/** The capsule blocks (hard capsules: filling, polishing, their IPC tests and release dissolution; soft gels). */
export const CAPSULE_CATALOGUE: readonly SeedItem[] = [...CAPSULE_SEEDS, ...SOFTGEL_SEEDS, ...CAPSULE_RELEASE_SEEDS];
