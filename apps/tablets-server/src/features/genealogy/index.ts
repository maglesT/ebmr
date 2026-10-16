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
import { dbNowUs, withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import type pg from 'pg';
import { GENEALOGY_GUIDANCE } from './guidance.ts';
import { askPeer, federatedTrace, otherEnd } from '../transfers/federation.ts';
import { usOf } from '../common/people.ts';
import { deviationImpact, lookup, mockRecallFederation, mockRecallList, mockRecallView, nodeViews, recurrence, supplyChain, trace, tsOf } from './reads.ts';
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
    federatedTrace: async ({ query, requireSession }) => {
      requireSession();
      return federatedTrace(app, pool, query.kind, query.id, query.direction, query.asOfUs);
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
      // The as-of point is fixed first, so the other sites are asked as of the very instant the run stores (L-41): the
      // outbound transfers the forward genealogy reaches then are asked before the one command that stores the run and
      // what each destination answered (D-P6i-0-7).
      const us = body.asOfUs ?? String(await dbNowUs(pool));
      const asked = await askDestinations(app, pool, body.subjectKind, body.subjectId, us);
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        const runId = (await c.query<{ id: string }>(
          `select recipe.run_mock_recall($1, $2, ${tsOf('$3')}, $4, $5) as id`,
          [body.subjectKind, body.subjectId, us, body.authorityInformed, body.authorityReference ?? null],
        )).rows[0]!.id;
        await recordRemote(c, runId, asked);
        return runId;
      });
      return mockRecallView(app, pool, id);
    },
    refreshFederation: async ({ params, actor, idempotencyKey, requestHash }) => {
      const m = (await pool.query<{ us: string; kind: 'LOT' | 'DEVIATION'; subject: string }>(
        `select ${usOf('as_of')} as us, subject_kind as kind, subject_id::text as subject from recipe.mock_recall where id = $1`, [params.mockRecallId])).rows[0];
      if (!m) return mockRecallView(app, pool, params.mockRecallId);
      const open = (await mockRecallFederation(app, pool, params.mockRecallId)).transfers.filter((t) => t.status !== 'ANSWERED').map((t) => t.transferId);
      const asked = (await askDestinations(app, pool, m.kind, m.subject, m.us)).filter((a) => open.includes(a.transferId));
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await recordRemote(c, params.mockRecallId, asked);
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
 * Phase 6 slice 6i: every outbound transfer the forward genealogy of the subject reaches as of `us`, each asked of its
 * destination as of that instant (transfers/federation.ts; the answer, or why not, with the last excerpt received).
 */
async function askDestinations(app: AppContext, pool: pg.Pool, kind: 'LOT' | 'DEVIATION', id: string, us: string): Promise<Asked[]> {
  // An unknown subject or a future instant is left to the run's own refusal (EBMR-RCL-002, -003).
  const rows = await pool.query<{ k: string; i: string }>(
    `select distinct g.node_kind as k, g.node_id::text as i
       from (select 'LOT'::text as kind, $2::uuid as id where $1 = 'LOT'
             union select y.subject_kind, y.subject_id from site.deviation_link y where $1 = 'DEVIATION' and y.deviation_id = $2::uuid and y.linked_at <= ${tsOf('$3')}) s,
            recipe.genealogy(s.kind, s.id, 'FORWARD', ${tsOf('$3')}) g
      where g.node_kind = 'TRANSFER'`, [kind, id, us]).then((r) => r.rows, () => [] as { k: string; i: string }[]);
  const outbound = (await nodeViews(pool, rows.map((r) => ({ kind: r.k, id: r.i })))).filter((n) => n.subKind === 'OUTBOUND');
  const out: Asked[] = [];
  for (const t of outbound) {
    const a = await askPeer(app, pool, otherEnd(t), t.id, 'FORWARD', us);
    out.push({ transferId: t.id, status: a.status === 'WRONG_ANSWER' ? 'REFUSED' : a.status, excerptId: a.excerptId, detail: a.detail });
  }
  return out;
}

async function recordRemote(c: pg.PoolClient, runId: string, asked: readonly Asked[]): Promise<void> {
  for (const a of asked) {
    await c.query('select recipe.record_mock_recall_remote($1, $2, $3, $4, $5)', [runId, a.transferId, a.status, a.excerptId, a.detail]);
  }
}
