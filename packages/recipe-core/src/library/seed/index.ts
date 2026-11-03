/**
 * The ready-made catalogue of library blocks (decision 0026, S7 and S8), by group. See types.ts.
 */
import { CAPSULE_RELEASE_SEEDS, CAPSULE_SEEDS } from './capsules.ts';
import { COATING_SEEDS } from './coating.ts';
import { CONTROL_SEEDS } from './controls.ts';
import { PACKAGING_SEEDS } from './packaging.ts';
import { PROCESS_SEEDS } from './process.ts';
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
  // The owner deferred hard capsules on 3 November 2026 (R3-CAT-4): their blocks stay in the catalogue and its tests,
  // but the Tablets load leaves them out (TABLETS_CATALOGUE).
  capsules: CAPSULE_SEEDS,
  'release tests': [...RELEASE_TEST_SEEDS, ...CAPSULE_RELEASE_SEEDS],
};

/** Every item of the catalogue. */
export const SEED_CATALOGUE: readonly SeedItem[] = Object.values(SEED_GROUPS).flat();

/** The hard-capsule blocks (filling, polishing, their IPC tests and release dissolution), deferred by the owner. */
export const CAPSULE_CATALOGUE: readonly SeedItem[] = [...CAPSULE_SEEDS, ...CAPSULE_RELEASE_SEEDS];

/** What the Tablets edition loads into its library: the catalogue without the deferred hard-capsule blocks. */
export const TABLETS_CATALOGUE: readonly SeedItem[] = SEED_CATALOGUE.filter((s) => !CAPSULE_CATALOGUE.includes(s));
