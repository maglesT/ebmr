/**
 * Feature `records` (Phase 4 slice 5b, GMP): record locking and amendment, the bulk reconciliation of a processing
 * record and the bright-stock maximum hold (contract ns/records-lock.ts; recipe-core 0870 to 0873, tablets 1190, 1199;
 * INV-21, R-04, PR-38). Every rule is the database's: the reads come from its tables and definers, the closure, the
 * amendment entries and the maximum hold are the person's own commands, and opening or closing an amendment is the
 * signable action RECORD_LOCK_ACT (signables.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { amendmentView, bulkView, holdList, holdOf, lockList, lockView } from './reads.ts';
import { recordLockActHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(recordLockActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.records, {
    locks: async ({ query, requireSession }) => {
      requireSession();
      return { records: await lockList(app, pool, query.state) };
    },
    lock: async ({ params, requireSession }) => {
      requireSession();
      return lockView(app, pool, params.batchId);
    },
    bulk: async ({ params, requireSession }) => {
      requireSession();
      return bulkView(app, pool, params.batchId);
    },
    closeBulk: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.close_bulk_reconciliation($1, $2)', [params.batchId, body.remainingHeldReason ?? null]);
        return null;
      });
      return bulkView(app, pool, params.batchId);
    },
    appendAmendmentEntry: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const n = Number.parseInt(params.number, 10);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.append_amendment_entry($1, $2, $3, $4, $5, $6, $7)', [params.batchId, n, body.kind, body.target, body.text, body.value ?? null, body.reason]);
        return null;
      });
      return amendmentView(app, pool, params.batchId, n);
    },
    brightStockHolds: async ({ requireSession }) => {
      requireSession();
      return { holds: await holdList(app, pool) };
    },
    setBrightStockHold: async ({ body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.set_bright_stock_hold($1, $2, $3, $4)', [body.productCode, body.strength, Number.parseInt(body.maxHoldHours, 10), body.reason]);
        return null;
      });
      const hold = await holdOf(app, pool, body.productCode, body.strength.trim());
      if (!hold) throw refusal(409, { code: 'EBMR-LCK-020', kind: 'STALE', whatHappened: 'The maximum hold was not found after it was set.', why: 'Reload the list.', whatYouCanDo: ['Reload the list.'] });
      return hold;
    },
  });
  return Promise.resolve();
}
