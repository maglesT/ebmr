/**
 * Feature `review` (Phase 4 slice 1, GMP): production approval, the exception register in QA review, the audit-trail
 * review, reopening, the abort checklist and translations (contract ns/review.ts; recipe-core 0710 to 0716). Every rule
 * is the database's: each route runs the person's own command through the review definers, and the signed acts are the
 * signable action REVIEW_ACT (signables.ts; CORRECTION_APPROVAL, also there, is registered by execution on both
 * installations).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { usOf } from '../common/people.ts';
import { auditTrailReport, batchReview, itemDetail, prioritisedQueue, reviewItems, reviewQueue } from './reads.ts';
import { reviewActHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(reviewActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.review, {
    queue: async ({ query, actor }) => {
      const who = actor();
      const batches = await reviewQueue(pool, query.state);
      // Phase 6A slice 6A-5 (PR-61): for a holder of ANALYTICS.VIEW (checked by the database), the advisory review
      // priority orders the same records. Without it, or when the priority cannot be read (the analytics runner down,
      // the view unreadable), the queue is exactly as before: the priority never decides which records are listed.
      try {
        return await withActorCommand(pool, who, async (c) => {
          await c.query("select iam.require_permission('ANALYTICS.VIEW', '{}'::jsonb)");
          return prioritisedQueue(app, c, batches);
        });
      } catch (error) {
        if (!/EBMR-IAM-040/.test(error instanceof Error ? error.message : String(error))) {
          app.log.warn({ err: error }, 'review queue: the advisory review priority could not be read; the queue is listed without it');
        }
        return { batches, ordering: { by: 'BATCH_NUMBER' as const, advisory: false, notForGmpDecisions: false, dataAgeSeconds: null } };
      }
    },
    batch: async ({ params, requireSession }) => {
      requireSession();
      return batchReview(app, pool, params.batchId);
    },
    register: async ({ params, actor, idempotencyKey, requestHash }) => {
      const who = actor();
      const out = await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        // The definer is called once, on its own (a call in a WHERE clause runs once per scanned row: never on an empty
        // table, once per row otherwise); the showing it recorded is then read by its id.
        const id = (await c.query<{ id: string }>('select recipe.show_review_register($1) as id', [params.batchId])).rows[0]?.id;
        const { rows } = await c.query<{ us: string }>(`select ${usOf('v.shown_at')} as us from recipe.review_list_view v where v.id = $1`, [id]);
        const us = rows[0]?.us;
        if (us === undefined) throw new Error('the showing of the register was not recorded');
        return us;
      });
      const items = await reviewItems(app, pool, params.batchId, who.personId);
      const byCategory: Record<string, number> = {};
      for (const i of items) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
      return { batchId: params.batchId, items, shownAt: app.formatInstant(out.result), noExceptions: items.length === 0, byCategory };
    },
    openItem: async ({ params, actor, idempotencyKey, requestHash }) => {
      const who = actor();
      const out = await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        // As for the register: the definer once, then the opening it recorded by its id.
        const id = (await c.query<{ id: string }>('select recipe.open_review_item($1, $2) as id', [params.batchId, params.exceptionId])).rows[0]?.id;
        const { rows } = await c.query<{ us: string }>(`select ${usOf('v.opened_at')} as us from recipe.review_item_view v where v.id = $1`, [id]);
        const us = rows[0]?.us;
        if (us === undefined) throw new Error('the opening of the item was not recorded');
        return us;
      });
      return itemDetail(app, pool, params.batchId, params.exceptionId, who.personId, out.result);
    },
    respond: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const who = actor();
      await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        await c.query("select recipe.review_exception($1, $2, 'RESPONDED', $3, null)", [params.batchId, params.exceptionId, body.text]);
        return null;
      });
      const item = (await reviewItems(app, pool, params.batchId, who.personId, params.exceptionId))[0];
      if (!item) throw new Error('the answered item was not found');
      return item;
    },
    auditTrail: async ({ params, query, requireSession }) => {
      requireSession();
      return auditTrailReport(app, pool, params.batchId, query.limit === undefined ? 500 : Number(query.limit));
    },
    recordAbortChecklist: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.record_abort_checklist($1, $2::jsonb)', [params.batchId, JSON.stringify(body)]);
        return null;
      });
      return batchReview(app, pool, params.batchId);
    },
    recordTranslation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.record_translation($1, $2, $3)', [params.batchId, body.sourceRef, body.english]);
        return null;
      });
      return batchReview(app, pool, params.batchId);
    },
    verifyTranslation: async ({ params, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.verify_translation($1)', [params.translationId]);
        const { rows } = await c.query<{ b: string }>('select batch_id as b from recipe.free_text_translation where id = $1', [params.translationId]);
        return rows[0]?.b ?? '';
      });
      return batchReview(app, pool, out.result);
    },
  });
  return Promise.resolve();
}
