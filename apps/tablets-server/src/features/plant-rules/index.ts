/**
 * Feature `plant-rules` (Phase 6 slice 6b, builder B; GMP): the plant rules behind the clauses Phase 4 deferred to
 * Phase 6 (contract ns/plant-rules.ts) and the status displays (the equipmentDisplays block of ns/equipment-data.ts):
 * the equipment status board (PR-22), the line station display (PR-35), rooms with their clean-hold time and cleaning
 * state (PR-25) and spills (PR-27), the room's EMS conditions (DI-32, DI-49), adjacency and segregation (PR-35), the
 * penicillin facility rule (PR-27), controlled areas and area authorisation types (PR-15), reagent and buffer lots and
 * their use at an in-process control (PR-29). Every rule is the database's (recipe-core 0973 to 0975, kernel 1190, site
 * services 0940): the routes call its commands and read its views; a refusal carries the database's code.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { PLANT_RULES_GUIDANCE } from './guidance.ts';
import { adjacencies, lineStation, reagentLot, reagentLots, room, roomConditions, rooms, statusBoard } from './reads.ts';

export const guidance = PLANT_RULES_GUIDANCE;

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  const one = async (c: { query: (t: string, p: unknown[]) => Promise<{ rows: { r: unknown }[] }> }, sql: string, params: unknown[]): Promise<string> =>
    String((await c.query(sql, params)).rows[0]?.r ?? '');
  bindRoutes(scope, app, routes.equipmentDisplays, {
    statusBoard: async ({ requireSession }) => {
      requireSession();
      return statusBoard(app, pool);
    },
    lineStation: async ({ params, requireSession }) => {
      requireSession();
      return lineStation(app, pool, params.code);
    },
  });
  bindRoutes(scope, app, routes.plantRules, {
    rooms: async ({ requireSession }) => {
      requireSession();
      return { rooms: await rooms(app, pool) };
    },
    roomConditions: async ({ params, requireSession }) => {
      requireSession();
      return roomConditions(app, pool, params.code);
    },
    recordSpill: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.record_spill($1, $2, $3, $4) as r', [params.code, body.description, body.material ?? null, body.batchId ?? null]));
      return room(app, pool, params.code);
    },
    setRoomRule: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.set_area_rule($1, $2, $3, $4) as r', [params.code, body.authorisationRequired, body.cleanHoldSeconds, body.reason]));
      return room(app, pool, params.code);
    },
    adjacencies: async ({ requireSession }) => {
      requireSession();
      return { adjacencies: await adjacencies(app, pool) };
    },
    defineAdjacency: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: version } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.define_area_adjacency($1, $2, $3, $4, $5) as r', [body.one, body.two, body.adjacent, body.segregated, body.justification ?? null]));
      return { version };
    },
    setFacilityRule: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const { result: version } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.set_facility_rule($1, $2, $3) as r', [params.site, body.penicillinFacility, body.justification]));
      return { version };
    },
    classifyBetaLactam: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: version } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.classify_beta_lactam($1, $2, $3, $4) as r', [body.kind, body.code, body.betaLactam, body.reason]));
      return { version };
    },
    createAreaAuthorisation: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: qualificationCode } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select iam.create_area_authorisation_type($1, $2) as r', [body.area, body.name]));
      return { qualificationCode };
    },
    reagentLots: async ({ requireSession }) => {
      requireSession();
      return { lots: await reagentLots(app, pool) };
    },
    recordReagentLot: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { attribution: _a, ...lot } = body;
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) => one(c, 'select site.record_reagent_lot($1::jsonb) as r', [JSON.stringify(lot)]));
      return reagentLot(app, pool, body.lotCode);
    },
    withdrawReagentLot: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select site.withdraw_reagent_lot($1, $2)', [params.lotCode, body.reason]);
        return params.lotCode;
      });
      return reagentLot(app, pool, params.lotCode);
    },
    recordReagentUse: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: useId } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.record_reagent_use($1, $2, $3, $4) as r', [body.batchId, body.step, body.lotCode, body.purpose]));
      return { useId };
    },
  });
  return Promise.resolve();
}
