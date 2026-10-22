/**
 * R3.3 (hosted-demo trials, October 2026; decision D-7k-2): "Start using room", then "Record ... in this step", then
 * "Save" was three presses and two badge taps for one thing the person does. A status or clearance step's plant act and
 * its record in the step are now one act: one request (one fresh badge tap on a shared terminal, INV-40), one command of
 * the person in one transaction. The plant act runs the same database function as its own route (plant.start_area_
 * occupancy, plant.record_instrument_use, plant.start_equipment_use: every guard is the database's), and the step entry
 * names what it returned; the engine then accepts or refuses the entry as for any entry (a refusal is recorded with the
 * command, DI-34, and the plant act stands, as it would have done when started on its own).
 *
 * What the act may name is the step's own: the room or line of the step's stage, the stage from the master (never the
 * browser's), and a unit of a class the step checks, booked as an instrument or started as a process unit as the master's
 * stage binding says.
 */
import type { ClientIntent, PlantEntryAct } from '@ebmr/api-contract';
import type pg from 'pg';
import { refusal } from '../../platform/http/refusal.ts';
import { notFound, runContext, type Db } from './runs.ts';

const notOfStep = (what: string, why: string) =>
  refusal(422, { code: 'EBMR-EXE-701', kind: 'NOT_ALLOWED', whatHappened: `${what} is not one this step records. Nothing was started or saved.`, why, controls: ['PR-23', 'PR-34'], whatYouCanDo: ['Reload the step: it lists the rooms and units it records.'] });

/** The work of a plant entry inside the run's command: the plant act, then the step entry that names it. */
export async function plantEntryPrelude(pool: Db, batchId: string, stepKey: string, act: PlantEntryAct): Promise<(client: pg.PoolClient) => Promise<ClientIntent>> {
  const run = await runContext(pool, batchId);
  const stepDef = run.def.steps.get(stepKey.split('@')[0] ?? stepKey);
  if (!stepDef) throw notFound('step');
  const block = stepDef.block ? `${stepDef.block.type}@${stepDef.block.version}` : null;
  const stage = stepDef.stage === undefined ? undefined : run.def.stages.get(stepDef.stage);
  const one = async (client: pg.PoolClient, sql: string, params: unknown[]): Promise<string> => {
    const { rows } = await client.query<{ r: string }>(sql, params);
    return String(rows[0]?.r ?? '');
  };
  if (act.act === 'START_AREA_OCCUPANCY') {
    if (block !== 'G-10@2') throw notOfStep(act.areaCode, `Step ${stepKey} is no room or line clearance step.`);
    const areas = [...(stage?.binding.rooms ?? []), ...(stage?.binding.line ? [stage.binding.line] : [])];
    if (stepDef.stage === undefined || !areas.includes(act.areaCode)) throw notOfStep(act.areaCode, `The stage of step ${stepKey} names ${areas.join(', ') || 'no room or line'}.`);
    const stageKey = stepDef.stage;
    return async (client) => {
      const occupancyId = await one(client, 'select plant.start_area_occupancy($1, $2, $3, $4, $5) as r', [act.areaCode, batchId, stageKey, act.order ?? null, act.artworkSet ?? null]);
      const intent: ClientIntent = { type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind: 'AREA_OCCUPANCY', data: { areaCode: act.areaCode, occupancyId } } };
      return intent;
    };
  }
  if (block !== 'G-09@2') throw notOfStep(act.code, `Step ${stepKey} is no equipment status step.`);
  const checked = stepDef.node.kind === 'phase' ? stepDef.node.equipment.filter((e) => e.use === 'STATUS_CHECK').map((e) => e.ref) : [];
  if (!checked.includes(act.equipmentRef)) throw notOfStep(act.equipmentRef, `Step ${stepKey} checks ${checked.join(', ') || 'no unit'}.`);
  const kind = stage?.binding.equipment.find((x) => x.ref === act.equipmentRef)?.kind ?? 'PROCESS';
  const sql =
    kind === 'INSTRUMENT'
      ? 'select plant.record_instrument_use($1, $2::uuid, clock_timestamp() + make_interval(hours => $3::int)) as r'
      : 'select plant.start_equipment_use($1, $2::uuid, clock_timestamp() + make_interval(hours => $3::int)) as r';
  return async (client) => {
    const useId = await one(client, sql, [act.code, batchId, act.plannedHours]);
    const intent: ClientIntent = { type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind: 'EQUIPMENT_USE', data: { equipmentRef: act.equipmentRef, equipmentCode: act.code, useId } } };
    return intent;
  };
}
