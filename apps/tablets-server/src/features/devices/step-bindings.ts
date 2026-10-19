/**
 * The bindings of a process step (Phase 7 slice 7g, WP4; decision 0025: every act has a screen): the process device a
 * step of a batch is bound to (tab.bind_step_device, tablets 0820 as replaced by 0870: an active device linked to the
 * plant unit of the step's equipment use), the plant units bound to the step (plant.bind_step_equipment, recipe-core
 * 0960: a unit the batch has in use; its alarms and series follow the step, DI-49) and a setpoint download of an MBR
 * setpoint to the bound device (tab.request_setpoint_download: the MBR's value, PR-14; one waiting download per tag).
 * Every act is the person's own idempotent command and every rule and right (STEP.EXECUTE in the batch's scope) is the
 * database's; the view is read again after each act.
 */
import type { StepBindingsView, routes } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { HandlerContext } from '../../platform/http/bind.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { runContext, type Db } from '../execution/runs.ts';
import { stepOfKey } from './process-readings.ts';

type Json = Record<string, unknown>;

/** The phase node `step` of an MBR procedure (depth first), or null. */
export function phaseNode(node: unknown, step: string): Json | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = phaseNode(n, step);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const o = node as Json;
  if (o['kind'] === 'phase' && o['id'] === step) return o;
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') {
      const found = phaseNode(v, step);
      if (found) return found;
    }
  }
  return null;
}

/** The setpoints the MBR approves for the step (its config's setpoints), as written there. */
function setpointsOf(node: Json | null): { tag: string; value: string; unit: string }[] {
  const config = node?.['config'];
  const list = config && typeof config === 'object' ? (config as Json)['setpoints'] : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => {
    const o = s as Json;
    return typeof o['tag'] === 'string' && typeof o['value'] === 'string' && typeof o['unit'] === 'string' ? [{ tag: o['tag'], value: o['value'], unit: o['unit'] }] : [];
  });
}

export async function stepBindingsView(app: AppContext, db: Db, batchId: string, stepKey: string): Promise<StepBindingsView> {
  const run = await runContext(db, batchId);
  const step = stepOfKey(stepKey);
  const [device, equipment, units, devices, waiting] = await Promise.all([
    db.query<{ code: string; person_id: string; us: string }>(
      `select d.device_code as code, b.person_id, ${usOf('b.bound_at')} as us
         from tab.step_device b join tab.process_device d on d.id = b.process_device_id where b.batch_id = $1 and b.step = $2`,
      [batchId, step],
    ),
    db.query<{ code: string; name: string; person_id: string; us: string }>(
      `select e.code, e.name, s.person_id, ${usOf('s.bound_at')} as us
         from plant.step_equipment s join plant.equipment e on e.id = s.equipment_id where s.batch_id = $1 and s.step = $2 order by s.bound_at, e.code`,
      [batchId, step],
    ),
    db.query<{ code: string; name: string }>(
      `select distinct e.code, e.name from plant.equipment_use_status u join plant.equipment e on e.id = u.equipment_id
        where u.batch_id = $1 and u.ended_at is null order by e.code`,
      [batchId],
    ),
    db.query<{ code: string; kind: string; unit: string | null }>(
      `select d.device_code as code, d.equipment_kind as kind, e.code as unit
         from tab.process_device d left join tab.process_device_unit x on x.process_device_id = d.id left join plant.equipment e on e.id = x.equipment_id
        where d.ended_at is null order by d.device_code`,
    ),
    db.query<{ tag: string }>(
      `select distinct d.tag from tab.setpoint_download d
        where d.batch_id = $1 and d.step = $2 and not exists (select 1 from tab.setpoint_download_ack a where a.download_id = d.id)`,
      [batchId, step],
    ),
  ]);
  const people = await peopleOf(db, [...device.rows.map((r) => r.person_id), ...equipment.rows.map((r) => r.person_id)]);
  const pending = new Set(waiting.rows.map((r) => r.tag));
  const d = device.rows[0];
  return {
    batchId,
    stepKey,
    device: d ? { code: d.code, boundBy: personRef(people, d.person_id, 'OPERATOR'), boundAt: app.formatInstant(d.us) } : null,
    equipment: equipment.rows.map((r) => ({ code: r.code, name: r.name, boundBy: personRef(people, r.person_id, 'OPERATOR'), boundAt: app.formatInstant(r.us) })),
    unitsInUse: units.rows,
    devices: devices.rows.map((r) => ({ code: r.code, equipmentKind: r.kind, unitCode: r.unit })),
    setpoints: setpointsOf(phaseNode(run.def.mbr, step)).map((s) => ({ ...s, waiting: pending.has(s.tag) })),
  };
}

type Ctx<R extends keyof typeof routes.devices> = HandlerContext<(typeof routes.devices)[R]>;

/** One idempotent command of the person's, then the step's bindings as they are now. */
async function act(
  app: AppContext,
  ctx: Pick<Ctx<'bindStepDevice'>, 'requireSession' | 'actor' | 'idempotencyKey' | 'requestHash'>,
  { batchId, stepKey }: { batchId: string; stepKey: string },
  sql: string,
  last: string,
): Promise<StepBindingsView> {
  ctx.requireSession();
  await withIdempotentActorCommand(app.pools.app, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
    await c.query(sql, [batchId, stepOfKey(stepKey), last]);
    return batchId;
  });
  return stepBindingsView(app, app.pools.app, batchId, stepKey);
}

export function stepBindingHandlers(app: AppContext) {
  return {
    stepBindings: (ctx: Ctx<'stepBindings'>) => {
      ctx.requireSession();
      return stepBindingsView(app, app.pools.app, ctx.query.batchId, ctx.query.stepKey);
    },
    bindStepDevice: (ctx: Ctx<'bindStepDevice'>) => act(app, ctx, ctx.body, 'select tab.bind_step_device($1, $2, $3)', ctx.body.deviceCode),
    bindStepEquipment: (ctx: Ctx<'bindStepEquipment'>) => act(app, ctx, ctx.body, 'select plant.bind_step_equipment($1, $2, $3)', ctx.body.equipmentCode),
    requestSetpointDownload: (ctx: Ctx<'requestSetpointDownload'>) => act(app, ctx, ctx.body, 'select tab.request_setpoint_download($1, $2, $3)', ctx.body.tag),
  };
}
