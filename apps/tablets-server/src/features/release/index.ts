/**
 * Feature `release` (Phase 4 slice 3, GMP): the release gate G-REL of a finished lot per market and the manufacturer
 * release (contract ns/release.ts; recipe-core 0780 to 0809; the Tablets items behind the hook, tablets 1160 to 1179).
 * Every rule is the database's; the signed acts are the signable action RELEASE_ACT.
 *
 * 3-0 (the interface commit): G-REL answers from recipe.grel_evaluate (recipe-core 0780); the other routes are "not
 * available yet" until slice 3a lands.
 */
import { routes, type GrelView } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';

const later = (): Promise<never> =>
  Promise.reject(
    refusal(501, {
      code: 'NOT_IMPLEMENTED',
      kind: 'NOT_ENABLED',
      whatHappened: 'This function is not available yet.',
      why: 'It arrives with Phase 4 slice 3a (release).',
      whatYouCanDo: ['Use another path for now.'],
    }),
  );

interface GrelRow {
  lot: string;
  market: GrelView['market'];
  epoch: string;
  ready: boolean;
  items: { id: string; group: string; title: string; status: 'GREEN' | 'RED' | 'NA'; problem: string | null; evidence: { kind: string; ref: string; label: string }[]; since_review: boolean }[];
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.release, {
    queue: later,
    lot: later,
    grel: async ({ params, query, requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ g: GrelRow }>('select recipe.grel_evaluate($1, $2) as g', [params.lotId, query.market]);
      const g = rows[0]?.g;
      if (!g) throw new Error('G-REL answered nothing');
      return {
        lotId: g.lot,
        market: g.market,
        epoch: g.epoch,
        ready: g.ready,
        items: g.items.map((i) => ({ id: i.id, group: i.group, title: i.title, status: i.status, problem: i.problem, evidence: i.evidence, sinceReview: i.since_review, acknowledged: false })),
      };
    },
    acknowledge: later,
  });
  return Promise.resolve();
}
