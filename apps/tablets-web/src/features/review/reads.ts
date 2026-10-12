/**
 * The reads the review screens show, read again after every act (route ids, so `useRefresh` invalidates each by its
 * prefix). Nothing is updated in the browser: the server's answer after the act is what the screen shows.
 */
import { routes, type ReviewState } from '@ebmr/api-contract';
import type { StateTone } from '@ebmr/ui-kit';

export const REVIEW_READS: readonly string[] = [routes.review.queue.id, routes.review.batch.id, routes.review.auditTrail.id];
export const CONTAINER_READS: readonly string[] = [routes.containers.list.id];

/** The chip tone of a review state (display only). */
export function stateTone(s: ReviewState): StateTone {
  switch (s) {
    case 'QA_REVIEWED':
      return 'ok';
    case 'PRODUCTION_APPROVED':
      return 'info';
    case 'EXECUTION_COMPLETE':
      return 'pending';
    case 'ABORTED':
    case 'CANCELLED':
      return 'error';
    default:
      return 'neutral';
  }
}

/** "PRODUCTION_APPROVED" -> "Production approved". */
export function words(code: string): string {
  const s = code.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
