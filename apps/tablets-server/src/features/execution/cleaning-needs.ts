/**
 * R3.10 (hosted-demo trials, October 2026): cleanings were started one by one, each room and unit found and typed on the
 * plant screen. This read lists, for one batch, the rooms and lines each stage of its master is bound to and the plant
 * units of each equipment class the stage uses, each with the plant's own cleaning state (DIRTY needs a cleaning;
 * CLEANING waits for its completion and the second person's verification; CLEAN, CLEARED_FOR_BATCH, IN_USE and
 * IN_PRODUCT need none). A stage signed off needs nothing more. The plant screen starts the needed cleanings from it
 * (each the person's own act through the existing cleaning route; the database's state machine decides).
 */
import type { CleaningNeedsView } from '@ebmr/api-contract';
import { execution, plant } from '@ebmr/recipe-core';
import { runContext, type Db } from './runs.ts';

const STATE = (aggregate: string, id: string): string => `(select s.state from platform.aggregate_state s where s.aggregate_type = '${aggregate}' and s.aggregate_id = ${id})`;

export async function cleaningNeedsView(db: Db, batchId: string): Promise<CleaningNeedsView> {
  const run = await runContext(db, batchId);
  const stored = await execution.loadState(db, batchId);
  const frames = stored ? Object.values(stored.state.stages) : [];
  const stages = [...run.def.stages.values()];
  const areaCodes = [...new Set(stages.flatMap((s) => [...s.binding.rooms, ...(s.binding.line ? [s.binding.line] : [])]))];
  const classes = [...new Set(stages.flatMap((s) => s.binding.equipment.map((e) => e.equipmentClass)))];
  const [head, areas, units] = await Promise.all([
    db.query<{ n: string }>('select b.batch_number as n from recipe.batch_execution b where b.id = $1', [batchId]),
    db.query<{ code: string; kind: 'ROOM' | 'LINE'; state: string | null }>(`select a.code, a.kind, ${STATE(plant.AREA_AGGREGATE, 'a.id')} as state from plant.area a where a.code = any ($1::text[])`, [areaCodes]),
    db.query<{ code: string; name: string; class_code: string; state: string | null }>(
      `select e.code, e.name, e.class_code, ${STATE(plant.EQUIPMENT_AGGREGATE, 'e.id')} as state from plant.equipment e where e.class_code = any ($1::text[]) order by e.code`,
      [classes],
    ),
  ]);
  const areaBy = new Map(areas.rows.map((a) => [a.code, a]));
  const needs = (state: string): boolean => state === 'DIRTY';
  return {
    batchId,
    batchNumber: head.rows[0]?.n ?? '',
    stages: stages.map((s) => {
      const mine = frames.filter((f) => f.stage === s.id);
      const status = mine.some((f) => f.signOff?.valid === true) ? 'SIGNED_OFF' : mine.length > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';
      const open = status !== 'SIGNED_OFF';
      const codes = [...s.binding.rooms, ...(s.binding.line ? [s.binding.line] : [])];
      return {
        stageKey: s.id,
        name: s.name,
        status,
        rooms: codes.map((code) => {
          const a = areaBy.get(code);
          const state = a?.state ?? 'UNKNOWN';
          return { code, kind: a?.kind ?? (code === s.binding.line ? 'LINE' : 'ROOM'), state, needsCleaning: open && needs(state) };
        }),
        units: s.binding.equipment.flatMap((e) =>
          units.rows.filter((u) => u.class_code === e.equipmentClass).map((u) => ({ ref: e.ref, classCode: e.equipmentClass, code: u.code, name: u.name, state: u.state ?? 'UNKNOWN', needsCleaning: open && needs(u.state ?? '') })),
        ),
      };
    }),
  };
}
