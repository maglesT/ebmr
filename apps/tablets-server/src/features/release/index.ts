/**
 * Feature `release` (Phase 4 slice 3, GMP): the release gate G-REL of a finished lot per market and the manufacturer
 * release (contract ns/release.ts; recipe-core 0780 to 0809; the Tablets items behind the hook, tablets 1160 to 1179).
 * Every rule is the database's: the reads come from its definers, the acknowledgement of a "since review" item is the
 * person's own command, and the signed acts are the signable action RELEASE_ACT (signables.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { grelView, lotRelease, releaseQueue } from './reads.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { batchMarketActHandler, releaseActHandler } from './signables.ts';

const notYet = (): Promise<never> =>
  Promise.reject(
    refusal(501, {
      code: 'NOT_IMPLEMENTED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This function is not available yet.',
      why: 'It arrives with Phase 4 slice 4a.',
      whatYouCanDo: ['Use another path for now.'],
    }),
  );

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(releaseActHandler(app));
  registry.register(batchMarketActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.release, {
    queue: async ({ query, requireSession }) => {
      requireSession();
      return { lots: await releaseQueue(pool, query.state) };
    },
    lot: async ({ params, requireSession }) => {
      const s = requireSession();
      return lotRelease(app, pool, params.lotId, s.personId);
    },
    grel: async ({ params, query, requireSession }) => {
      const s = requireSession();
      return grelView(pool, params.lotId, query.market, s.personId);
    },
    acknowledge: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const who = actor();
      await withIdempotentActorCommand(pool, who, idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select recipe.acknowledge_release_item($1, $2, $3, $4)', [params.lotId, body.market, body.itemId, body.epoch]);
        return null;
      });
      return grelView(pool, params.lotId, body.market, who.personId);
    },
    // Slice 4-0: the market routes answer 501 until 4a builds them.
    markets: notYet,
    marketAdd: notYet,
    batchMarketAdd: notYet,
    qpMessage: notYet,
    importers: notYet,
  });
  return Promise.resolve();
}
