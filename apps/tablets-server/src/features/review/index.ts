/**
 * Feature `review` (Phase 4 slice 1, GMP): production approval, the exception register in QA review, the audit-trail
 * review, reopening, the abort checklist and translations (contract ns/review.ts; recipe-core 0710 to 0739). Every rule
 * is the database's; the signed acts are the signable action REVIEW_ACT.
 *
 * 1-0 (the interface commit): the reads answer from the review register (recipe-core 0710); the attributed commands are
 * "not available yet" until slice 1a lands.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { auditTrailReport, batchReview, reviewQueue } from './reads.ts';

const later = (): Promise<never> =>
  Promise.reject(
    refusal(501, {
      code: 'NOT_IMPLEMENTED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This function is not available yet.',
      why: 'It arrives with Phase 4 slice 1a (review).',
      whatYouCanDo: ['Use another path for now.'],
    }),
  );

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.review, {
    queue: async ({ query, requireSession }) => {
      requireSession();
      return { batches: await reviewQueue(pool, query.state) };
    },
    batch: async ({ params, requireSession }) => {
      requireSession();
      return batchReview(app, pool, params.batchId);
    },
    auditTrail: async ({ params, requireSession }) => {
      requireSession();
      return auditTrailReport(pool, params.batchId);
    },
    register: later,
    openItem: later,
    respond: later,
    recordAbortChecklist: later,
    recordTranslation: later,
    verifyTranslation: later,
  });
  return Promise.resolve();
}
