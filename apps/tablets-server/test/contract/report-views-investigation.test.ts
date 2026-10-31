/**
 * The investigation report views of tablets 1801 (slice S16; ADR 0022, D-S16-6), read as the reporting role ebmr_report:
 * a run through the real server and engine (the execution test world: a dc-mini variant with an in-process physical
 * check, TB-13, and a dryer step collecting a process value, G-06) records a failing breaking-force check (48, 95 and
 * 52 N against 60 to 140 N; mean 65 N against the action minimum 60 and the alert minimum 70), the thickness readings,
 * the inlet temperature 51.0 degC against 50 to 70, and the exceptions they raise, one dispositioned by QA. The plant
 * (press, tester) is arranged as the IPC block tests arrange it (superuser master data). The run is a test run on the
 * sandbox database, the only installation where the execution world issues one; the row functions read every batch record
 * of their database, and on a GMP database those are GMP records only (the reporting role never connects to a sandbox).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import type { ClientIntent } from '@ebmr/api-contract';
import { actorOfBrowser } from '../esig/support.ts';
import { dcMiniVariant, importAndIssue, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

type Json = Record<string, unknown>;

let sbx: ExecServer;
let d: RunDriver;
let batchNumber: string;

const SIGNATURES = { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } };
const phaseOf = (id: string, name: string, type: string, config: Json): Json => ({
  kind: 'phase', id, name, block: { type, version: '1' }, config,
  records: [], computes: [], reads: [], consumes: [], produces: [], uses: [], equipment: [], signatures: SIGNATURES, significant: true, riskClass: 'HIGH',
});
const PHYSICAL = {
  n: 3,
  thickness: { individual: { action: { min: '4.0', max: '4.6' } } },
  hardness: { unit: 'N', individual: { action: { min: '60', max: '140' } }, mean: { action: { min: '60' }, alert: { min: '70' } } },
};
const ACTUALS = { actuals: [{ tag: 'dryer.inlet_temp_C', unit: 'degC', min: '50', max: '70' }], manualFallback: true };

const entry = (stepKey: string, entryKind: string, data: Json): ClientIntent => ({ type: 'RECORD_ENTRY', stepKey, entry: { kind: 'BLOCK_ENTRY', entryKind, data } }) as ClientIntent;

/** A query as the reporting role (the superuser's session takes that role, and with it only its rights). */
async function asReport<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_report');
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.query('rollback');
    c.release();
  }
}

beforeAll(async () => {
  sbx = await startExecServer();
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query("insert into plant.product (code, name, highly_potent, recorded_by) values ('PCM500', 'Paracetamol tablets', false, gen_random_uuid()) on conflict do nothing");
    await c.query("insert into plant.equipment_class (code, kind, description, calibration_required, check_regime, recorded_by) values ('EQC-IPC', 'INSTRUMENT', 'IPC testers', true, 'PER_USE', gen_random_uuid())");
    await c.query("insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, recorded_by) values ('EQC-PRESS', 'PROCESS', 'Rotary press', interval '3 days', interval '2 days', false, gen_random_uuid())");
    await c.query("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('TEST-PRESS-01', 'Rotary press', 'EQC-PRESS', 'PROCESS', gen_random_uuid())");
    const { rows } = await c.query<{ id: string }>("insert into plant.equipment (code, name, class_code, kind, recorded_by) values ('TEST-HT-01', 'Hardness tester', 'EQC-IPC', 'INSTRUMENT', gen_random_uuid()) returning id");
    await c.query("insert into plant.equipment_event (equipment_id, kind, reference, detail, person_id, account_id) values ($1, 'QUALIFIED', 'QUAL-IPC', 'IQ/OQ/PQ approved', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query("insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id) values ($1, clock_timestamp() + interval '1 year', 'PASS', 'PASS', 'CAL-IPC', gen_random_uuid(), gen_random_uuid())", [rows[0]?.id]);
    await c.query('commit');
  } finally {
    c.release();
  }
  // The two steps in branches of one parallel node, so each can start at once (as the IPC block tests do).
  const mbr = dcMiniVariant((prep) => [
    {
      kind: 'parallel', id: 'par-s16', branches: [
        { id: 'br-s16-dry', name: 'Drying', body: { ...phaseOf('p-dry', 'Fluid-bed drying: inlet air temperature', 'G-06', ACTUALS), system: { kind: 'PLC', ref: 'SYS-WEIGH-01', recipe: 'RCP-FBD-DRY', recipeVersion: '1' } } },
        { id: 'br-s16-ipc', name: 'In-process check', body: phaseOf('p-ipc-phys', 'Thickness and breaking force of the cores', 'TB-13', PHYSICAL) },
      ],
    },
    ...prep,
  ]);
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, mbr));
  d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1'), qa1: await sbx.asPersona('qa1') });
  batchNumber = (await sbx.db.admin.query<{ n: string }>('select batch_number as n from recipe.batch_execution where id = $1', [runId])).rows[0]?.n ?? '';
  // The press in use for the run (superuser master data, as the IPC block tests), the tester checked and in use (operator1).
  const c2 = await sbx.db.admin.connect();
  try {
    await c2.query('begin');
    await c2.query('set local session_replication_role = replica');
    await c2.query(
      `insert into plant.equipment_use (equipment_id, previous_use_id, batch_id, batch_ref, product_code, planned_end, cleaning_id, started_by)
       select q.id, null, b.id, b.batch_number, 'PCM500', clock_timestamp() + interval '8 hours', gen_random_uuid(), gen_random_uuid()
         from plant.equipment q, recipe.batch_execution b where q.code = 'TEST-PRESS-01' and b.id = $1`,
      [runId],
    );
    await c2.query('commit');
  } finally {
    c2.release();
  }
  await withCommand(sbx.db.app, await actorOfBrowser(sbx, d.browser('operator1'), 'operator1'), async (cl) => {
    await cl.query("select plant.record_instrument_check('TEST-HT-01', 'PASS', 'IPC per-use check', $1::uuid)", [runId]);
    await cl.query("select plant.record_instrument_use('TEST-HT-01', $1::uuid, clock_timestamp() + interval '8 hours')", [runId]);
  });
  // The physical check: 2 of 3 tablets below 60 N, so the check fails (IPC_CHECK_FAILED); then the dryer's inlet temperature.
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-ipc-phys@' });
  await d.ok('operator1', entry('p-ipc-phys@', 'PHYSICAL_CHECK', {
    instrument: 'TEST-HT-01', capture: 'MANUAL',
    tablets: [{ thickness: '4.31', hardness: '48' }, { thickness: '4.28', hardness: '95' }, { thickness: '4.35', hardness: '52' }],
  }));
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-dry@' });
  await d.ok('operator1', entry('p-dry@', 'ACTUAL', { tag: 'dryer.inlet_temp_C', value: '51.0', unit: 'degC', source: 'MANUAL' }));
}, 300_000);

afterAll(async () => {
  await sbx?.close();
});

describe('the investigation report views (tablets 1801), read as ebmr_report', () => {
  it('ipc_result_v1 gives each tablet\'s breaking force and thickness, the means with their action and alert limits, the instrument and the failed result', async () => {
    const rows = await asReport<Json>(
      `select step, step_title, check_kind, item, instrument_code, reading, value_text, unit, lower_text, upper_text, aggregate, alert_lower_text, alert_upper_text, result
         from report.ipc_result_v1 where batch_number = $1`, [batchNumber],
    );
    const hardness = rows.filter((r) => r['item'] === 'hardness');
    expect(hardness.filter((r) => r['aggregate'] === null).map((r) => [r['reading'], r['value_text'], r['unit'], r['lower_text'], r['upper_text'], r['result']])).toEqual([
      [1, '48', 'N', '60', '140', 'FAIL'], [2, '95', 'N', '60', '140', 'FAIL'], [3, '52', 'N', '60', '140', 'FAIL'],
    ]);
    const mean = hardness.find((r) => r['aggregate'] === 'mean');
    expect(mean).toMatchObject({ unit: 'N', lower_text: '60', upper_text: null, alert_lower_text: '70', alert_upper_text: null, result: 'FAIL', reading: null });
    expect(Number(mean?.['value_text'])).toBe(65);
    expect(rows.filter((r) => r['item'] === 'thickness' && r['aggregate'] === null).map((r) => [r['value_text'], r['unit'], r['lower_text'], r['upper_text'], r['result']])).toEqual([
      ['4.31', 'mm', '4.0', '4.6', 'PASS'], ['4.28', 'mm', '4.0', '4.6', 'PASS'], ['4.35', 'mm', '4.0', '4.6', 'PASS'],
    ]);
    for (const r of rows) expect(r).toMatchObject({ step: 'p-ipc-phys@', step_title: 'Thickness and breaking force of the cores', check_kind: 'PHYSICAL_CHECK', instrument_code: 'TEST-HT-01' });
  });

  it('process_actual_v1 gives the collected inlet temperature with the step\'s acceptance limits and the stored within-limits flag', async () => {
    const rows = await asReport<Json>('select step, tag, value_text, unit, lower_text, upper_text, within_limits, recorded_at from report.process_actual_v1 where batch_number = $1', [batchNumber]);
    expect(rows).toEqual([expect.objectContaining({ step: 'p-dry@', tag: 'dryer.inlet_temp_C', value_text: '51.0', unit: 'degC', lower_text: '50', upper_text: '70', within_limits: true })]);
    expect(rows[0]?.['recorded_at']).toBeInstanceOf(Date);
  });

  it('exception_detail_v1 gives each exception with its step, step title and text; open until QA dispositions it, then the outcome, the person and the time', async () => {
    const before = await asReport<Json>('select exception_id, exception_type, category, severity, step, step_title, description, status, disposition, disposed_by, disposed_at from report.exception_detail_v1 where batch_number = $1', [batchNumber]);
    const failed = before.find((r) => r['exception_type'] === 'IPC_CHECK_FAILED');
    expect(failed).toMatchObject({ category: 'OUT_OF_LIMIT', severity: 'ACTION', step: 'p-ipc-phys@', step_title: 'Thickness and breaking force of the cores', status: 'OPEN', disposition: null, disposed_by: null, disposed_at: null });
    expect(String(failed?.['description'])).not.toBe('');
    const alert = before.find((r) => r['severity'] === 'ALERT' && r['step'] === 'p-ipc-phys@');
    expect(alert).toBeDefined();
    await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: String(alert?.['exception_id']), outcome: 'NO_IMPACT', justification: 'Values keyed by hand were checked by the second person at the time.' });
    const after = (await asReport<Json>('select exception_id, status, disposition, disposed_by, disposed_at from report.exception_detail_v1 where batch_number = $1 and exception_id = $2', [batchNumber, alert?.['exception_id']]))[0];
    expect(after).toMatchObject({ status: 'DISPOSITIONED', disposition: 'NO_IMPACT', disposed_by: 'TEST-Fatima Sheikh' });
    expect(after?.['disposed_at']).toBeInstanceOf(Date);
    // The register's own view gives the same exceptions.
    const plain = await asReport<{ exception_id: string }>('select exception_id from report.exception_v1 where batch_number = $1 order by 1', [batchNumber]);
    expect(before.map((r) => r['exception_id']).sort()).toEqual(plain.map((r) => r.exception_id));
  });

  it('equipment_use_v1 gives the press and the tester the run uses, with class, start and end', async () => {
    const rows = await asReport<Json>('select equipment_code, equipment_type, room_code, step, started_at, ended_at from report.equipment_use_v1 where batch_number = $1 order by equipment_code', [batchNumber]);
    expect(rows.map((r) => [r['equipment_code'], r['equipment_type'], r['ended_at']])).toEqual([['TEST-HT-01', 'EQC-IPC', null], ['TEST-PRESS-01', 'EQC-PRESS', null]]);
    for (const r of rows) expect(r['started_at']).toBeInstanceOf(Date);
  });

  it('the reporting role reaches no table or helper behind the views, and the sandbox database\'s segregation check stays clean', async () => {
    expect((await sbx.db.admin.query<{ p: string }>('select p from sandbox.segregation_problems() p')).rows.map((r) => r.p)).toEqual([]);
    await expect(asReport('select 1 from recipe.execution_state limit 1')).rejects.toThrow(/permission denied/);
    await expect(asReport('select 1 from plant.equipment_use limit 1')).rejects.toThrow(/permission denied/);
    await expect(asReport("select report.phase_of('{}'::jsonb, 'x')")).rejects.toThrow(/permission denied/);
  });
});
