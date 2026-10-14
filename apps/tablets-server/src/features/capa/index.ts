/**
 * Feature `capa` (Phase 6 slice 6a, builder B, GMP): the CAPA register (contract ns/capa.ts; site services 0925,
 * recipe-core 0952; IN-01 (d), PR-51; D-P6a-6). Every rule is the database's: each write is the person's own command
 * through a site definer (CAPA.RECORD, CAPA.QA_APPROVE), the reads come from site.capa_view, and the closure is the
 * signable action CAPA_ACT (signables.ts). With a QMS (QMS_STATUS MIRROR) every write is refused by the database.
 */
import { routes, type CapaView } from '@ebmr/api-contract';
import type { commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { compact } from '../common/people.ts';
import { CAPA_GUIDANCE } from './guidance.ts';
import { capaDetail, capaRegister } from './reads.ts';
import { capaActHandler } from './signables.ts';

type JsonValue = commands.JsonValue;

export const guidance = CAPA_GUIDANCE;

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(capaActHandler(app));
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  /** One write as the person's own command (idempotent by the request's key), then the CAPA as it stands. */
  const write = async (
    ctx: { actor: () => Parameters<typeof withIdempotentActorCommand>[1]; idempotencyKey: string | null | undefined; requestHash: string },
    sql: string,
    params: unknown[],
    capaOf: (r: unknown) => string,
  ): Promise<CapaView> => {
    const { result } = await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => (await c.query<{ r: JsonValue }>(sql, params)).rows[0]?.r ?? null);
    return capaDetail(pool, capaOf(result));
  };
  bindRoutes(scope, app, routes.capa, {
    register: async ({ query, requireSession }) => {
      requireSession();
      return capaRegister(pool, query);
    },
    detail: async ({ params, requireSession }) => {
      requireSession();
      return capaDetail(pool, params.capaId);
    },
    raise: ({ body, actor, idempotencyKey, requestHash }) => {
      const { attribution: _a, ...p } = body;
      void _a;
      return write({ actor, idempotencyKey, requestHash }, 'select site.raise_capa($1::jsonb) as r', [JSON.stringify(compact(p))], (r) => (r as { capaId: string }).capaId);
    },
    linkDeviation: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select site.link_capa_deviation($1, $2) as r', [params.capaId, body.deviationId], () => params.capaId),
    linkMasterVersion: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select site.link_capa_master_version($1, $2) as r', [params.capaId, body.versionId], () => params.capaId),
    implement: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select site.record_capa_implemented($1, $2) as r', [params.capaId, body.note], () => params.capaId),
    scheduleCheck: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select site.schedule_capa_effectiveness_check($1, $2, $3) as r', [params.capaId, body.criteria, body.periodDays], () => params.capaId),
    recordEffectiveness: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const owns = await pool.query('select 1 from site.capa_effectiveness_check where id = $1 and capa_id = $2', [params.checkId, params.capaId]);
      if (owns.rowCount === 0) {
        throw refusal(404, { code: 'EBMR-CAPA-009', kind: 'INVALID_INPUT', whatHappened: 'This effectiveness check is not one of this CAPA.', why: `Check ${params.checkId} is not a check of CAPA ${params.capaId}.`, whatYouCanDo: ['Reload the CAPA.'] });
      }
      return write({ actor, idempotencyKey, requestHash }, 'select site.record_capa_effectiveness($1, $2, $3) as r', [params.checkId, body.effective, body.evidence], () => params.capaId);
    },
    cancel: ({ params, body, actor, idempotencyKey, requestHash }) =>
      write({ actor, idempotencyKey, requestHash }, 'select site.cancel_capa($1, $2) as r', [params.capaId, body.reason], () => params.capaId),
  });
  return Promise.resolve();
}
