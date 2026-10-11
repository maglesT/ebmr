/**
 * Feature `plant` (Phase 3 slice 6a, GMP): plant master data (areas, equipment classes, equipment, tooling sets,
 * detectors, test pieces, utilities) over the plant and tablets definers, and the plant acts recorded from the screens
 * (cleaning, clearance, logbook events and repairs). The second person's verification of a cleaning, clearance or repair
 * is the signable action PLANT_VERIFY. Every write is the person's own command; every rule is the database's (recipe-core
 * 0400 to 0405 and 0460, tablets 0871, 0872 and 1040).
 */
import { routes, type AreaView, type CleaningView, type ClearanceView, type DetectorView, type EquipmentClassView, type EquipmentView, type SignableAction, type TestPieceView, type ToolingSetView } from '@ebmr/api-contract';
import type { ActorContext } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import { bindRoutes } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { compact, peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type Db = Pick<pg.Pool, 'query'>;
type PlantVerify = Extract<SignableAction, { kind: 'PLANT_VERIFY' }>;

const notFound = (what: string) => refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

const STATE = (type: string, col: string) => `(select s.state from platform.aggregate_state s where s.aggregate_type = '${type}' and s.aggregate_id = ${col})`;

async function areas(db: Db, code?: string): Promise<AreaView[]> {
  const { rows } = await db.query<{ id: string; code: string; kind: 'ROOM' | 'LINE'; name: string; segregated: boolean; negative_pressure: boolean; state: string | null }>(
    `select a.id, a.code, a.kind, a.name, a.segregated, a.negative_pressure, ${STATE(plant.AREA_AGGREGATE, 'a.id')} as state
       from plant.area a where ($1::text is null or a.code = $1) order by a.code`,
    [code ?? null],
  );
  return rows.map((r) => ({ areaId: r.id, code: r.code, kind: r.kind, name: r.name, segregated: r.segregated, negativePressure: r.negative_pressure, state: r.state ?? 'UNKNOWN' }));
}

async function classes(db: Db, code?: string): Promise<EquipmentClassView[]> {
  const { rows } = await db.query<{ code: string; kind: EquipmentClassView['kind']; description: string; clean_hold: string | null; dirty_hold: string | null; calibration_required: boolean; check_regime: 'PER_USE' | 'DAILY' | null; cip_validation_ref: string | null }>(
    `select c.code, c.kind, c.description, c.clean_hold::text as clean_hold, c.dirty_hold::text as dirty_hold, c.calibration_required, c.check_regime, c.cip_validation_ref
       from plant.equipment_class c where ($1::text is null or c.code = $1) order by c.code`,
    [code ?? null],
  );
  return rows.map((r) => ({
    code: r.code, kind: r.kind, description: r.description, cleanHold: r.clean_hold, dirtyHold: r.dirty_hold, calibrationRequired: r.calibration_required, checkRegime: r.check_regime, cipValidationRef: r.cip_validation_ref,
  }));
}

async function equipment(db: Db, filter: { code?: string; kind?: 'UTILITY' | 'NOT_UTILITY' }): Promise<EquipmentView[]> {
  const { rows } = await db.query<{ id: string; code: string; name: string; class_code: string; kind: EquipmentView['kind']; area_code: string | null; state: string | null }>(
    `select e.id, e.code, e.name, e.class_code, e.kind, a.code as area_code, ${STATE(plant.EQUIPMENT_AGGREGATE, 'e.id')} as state
       from plant.equipment e left join plant.area a on a.id = e.area_id
      where ($1::text is null or e.code = $1) and ($2::text is null or ($2 = 'UTILITY') = (e.kind = 'UTILITY'))
      order by e.code`,
    [filter.code ?? null, filter.kind ?? null],
  );
  const out: EquipmentView[] = [];
  for (const r of rows) {
    const fitness = await plant.equipmentFitness(db as pg.Pool, r.id).catch(() => null);
    out.push({ equipmentId: r.id, code: r.code, name: r.name, classCode: r.class_code, kind: r.kind, areaCode: r.area_code, state: r.state ?? 'UNKNOWN', fitness });
  }
  return out;
}

async function toolingSets(db: Db, code?: string): Promise<ToolingSetView[]> {
  const { rows } = await db.query<{ id: string; code: string; product_code: string; tooling_type: ToolingSetView['type']; shape: string; upper_embossing: string; lower_embossing: string; score: string; tips: number; upper_punches: number; lower_punches: number; dies: number; stroke_limit: string }>(
    `select t.id, t.code, t.product_code, t.tooling_type, t.shape, t.upper_embossing, t.lower_embossing, t.score, t.tips, t.upper_punches, t.lower_punches, t.dies, t.stroke_limit::text as stroke_limit
       from tab.tooling_set t where ($1::text is null or t.code = $1) order by t.code`,
    [code ?? null],
  );
  return rows.map((r) => ({
    setId: r.id, code: r.code, product: r.product_code, type: r.tooling_type, shape: r.shape, upperEmbossing: r.upper_embossing, lowerEmbossing: r.lower_embossing, score: r.score,
    tips: r.tips, upperPunches: r.upper_punches, lowerPunches: r.lower_punches, dies: r.dies, strokeLimit: r.stroke_limit,
  }));
}

async function detectors(db: Db, code?: string): Promise<DetectorView[]> {
  const { rows } = await db.query<{ id: string; code: string; name: string; device: DetectorView['device']; class_code: string; area_code: string | null }>(
    `select e.id, e.code, e.name, d.device, e.class_code, a.code as area_code
       from tab.detector_unit d join plant.equipment e on e.id = d.equipment_id left join plant.area a on a.id = e.area_id
      where ($1::text is null or e.code = $1) order by e.code`,
    [code ?? null],
  );
  return rows.map((r) => ({ equipmentId: r.id, code: r.code, name: r.name, device: r.device, classCode: r.class_code, areaCode: r.area_code }));
}

async function testPieces(app: AppContext, db: Db, code?: string): Promise<TestPieceView[]> {
  const { rows } = await db.query<{ id: string; code: string; kind: TestPieceView['kind']; size_value: string; size_unit: TestPieceView['size']['unit']; certificate_ref: string; until_us: string }>(
    `select t.id, t.code, t.kind, t.size_value, t.size_unit, t.certificate_ref, ${usOf('t.certified_until')} as until_us from tab.test_piece t where ($1::text is null or t.code = $1) order by t.code`,
    [code ?? null],
  );
  return rows.map((r) => ({ testPieceId: r.id, code: r.code, kind: r.kind, size: { value: r.size_value, unit: r.size_unit }, certificateRef: r.certificate_ref, certifiedUntil: app.formatInstant(r.until_us) }));
}

async function cleaningView(app: AppContext, db: Db, id: string): Promise<CleaningView> {
  const { rows } = await db.query<{ id: string; eq_code: string | null; area_code: string | null; level: CleaningView['level']; method: CleaningView['method']; started_by: string; started_us: string; completed: boolean; verified: boolean; abandoned: boolean }>(
    `select c.id, e.code as eq_code, a.code as area_code, c.level, c.method, c.started_by, ${usOf('c.started_at')} as started_us,
            c.completed_at is not null as completed, c.verified_at is not null as verified, c.abandoned_at is not null as abandoned
       from plant.cleaning_status c left join plant.equipment e on e.id = c.equipment_id left join plant.area a on a.id = c.area_id where c.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('cleaning');
  const people = await peopleOf(db, [r.started_by]);
  return {
    cleaningId: r.id,
    target: r.eq_code ? 'EQUIPMENT' : 'AREA',
    code: r.eq_code ?? r.area_code ?? '',
    level: r.level,
    method: r.method,
    state: r.abandoned ? 'ABANDONED' : r.verified ? 'VERIFIED' : r.completed ? 'COMPLETED' : 'IN_PROGRESS',
    startedBy: personRef(people, r.started_by, 'PERFORMER'),
    startedAt: app.formatInstant(r.started_us),
  };
}

async function clearanceView(app: AppContext, db: Db, id: string): Promise<ClearanceView> {
  const { rows } = await db.query<{ id: string; area_code: string; clearance_type: ClearanceView['type']; next_batch: string; result: ClearanceView['result']; verified: boolean; performed_by: string; performed_us: string }>(
    `select c.id, a.code as area_code, c.clearance_type, c.next_batch, c.recorded_result as result, c.verified_at is not null as verified, c.performed_by, ${usOf('c.performed_at')} as performed_us
       from plant.clearance_status c join plant.area a on a.id = c.area_id where c.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw notFound('clearance');
  const people = await peopleOf(db, [r.performed_by]);
  return {
    clearanceId: r.id, areaCode: r.area_code, type: r.clearance_type, batchNumber: r.next_batch, result: r.result, state: r.verified ? 'VERIFIED' : 'PERFORMED',
    recordedBy: personRef(people, r.performed_by, 'PERFORMER'), recordedAt: app.formatInstant(r.performed_us),
  };
}

const VERIFY: Readonly<Record<PlantVerify['act'], { aggregateType: string; meaning: string; sql: string }>> = {
  CLEANING: { aggregateType: 'plant_cleaning', meaning: 'LOGBOOK_DOUBLE_CHECKED', sql: 'select plant.verify_cleaning($1, $2)' },
  CLEARANCE: { aggregateType: 'plant_clearance', meaning: 'VERIFIED', sql: 'select plant.verify_clearance($1, $2)' },
  REPAIR: { aggregateType: 'plant_equipment_repair', meaning: 'LOGBOOK_DOUBLE_CHECKED', sql: 'select plant.verify_repair($1, $2)' },
};

export function plantVerifyHandler(app: AppContext): SignableActionHandler<PlantVerify> {
  return dbActHandler<PlantVerify>(app, {
    kind: 'PLANT_VERIFY',
    aggregateTypes: ['plant_cleaning', 'plant_clearance', 'plant_equipment_repair'],
    target: (a) => ({ aggregateType: VERIFY[a.act].aggregateType, aggregateId: a.id, meaning: VERIFY[a.act].meaning }),
    async apply(client, _ctx, a, signatureId) {
      await client.query(VERIFY[a.act].sql, [a.id, signatureId]);
      return { act: a.act, id: a.id };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation === 'GMP') registry.register(plantVerifyHandler(app));
}

const one = <T>(xs: T[], what: string): T => {
  const x = xs[0];
  if (x === undefined) throw notFound(what);
  return x;
};

export function plugin(scope: FastifyInstance, app: AppContext): Promise<void> {
  const pool = app.pools.app;
  /** One idempotent command of the person's; the database's answer as text (an id). */
  const write = async (ctx: { actor: () => ActorContext & { deviceId: string }; idempotencyKey: string | null; requestHash: string }, work: (c: pg.PoolClient) => Promise<unknown>): Promise<string> => {
    const out = await withIdempotentActorCommand(pool, ctx.actor(), ctx.idempotencyKey ?? '', ctx.requestHash, async (c) => {
      const r = await work(c);
      return (typeof r === 'string' ? r : '');
    });
    return typeof out.result === 'string' ? out.result : '';
  };
  bindRoutes(scope, app, routes.plant, {
    areas: async ({ requireSession }) => {
      requireSession();
      return { areas: await areas(pool) };
    },
    defineArea: async (ctx) => {
      ctx.requireSession();
      await write(ctx, (c) => plant.defineArea(c, compact(ctx.body) as plant.AreaDefinition));
      return one(await areas(pool, ctx.body.code), 'area');
    },
    equipmentClasses: async ({ requireSession }) => {
      requireSession();
      return { classes: await classes(pool) };
    },
    defineEquipmentClass: async (ctx) => {
      ctx.requireSession();
      await write(ctx, (c) => plant.defineEquipmentClass(c, compact(ctx.body) as plant.EquipmentClassDefinition));
      return one(await classes(pool, ctx.body.code), 'equipment class');
    },
    equipment: async ({ requireSession }) => {
      requireSession();
      return { equipment: await equipment(pool, { kind: 'NOT_UTILITY' }) };
    },
    defineEquipment: async (ctx) => {
      ctx.requireSession();
      await write(ctx, (c) => plant.defineEquipment(c, compact(ctx.body) as plant.EquipmentDefinition));
      return one(await equipment(pool, { code: ctx.body.code }), 'equipment');
    },
    toolingSets: async ({ requireSession }) => {
      requireSession();
      return { toolingSets: await toolingSets(pool) };
    },
    defineToolingSet: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => (await c.query<{ r: string }>('select tab.define_tooling_set($1::jsonb)::text as r', [JSON.stringify(ctx.body)])).rows[0]?.r ?? '');
      return one(await toolingSets(pool, ctx.body.code), 'tooling set');
    },
    detectors: async ({ requireSession }) => {
      requireSession();
      return { detectors: await detectors(pool) };
    },
    defineDetector: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => (await c.query<{ r: string }>('select tab.define_detector($1::jsonb)::text as r', [JSON.stringify(ctx.body)])).rows[0]?.r ?? '');
      return one(await detectors(pool, ctx.body.code), 'detector');
    },
    testPieces: async ({ requireSession }) => {
      requireSession();
      return { testPieces: await testPieces(app, pool) };
    },
    defineTestPiece: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => (await c.query<{ r: string }>('select tab.define_test_piece($1::jsonb)::text as r', [JSON.stringify(ctx.body)])).rows[0]?.r ?? '');
      return one(await testPieces(app, pool, ctx.body.code), 'test piece');
    },
    utilities: async ({ requireSession }) => {
      requireSession();
      return { utilities: await equipment(pool, { kind: 'UTILITY' }) };
    },
    defineUtility: async (ctx) => {
      ctx.requireSession();
      const cls = (await classes(pool, ctx.body.classCode))[0];
      if (cls && cls.kind !== 'UTILITY') {
        throw refusal(422, { code: 'EBMR-API-NOT-UTILITY', kind: 'INVALID_INPUT', whatHappened: 'This class is not a utility class.', why: `${cls.code} is a ${cls.kind} class.`, whatYouCanDo: ['Choose a UTILITY class.'] });
      }
      await write(ctx, (c) => plant.defineEquipment(c, compact(ctx.body) as plant.EquipmentDefinition));
      return one(await equipment(pool, { code: ctx.body.code }), 'utility');
    },
    startCleaning: async (ctx) => {
      ctx.requireSession();
      const out = await write(ctx, (c) => plant.startCleaning(c, ctx.body.target, ctx.body.code, ctx.body.level, ctx.body.method ?? 'MANUAL'));
      return cleaningView(app, pool, out);
    },
    completeCleaning: async (ctx) => {
      ctx.requireSession();
      await write(ctx, async (c) => {
        await plant.completeCleaning(c, ctx.params.id, ctx.body.cycleReference);
        return ctx.params.id;
      });
      return cleaningView(app, pool, ctx.params.id);
    },
    recordClearance: async (ctx) => {
      ctx.requireSession();
      const b = ctx.body;
      const out = await write(ctx, (c) =>
        plant.recordClearance(c, b.areaCode, b.type, { batchId: b.batchId, result: b.result, ...(b.order ? { order: b.order } : {}), ...(b.artworkSet ? { artworkSet: b.artworkSet } : {}) }),
      );
      return clearanceView(app, pool, out);
    },
    equipmentEvent: async (ctx) => {
      ctx.requireSession();
      const b = ctx.body;
      if (b.event === 'REPAIR' ? b.reference === undefined || b.kind !== undefined : b.kind === undefined) {
        throw refusal(422, {
          code: 'EBMR-API-EVENT-INPUT',
          kind: 'INVALID_INPUT',
          whatHappened: 'The logbook entry is incomplete. Nothing was saved.',
          why: 'An EVENT names its kind; a REPAIR names its work-order reference and no kind.',
          whatYouCanDo: ['Complete the entry and save it again.'],
        });
      }
      const kind = b.kind;
      const out = await write(ctx, (c) =>
        b.event === 'REPAIR' || kind === undefined ? plant.recordRepair(c, ctx.params.code, b.detail, b.reference ?? '') : plant.recordEquipmentEvent(c, ctx.params.code, kind, b.detail, b.reference, b.batchNumber),
      );
      return { id: out, equipmentCode: ctx.params.code, recorded: b.event === 'REPAIR' || kind === undefined ? ('REPAIR_RECORDED' as const) : kind };
    },
    pendingVerifications: async ({ requireSession }) => {
      requireSession();
      const { rows } = await pool.query<{ act: 'CLEANING' | 'CLEARANCE' | 'REPAIR'; id: string; subject: string; summary: string; by: string; us: string }>(
        `select 'CLEANING' as act, c.id, coalesce(e.code, a.code) as subject, format('%s cleaning of %s (%s), completed', c.level, coalesce(e.code, a.code), c.method) as summary,
                c.completed_by as by, ${usOf('c.completed_at')} as us
           from plant.cleaning_status c left join plant.equipment e on e.id = c.equipment_id left join plant.area a on a.id = c.area_id
          where c.completed_at is not null and c.verified_at is null and c.abandoned_at is null
         union all
         select 'CLEARANCE', c.id, a.code, format('%s clearance of %s for batch %s: %s', c.clearance_type, a.code, c.next_batch, c.recorded_result), c.performed_by, ${usOf('c.performed_at')}
           from plant.clearance_status c join plant.area a on a.id = c.area_id where c.verified_at is null
         union all
         select 'REPAIR', r.id, e.code, format('Repair of %s: %s (%s)', e.code, r.detail, r.reference), r.repaired_by, ${usOf('r.recorded_at')}
           from plant.equipment_repair r join plant.equipment e on e.id = r.equipment_id
          where not exists (select 1 from plant.equipment_repair_verification v where v.repair_id = r.id)
         order by us`,
      );
      const people = await peopleOf(pool, rows.map((r) => r.by));
      return { items: rows.map((r) => ({ act: r.act, id: r.id, subject: r.subject, summary: r.summary, recordedBy: personRef(people, r.by, 'PERFORMER'), recordedAt: app.formatInstant(r.us) })) };
    },
  });
  return Promise.resolve();
}
