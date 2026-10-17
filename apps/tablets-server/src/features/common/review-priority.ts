/**
 * The review priority as a person may see it (Phase 6A slice 6A-5; draft controls PR-61, DI-53; D-6A-5-4). The score
 * counts the audit-trail rule hits on a record's entries (OPEN_AUDIT_FLAG). Those hits come from flags about persons,
 * which only data-integrity review (ANALYTICS.DI_REVIEW) may read, so anyone else sees the score without that term and
 * without its reason: the priority then neither shows nor implies that a record's entries had a hit. Used by the review
 * queue (feature review) and the one-record route (feature analytics-review); both read the database views only.
 */
import type pg from 'pg';
import type { ReviewPriority } from '@ebmr/api-contract';

type Db = Pick<pg.PoolClient, 'query'>;

export const AUDIT_TERM = 'OPEN_AUDIT_FLAG';

/** The priority shown to a person: in full to a data-integrity reviewer, else without the audit-trail term. */
export function priorityForViewer(p: ReviewPriority, auditPoints: number, diReview: boolean): ReviewPriority {
  if (diReview) return p;
  return { ...p, score: Math.max(0, p.score - auditPoints), reasons: p.reasons.filter((r) => r.code !== AUDIT_TERM) };
}

/** The points of the audit-trail term in an output's values (0 when absent or not a finite number). */
export function auditPointsOf(values: unknown): number {
  const v = values !== null && typeof values === 'object' ? (values as Record<string, unknown>)[`${AUDIT_TERM}.points`] : undefined;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Whether the command's person holds ANALYTICS.DI_REVIEW, as the database decides (iam.require_permission), asked in a
 * savepoint so a refusal leaves the command's transaction usable.
 */
export async function holdsDiReview(c: Db): Promise<boolean> {
  await c.query('savepoint review_priority_di');
  try {
    await c.query("select iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb)");
    await c.query('release savepoint review_priority_di');
    return true;
  } catch (error) {
    await c.query('rollback to savepoint review_priority_di');
    if (/EBMR-IAM-040/.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}
