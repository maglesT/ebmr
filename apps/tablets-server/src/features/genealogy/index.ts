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
import { dbNowUs, withActorCommand, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import type pg from 'pg';
import { GENEALOGY_GUIDANCE } from './guidance.ts';
import { askPeer, federatedTrace } from '../transfers/federation.ts';
import { usOf } from '../common/people.ts';
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
    federatedTrace: async ({ query, actor }) =>
      // One command of the person (GENEALOGY.FEDERATE, recipe-core 1093): the requests and answers it records are theirs.
      withActorCommand(pool, actor(), (c) => federatedTrace(app, c, query.kind, query.id, query.direction, query.asOfUs)),
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
      // One command (the person's tap on a shared terminal is used once): the as-of point is fixed first and the run is
      // stored (RECALL.MOCK_RUN, the subject and the instant checked by the database before any site is asked); then every
      // outbound transfer the stored run reached is asked of its destination as of that instant, and what each answered
      // is recorded (L-41; D-P6i-0-7). A resend returns the stored run and asks nobody again.
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const us = body.asOfUs ?? String(await dbNowUs(c));
        const runId = (await c.query<{ id: string }>(
          `select recipe.run_mock_recall($1, $2, ${tsOf('$3')}, $4, $5) as id`,
          [body.subjectKind, body.subjectId, us, body.authorityInformed, body.authorityReference ?? null],
        )).rows[0]!.id;
        await recordRemote(c, runId, await askDestinations(app, c, runId, us));
        return runId;
      });
      return mockRecallView(app, pool, id);
    },
    refreshFederation: async ({ params, actor, idempotencyKey, requestHash }) => {
      const m = (await pool.query<{ us: string }>(`select ${usOf('as_of')} as us from recipe.mock_recall where id = $1`, [params.mockRecallId])).rows[0];
      if (!m) return mockRecallView(app, pool, params.mockRecallId);
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        // The destinations still without an answer, named by the database after its RECALL.MOCK_RUN check (recipe-core 1225).
        await recordRemote(c, params.mockRecallId, await askDestinations(app, c, params.mockRecallId, m.us));
        return params.mockRecallId;
      });
      return mockRecallView(app, pool, params.mockRecallId);
    },
  });
  return Promise.resolve();
}

interface Asked {
  transferId: string;
  status: 'ANSWERED' | 'UNREACHABLE' | 'REFUSED' | 'NOT_REGISTERED';
  excerptId: string | null;
  detail: string | null;
}

/**
 * Phase 6 slice 6i; Phase 7 slice 7b-1 (6jc-R12): the outbound transfers of the stored run that have no answer yet, as
 * the database names them after its RECALL.MOCK_RUN check (recipe.mock_recall_destinations, recipe-core 1225), each asked
 * of its destination as of `us` (transfers/federation.ts; the answer, or why not, with the last excerpt received). The
 * transfers are the run's own (its stored result), not a second read here, so a failed read cannot stand for "no
 * destination": it fails the command, and a destination that is not asked keeps the run incomplete.
 */
async function askDestinations(app: AppContext, c: pg.PoolClient, runId: string, us: string): Promise<Asked[]> {
  const destinations = (await c.query<{ d: { transferId: string; destination: string }[] }>('select recipe.mock_recall_destinations($1) as d', [runId])).rows[0]!.d;
  const out: Asked[] = [];
  for (const t of destinations) {
    const a = await askPeer(app, c, t.destination, t.transferId, 'FORWARD', us);
    out.push({ transferId: t.transferId, status: a.status === 'WRONG_ANSWER' ? 'REFUSED' : a.status, excerptId: a.excerptId, detail: a.detail });
  }
  return out;
}

async function recordRemote(c: pg.PoolClient, runId: string, asked: readonly Asked[]): Promise<void> {
  for (const a of asked) {
    await c.query('select recipe.record_mock_recall_remote($1, $2, $3, $4, $5)', [runId, a.transferId, a.status, a.excerptId, a.detail]);
  }
}
