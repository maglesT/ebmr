/**
 * The plant facts of a step of a GMP batch (Phase 7 slice 7h, WP-A; contract batches.stepPlant): what the step screen
 * offers its plant acts from, so an operator taps a room, a unit, a set or a container and never types an identifier:
 *  - the rooms and line the step's stage is bound to (the MBR) and a packaging line's verified clearance for an order;
 *  - the batch's open occupancies and uses (equipment uses not ended, instrument bookings before their planned end),
 *    each marked when the viewer started it (an entry names only its own person's use: recipe-core 0521);
 *  - the units the step checks (the phase's STATUS_CHECK equipment), each with the plant units of its class, their
 *    fitness and their last check;
 *  - the product's tooling sets, the batch's tooling issues and the pre-use inspections not yet taken by an issue;
 *  - the batch's closed containers not charged or merged (with why one may not be used) and the charges made.
 * Read-only; every act re-checks everything in the database.
 */
import type { StepPlantView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { notFound, runContext, type Db } from './runs.ts';

export async function stepPlantView(app: AppContext, db: Db, batchId: string, stepKey: string, viewer: string): Promise<StepPlantView> {
  const run = await runContext(db, batchId);
  const stepId = stepKey.split('@')[0] ?? stepKey;
  const stepDef = run.def.steps.get(stepId);
  if (!stepDef) throw notFound('step');
  const block = stepDef.block ? `${stepDef.block.type}@${stepDef.block.version}` : null;
  const stage = stepDef.stage === undefined ? undefined : run.def.stages.get(stepDef.stage);
  const codes = [...(stage?.binding.rooms ?? []), ...(stage?.binding.line ? [stage.binding.line] : [])];
  const refs = stepDef.node.kind === 'phase' ? stepDef.node.equipment.filter((e) => e.use === 'STATUS_CHECK') : [];
  const wanted = refs.map((r) => {
    const s = stage?.binding.equipment.find((x) => x.ref === r.ref);
    return { ref: r.ref, kind: s?.kind ?? ('PROCESS' as const), classCode: s?.equipmentClass ?? '' };
  });
  const [head, areas, lines, occ, units, uses, sets, issues, preUse, containers, charges, checklist] = await Promise.all([
    db.query<{ n: string; product: string }>("select b.batch_number as n, coalesce(recipe.batch_product(b.id) ->> 'code', '') as product from recipe.batch_execution b where b.id = $1", [batchId]),
    db.query<{ code: string; kind: 'ROOM' | 'LINE'; state: string | null }>(
      `select a.code, a.kind, (select s.state from platform.aggregate_state s where s.aggregate_type = 'plant_area' and s.aggregate_id = a.id) as state
         from plant.area a where a.code = any ($1::text[]) order by array_position($1::text[], a.code)`,
      [codes],
    ),
    db.query<{ code: string; next_order: string; next_artwork_set: string }>(
      `select a.code, c.next_order, c.next_artwork_set from plant.clearance_status c join plant.area a on a.id = c.area_id
        where c.next_batch_id = $1 and c.verified_at is not null and c.recorded_result = 'PASSED' and c.next_order is not null
          and not exists (select 1 from plant.area_occupancy o where o.clearance_id = c.id) order by c.performed_at`,
      [batchId],
    ),
    db.query<{ id: string; area: string; batch: string; stage: string; by: string; us: string }>(
      `select o.id, a.code as area, o.batch_ref as batch, o.stage, o.started_by as by, ${usOf('o.started_at')} as us
         from plant.area_occupancy_status o join plant.area a on a.id = o.area_id where o.batch_id = $1 and o.ended_at is null order by o.started_at`,
      [batchId],
    ),
    db.query<{ code: string; name: string; class_code: string; area: string | null; fitness: string | null; result: 'PASS' | 'FAIL' | null; check_us: string | null; check_by: string | null }>(
      `select e.code, e.name, e.class_code, a.code as area, plant.equipment_fitness(e.id) as fitness, k.result, ${usOf('k.recorded_at')} as check_us, k.person_id::text as check_by
         from plant.equipment e left join plant.area a on a.id = e.area_id
         left join lateral (select c.result, c.recorded_at, c.person_id from plant.instrument_check c
                             where c.equipment_id = e.id and (c.batch_id = $2 or c.regime = 'DAILY') order by c.recorded_at desc, c.id desc limit 1) k on true
        where e.class_code = any ($1::text[]) order by e.code`,
      [wanted.map((w) => w.classCode), batchId],
    ),
    db.query<{ id: string; kind: 'PROCESS' | 'INSTRUMENT'; code: string; batch: string; by: string; us: string; end_us: string }>(
      `select u.id, 'PROCESS' as kind, e.code, u.batch_ref as batch, u.started_by as by, ${usOf('u.started_at')} as us, ${usOf('u.planned_end')} as end_us
         from plant.equipment_use_status u join plant.equipment e on e.id = u.equipment_id where u.batch_id = $1 and u.ended_at is null
       union all
       select u.id, 'INSTRUMENT', e.code, u.batch_ref, u.person_id, ${usOf('u.recorded_at')}, ${usOf('u.planned_end')}
         from plant.instrument_use u join plant.equipment e on e.id = u.equipment_id where u.batch_id = $1 and u.planned_end > clock_timestamp()
       order by us`,
      [batchId],
    ),
    db.query<{ code: string; upper: number; lower: number; dies: number; issued: boolean }>(
      `select s.code, s.upper_punches as upper, s.lower_punches as lower, s.dies,
              exists (select 1 from tab.tooling_issue x where x.set_id = s.id and not exists (select 1 from tab.tooling_return r where r.issue_id = x.id)) as issued
         from tab.tooling_set s where s.product_code = (select coalesce(recipe.batch_product($1) ->> 'code', '')) order by s.code`,
      [batchId],
    ),
    db.query<{
      id: string; set: string; press: string; upper: number; lower: number; dies: number; pre_id: string; pre_result: 'PASS' | 'FAIL';
      strokes: string | null; source: 'PRESS_COUNTER' | 'MANUAL' | null; mismatch: boolean | null; exceeded: boolean | null; post_id: string | null; post_result: 'PASS' | 'FAIL' | null;
    }>(
      `select x.id, s.code as set, e.code as press, x.upper_issued as upper, x.lower_issued as lower, x.dies_issued as dies, x.pre_use_inspection_id as pre_id, pi.result as pre_result,
              r.strokes::text as strokes, r.stroke_source as source, r.count_mismatch as mismatch, r.limit_exceeded as exceeded, po.id as post_id, po.result as post_result
         from tab.tooling_issue x join tab.tooling_set s on s.id = x.set_id join plant.equipment e on e.id = x.press_equipment_id
         join tab.tooling_inspection pi on pi.id = x.pre_use_inspection_id
         left join tab.tooling_return r on r.issue_id = x.id
         left join tab.tooling_inspection po on po.issue_id = x.id and po.kind = 'POST_USE'
        where x.batch_id = $1 order by x.issued_at`,
      [batchId],
    ),
    db.query<{ id: string; set: string; result: 'PASS' | 'FAIL'; us: string }>(
      `select distinct on (s.code) i.id, s.code as set, i.result, ${usOf('i.inspected_at')} as us
         from tab.tooling_inspection i join tab.tooling_set s on s.id = i.set_id
        where s.product_code = (select coalesce(recipe.batch_product($1) ->> 'code', '')) and i.kind = 'PRE_USE'
          and not exists (select 1 from tab.tooling_issue x where x.pre_use_inspection_id = i.id)
        order by s.code, i.inspected_at desc, i.id desc`,
      [batchId],
    ),
    db.query<{ id: string; label: string; stage: string; net: string | null; unit: string; problem: string | null }>(
      `select o.id, o.label_code as label, o.stage, x.net_quantity::text as net, o.quantity_unit as unit, plant.container_usable_problem(o.id) as problem
         from plant.output_container o join plant.container_close x on x.container_id = o.id
        where o.batch_id = $1 and not exists (select 1 from plant.container_charge g where g.container_id = o.id)
          and not exists (select 1 from plant.container_merge m where m.source_id = o.id)
        order by x.closed_at, o.label_code limit 200`,
      [batchId],
    ),
    db.query<{ id: string; label: string; stage: string; by: string; us: string }>(
      `select g.id, o.label_code as label, g.stage, g.person_id::text as by, ${usOf('g.recorded_at')} as us
         from plant.container_charge g join plant.output_container o on o.id = g.container_id where g.batch_id = $1 and g.purpose = 'CHARGE' order by g.recorded_at`,
      [batchId],
    ),
    db.query<{ items: string[] }>('select tab.tooling_checklist_items() as items'),
  ]);
  const people = await peopleOf(db, [...occ.rows.map((r) => r.by), ...uses.rows.map((r) => r.by), ...charges.rows.map((r) => r.by)]);
  const inRooms = (u: { area: string | null }) => u.area !== null && codes.includes(u.area);
  return {
    batchId,
    stepKey,
    batchNumber: head.rows[0]?.n ?? '',
    block,
    stage: stepDef.stage ?? null,
    areas: areas.rows.map((a) => ({ code: a.code, kind: a.kind, state: a.state ?? 'UNKNOWN' })),
    lineClearances: lines.rows.map((l) => ({ areaCode: l.code, order: l.next_order, artworkSet: l.next_artwork_set })),
    occupancies: occ.rows.map((o) => ({
      occupancyId: o.id, areaCode: o.area, batchNumber: o.batch, stage: o.stage, startedBy: personRef(people, o.by, 'OPERATOR'), startedAt: app.formatInstant(o.us), ended: null, mine: o.by === viewer,
    })),
    equipment: wanted.map((w) => {
      const ofClass = units.rows.filter((u) => u.class_code === w.classCode);
      // The units of the step's rooms first; a class with none there offers every unit of the class.
      const here = ofClass.filter(inRooms);
      return {
        ...w,
        units: (here.length > 0 ? here : ofClass).map((u) => ({
          code: u.code, name: u.name, areaCode: u.area, fitness: u.fitness,
          lastCheck: u.result && u.check_us ? { result: u.result, at: app.formatInstant(u.check_us), mine: u.check_by === viewer } : null,
        })),
      };
    }),
    uses: uses.rows.map((u) => ({
      useId: u.id, kind: u.kind, equipmentCode: u.code, batchNumber: u.batch, startedBy: personRef(people, u.by, 'OPERATOR'), startedAt: app.formatInstant(u.us), plannedEnd: app.formatInstant(u.end_us), ended: null, mine: u.by === viewer,
    })),
    tooling: {
      checklist: checklist.rows[0]?.items ?? [],
      sets: sets.rows.map((s) => ({ code: s.code, upper: s.upper, lower: s.lower, dies: s.dies, issuedNow: s.issued })),
      issues: issues.rows.map((x) => ({
        issueId: x.id, set: x.set, press: x.press, counts: { upper: x.upper, lower: x.lower, dies: x.dies }, preUse: { inspectionId: x.pre_id, result: x.pre_result },
        returned: x.strokes !== null && x.source !== null ? { strokes: x.strokes, strokeSource: x.source, countMismatch: x.mismatch === true, limitExceeded: x.exceeded === true } : null,
        postUse: x.post_id && x.post_result ? { inspectionId: x.post_id, result: x.post_result } : null,
      })),
      preUse: preUse.rows.map((p) => ({ inspectionId: p.id, set: p.set, result: p.result, at: app.formatInstant(p.us) })),
    },
    containers: containers.rows.map((c) => ({ containerId: c.id, label: c.label, stage: c.stage, netQuantity: c.net, unit: c.unit, problem: c.problem })),
    charges: charges.rows.map((g) => ({ chargeId: g.id, label: g.label, stage: g.stage, chargedBy: personRef(people, g.by, 'OPERATOR'), chargedAt: app.formatInstant(g.us), mine: g.by === viewer })),
  };
}
