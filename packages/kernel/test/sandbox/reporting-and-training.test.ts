/**
 * Phase 6 slice 6g (kernel 1210, 1211; D-P6g-0-1 to 3, D-P6g-0-9): the reporting role reads the report views and can
 * write nothing (bypass tests as ebmr_report, and the segregation check that reports any extra grant), and training
 * mode keeps its attempts in the sandbox only (DI-05, INV-18).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { segregationProblems } from '../../src/sandbox/provision.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { SANDBOX_LOGIN, attempt, provisionTestSandbox, type TestSandbox } from './helpers.ts';

const REPORT_LOGIN = { name: 'ebmr_report', password: 'ebmr_report' };

let gmp: TestDatabase;
let sbx: TestSandbox;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([createTestDatabase(), provisionTestSandbox()]);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.drop(), sbx?.drop()]);
});

/** Runs each statement on its own as ebmr_report in the GMP database; returns the error of each (null: it ran). */
async function asReport(statements: string[]): Promise<Record<string, string | null>> {
  const client = new pg.Client({ connectionString: urlFor(gmp.name, REPORT_LOGIN) });
  await client.connect();
  const out: Record<string, string | null> = {};
  try {
    for (const s of statements) {
      try {
        await client.query(s);
        out[s] = null;
      } catch (e) {
        out[s] = (e as Error).message;
      }
    }
  } finally {
    await client.end();
  }
  return out;
}

describe('the reporting role (kernel 1210)', () => {
  it('the reporting role cannot write: no insert, update, delete, command or other schema, and the segregation check reports any extra grant', async () => {
    // It reads the report views.
    const reads = await asReport(['select * from report.catalog_v1', 'select * from report.batch_outcome_v1', 'select * from report.alarm_v1']);
    expect(Object.values(reads)).toEqual([null, null, null]);
    // Every write path is refused by a privilege, before any trigger or function runs.
    const writes = await asReport([
      "insert into report.view_registry (view_name, version, grain, description) values ('x_v1', 1, 'x', 'x')",
      "delete from report.view_registry",
      "update report.catalog_v1 set grain = 'x'",
      "insert into report.catalog_v1 (view_name) values ('x_v1')",
      'delete from kernel.audit_event',
      'select * from iam.person',
      'select * from recipe.batch_execution',
      'select * from site.deviation',
      "select kernel.begin_command('{}'::jsonb)",
      "select sandbox.start_training('EX-1', 1, 1)",
      'select report.batch_version(gen_random_uuid())',
      'select * from report.batch_outcome_rows_v1() where false',
      'create table report.probe (a int)',
      'create table public.probe (a int)',
      'create temporary table probe (a int)',
      'set role ebmr_app',
      'set role ebmr_owner',
    ]);
    for (const [statement, error] of Object.entries(writes)) {
      if (statement.startsWith('select * from report.batch_outcome_rows_v1')) {
        // The row function behind a view is granted (a view's functions run with the reader's own right); it reads only.
        expect(error, statement).toBeNull();
        continue;
      }
      expect(error, statement).toMatch(/permission denied|cannot (insert|update|delete)|must be owner/);
    }
    // In a GMP database the role holds only what reading the views needs.
    expect(await segregationProblems(gmp.app)).toEqual([]);
    // Any extra grant is reported.
    await gmp.admin.query('grant select on recipe.batch_execution to ebmr_report');
    await gmp.admin.query('grant usage on schema recipe to ebmr_report');
    await gmp.admin.query('grant execute on function sandbox.start_training(text, integer, integer) to ebmr_report');
    await gmp.admin.query('grant usage on schema sandbox to ebmr_report');
    try {
      const problems = await segregationProblems(gmp.app);
      expect(problems).toEqual(expect.arrayContaining([
        'ebmr_report holds SELECT on table recipe.batch_execution, beyond reading the report views',
        'ebmr_report holds USAGE on schema recipe, beyond reading the report views',
        'ebmr_report holds USAGE on schema sandbox, beyond reading the report views',
        'ebmr_report holds EXECUTE on routine sandbox.start_training(text,integer,integer), beyond reading the report views',
        'ebmr_report may execute the volatile function sandbox.start_training(text,integer,integer)',
      ]));
    } finally {
      await gmp.admin.query('revoke select on recipe.batch_execution from ebmr_report');
      await gmp.admin.query('revoke usage on schema recipe, sandbox from ebmr_report');
      await gmp.admin.query('revoke execute on function sandbox.start_training(text, integer, integer) from ebmr_report');
    }
    expect(await segregationProblems(gmp.app)).toEqual([]);
  });

  it('the reporting role is a member of nothing, has no elevated attribute and never connects to a sandbox', async () => {
    const { rows } = await gmp.admin.query<{ rolinherit: boolean; rolsuper: boolean; rolcreaterole: boolean; rolbypassrls: boolean; rolconnlimit: number; members: number }>(
      `select r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolbypassrls, r.rolconnlimit,
              (select count(*)::int from pg_catalog.pg_auth_members m where m.member = r.oid or m.roleid = r.oid) as members
         from pg_catalog.pg_roles r where r.rolname = 'ebmr_report'`,
    );
    expect(rows).toEqual([{ rolinherit: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolconnlimit: 4, members: 0 }]);
    expect(await attempt(sbx.name, REPORT_LOGIN)).toMatch(/permission denied for database/);
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
    // A grant of CONNECT on the sandbox is reported.
    await sbx.admin.query(`grant connect on database ${sbx.name} to ebmr_report`);
    try {
      expect(await segregationProblems(sbx.sandbox)).toContain(`the reporting role ebmr_report can connect to the sandbox database ${sbx.name}`);
    } finally {
      await sbx.admin.query(`revoke connect on database ${sbx.name} from ebmr_report`);
    }
  });

  it('every report view carries its read time and data age, and the catalogue lists each view with its columns', async () => {
    const { rows } = await gmp.app.query<{ view_name: string; columns: { name: string }[]; age: string }>(
      "select view_name, columns, (read_at - data_as_of)::text as age from report.catalog_v1 order by view_name",
    );
    expect(rows.map((r) => r.view_name)).toEqual(expect.arrayContaining(['catalog_v1', 'batch_outcome_v1', 'exception_v1', 'deviation_ageing_v1',
      'hold_time_risk_v1', 'overdue_review_v1', 'press_counter_v1', 'alarm_v1']));
    for (const r of rows) {
      expect(r.columns.map((c) => c.name), r.view_name).toEqual(expect.arrayContaining(['read_at', 'data_as_of']));
      // On a primary the data is current at the read (age zero or a few microseconds).
      expect(r.age).toMatch(/^00:00:00(\.\d+)?$/);
    }
    const { rows: views } = await gmp.admin.query<{ v: string }>(
      "select c.relname as v from pg_catalog.pg_class c where c.relnamespace = 'report'::regnamespace and c.relkind = 'v' order by 1",
    );
    expect(views.map((v) => v.v).sort()).toEqual(rows.map((r) => r.view_name).sort());
  });
});

describe('training attempts stay in the sandbox (kernel 1211)', () => {
  it('[DI-05] the training attempts are refused in a GMP database, whoever writes', async () => {
    const actor = await seededTestActor(gmp);
    await expect(withCommand(gmp.app, { ...actor, correlationId: randomUUID() }, (c) => c.query("select sandbox.start_training('EX-FLOOR-1', 1, 3)")))
      .rejects.toThrow(/Training runs only on the sandbox installation.*EBMR-SBX-039/);
    // Not even the table owner or a superuser can put training state into a GMP database.
    await expect(gmp.admin.query(
      "insert into sandbox.training_attempt (exercise_code, exercise_version, step_count, person_id, account_id) values ('EX-FLOOR-1', 1, 3, gen_random_uuid(), gen_random_uuid())",
    )).rejects.toThrow(/EBMR-SBX-039/);
    expect((await gmp.admin.query('select count(*)::int as n from sandbox.training_attempt')).rows[0]).toEqual({ n: 0 });
    // The application role cannot write the tables directly either.
    await expect(gmp.app.query(
      "insert into sandbox.training_attempt (exercise_code, exercise_version, step_count, person_id, account_id) values ('EX-FLOOR-1', 1, 3, gen_random_uuid(), gen_random_uuid())",
    )).rejects.toThrow(/permission denied/);
  });

  it('[DI-05] a training session cannot write to the GMP database', async () => {
    // The training session's only credential is the sandbox role: it cannot open the GMP database at all.
    expect(await attempt(gmp.name, SANDBOX_LOGIN, "select sandbox.start_training('EX-FLOOR-1', 1, 3)")).toMatch(/permission denied for database/);
    // Inside the sandbox the store accepts training state (the person rules of the commands are proven through the
    // training routes, apps/tablets-server training tests); it stays insert-only, and a command needs a session.
    const { rows } = await sbx.admin.query<{ id: string }>(
      "insert into sandbox.training_attempt (exercise_code, exercise_version, step_count, person_id, account_id) values ('EX-FLOOR-1', 1, 3, gen_random_uuid(), gen_random_uuid()) returning id::text",
    );
    const attemptId = rows[0]!.id;
    await sbx.admin.query('insert into sandbox.training_step (attempt_id, step_no, person_id) select id, 1, person_id from sandbox.training_attempt where id = $1', [attemptId]);
    await expect(sbx.sandbox.query("select sandbox.start_training('EX-FLOOR-1', 1, 3)")).rejects.toThrow();
    await expect(sbx.sandbox.query('delete from sandbox.training_step')).rejects.toThrow(/permission denied/);
    await expect(sbx.admin.query('delete from sandbox.training_step')).rejects.toThrow();
    expect((await sbx.admin.query('select count(*)::int as n from sandbox.training_step where attempt_id = $1', [attemptId])).rows[0]).toEqual({ n: 1 });
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
  });
});
