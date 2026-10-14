/**
 * Feature `integrations` (Phase 6 slice 6a, GMP): the integration health page, mirror freshness, reconciliation
 * reports and integration alarms, and the one act of the namespace: a person acknowledges an alarm with a note
 * (contract ns/integrations.ts; kernel 1180; DI-31, DI-20). Every rule is the database's: the reads come from its
 * tables and platform.mirror_freshness, the acknowledgment is platform.acknowledge_integration_alarm (ALARM.ACKNOWLEDGE).
 * Slice 6a-0 fixes these routes; the adapter workers (builders A and B) live beside this file and hand data over
 * through the database under their integration identities, never through these routes. The plugin starts the adapters
 * the service-keys file configures for the systems the site runs in MIRROR mode (adapters/start.ts; the one worker
 * framework adapters/framework.ts), stops them when the server closes and shows their workers' health on the routes.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { materialSourceActHandler } from '../quality/receipt.ts';
import { startAdapters, type AdapterRuntime } from './adapters/start.ts';
import { INTEGRATIONS_GUIDANCE } from './guidance.ts';
import { adapterDetail, adapterList, alarmList, alarmView, mirrorList, reconciliationList } from './reads.ts';

export const guidance = INTEGRATIONS_GUIDANCE;

/** Slice 6a builder A: QA's approval of a manufacturer (MATERIAL_SOURCE_ACT; the receipt routes live in quality/receipt.ts). */
export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(materialSourceActHandler(app));
}

export async function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const adapters: AdapterRuntime | null = await startAdapters(app, scope.log).catch((e: unknown) => {
    scope.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the integration adapters could not start');
    return null;
  });
  if (adapters && adapters.workers.length > 0) scope.addHook('onClose', () => adapters.stop());
  const live = (code: string) => adapters?.health(code) ?? null;
  bindRoutes(scope, app, routes.integrations, {
    adapters: async ({ requireSession }) => {
      requireSession();
      return { adapters: await adapterList(app, pool, live) };
    },
    adapter: async ({ params, requireSession }) => {
      requireSession();
      return adapterDetail(app, pool, params.adapterCode, live);
    },
    reconciliations: async ({ params, requireSession }) => {
      requireSession();
      return { reports: await reconciliationList(app, pool, params.adapterCode) };
    },
    mirrors: async ({ requireSession }) => {
      requireSession();
      return { mirrors: await mirrorList(app, pool) };
    },
    alarms: async ({ query, requireSession }) => {
      requireSession();
      return { alarms: await alarmList(app, pool, query.state ?? 'OPEN', query.adapterCode) };
    },
    acknowledgeAlarm: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select platform.acknowledge_integration_alarm($1, $2)', [params.alarmId, body.note]);
        return params.alarmId;
      });
      return alarmView(app, pool, params.alarmId);
    },
  });
}
