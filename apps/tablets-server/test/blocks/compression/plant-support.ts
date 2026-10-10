/**
 * Plant set-up for the tests of steps on a press (Phase 3 slice 3c): a PROCESS unit of the plant, clean and qualified,
 * with an open use by a test run, and the process device linked to it (tablets 0870: a step's device is the unit of its
 * equipment use).
 *
 * The unit's master data, qualification and verified cleaning are arranged by the superuser with triggers off, as test
 * setup only (as the recipe-core tests arrange batch records); the cleaning and equipment commands are proven in
 * recipe-core's plant tests. The use itself is started through plant.start_equipment_use as the operator, and the device
 * is linked through tab.link_process_device_unit as the system administrator.
 */
import { randomUUID } from 'node:crypto';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import type { TestServer } from '../../support/harness.ts';
import { adminActor } from '../../devices/support.ts';

export interface PressUnit {
  id: string;
  code: string;
  classCode: string;
  useId: string;
}

export async function asSetup(server: TestServer, sql: string, params: unknown[] = []): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** A clean, qualified PROCESS unit of class `classCode` (arranged), the run's product in the plant list. */
export async function cleanUnit(server: TestServer, runId: string, classCode = `CL-PRESS-${randomUUID().slice(0, 6).toUpperCase()}`): Promise<{ id: string; code: string; classCode: string }> {
  const id = randomUUID();
  const code = `TEST-PRESS-${randomUUID().slice(0, 8).toUpperCase()}`;
  const cleaning = randomUUID();
  const product = (await server.db.admin.query<{ p: string }>("select recipe.batch_product($1) ->> 'code' as p", [runId])).rows[0]?.p ?? '';
  await asSetup(server, `insert into plant.product (code, name, highly_potent, recorded_by) values ($1, $1, false, gen_random_uuid()) on conflict do nothing`, [product]);
  await asSetup(
    server,
    `insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by)
     values ($1, 'PROCESS', 'Rotary tablet press (test)', interval '72 hours', interval '48 hours', false, gen_random_uuid()) on conflict do nothing`,
    [classCode],
  );
  await asSetup(server, `insert into plant.equipment (id, code, name, class_code, kind, recorded_by) values ($1, $2, $2, $3, 'PROCESS', gen_random_uuid())`, [id, code, classCode]);
  await asSetup(server, `insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-TEST', 'IQ/OQ/PQ', gen_random_uuid(), gen_random_uuid())`, [id]);
  await asSetup(server, `insert into plant.cleaning (id, equipment_id, level, method, dirty_hold_exceeded, started_by) values ($1, $2, 'MAJOR', 'MANUAL', false, gen_random_uuid())`, [cleaning, id]);
  await asSetup(server, `insert into plant.cleaning_completion (cleaning_id, completed_by) values ($1, gen_random_uuid())`, [cleaning]);
  await asSetup(server, `insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values ($1, gen_random_uuid(), gen_random_uuid())`, [cleaning]);
  await asSetup(
    server,
    `insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
     values ('plant_equipment', $1, 'equipment_cleanliness', 1, 'CLEAN', 1)`,
    [id],
  );
  await asSetup(
    server,
    `insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, to_state, to_version, person_id, account_id, role_code, correlation_id)
     values ('plant_equipment', $1, 'equipment_cleanliness', 1, 'CLEAN', 1, 'TEST_SETUP', 'TEST_SETUP', 'TEST_SETUP', gen_random_uuid())`,
    [id],
  );
  return { id, code, classCode };
}

/** The unit's use by run `runId`, started by `operator` through plant.start_equipment_use (8 h planned). */
export async function startUse(server: TestServer, operator: ActorContext, code: string, runId: string): Promise<string> {
  return withCommand(server.db.app, operator, async (c) =>
    String((await c.query<{ id: string }>("select plant.start_equipment_use($1, $2, clock_timestamp() + interval '8 hours') as id", [code, runId])).rows[0]?.id),
  );
}

/** Links the active process device `deviceCode` to unit `code` (system administrator). */
export async function linkDevice(server: TestServer, deviceCode: string, code: string): Promise<void> {
  await identity.withGuardedCommand(server.db.app, await adminActor(server), async (c) => {
    const b = (await c.query<{ id: string }>('select id from tab.process_device where device_code = $1 and ended_at is null', [deviceCode])).rows[0]?.id;
    await c.query('select tab.link_process_device_unit($1, $2)', [b, code]);
  });
}

/** A clean unit in use by the run, with `deviceCode` (when given) linked to it. */
export async function pressInUse(server: TestServer, operator: () => Promise<ActorContext>, runId: string, opts: { deviceCode?: string; classCode?: string } = {}): Promise<PressUnit> {
  const unit = await cleanUnit(server, runId, opts.classCode);
  const useId = await startUse(server, await operator(), unit.code, runId);
  if (opts.deviceCode) await linkDevice(server, opts.deviceCode, unit.code);
  return { ...unit, useId };
}
