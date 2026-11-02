/**
 * The ready-made catalogue of library blocks (decision 0026, S7 and S8), by group. See types.ts.
 */
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
  'release tests': RELEASE_TEST_SEEDS,
};

/** Every item of the catalogue. */
export const SEED_CATALOGUE: readonly SeedItem[] = Object.values(SEED_GROUPS).flat();
