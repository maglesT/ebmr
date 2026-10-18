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
import { refusal } from '../../platform/http/refusal.ts';
import { PLANT_RULES_GUIDANCE } from './guidance.ts';
import { adjacencies, areaAuthorisationRecord, areaAuthorisations, lineStation, reagentLot, reagentLots, room, roomConditions, rooms, statusBoard } from './reads.ts';

export const guidance = PLANT_RULES_GUIDANCE;

/** The id of a proposed plant rule version (recipe-core 1210): the subject QA signs; PROPOSED as returned. */
async function proposal(pool: AppContext['pools']['app'], sql: string, params: unknown[]): Promise<{ proposalId: string; state: 'PROPOSED' }> {
  const id = (await pool.query<{ id: string }>(sql, params)).rows[0]?.id;
  if (!id) throw new Error('the proposed version was not found after it was recorded');
  return { proposalId: id, state: 'PROPOSED' };
}

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  // Every command here returns a scalar (a version, an id, a code) as its single column r.
  const one = async (c: { query: (t: string, p: unknown[]) => Promise<{ rows: { r: string | number | null }[] }> }, sql: string, params: unknown[]): Promise<string> =>
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
    // PR-27 (recipe-core 1210): the steward's rule or classification is a proposal, approved by a QA person other than the
    // proposer (INDIA_ACT FACILITY_RULE_APPROVE or BETA_LACTAM_APPROVE on the proposal id); a loosening counts only then.
    setFacilityRule: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const { result: version } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.set_facility_rule($1, $2, $3) as r', [params.site, body.penicillinFacility, body.justification]));
      return { version, ...(await proposal(pool, 'select id from plant.facility_rule where site_code = $1 and version = $2::integer', [params.site, version])) };
    },
    classifyBetaLactam: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: version } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select plant.classify_beta_lactam($1, $2, $3, $4) as r', [body.kind, body.code, body.betaLactam, body.reason]));
      return { version, ...(await proposal(pool, 'select id from plant.beta_lactam_class where subject_kind = $1 and code = $2 and version = $3::integer', [body.kind, body.code, version])) };
    },
    createAreaAuthorisation: async ({ body, actor, idempotencyKey, requestHash }) => {
      const { result: qualificationCode } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select iam.create_area_authorisation_type($1, $2) as r', [body.area, body.name]));
      return { qualificationCode };
    },
    areaAuthorisations: async ({ requireSession }) => {
      requireSession();
      return areaAuthorisations(app, pool);
    },
    // PR-15: a person's authorisation for a controlled area is a record of the qualification register (kernel 0130:
    // QUALIFICATION.RECORD, never by the person, insert-only with its withdrawal), valid from the recording instant
    // (D-P6b-L-3). The type must exist (createAreaAuthorisation); the person is named by their login.
    recordAreaAuthorisation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const person = (await pool.query<{ id: string }>('select a.person_id as id from iam.account a where a.login_name = $1', [body.loginName])).rows[0]?.id;
      if (!person) throw refusal(404, { code: 'EBMR-PLANT-186', kind: 'INVALID_INPUT', whatHappened: `There is no user ${body.loginName}.`, whatYouCanDo: ['Check the user id and record again.'], whoCanHelp: ['The training coordinator'], controls: ['PR-15'] });
      const { rows } = await pool.query<{ defined: boolean; future: boolean | null }>(
        'select exists (select 1 from iam.qualification_type t where t.code = iam.area_authorisation_code($1)) as defined, $2::timestamptz > clock_timestamp() as future',
        [params.code, body.validTo ?? null],
      );
      if (!rows[0]?.defined) throw refusal(422, { code: 'EBMR-PLANT-187', kind: 'INVALID_INPUT', whatHappened: `The area authorisation of ${params.code} is not defined yet.`, whatYouCanDo: ['Define the area authorisation of the room or line first, then record the person.'], whoCanHelp: ['The training coordinator'], controls: ['PR-15'] });
      if (rows[0].future === false) throw refusal(422, { code: 'EBMR-PLANT-188', kind: 'INVALID_INPUT', whatHappened: 'The authorisation would end before it starts: it is valid from now.', whatYouCanDo: ['Give an end in the future, or none.'], whoCanHelp: ['The training coordinator'], controls: ['PR-15'] });
      const { result: id } = await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, (c) =>
        one(c, 'select iam.record_qualification($1, iam.area_authorisation_code($2), clock_timestamp(), $3::timestamptz) as r', [person, params.code, body.validTo ?? null]));
      return areaAuthorisationRecord(app, pool, id);
    },
    withdrawAreaAuthorisation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await areaAuthorisationRecord(app, pool, params.recordId);
      // The withdrawal updates the register row: its audit entry carries the person's reason (EBMR-AUDIT-002).
      const withReason = { ...actor(), reasonCode: 'AREA_AUTHORISATION_WITHDRAWN', reasonText: body.reason };
      await withIdempotentActorCommand(pool, withReason, idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select iam.withdraw_qualification($1, $2)', [params.recordId, body.reason]);
        return params.recordId;
      });
      return areaAuthorisationRecord(app, pool, params.recordId);
    },
    reagentLots: async ({ requireSession }) => {
      requireSession();
      return { lots: await reagentLots(app, pool) };
    },
    recordReagentLot: async ({ body, actor, idempotencyKey, requestHash }) => {
      const lot = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'attribution'));
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
