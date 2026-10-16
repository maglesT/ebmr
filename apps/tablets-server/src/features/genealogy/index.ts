/**
 * Feature `genealogy` (Phase 6 slice 6d, GMP): the genealogy explorer's trace, the complaint-to-lot lookup, the API
 * supply-chain report, the deviation impact query, the recurrence warning of the certification screen, and the mock
 * recall with the AP's sign-off (contract ns/genealogy.ts and ns/recall.ts; recipe-core 1010 to 1013; PR-57, IN-07,
 * IN-29, PR-50, PR-49). Every rule is the database's: the reads come from its definers, the run is the person's own
 * command (recipe.run_mock_recall) and the sign-off the signable action MOCK_RECALL_SIGN_OFF (signables.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { GENEALOGY_GUIDANCE } from './guidance.ts';
import { deviationImpact, lookup, mockRecallList, mockRecallView, recurrence, supplyChain, trace, tsOf } from './reads.ts';
import { mockRecallSignOffHandler } from './signables.ts';

export const guidance = GENEALOGY_GUIDANCE;

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(mockRecallSignOffHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.genealogy, {
    trace: async ({ query, requireSession }) => {
      requireSession();
      return trace(app, pool, query.kind, query.id, query.direction, query.asOfUs);
    },
    lookup: async ({ query, requireSession }) => {
      requireSession();
      return lookup(app, pool, query.code);
    },
    supplyChain: async ({ params, query, requireSession }) => {
      requireSession();
      return supplyChain(app, pool, params.lotId, query.asOfUs);
    },
    deviationImpact: async ({ params, query, requireSession }) => {
      requireSession();
      return deviationImpact(app, pool, params.deviationId, query.asOfUs);
    },
    recurrence: async ({ params, requireSession }) => {
      requireSession();
      return recurrence(app, pool, params.lotId);
    },
  });
  bindRoutes(scope, app, routes.recall, {
    mockRecalls: async ({ requireSession }) => {
      requireSession();
      return { mockRecalls: await mockRecallList(app, pool) };
    },
    mockRecall: async ({ params, requireSession }) => {
      requireSession();
      return mockRecallView(app, pool, params.mockRecallId);
    },
    run: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) =>
        (await c.query<{ id: string }>(
          `select recipe.run_mock_recall($1, $2, case when $3::text is null then null else ${tsOf('$3')} end, $4, $5) as id`,
          [body.subjectKind, body.subjectId, body.asOfUs ?? null, body.authorityInformed, body.authorityReference ?? null],
        )).rows[0]!.id,
      );
      return mockRecallView(app, pool, id);
    },
  });
  return Promise.resolve();
}
