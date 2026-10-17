/**
 * Phase 6A slice 6A-1 (kernel 1245; ADR 0020 point 6; draft controls DI-52, DI-53; DI-09): method versions and
 * reference sets are written by a person holding ANALYTICS.METHOD (never an administrator) under an approved change
 * record naming the area; they never change once written, only retire; the configuration of a past instant shows the
 * methods then in force; the screens' views show method versions with their validity and change record, and the
 * unrestricted flags with their dispositions; a restricted flag's dispositions need ANALYTICS.DI_REVIEW.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { ensureFixtureChangeRecord, FIXTURE_CHANGE_RECORD, underChange } from '../support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, type SeededActor } from '../identity/seed.ts';

const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const SHA = 'c'.repeat(64);
const RUNTIME = { package: '@ebmr/analytics 0.1.0', commit: '0a1b2c3', node: '22.20.0', libraries: {} };

let db: TestDatabase;
let qa: SeededActor;
let owner: SeededActor;
let diLead: SeededActor;
let operator: SeededActor;
let sysAdmin: SeededActor;

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

async function analyticsQuery<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(db.name, ANALYTICS_LOGIN) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

const definition = (over: Record<string, unknown> = {}) => ({
  method: 'DRIFT.TREND', version: 1, status: 'EFFECTIVE', title: 'Drift', intendedUse: 'advisory drift test', acceptance: { within: '1e-9' },
  parameters: { slopeWindow: 10 }, parametersSha256: SHA, codeIdentity: '@ebmr/analytics 0.1.0 0a1b2c3', validationRef: 'VAL-ANA-001', ...over,
});

const setVersion = (ctx: ActorContext, def: Record<string, unknown>) =>
  withCommand(db.app, again(ctx), async (c) => (await c.query<{ id: string }>('select analytics.set_method_version($1::jsonb) as id', [JSON.stringify(def)])).rows[0]!.id);

const effectiveNow = async (method: string): Promise<number[]> =>
  (await analyticsQuery<{ version: number }>('select version from analytics.effective_methods() where method = $1 order by version', [method])).map((r) => r.version);

/** A finished run of `method` v1 with one output (a model candidate with `modelSha` when given) and one flag. */
async function finishedRun(method: string, kind: 'BATCH' | 'PERSON' = 'BATCH', modelSha?: string): Promise<{ run: string; output: string; flag: string }> {
  const input = [{ view: 'report.batch_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 1, sha256: SHA }];
  const [r] = await analyticsQuery<{ id: string }>("select analytics.begin_run($1, 1, null, 'ON_DEMAND', $2::jsonb, $3::jsonb) as id", [method, JSON.stringify(input), JSON.stringify(RUNTIME)]);
  const run = r!.id;
  const values = modelSha ? { modelSha256: modelSha } : { centre: 7.5 };
  const [o] = await analyticsQuery<{ id: string }>('select analytics.record_output($1, $2, $3, $4, $5::jsonb, \'[]\') as id', [
    run, kind === 'PERSON' ? 'PERSON' : 'GROUP', kind === 'PERSON' ? randomUUID() : 'PCM-500|GRAN', modelSha ? 'MODEL_CANDIDATE' : 'CONTROL_CHART', JSON.stringify(values),
  ]);
  const [f] = await analyticsQuery<{ id: string }>(
    "select analytics.record_flag($1, $2, $3, $4, 'NELSON_1', 'HIGH', '[{\"code\": \"NELSON_1\", \"text\": \"beyond three sigma\"}]') as id",
    [run, o!.id, kind === 'PERSON' ? 'PERSON' : 'BATCH', randomUUID()],
  );
  await analyticsQuery('select analytics.finish_run($1, $2, $3)', [run, SHA, '{}']);
  return { run, output: o!.id, flag: f!.id };
}

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureFixtureChangeRecord(db);
  sysAdmin = (await seedAdministration(db)).admin;
  // The Tablets grants of tablets 1330 (the kernel's template has no edition migrations), as a release writes them.
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(jsonb_build_object(
      'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
      'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
      'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (analytics)',
      'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture'))`);
    await c.query(`insert into iam.role_permission (role_code, permission_code) values
      ('QA_REVIEWER', 'ANALYTICS.METHOD'), ('PROCESS_OWNER', 'ANALYTICS.METHOD'), ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'),
      ('CSV_DI_LEAD', 'ANALYTICS.DISPOSITION'), ('CSV_DI_LEAD', 'ANALYTICS.DI_REVIEW')`);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } finally {
    c.release();
  }
  [qa, owner, diLead, operator] = await Promise.all([
    seedActor(db, { roleCode: 'QA_REVIEWER' }),
    seedActor(db, { roleCode: 'PROCESS_OWNER' }),
    seedActor(db, { roleCode: 'CSV_DI_LEAD' }),
    seedActor(db, { roleCode: 'OPERATOR' }),
  ]);
}, 300_000);

afterAll(async () => {
  await db?.drop();
});

describe('method versions under change control (kernel 1245)', () => {
  it('[DI-52][DI-09] a method version without an approved change record is refused; a person holding ANALYTICS.METHOD writes it under one, and an administrator never does', async () => {
    await expect(setVersion(sysAdmin, definition())).rejects.toThrow(/EBMR-IAM-042/);
    await expect(setVersion(underChange(sysAdmin), definition())).rejects.toThrow(/EBMR-IAM-042/);
    await expect(setVersion(underChange(operator), definition())).rejects.toThrow(/EBMR-IAM-040/);
    await expect(setVersion(qa, definition())).rejects.toThrow(/EBMR-CFG-001/);
    await expect(setVersion(underChange(qa, 'CR-NOT-THERE'), definition())).rejects.toThrow(/EBMR-CFG-002/);
    for (const bad of [{ method: 'drift' }, { version: 0 }, { version: 1.5 }, { status: 'DRAFT' }, { intendedUse: ' ' }, { parameters: [] }, { parametersSha256: 'x' }, { validationRef: '' }]) {
      await expect(setVersion(underChange(qa), definition(bad)), JSON.stringify(bad)).rejects.toThrow(/EBMR-ANA-015/);
    }
    await expect(db.app.query('select analytics.set_method_version($1::jsonb)', [JSON.stringify(definition())])).rejects.toThrow(/EBMR-IAM/);
    expect(await effectiveNow('DRIFT.TREND')).toEqual([]);
    const id = await setVersion(underChange(owner), definition());
    expect(await effectiveNow('DRIFT.TREND')).toEqual([1]);
    // A configuration version naming the change record and the person, and an audit entry under the person.
    const { rows } = await db.admin.query<{ basis: string; cr: string; person: string }>(
      `select v.basis, c.number as cr, v.person_id::text as person from platform.config_version v join platform.change_record c on c.id = v.change_record_id
        where v.area = 'ANALYTICS_METHOD' and v.source_row ->> 'id' = $1`, [id]);
    expect(rows).toEqual([{ basis: 'CHANGE_RECORD', cr: FIXTURE_CHANGE_RECORD, person: owner.personId }]);
    const { rows: audit } = await db.admin.query<{ person: string }>(
      "select payload -> 'actor' ->> 'person_id' as person from kernel.audit_event where table_name = 'analytics.method_version' and chain_key = $1", ['analytics_method:DRIFT.TREND']);
    expect(audit.map((a) => a.person)).toContain(owner.personId);
  });

  it('[DI-52] a method version never changes: retuning is a new version, a retired version stays retired, and the configuration of a past instant shows the methods then in force', async () => {
    const method = 'RATE.DEVIATION';
    await expect(setVersion(underChange(qa), definition({ method, status: 'RETIRED' }))).rejects.toThrow(/EBMR-ANA-013/);
    await setVersion(underChange(qa), definition({ method }));
    const before = (await db.admin.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]!.t;
    // The same version with other parameters, another intended use, other code, or EFFECTIVE again: refused.
    for (const change of [{ parameters: { slopeWindow: 12 }, parametersSha256: 'd'.repeat(64) }, { intendedUse: 'another use' }, { codeIdentity: '@ebmr/analytics 0.2.0' }, {}]) {
      await expect(setVersion(underChange(qa), definition({ method, ...change })), JSON.stringify(change)).rejects.toThrow(/EBMR-ANA-013/);
    }
    // Not in place either, even as the release (which passes the change-control guard), nor as a changed row.
    const asRelease = async (sql: string) => {
      const c = await db.admin.connect();
      try {
        await c.query('begin');
        await c.query(`select kernel.set_actor_context(jsonb_build_object(
          'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
          'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
          'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture', 'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test'))`);
        await c.query(sql, [method]);
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    await expect(asRelease("update analytics.method_version set parameters = '{}' where method = $1")).rejects.toThrow(/EBMR-AUDIT-004/);
    await expect(asRelease(`insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
                            values ($1, 1, 'RETIRED', 't', 'u', '{}', '{"slopeWindow": 99}', '${SHA}', 'c', 'v')`)).rejects.toThrow(/EBMR-ANA-013/);
    // A new version with the new parameters, then the old one retired.
    await setVersion(underChange(qa), definition({ method, version: 2, parameters: { slopeWindow: 12 }, parametersSha256: 'd'.repeat(64) }));
    await setVersion(underChange(qa), definition({ method, status: 'RETIRED' }));
    expect(await effectiveNow(method)).toEqual([2]);
    await expect(setVersion(underChange(qa), definition({ method }))).rejects.toThrow(/EBMR-ANA-013/);
    await expect(setVersion(underChange(qa), definition({ method, status: 'RETIRED' }))).rejects.toThrow(/EBMR-ANA-013/);
    // As of the earlier instant only version 1 was in force.
    const { rows: asOf } = await db.admin.query<{ key: string }>(
      "select c.item_key as key from platform.config_as_of($1::timestamptz) c join platform.config_version v on v.id = c.version_id where c.area = 'ANALYTICS_METHOD' and c.item_key like $2 and v.source_row ->> 'status' = 'EFFECTIVE' order by 1",
      [before, `${method}|%`]);
    expect(asOf.map((r) => r.key)).toEqual([`${method}|1`]);
    // The methods page's view: each row with its validity and change record.
    const { rows: view } = await db.app.query<{ version: number; status: string; open: boolean; change_record: string; basis: string }>(
      'select version, status, valid_to is null as open, change_record, basis from analytics.method_version_v1 where method = $1 order by version, valid_from', [method]);
    expect(view).toEqual([
      { version: 1, status: 'EFFECTIVE', open: false, change_record: FIXTURE_CHANGE_RECORD, basis: 'CHANGE_RECORD' },
      { version: 1, status: 'RETIRED', open: true, change_record: FIXTURE_CHANGE_RECORD, basis: 'CHANGE_RECORD' },
      { version: 2, status: 'EFFECTIVE', open: true, change_record: FIXTURE_CHANGE_RECORD, basis: 'CHANGE_RECORD' },
    ]);
  });

  it('[DI-52][DI-09] a reference set is written under an approved change record, is its candidate\'s model, never changes and retires once', async () => {
    const method = 'MSPC.PCA';
    await setVersion(underChange(qa), definition({ method }));
    const { output } = await finishedRun(method, 'BATCH', SHA);
    const set = (ctx: ActorContext, over: Record<string, unknown> = {}) =>
      withCommand(db.app, again(ctx), async (c) => (await c.query<{ id: string }>('select analytics.set_reference_set($1::jsonb) as id', [JSON.stringify({
        method, scope: { product: 'PCM-500' }, batchIds: [randomUUID()], candidateOutput: output, model: { components: 2 }, modelSha256: SHA, status: 'EFFECTIVE', ...over,
      })])).rows[0]!.id);
    await expect(set(underChange(sysAdmin))).rejects.toThrow(/EBMR-IAM-042/);
    await expect(set(underChange(operator))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(set(qa)).rejects.toThrow(/EBMR-CFG-001/);
    await expect(set(underChange(qa), { modelSha256: 'e'.repeat(64) })).rejects.toThrow(/EBMR-ANA-010/);
    for (const bad of [{ batchIds: [] }, { batchIds: ['x'] }, { candidateOutput: 'x' }, { scope: 'all' }, { id: 7 }]) {
      await expect(set(underChange(qa), bad), JSON.stringify(bad)).rejects.toThrow(/EBMR-ANA-015/);
    }
    await expect(set(underChange(qa), { id: randomUUID(), status: 'RETIRED' })).rejects.toThrow(/EBMR-ANA-014/);
    const batches = [randomUUID(), randomUUID()];
    const id = await set(underChange(qa), { batchIds: batches });
    const [run] = await analyticsQuery<{ id: string }>("select analytics.begin_run($1, 1, $2, 'SCHEDULED', $3::jsonb, $4::jsonb) as id", [
      method, id, JSON.stringify([{ view: 'report.batch_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 1, sha256: SHA }]), JSON.stringify(RUNTIME),
    ]);
    expect(run!.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(set(underChange(qa), { id, batchIds: [randomUUID()], status: 'RETIRED' })).rejects.toThrow(/EBMR-ANA-014/);
    await expect(set(underChange(qa), { id, batchIds: batches })).rejects.toThrow(/EBMR-ANA-014/);
    await set(underChange(qa), { id, batchIds: batches, status: 'RETIRED' });
    await expect(set(underChange(qa), { id, batchIds: batches, status: 'RETIRED' })).rejects.toThrow(/EBMR-ANA-014/);
    const { rows } = await db.app.query<{ status: string; open: boolean; change_record: string }>(
      'select status, valid_to is null as open, change_record from analytics.reference_set_v1 where reference_set_id = $1 order by valid_from', [id]);
    expect(rows).toEqual([{ status: 'EFFECTIVE', open: false, change_record: FIXTURE_CHANGE_RECORD }, { status: 'RETIRED', open: true, change_record: FIXTURE_CHANGE_RECORD }]);
  });
});

describe('the flags views (kernel 1245)', () => {
  it('[DI-52] the flags view shows every unrestricted flag of a completed run with its current disposition; the dispositions view marks the current one', async () => {
    await setVersion(underChange(qa), definition({ method: 'SPC.IMR' }));
    const { flag } = await finishedRun('SPC.IMR');
    const dispose = (ctx: ActorContext, cause: string, supersedes: string | null, reason: string | null) =>
      withCommand(db.app, again(ctx), async (c) =>
        (await c.query<{ id: string }>("select analytics.record_disposition($1, 'FALSE_ALARM', $2, null, $3, $4) as id", [flag, cause, supersedes, reason])).rows[0]!.id);
    const current = async () => (await db.app.query<{ d: string | null }>('select current_disposition::text as d from analytics.flag_v1 where flag_id = $1', [flag])).rows;
    expect(await current()).toEqual([{ d: null }]);
    const first = await dispose(qa, 'gauge recalibrated before the batch', null, null);
    const second = await dispose(diLead, 'gauge recalibrated, confirmed by records', first, 'calibration record found');
    expect(await current()).toEqual([{ d: second }]);
    const { rows } = await db.app.query<{ id: string; current: boolean; person: string }>(
      'select disposition_id::text as id, current, person_id::text as person from analytics.flag_disposition_v1 where flag_id = $1 order by recorded_at', [flag]);
    expect(rows).toEqual([{ id: first, current: false, person: qa.personId }, { id: second, current: true, person: diLead.personId }]);
    // A run not yet finished shows nothing.
    const input = [{ view: 'report.batch_fact_v1', version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 1, sha256: SHA }];
    const [open] = await analyticsQuery<{ id: string }>("select analytics.begin_run('SPC.IMR', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb) as id", [JSON.stringify(input), JSON.stringify(RUNTIME)]);
    await analyticsQuery("select analytics.record_flag($1, null, 'BATCH', 'B-1', 'NELSON_1', 'HIGH', '[{\"code\": \"NELSON_1\", \"text\": \"x\"}]')", [open!.id]);
    expect((await db.app.query('select 1 from analytics.flag_v1 where run_id = $1', [open!.id])).rowCount).toBe(0);
  });

  it('[DI-53] a person flag and its dispositions are unreadable without ANALYTICS.DI_REVIEW, also through the app role directly', async () => {
    await setVersion(underChange(qa), definition({ method: 'ATA.RULES' }));
    const { flag } = await finishedRun('ATA.RULES', 'PERSON');
    await withCommand(db.app, again(diLead), (c) => c.query("select analytics.record_disposition($1, 'NOT_ASSESSABLE', 'shift change entries, documented', null, null, null)", [flag]));
    for (const view of ['analytics.flag_v1', 'analytics.flag_disposition_v1']) {
      expect((await db.app.query(`select * from ${view} where flag_id = $1`, [flag])).rowCount, view).toBe(0);
    }
    await expect(db.app.query('select * from analytics.flag_disposition')).rejects.toThrow(/permission denied/);
    const read = (ctx: ActorContext) => withCommand(db.app, again(ctx), async (c) => (await c.query<{ verdict: string }>('select verdict from analytics.person_flag_dispositions($1)', [flag])).rows);
    expect(await read(diLead)).toEqual([{ verdict: 'NOT_ASSESSABLE' }]);
    await expect(read(qa)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(read(sysAdmin)).rejects.toThrow(/EBMR-IAM-042/);
    await expect(db.app.query('select * from analytics.person_flag_dispositions($1)', [flag])).rejects.toThrow(/EBMR-IAM/);
  });
});
