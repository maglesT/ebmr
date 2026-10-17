/**
 * What the runner needs to run a method (ADR 0020 point 1): the method of @ebmr/analytics, the catalogued inputs it
 * reads and how the rows of those inputs become the method's input. Each method slice (6A-2 to 6A-6) adds its
 * implementations to IMPLEMENTATIONS in its own file under this folder; slice 6A-1 has none, so the runner runs nothing
 * until a slice adds a method and QA makes a version of it EFFECTIVE under a change record (D-6A-1-10). The shapes are in
 * method-types.ts (re-exported here); an implementation file imports them from there, so this list causes no import cycle.
 */
import type { AuditBaselineParameters, AuditInput, AuditRulesParameters, ReviewInput, ReviewPriorityParameters } from '@ebmr/analytics';
import { ATA_BASELINE_IMPLEMENTATION, ATA_RULES_IMPLEMENTATION } from './audit.ts';
import { implementation, type MethodImplementation } from './method-types.ts';
import { MSPC_IMPLEMENTATION } from './mspc.ts';
import { GOLDEN_PROFILE } from './profile.ts';
import { REVIEW_PRIORITY_IMPLEMENTATION } from './review.ts';
import { SPC_IMPLEMENTATIONS } from './spc.ts';

export { implementation, type InputRow, type InputSpec, type MethodImplementation, type ReferenceRow } from './method-types.ts';

/** The implementations of the running code. Slice 6A-1 has none (D-6A-1-10); each method slice adds its own line. */
export const IMPLEMENTATIONS: readonly MethodImplementation[] = [
  // Slice 6A-4: the audit-trail methods (audit.ts).
  implementation<AuditInput, AuditRulesParameters>(ATA_RULES_IMPLEMENTATION),
  implementation<AuditInput, AuditBaselineParameters>(ATA_BASELINE_IMPLEMENTATION),
  ...SPC_IMPLEMENTATIONS, // 6A-2 (spc.ts)
  // Slice 6A-5: the review priority (review.ts).
  implementation<ReviewInput, ReviewPriorityParameters>(REVIEW_PRIORITY_IMPLEMENTATION),
  MSPC_IMPLEMENTATION, // 6A-3 (mspc.ts)
  GOLDEN_PROFILE, // 6A-6
];
