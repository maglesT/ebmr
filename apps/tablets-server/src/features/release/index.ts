/**
 * Feature `release` (Phase 4 slices 3 and 4a, GMP): the release gate G-REL of a finished lot per market, the manufacturer
 * release, the US and EU dispositions, the EU certification intake and market changes, and after release the suspension,
 * re-confirmation, recall, rejection after release and disposal (contract ns/release.ts; recipe-core 0780 to 0869; tablets
 * 1160 to 1189; site services 0880).
 * Every rule is the database's: the reads come from its definers, the acknowledgement of a "since review" item is the
 * person's own command, and the signed acts are the signable action RELEASE_ACT (signables.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { lotAfterRelease, suspendedLots } from './after-release.ts';
import { coaActHandler, lotCoa } from './coa.ts';
import { euImporters, grelView, lotMarkets, lotRelease, marketAddView, releaseQueue } from './reads.ts';
import { batchMarketActHandler, releaseActHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(releaseActHandler(app));
  registry.register(batchMarketActHandler(app));
  // API plan A3: the quality unit's signature of a CoA of a released API lot (substance 5005).
  registry.register(coaActHandler(app));
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
    // Slice 4a: the market dispositions, market-add evaluations, certification intake and importers.
    markets: async ({ params, requireSession }) => {
      const s = requireSession();
      return lotMarkets(app, pool, params.lotId, s.personId);
    },
    marketAdd: async ({ params, query, requireSession }) => {
      requireSession();
      return marketAddView(pool, 'LOT', params.lotId, query.market);
    },
    batchMarketAdd: async ({ params, query, requireSession }) => {
      requireSession();
      return marketAddView(pool, 'BATCH', params.batchId, query.market);
    },
    // DI-39: the importer's signed message is verified and taken in by the database, which acknowledges every message
    // (ACCEPTED, or REFUSED with its reason); the acknowledgement is the answer the sender keeps.
    qpMessage: async ({ body, actor, idempotencyKey, requestHash }) => {
      const out = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const ack = (await c.query<{ a: { id: string } }>('select tab.take_qp_certification_message($1, $2) as a', [body.message, body.signature])).rows[0]!.a;
        const { rows } = await c.query<{ id: string; message_id: string; message_sha256: string; outcome: 'ACCEPTED' | 'REFUSED'; reason: string | null; lot_id: string | null; certification_id: string | null; us: string }>(
          `select a.id, a.message_id, a.message_sha256, a.outcome, a.reason, a.lot_id, a.certification_id, (extract(epoch from a.recorded_at) * 1000000)::numeric(20, 0)::text as us
             from recipe.qp_message_ack a where a.id = $1`,
          [ack.id],
        );
        return rows[0]!;
      });
      const r = out.result;
      return {
        acknowledgementId: r.id,
        messageId: r.message_id,
        messageSha256: r.message_sha256,
        outcome: r.outcome,
        reason: r.reason,
        receivedAt: app.formatInstant(r.us),
        lotId: r.lot_id,
        certificationId: r.certification_id,
      };
    },
    importers: async ({ requireSession }) => {
      requireSession();
      return { importers: await euImporters(pool) };
    },
    // Slice 5a: after release (recipe-core 0840, site services 0880).
    suspended: async ({ requireSession }) => {
      requireSession();
      return { lots: await suspendedLots(app, pool) };
    },
    afterRelease: async ({ params, requireSession }) => {
      requireSession();
      return lotAfterRelease(app, pool, params.lotId);
    },
    // API plan A3 (AS-17): the CoA of a released API lot; the database prepares it and refuses while a problem stands.
    coa: async ({ params, requireSession }) => {
      requireSession();
      return lotCoa(app, pool, params.lotId);
    },
    prepareCoa: async ({ params, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select substance.prepare_coa($1)', [params.lotId]);
        return null;
      });
      return lotCoa(app, pool, params.lotId);
    },
  });
  return Promise.resolve();
}
