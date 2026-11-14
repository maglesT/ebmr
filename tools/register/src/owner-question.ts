/**
 * Owner-question deferrals (phase 8). Its own module so that trace.ts and validate.ts can share it without an import
 * cycle (sync.ts -> trace.ts -> validate.ts -> sync.ts).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 8 is no build phase (target phases stop at 7): it holds an open owner question or a deployment item after the
 * editions' exit, never a gap the lead can decide (lead ruling, 13 November 2026, decision 0031). So a phase-8 deferral's
 * reason must name an existing decision record under docs/decisions/.
 */
export const OWNER_QUESTION_PHASE = 8;

export function ownerQuestionErrors(at: string, phase: number, reason: string, root: string): string[] {
  if (phase !== OWNER_QUESTION_PHASE) return [];
  const path = /docs\/decisions\/[\w.-]+\.md/.exec(reason)?.[0];
  if (!path) return [`${at} is deferred to phase ${OWNER_QUESTION_PHASE} (owner question) but its reason cites no decision record (docs/decisions/<file>.md)`];
  const file = join(root, path);
  if (!existsSync(file) || !statSync(file).isFile()) return [`${at} is deferred to phase ${OWNER_QUESTION_PHASE} (owner question) but its decision record ${path} does not exist`];
  return [];
}
