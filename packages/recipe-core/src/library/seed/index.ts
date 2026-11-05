/**
 * The ready-made catalogue of library blocks (decision 0026, S7 and S8), by group. See types.ts.
 */
import { CAPSULE_RELEASE_SEEDS, CAPSULE_SEEDS } from './capsules.ts';
import { COATING_SEEDS } from './coating.ts';
import { CONTROL_SEEDS } from './controls.ts';
import { INJECTABLE_RELEASE_SEEDS, INJECTABLE_SEEDS } from './injectables.ts';
import { INJECTABLE_ASEPTIC_SEEDS } from './injectables-aseptic.ts';
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
  // Hard capsules (Capsules edition plan, approved 4 November 2026): they load with the rest; the deferral of
  // 3 November (R3-CAT-4) is lifted.
  capsules: CAPSULE_SEEDS,
  // Injectables edition, slice I-1 (plan v2, approved 4 November 2026): blocks of the `injectables` edition, offered
  // only to a master of that edition (recipe-core 1871).
  injectables: INJECTABLE_SEEDS,
  // Injectables edition, slice I-2 (plan v2): aseptic processing and environmental monitoring blocks of the same edition.
  'injectables aseptic': INJECTABLE_ASEPTIC_SEEDS,
  'release tests': [...RELEASE_TEST_SEEDS, ...CAPSULE_RELEASE_SEEDS, ...INJECTABLE_RELEASE_SEEDS],
};

/** Every item of the catalogue. */
export const SEED_CATALOGUE: readonly SeedItem[] = Object.values(SEED_GROUPS).flat();

/** The hard-capsule blocks (filling, polishing, their IPC tests and release dissolution). */
export const CAPSULE_CATALOGUE: readonly SeedItem[] = [...CAPSULE_SEEDS, ...CAPSULE_RELEASE_SEEDS];

/** The Injectables edition's blocks of slice I-1 (terminally sterilised vials and ampoules) and its release tests. */
export const INJECTABLE_CATALOGUE: readonly SeedItem[] = [...INJECTABLE_SEEDS, ...INJECTABLE_RELEASE_SEEDS];

/** The Injectables edition's blocks of slice I-2 (aseptic processing and environmental monitoring). */
export const INJECTABLE_ASEPTIC_CATALOGUE: readonly SeedItem[] = [...INJECTABLE_ASEPTIC_SEEDS];
