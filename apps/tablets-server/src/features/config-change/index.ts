/**
 * Feature `config-change` (Phase 6 slice 6f, builder A, GMP): configuration change control (contract ns/config.ts;
 * kernel 1195; DI-09) and the review-by-exception rules (recipe-core 1050; DI-26, PR-52).
 *
 * The database decides: a configuration row is written only under an approved, open change record that covers its area
 * (EBMR-CFG-001 to -004); this feature puts the request's change-record number into the command's actor context
 * (ActorContext.changeRecord) and runs each write as the person's own command. The approval of a change record is the
 * signable action CONFIG_CHANGE_ACT (signables.ts).
 */
import { routes, type PlatformSettingView, type RbeRuleView } from '@ebmr/api-contract';
import { config as kernelConfig, type commands } from '@ebmr/kernel';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionRegistry } from '../../platform/ports.ts';
import { CONFIG_GUIDANCE } from './guidance.ts';
import { changeRecordViews, platformSettingViews, rbeRuleViews } from './reads.ts';
import { configChangeActHandler } from './signables.ts';

type JsonValue = commands.JsonValue;

export const guidance = CONFIG_GUIDANCE;

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(configChangeActHandler(app));
}

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-CFG-002', kind: 'INVALID_INPUT', whatHappened: `${what} was not found.`, why: 'There is no such record.', whatYouCanDo: ['Reload the list.'] });

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const recordView = async (num: string) => {
    const [v] = await changeRecordViews(app, pool, { number: num });
    if (!v) throw notFound(`Change record ${num}`);
    return v;
  };
  bindRoutes(scope, app, routes.config, {
    areas: async ({ requireSession }) => {
      requireSession();
      const areas = await kernelConfig.listConfigAreas(pool);
      return { areas };
    },
    changeRecords: async ({ query, requireSession }) => {
      requireSession();
      return { changeRecords: await changeRecordViews(app, pool, query.state !== undefined ? { state: query.state } : {}) };
    },
    raiseChangeRecord: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { attribution: _a, ...def } = body;
      void _a;
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => (await kernelConfig.raiseChangeRecord(c, def)) as JsonValue);
      return recordView(def.number);
    },
    closeChangeRecord: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await kernelConfig.closeChangeRecord(c, params.number, body.note);
        return params.number;
      });
      return recordView(params.number);
    },
    asOf: async ({ query, requireSession }) => {
      requireSession();
      const items = await kernelConfig.configurationAsOf(pool, query.at, query.area);
      return { at: query.at, items: items.map((i) => ({ area: i.area, itemKey: i.itemKey, value: i.value as Record<string, unknown>, validFrom: i.validFrom, basis: i.basis, changeRecord: i.changeRecord })) };
    },
    diff: async ({ query, requireSession }) => {
      requireSession();
      const d = await kernelConfig.configurationDiff(pool, query.from, query.to, query.area);
      return {
        from: query.from,
        to: query.to,
        differences: d.map((x) => ({ ...x, before: x.before as Record<string, unknown> | null, after: x.after as Record<string, unknown> | null })),
      };
    },
    settings: async ({ requireSession }) => {
      requireSession();
      return { settings: await platformSettingViews(pool) };
    },
    setSetting: async ({ params, body, actor, idempotencyKey, requestHash }): Promise<PlatformSettingView> => {
      const ctx = { ...actor({ reasonCode: 'CONFIG_CHANGE', reasonText: body.reason }), changeRecord: body.changeRecord };
      await withIdempotentActorCommand(pool, ctx, idempotencyKey ?? '', requestHash, async (c) => kernelConfig.setPlatformSetting(c, params.key, body.value));
      const [v] = await platformSettingViews(pool, params.key);
      if (!v) throw notFound(`Setting ${params.key}`);
      return v;
    },
    rbeRules: async ({ query, requireSession }) => {
      requireSession();
      return { rules: await rbeRuleViews(pool, query.at) };
    },
    setRbeRule: async ({ params, body, actor, idempotencyKey, requestHash }): Promise<RbeRuleView> => {
      const ctx = { ...actor({ reasonCode: 'RBE_RULE_CHANGE', reasonText: body.rationale }), changeRecord: body.changeRecord };
      await withIdempotentActorCommand(pool, ctx, idempotencyKey ?? '', requestHash, async (c) => {
        const { rows } = await c.query<{ id: string }>('select recipe.set_rbe_rule($1, $2, $3, $4)::text as id', [params.category, body.included, body.minSeverity, body.rationale]);
        return rows[0]?.id ?? null;
      });
      const [v] = await rbeRuleViews(pool, undefined, params.category);
      if (!v) throw notFound(`Review category ${params.category}`);
      return v;
    },
  });
  return Promise.resolve();
}
