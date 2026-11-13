/**
 * The plant facts of a step of a GMP batch (Phase 7 slice 7h, WP-A; contract batches.stepPlant): what the step screen
 * offers its plant acts from, so an operator taps a room, a unit, a set or a container and never types an identifier:
 *  - the rooms and line the step's stage is bound to (the MBR) and a packaging line's passed clearance for an order (verified, unless the stage's G-10 names no checker: 1886);
 *  - the batch's open occupancies and uses (equipment uses not ended, instrument bookings before their planned end),
 *    each marked when the viewer started it (an entry names only its own person's use: recipe-core 0521);
 *  - the units the step checks (the phase's STATUS_CHECK equipment), each with the plant units of its class, their
 *    fitness and their last check;
 *  - the product's tooling sets, the batch's tooling issues and the pre-use inspections not yet taken by an issue;
 *  - the batch's closed containers not charged or merged (with why one may not be used) and the charges made;
 *  - a bilayer compression step's layers with their hoppers and blend stages (slice 7m, R1: the hopper charge of each
 *    layer on the TB-16 step).
 * Read-only; every act re-checks everything in the database.
 */
import type { StepPlantView } from '@ebmr/api-contract';
import { plant } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import { layersOf } from '../../blocks/tb-16.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { notFound, runContext, type Db } from './runs.ts';

/** A step of the run's master as far as its clearance rule reads it. */
interface ClearanceStep {
  stage?: string | undefined;
  block?: { type: string } | undefined;
  node: { kind: string; signatures?: { check?: unknown } };
}

/**
 * recipe.clearance_checked (recipe-core 1886) for the kiosk's read: a stage's line clearance needs a second person's
 * verification unless its G-10 steps name no checker (211.130(e), lead ruling A5). A stage with no G-10 step, or a step
 * with no stage, keeps the verified rule (fails closed), as the database does.
 */
export function stageClearanceChecked(steps: Iterable<ClearanceStep>, stage: string | undefined): boolean {
  if (stage === undefined) return true;
  const g10 = [...steps].filter((s) => s.stage === stage && s.block?.type === 'G-10');
  return g10.length === 0 || g10.some((s) => s.node.kind === 'phase' && s.node.signatures?.check !== undefined);
}

/** A plant unit of a class a step checks, as the step's plant read finds it. */
export interface UnitFact {
  code: string;
  class_code: string;
  area: string | null;
  problems: string[];
}

const unitText = (u: UnitFact): string => `${u.code} (${u.area ?? 'no room'}${u.problems.length > 0 ? `: ${u.problems.join('; ')}` : ''})`;

/**
 * The units of class `classCode` a status step offers (retest of 13 November 2026, bug 5), and why when it is not simply
 * the stage's own. Neither the controls nor the database tie a unit to the stage's room (plant.start_equipment_use and the
 * entry guard of recipe-core 0521 check the class, the batch, the person and the unit's status), so a unit elsewhere may
 * be used when the stage's own cannot:
 *  - a unit in the stage's rooms that can be used now: the stage's units only;
 *  - none there can: the stage's units, then the class's units in other rooms that can, with a note naming why;
 *  - none can anywhere (or the class has no unit in the stage's rooms): every unit of the class, the stage's first, with
 *    a note naming why each cannot be used and what to do;
 *  - and always any unit with an open use of the batch (`inUse`), so a use started on the Plant screen is recorded or
 *    ended from the step without its identifier.
 */
export function offeredUnits<U extends UnitFact>(classCode: string, rooms: readonly string[], all: readonly U[], inUse: ReadonlySet<string>): { offered: U[]; note: string | null } {
  const ofClass = all.filter((u) => u.class_code === classCode);
  const inRoom = (u: U) => u.area !== null && rooms.includes(u.area);
  const usable = (u: U) => u.problems.length === 0;
  const here = ofClass.filter(inRoom);
  const elsewhere = ofClass.filter((u) => !inRoom(u));
  const withOpenUses = (list: U[]): U[] => [...list, ...ofClass.filter((u) => inUse.has(u.code) && !list.includes(u))];
  const roomText = rooms.length > 0 ? rooms.join(', ') : 'no room';
  if (here.some(usable)) return { offered: withOpenUses(here), note: null };
  const others = elsewhere.filter(usable);
  if (here.length > 0 && others.length > 0) {
    return {
      offered: withOpenUses([...here, ...others]),
      note: `${here.map(unitText).join('; ')}: cannot be used now. Units of class ${classCode} in other rooms that can be used are offered: ${others.map(unitText).join(', ')}. The stage's room does not restrict the unit; its status is checked again when its use starts.`,
    };
  }
  if (ofClass.length === 0) return { offered: withOpenUses([]), note: null };
  if (others.length > 0) {
    return { offered: withOpenUses(ofClass), note: `No unit of class ${classCode} is installed in the stage's rooms (${roomText}); the units of the class in other rooms are offered.` };
  }
  return {
    offered: withOpenUses([...here, ...elsewhere]),
    note: `No unit of class ${classCode} can be used now: ${[...here, ...elsewhere].map(unitText).join('; ')}. Have a unit cleaned (and the cleaning verified), its status restored or its use by another batch ended, then reload this step; or tell your supervisor.`,
  };
}

export async function stepPlantView(app: AppContext, db: Db, batchId: string, stepKey: string, viewer: string): Promise<StepPlantView> {
  const run = await runContext(db, batchId);
  const stepId = stepKey.split('@')[0] ?? stepKey;
  const stepDef = run.def.steps.get(stepId);
  if (!stepDef) throw notFound('step');
  const block = stepDef.block ? `${stepDef.block.type}@${stepDef.block.version}` : null;
  const stage = stepDef.stage === undefined ? undefined : run.def.stages.get(stepDef.stage);
  const codes = [...(stage?.binding.rooms ?? []), ...(stage?.binding.line ? [stage.binding.line] : [])];
  const clearanceChecked = stageClearanceChecked(run.def.steps.values(), stepDef.stage);
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
    plant.lineClearancesForBatch(db, batchId, clearanceChecked),
    db.query<{ id: string; area: string; batch: string; stage: string; by: string; us: string }>(
      `select o.id, a.code as area, o.batch_ref as batch, o.stage, o.started_by as by, ${usOf('o.started_at')} as us
         from plant.area_occupancy_status o join plant.area a on a.id = o.area_id where o.batch_id = $1 and o.ended_at is null order by o.started_at`,
      [batchId],
    ),
    // Retest of 13 November 2026 (bug 5): why each unit cannot be used for the batch now, in the plant's own words: a
    // process unit's use assessment (fitness, cleanliness, clean hold, in use by a batch, cleaning level) for the shortest
    // planned use the screen offers (4 h); another unit's fitness. Advisory only: the act's database function checks again.
    db.query<{ code: string; name: string; class_code: string; area: string | null; fitness: string | null; problems: string[]; result: 'PASS' | 'FAIL' | null; check_us: string | null; check_by: string | null }>(
      `select e.code, e.name, e.class_code, a.code as area, plant.equipment_fitness(e.id) as fitness,
              case when e.kind = 'PROCESS'
                   then array(select jsonb_array_elements_text(plant.equipment_use_assessment(e.id, coalesce(recipe.batch_product($2) ->> 'code', ''), clock_timestamp() + interval '4 hours') -> 'problems'))
                   when plant.equipment_fitness(e.id) in ('QUALIFIED', 'CALIBRATION_DUE_SOON') then '{}'::text[]
                   else array[format('it is %s', coalesce(plant.equipment_fitness(e.id), 'of no known fitness'))] end as problems,
              k.result, ${usOf('k.recorded_at')} as check_us, k.person_id::text as check_by
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
    db.query<{ id: string; label: string; stage: string; container_stage: string; by: string; us: string }>(
      `select g.id, o.label_code as label, g.stage, o.stage as container_stage, g.person_id::text as by, ${usOf('g.recorded_at')} as us
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
      const { offered, note } = offeredUnits(w.classCode, codes, units.rows, new Set(uses.rows.map((u) => u.code)));
      return {
        ...w,
        units: offered.map((u) => ({
          code: u.code, name: u.name, areaCode: u.area, inStageRoom: inRooms(u), fitness: u.fitness, problems: u.problems,
          lastCheck: u.result && u.check_us ? { result: u.result, at: app.formatInstant(u.check_us), mine: u.check_by === viewer } : null,
        })),
        note,
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
    layers: block === 'TB-16@1' && stepDef.node.kind === 'phase' ? layersOf(stepDef.node.config).map((l) => ({ id: l.id, hopper: l.hopper, stage: l.stage })) : [],
    chargedStages: Object.fromEntries(charges.rows.map((g) => [g.id, g.container_stage])),
  };
}
