/**
 * What the runner needs to run a method (ADR 0020 point 1): the method of @ebmr/analytics, the catalogued inputs it
 * reads and how the rows of those inputs become the method's input. Each method slice (6A-2 to 6A-6) adds its
 * implementations to IMPLEMENTATIONS in its own file under this folder; slice 6A-1 has none, so the runner runs nothing
 * until a slice adds a method and QA makes a version of it EFFECTIVE under a change record (D-6A-1-10). The shapes are in
 * method-types.ts (re-exported here); an implementation file imports them from there, so this list causes no import cycle.
 */
import type { MethodImplementation } from './method-types.ts';
import { GOLDEN_PROFILE } from './profile.ts';
import { SPC_IMPLEMENTATIONS } from './spc.ts';

export { implementation, type InputRow, type InputSpec, type MethodImplementation, type ReferenceRow } from './method-types.ts';

/** The implementations of the running code. Slice 6A-1 has none (D-6A-1-10); each method slice adds its own line. */
export const IMPLEMENTATIONS: readonly MethodImplementation[] = [
  ...SPC_IMPLEMENTATIONS, // 6A-2 (spc.ts)
  GOLDEN_PROFILE, // 6A-6
];
