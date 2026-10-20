/**
 * The plant acts a person performs on the floor for a GMP batch (Phase 7 slice 7h, WP-A; demo gap report A2 to A7, A9;
 * contract ns/plant-floor.ts): the start and end of a room's or line's use, the per-use check and booking of an
 * instrument, the start and end of a process unit's use, the charge of a container by its label, the inspection, issue
 * and return of press tooling, a press's discharge configuration and a calibration. Each handler runs the person's own
 * idempotent command over the existing database function (recipe-core 0403, 0404, 0422 as replaced by 0540 and 0624,
 * 0950; tablets 0871) and reads the record back; every rule and right is the database's, never re-implemented here.
 * A planned end is database time plus the hours given (no server clock); a due date is the end of that site day.
 */
import type { CalibrationView, ChargeView, InstrumentCheckView, OccupancyView, PlantUseView, PressDischargeView, routes, ToolingInspectionView, ToolingIssueResultView, ToolingReturnView } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { HandlerContext } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;
type Ctx<R extends keyof typeof routes.plant> = HandlerContext<(typeof routes.plant)[R]>;
type WriteCtx = Pick<Ctx<'startAreaOccupancy'>, 'requireSession' | 'actor' | 'idempotencyKey' | 'requestHash'>;

const notFound = (what: string) => refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the screen.'] });

/** One idempotent command of the person's: the database's answer (`r`) as it came back. */
async function write(app: AppContext, ctx: WriteCtx, sql: string, params: unknown[]): Promise<unknown> {
  ctx.requireSession();
  const out = await withIdempotentActorCommand(app.pools.app, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
    const { rows } = await c.query<{ r: unknown }>(sql, params);
    return (rows[0]?.r ?? null) as never;
  });
  return out.result;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
/** The container labels a hold names (tab.hold_press_output answers held and pending labels). */
const heldOf = (hold: unknown): string[] => {
  const h = hold && typeof hold === 'object' ? (hold as { held?: unknown; pending?: unknown }) : {};
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? (x as unknown[]) : []);
  return [...list(h.held), ...list(h.pending)].map(String);
};

export async function occupancyView(app: AppContext, db: Db, id: string): Promise<OccupancyView> {
  const { rows } = await db.query<{ id: string; area: string; batch: string; stage: string; started_by: string; started_us: string; ended_by: string | null; ended_us: string | null }>(
    `select o.id, a.code as area, o.batch_ref as batch, o.stage, o.started_by, ${usOf('o.started_at')} as started_us, o.ended_by, ${usOf('o.ended_at')} as ended_us
       from plant.area_occupancy_status o join plant.area a on a.id = o.area_id where o.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('occupancy');
  const people = await peopleOf(db, [r.started_by, r.ended_by]);
  return {
    occupancyId: r.id, areaCode: r.area, batchNumber: r.batch, stage: r.stage, startedBy: personRef(people, r.started_by, 'OPERATOR'), startedAt: app.formatInstant(r.started_us),
    ended: r.ended_by && r.ended_us ? { by: personRef(people, r.ended_by, 'OPERATOR'), at: app.formatInstant(r.ended_us) } : null,
  };
}

export async function useView(app: AppContext, db: Db, id: string): Promise<PlantUseView> {
  const { rows } = await db.query<{ id: string; kind: 'PROCESS' | 'INSTRUMENT'; code: string; batch: string; by: string; us: string; end_us: string; ended_by: string | null; ended_us: string | null }>(
    `select u.id, 'PROCESS' as kind, e.code, u.batch_ref as batch, u.started_by as by, ${usOf('u.started_at')} as us, ${usOf('u.planned_end')} as end_us, u.ended_by, ${usOf('u.ended_at')} as ended_us
       from plant.equipment_use_status u join plant.equipment e on e.id = u.equipment_id where u.id = $1
     union all
     select u.id, 'INSTRUMENT', e.code, u.batch_ref, u.person_id, ${usOf('u.recorded_at')}, ${usOf('u.planned_end')}, null, null
       from plant.instrument_use u join plant.equipment e on e.id = u.equipment_id where u.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('use');
  const people = await peopleOf(db, [r.by, r.ended_by]);
  return {
    useId: r.id, kind: r.kind, equipmentCode: r.code, batchNumber: r.batch, startedBy: personRef(people, r.by, 'OPERATOR'), startedAt: app.formatInstant(r.us), plannedEnd: app.formatInstant(r.end_us),
    ended: r.ended_by && r.ended_us ? { by: personRef(people, r.ended_by, 'OPERATOR'), at: app.formatInstant(r.ended_us) } : null,
  };
}

/** The handlers of the plant floor routes, spread into the plant namespace's binding (features/plant/index.ts). */
export function plantFloorHandlers(app: AppContext) {
  const pool = app.pools.app;
  return {
    startAreaOccupancy: async (ctx: Ctx<'startAreaOccupancy'>): Promise<OccupancyView> => {
      const b = ctx.body;
      const id = await write(app, ctx, 'select plant.start_area_occupancy($1, $2, $3, $4, $5) as r', [b.areaCode, b.batchId, b.stage, b.order ?? null, b.artworkSet ?? null]);
      return occupancyView(app, pool, text(id));
    },
    endAreaOccupancy: async (ctx: Ctx<'endAreaOccupancy'>): Promise<OccupancyView> => {
      await write(app, ctx, 'select plant.end_area_occupancy($1) as r', [ctx.params.occupancyId]);
      return occupancyView(app, pool, ctx.params.occupancyId);
    },
    recordInstrumentCheck: async (ctx: Ctx<'recordInstrumentCheck'>): Promise<InstrumentCheckView> => {
      const b = ctx.body;
      const id = text(await write(app, ctx, 'select plant.record_instrument_check($1, $2, $3, $4::uuid) as r', [ctx.params.code, b.result, b.reference, b.batchId ?? null]));
      const { rows } = await pool.query<{ result: 'PASS' | 'FAIL'; regime: 'PER_USE' | 'DAILY'; us: string }>(`select c.result, c.regime, ${usOf('c.recorded_at')} as us from plant.instrument_check c where c.id = $1`, [id]);
      const r = rows[0];
      if (!r) throw notFound('instrument check');
      return { checkId: id, equipmentCode: ctx.params.code, result: r.result, regime: r.regime, recordedAt: app.formatInstant(r.us) };
    },
    recordInstrumentUse: async (ctx: Ctx<'recordInstrumentUse'>): Promise<PlantUseView> => {
      const id = await write(app, ctx, 'select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + make_interval(hours => $3::int)) as r', [ctx.params.code, ctx.body.batchId, ctx.body.plannedHours]);
      return useView(app, pool, text(id));
    },
    startEquipmentUse: async (ctx: Ctx<'startEquipmentUse'>): Promise<PlantUseView> => {
      const id = await write(app, ctx, 'select plant.start_equipment_use($1, $2::uuid, clock_timestamp() + make_interval(hours => $3::int)) as r', [ctx.params.code, ctx.body.batchId, ctx.body.plannedHours]);
      return useView(app, pool, text(id));
    },
    endEquipmentUse: async (ctx: Ctx<'endEquipmentUse'>): Promise<PlantUseView> => {
      await write(app, ctx, 'select plant.end_equipment_use($1) as r', [ctx.params.useId]);
      return useView(app, pool, ctx.params.useId);
    },
    chargeContainer: async (ctx: Ctx<'chargeContainer'>): Promise<ChargeView> => {
      const b = ctx.body;
      const r = (await write(app, ctx, 'select plant.charge_container($1, $2, $3) as r', [b.batchId, b.stage, b.label])) as Record<string, unknown>;
      return { chargeId: text(r['charge_id']), containerId: text(r['container_id']), label: text(r['label_code']), netQuantity: typeof r['net_quantity'] === 'string' ? r['net_quantity'] : null, unit: text(r['quantity_unit']) };
    },
    inspectTooling: async (ctx: Ctx<'inspectTooling'>): Promise<ToolingInspectionView> => {
      const b = ctx.body;
      const r = (await write(app, ctx, 'select tab.inspect_tooling($1, $2, $3, $4::jsonb, $5) as r', [ctx.params.set, b.kind, b.issueId ?? null, JSON.stringify(b.findings), b.disposition ?? null])) as Record<string, unknown>;
      return { inspectionId: text(r['inspectionId']), set: ctx.params.set, kind: b.kind, result: r['result'] === 'PASS' ? 'PASS' : 'FAIL', held: heldOf(r['hold']) };
    },
    issueTooling: async (ctx: Ctx<'issueTooling'>): Promise<ToolingIssueResultView> => {
      const b = ctx.body;
      const r = (await write(app, ctx, 'select tab.issue_tooling($1, $2, $3, $4::jsonb) as r', [ctx.params.set, b.batchId, b.press, JSON.stringify(b.counts)])) as Record<string, unknown>;
      return { issueId: text(r['issueId']), set: text(r['set']), press: text(r['press']), preUseInspectionId: text(r['preUseInspectionId']) };
    },
    returnTooling: async (ctx: Ctx<'returnTooling'>): Promise<ToolingReturnView> => {
      const b = ctx.body;
      const r = (await write(app, ctx, 'select tab.return_tooling($1, $2::jsonb, $3) as r', [ctx.params.issueId, JSON.stringify(b.counts), b.manualStrokes ?? null])) as Record<string, unknown>;
      return {
        issueId: ctx.params.issueId, strokes: text(r['strokes']), strokeSource: r['strokeSource'] === 'MANUAL' ? 'MANUAL' : 'PRESS_COUNTER', cumulative: text(r['cumulative']),
        countMismatch: r['countMismatch'] === true, limitExceeded: r['limitExceeded'] === true, held: heldOf(r['hold']),
      };
    },
    configurePressDischarge: async (ctx: Ctx<'configurePressDischarge'>): Promise<PressDischargeView> => {
      const r = (await write(app, ctx, 'select plant.configure_press_discharge($1, $2) as r', [ctx.params.code, ctx.body.separateStreams])) as Record<string, unknown>;
      return { press: text(r['press_code']), separateStreams: r['separate_streams'] === true, version: Number(r['version']) };
    },
    recordCalibration: async (ctx: Ctx<'recordCalibration'>): Promise<CalibrationView> => {
      const b = ctx.body;
      const id = text(await write(app, ctx, 'select plant.record_calibration($1, (($2::date + 1)::timestamp at time zone $3), $4, $5, $6) as r', [ctx.params.code, b.dueDate, app.siteZone.current(), b.asFound, b.asLeft, b.reference]));
      const { rows } = await pool.query<{ us: string }>(`select ${usOf('c.due_at')} as us from plant.calibration c where c.id = $1`, [id]);
      const r = rows[0];
      if (!r) throw notFound('calibration');
      return { calibrationId: id, equipmentCode: ctx.params.code, dueAt: app.formatInstant(r.us), asFound: b.asFound, asLeft: b.asLeft, reference: b.reference };
    },
  };
}
