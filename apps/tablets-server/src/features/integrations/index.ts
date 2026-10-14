/**
 * Feature `integrations` (Phase 6 slice 6a, GMP): the integration health page, mirror freshness, reconciliation
 * reports and integration alarms, and the one act of the namespace: a person acknowledges an alarm with a note
 * (contract ns/integrations.ts; kernel 1180; DI-31, DI-20). Every rule is the database's: the reads come from its
 * tables and platform.mirror_freshness, the acknowledgment is platform.acknowledge_integration_alarm (ALARM.ACKNOWLEDGE).
 * Slice 6a-0 fixes these routes; the adapter workers (builders A and B) live beside this file and hand data over
 * through the database under their integration identities, never through these routes. Slice 6a builder A: the plugin
 * starts the ERP/WMS feeds the service-keys file configures (adapters/erp-wms; the worker base adapters/framework.ts).
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { startErpWmsAdapters } from './adapters/erp-wms/index.ts';
import { INTEGRATIONS_GUIDANCE } from './guidance.ts';
import { adapterDetail, adapterList, alarmList, alarmView, mirrorList, reconciliationList } from './reads.ts';

export const guidance = INTEGRATIONS_GUIDANCE;

export async function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  if (app.config.serviceKeysFile) {
    const workers = await startErpWmsAdapters(app, scope.log).catch((e: unknown) => {
      scope.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the ERP/WMS adapters could not start');
      return [];
    });
    if (workers.length > 0) scope.addHook('onClose', async () => Promise.all(workers.map((w) => w.stop())).then(() => undefined));
  }
  bindRoutes(scope, app, routes.integrations, {
    adapters: async ({ requireSession }) => {
      requireSession();
      return { adapters: await adapterList(app, pool) };
    },
    adapter: async ({ params, requireSession }) => {
      requireSession();
      return adapterDetail(app, pool, params.adapterCode);
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
