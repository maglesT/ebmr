/**
 * Feature `alarms` (Phase 6 slice 6b-0, GMP): the plant alarm log (contract ns/alarms.ts; recipe-core 0960; DI-49;
 * D-P6b-3). Every rule is the database's: the reads come from plant.alarm_status and plant.alarm_batch, the
 * acknowledgment is plant.acknowledge_alarm (ALARM.ACKNOWLEDGE in the batch's scope, a person, once; the action taken,
 * a comment for a GMP-critical alarm, a deviation reference where required). Alarms arrive through the OPC UA and EMS
 * adapters (plant.receive_equipment_alarm) and the tablets bridge of the gateway's process alarms (builder B), never
 * through these routes. Slice 6b-0 fixes the routes; builder B adds the step-screen and review wiring.
 */
import { routes } from '@ebmr/api-contract';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { ALARMS_GUIDANCE } from './guidance.ts';
import { alarmList, alarmView, batchAlarmLog } from './reads.ts';

export const guidance = ALARMS_GUIDANCE;

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  bindRoutes(scope, app, routes.alarms, {
    list: async ({ query, requireSession }) => {
      requireSession();
      return { alarms: await alarmList(app, pool, query) };
    },
    batchLog: async ({ params, query, requireSession }) => {
      requireSession();
      return { alarms: await batchAlarmLog(app, pool, params.batchId, query.step) };
    },
    alarm: async ({ params, requireSession }) => {
      requireSession();
      return alarmView(app, pool, params.alarmId);
    },
    acknowledge: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await withIdempotentActorCommand(pool, actor(), idempotencyKey ?? '', requestHash, async (c) => {
        await c.query('select plant.acknowledge_alarm($1, $2, $3, $4)', [params.alarmId, body.actionTaken, body.comment ?? null, body.deviationRef ?? null]);
        return params.alarmId;
      });
      return alarmView(app, pool, params.alarmId);
    },
  });
  return Promise.resolve();
}
