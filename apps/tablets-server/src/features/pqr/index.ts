/**
 * Feature `pqr` (Phase 4 slice 6c, GMP): the product quality review extract per product and period, reconciled to the
 * registers, and the AP's sign-off (contract ns/pqr.ts; recipe-core 0910, tablets 1200; IN-01, PR-58). Every rule is the
 * database's: the run is the person's own command (recipe.run_pqr_extract), the reads come from its tables and definers,
 * and the sign-off is the signable action PQR_SIGN_OFF (signables.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { extractList, extractView } from './reads.ts';
import { pqrSignOffHandler } from './signables.ts';

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(pqrSignOffHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.pqr, {
    extracts: async ({ query, requireSession }) => {
      requireSession();
      return { extracts: await extractList(app, pool, query.productCode) };
    },
    extract: async ({ params, requireSession }) => {
      requireSession();
      return extractView(app, pool, params.extractId);
    },
    run: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ id: string }>('select recipe.run_pqr_extract($1, $2::date, $3::date) as id', [body.productCode, body.periodFrom, body.periodTo])).rows[0]!.id,
      );
      return extractView(app, pool, id);
    },
  });
  return Promise.resolve();
}
