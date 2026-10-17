/**
 * Phase 6A slice 6A-0 (kernel 1240 to 1244; ADR 0020; draft controls DI-51, DI-52, DI-53): the analytics role reads its
 * catalogued inputs and records advisory outputs, and can write nothing else (bypass tests as ebmr_analytics, and the
 * segregation check that reports any extra grant, on the model of slice 6g's reporting role); nothing outside the
 * analytics schema depends on it; no floating-point column exists outside it; its tables are insert-only and audited;
 * method versions and reference sets change only under an approved change record; runs, outputs, flags and
 * dispositions keep their rules; flags about a person are readable only with ANALYTICS.DI_REVIEW.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { segregationProblems } from '../../src/sandbox/provision.ts';
import { ensureFixtureChangeRecord, FIXTURE_CHANGE_RECORD, underChange } from '../support/change-record.ts';
import { createTestDatabase, urlFor, type TestDatabase } from '../support/db.ts';
import { seedActor, seedAdministration, type SeededActor } from '../identity/seed.ts';
import { attempt, provisionTestSandbox, type TestSandbox } from '../sandbox/helpers.ts';

const ANALYTICS_LOGIN = { name: 'ebmr_analytics', password: 'ebmr_analytics' };
const INPUT = 'report.batch_outcome_v1';
const SHA = 'a'.repeat(64);
const RUNTIME = { package: '@ebmr/analytics 0.1.0', commit: '0a1b2c3', node: '22.20.0', libraries: {} };

let gmp: TestDatabase;
let sbx: TestSandbox;
let qa: SeededActor;
let diLead: SeededActor;
let operator: SeededActor;
let sysAdmin: SeededActor;

const RELEASE = `jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', 'Test fixture (analytics)',
  'reason_code', 'SOFTWARE_RELEASE', 'reason_text', 'test fixture')`;

/** Runs statements as the software release (what a migration does), in one transaction. */
async function asRelease(db: TestDatabase, statements: string[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query(`select kernel.set_actor_context(${RELEASE})`);
    for (const s of statements) await c.query(s);
    await c.query('select kernel.set_actor_context(null)');
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

/** Runs each statement on its own as ebmr_analytics; returns the error of each (null: it ran). */
async function asAnalytics(db: TestDatabase, statements: string[]): Promise<Record<string, string | null>> {
  const client = new pg.Client({ connectionString: urlFor(db.name, ANALYTICS_LOGIN) });
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

/** One query as ebmr_analytics. */
async function analyticsQuery<T extends pg.QueryResultRow>(db: TestDatabase, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: urlFor(db.name, ANALYTICS_LOGIN) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

const again = <T extends ActorContext>(ctx: T): T => ({ ...ctx, correlationId: randomUUID() });

/** A method version row, written under the fixture change record (or the context given). */
async function writeMethodVersion(db: TestDatabase, ctx: ActorContext, method: string, version: number, status = 'EFFECTIVE'): Promise<void> {
  await withCommand(db.admin, again(ctx), (c) =>
    c.query(
      `insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
       values ($1, $2, $3, 'Test method', 'advisory test', '{"within": "1e-9"}', '{"phaseOneBatches": 20}', $4, '@ebmr/analytics 0.1.0', 'VAL-TEST-1')`,
      [method, version, status, SHA],
    ),
  );
}

const input = (over: Record<string, unknown> = {}) => [{ view: INPUT, version: 1, filter: null, data_as_of: '2026-10-12T04:40:00Z', rows: 3, sha256: SHA, ...over }];

/** Begins a run of SPC.IMR v1 as the analytics role; returns its id. */
async function beginRun(db: TestDatabase, method = 'SPC.IMR'): Promise<string> {
  const rows = await analyticsQuery<{ id: string }>(db, "select analytics.begin_run($1, 1, null, 'ON_DEMAND', $2::jsonb, $3::jsonb) as id", [
    method, JSON.stringify(input()), JSON.stringify(RUNTIME),
  ]);
  return rows[0]!.id;
}

/** A finished run with one output and one flag about subject kind `kind`; returns the flag id. */
async function finishedFlag(db: TestDatabase, kind = 'BATCH', ref = randomUUID()): Promise<{ run: string; flag: string; output: string }> {
  const run = await beginRun(db, kind === 'PERSON' ? 'ATA.RULES' : 'SPC.IMR');
  const [o] = await analyticsQuery<{ id: string }>(db, "select analytics.record_output($1, $2, $3, 'CONTROL_CHART', '{\"centre\": 7.5}', '[]') as id", [run, kind, ref]);
  const [f] = await analyticsQuery<{ id: string }>(db, "select analytics.record_flag($1, $2, $3, $4, 'NELSON_2', 'ATTENTION', '[{\"code\": \"NELSON_2\", \"text\": \"nine in a row above the centre\"}]') as id", [
    run, o!.id, kind, ref,
  ]);
  await analyticsQuery(db, 'select analytics.finish_run($1, $2, $3)', [run, SHA, '{"outputs": 1, "flags": 1}']);
  return { run, flag: f!.id, output: o!.id };
}

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([createTestDatabase(), provisionTestSandbox()]);
  await ensureFixtureChangeRecord(gmp);
  sysAdmin = (await seedAdministration(gmp)).admin;
  // The Tablets grants of tablets 1330, as a release writes them (the kernel's template has no edition migrations).
  await asRelease(gmp, [
    `insert into iam.role_permission (role_code, permission_code) values
       ('QA_REVIEWER', 'ANALYTICS.VIEW'), ('QA_REVIEWER', 'ANALYTICS.DISPOSITION'),
       ('CSV_DI_LEAD', 'ANALYTICS.DISPOSITION'), ('CSV_DI_LEAD', 'ANALYTICS.DI_REVIEW')`,
    // Recipe-core 1115 (slice 6A-1) registers it in the template; registered here only where it is not.
    `select analytics.register_input('VIEW', '${INPUT}', 1, '6A-1', 'GMP batch', 'test input: the batch outcomes')
      where not exists (select 1 from analytics.input_registry where name = '${INPUT}')`,
  ]);
  [qa, diLead, operator] = await Promise.all([
    seedActor(gmp, { roleCode: 'QA_REVIEWER' }),
    seedActor(gmp, { roleCode: 'CSV_DI_LEAD' }),
    seedActor(gmp, { roleCode: 'OPERATOR' }),
  ]);
  for (const m of ['SPC.IMR', 'ATA.RULES']) await writeMethodVersion(gmp, underChange(qa), m, 1);
}, 300_000);

afterAll(async () => {
  await Promise.all([gmp?.drop(), sbx?.drop()]);
});

describe('the analytics role (kernel 1240, 1242)', () => {
  it('[DI-51] the analytics role cannot write: no insert, update or delete outside analytics, no command, and the segregation check reports any extra grant', async () => {
    // It reads its catalogued inputs, the catalogue and the methods in force, and records through the runner functions.
    const reads = await asAnalytics(gmp, [`select * from ${INPUT}`, 'select * from analytics.input_catalog_v1', 'select * from analytics.effective_methods()']);
    expect(Object.values(reads)).toEqual([null, null, null]);
    await expect(beginRun(gmp)).resolves.toMatch(/^[0-9a-f-]{36}$/);
    // Every other path is refused by a privilege, before any trigger or function runs.
    const attempts = await asAnalytics(gmp, [
      "insert into analytics.run (id, method, version, trigger, inputs, runtime) values (gen_random_uuid(), 'SPC.IMR', 1, 'ON_DEMAND', '[{}]', '{}')",
      'update analytics.output set kind = kind',
      'delete from analytics.flag',
      'select * from analytics.flag',
      'select * from analytics.output_v1',
      "insert into analytics.method_version (method) values ('SPC.IMR')",
      'delete from kernel.audit_event',
      'select * from iam.person',
      'select * from recipe.batch_execution',
      'select * from site.deviation',
      'select * from report.catalog_v1',
      'select * from report.exception_v1',
      "select kernel.begin_command('{}'::jsonb)",
      "select analytics.record_disposition(gen_random_uuid(), 'FALSE_ALARM', 'not a real problem at all', null, null, null)",
      "select * from analytics.person_flags(now() - interval '1 day', now())",
      "select analytics.register_input('VIEW', 'report.catalog_v1', 1, '6A-1', 'x', 'x')",
      'select * from analytics.role_problems()',
      'create table analytics.probe (a int)',
      'create table report.probe (a int)',
      'create table public.probe (a int)',
      'create temporary table probe (a int)',
      'set role ebmr_app',
      'set role ebmr_owner',
    ]);
    for (const [statement, error] of Object.entries(attempts)) expect(error, statement).toMatch(/permission denied|must be owner/);
    // Over the whole catalogue: no table outside analytics it may change, and none it may read but its inputs.
    const { rows } = await gmp.admin.query<{ t: string; write: boolean }>(`
      select c.oid::regclass::text as t,
             has_table_privilege('ebmr_analytics', c.oid, 'INSERT') or has_table_privilege('ebmr_analytics', c.oid, 'UPDATE')
             or has_table_privilege('ebmr_analytics', c.oid, 'DELETE') or has_table_privilege('ebmr_analytics', c.oid, 'TRUNCATE') as write
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%'
         and (has_table_privilege('ebmr_analytics', c.oid, 'SELECT') or has_table_privilege('ebmr_analytics', c.oid, 'INSERT')
              or has_table_privilege('ebmr_analytics', c.oid, 'UPDATE') or has_table_privilege('ebmr_analytics', c.oid, 'DELETE')
              or has_table_privilege('ebmr_analytics', c.oid, 'TRUNCATE'))
         and has_schema_privilege('ebmr_analytics', n.oid, 'USAGE')
       order by 1`);
    // Exactly the catalogue and the catalogued views (slice 6A-1 registers its inputs in recipe-core 1115), none writable.
    const { rows: catalogued } = await gmp.admin.query<{ name: string }>("select name from analytics.input_catalog_v1 where kind = 'VIEW'");
    expect(catalogued.map((c) => c.name)).toContain(INPUT);
    expect(rows).toEqual(['analytics.input_catalog_v1', ...catalogued.map((c) => c.name)].sort().map((t) => ({ t, write: false })));
    // In a GMP database the role holds only what its inputs and the runner functions need.
    expect(await segregationProblems(gmp.app)).toEqual([]);
    // Any extra grant is reported.
    await gmp.admin.query('grant select on report.exception_v1 to ebmr_analytics');
    await gmp.admin.query('grant usage on schema recipe to ebmr_analytics');
    await gmp.admin.query('grant insert on analytics.output to ebmr_analytics');
    await gmp.admin.query('grant execute on function analytics.record_disposition(uuid, text, text, text, uuid, text) to ebmr_analytics');
    try {
      expect(await segregationProblems(gmp.app)).toEqual(expect.arrayContaining([
        'ebmr_analytics holds SELECT on table report.exception_v1, beyond reading its catalogued inputs and recording advisory outputs',
        'ebmr_analytics holds USAGE on schema recipe, beyond reading its catalogued inputs and recording advisory outputs',
        'ebmr_analytics holds INSERT on table analytics.output, beyond reading its catalogued inputs and recording advisory outputs',
        'ebmr_analytics holds EXECUTE on routine analytics.record_disposition(uuid,text,text,text,uuid,text), beyond reading its catalogued inputs and recording advisory outputs',
        'ebmr_analytics may execute the volatile function analytics.record_disposition(uuid,text,text,text,uuid,text)',
      ]));
    } finally {
      await gmp.admin.query('revoke select on report.exception_v1 from ebmr_analytics');
      await gmp.admin.query('revoke usage on schema recipe from ebmr_analytics');
      await gmp.admin.query('revoke insert on analytics.output from ebmr_analytics');
      await gmp.admin.query('revoke execute on function analytics.record_disposition(uuid, text, text, text, uuid, text) from ebmr_analytics');
    }
    expect(await segregationProblems(gmp.app)).toEqual([]);
  });

  it('[DI-51] the segregation check reports the analytics role missing, each elevated attribute alone and a membership either way; the role never connects to a sandbox', async () => {
    const inTx = async (change: string): Promise<string[]> => {
      const c = await gmp.admin.connect();
      try {
        await c.query('begin');
        await c.query(change);
        return (await c.query<{ p: string }>('select p from sandbox.segregation_problems() p')).rows.map((r) => r.p);
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    const elevated = 'ebmr_analytics has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
    for (const attr of ['superuser', 'createdb', 'createrole', 'replication', 'bypassrls', 'inherit']) {
      expect(await inTx(`alter role ebmr_analytics ${attr}`), attr).toContain(elevated);
    }
    expect(await inTx('grant ebmr_app to ebmr_analytics')).toContain('ebmr_analytics is a member of role ebmr_app');
    expect(await inTx('grant ebmr_analytics to ebmr_app')).toContain('ebmr_app is a member of role ebmr_analytics');
    expect(await inTx('alter role ebmr_analytics rename to ebmr_analytics_renamed_by_test')).toContain('the analytics role ebmr_analytics does not exist');
    expect(await inTx('alter default privileges in schema report grant select on tables to ebmr_analytics')).toContain(
      'a default privilege grants to ebmr_analytics (schema report)',
    );
    const { rows } = await gmp.admin.query<Record<string, unknown>>(
      `select r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreaterole, r.rolbypassrls, r.rolconnlimit,
              (select count(*)::int from pg_catalog.pg_auth_members m where m.member = r.oid or m.roleid = r.oid) as members
         from pg_catalog.pg_roles r where r.rolname = 'ebmr_analytics'`,
    );
    expect(rows).toEqual([{ rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolconnlimit: 4, members: 0 }]);
    // GMP: it connects. Sandbox: it does not, and a CONNECT given there is reported.
    expect(await attempt(gmp.name, ANALYTICS_LOGIN)).toBeNull();
    expect(await attempt(sbx.name, ANALYTICS_LOGIN)).toMatch(/permission denied for database/);
    expect(await segregationProblems(sbx.sandbox)).toEqual([]);
    await sbx.admin.query(`grant connect on database ${sbx.name} to ebmr_analytics`);
    try {
      expect(await segregationProblems(sbx.sandbox)).toContain(`the analytics role ebmr_analytics can connect to the sandbox database ${sbx.name}`);
    } finally {
      await sbx.admin.query(`revoke connect on database ${sbx.name} from ebmr_analytics`);
    }
  });

  it('[DI-51] no GMP table, function, view or trigger depends on the analytics schema', async () => {
    // Catalogue dependencies (foreign keys, views, triggers, defaults, types, functions' argument and result types):
    // nothing outside the schema refers to an object in it (a table's own TOAST storage aside).
    const { rows: edges } = await gmp.admin.query<{ dependent: string; on: string }>(`
      with a as (select 'analytics'::regnamespace as ns),
      ref as (
        select d.classid, d.objid, d.refclassid, d.refobjid from pg_depend d
         where (d.refclassid = 'pg_class'::regclass and exists (select 1 from pg_class c where c.oid = d.refobjid and c.relnamespace = (select ns from a)))
            or (d.refclassid = 'pg_proc'::regclass and exists (select 1 from pg_proc p where p.oid = d.refobjid and p.pronamespace = (select ns from a)))
            or (d.refclassid = 'pg_type'::regclass and exists (select 1 from pg_type t where t.oid = d.refobjid and t.typnamespace = (select ns from a)))),
      owner_ns as (
        select r.*, case r.classid
          when 'pg_class'::regclass then (select c.relnamespace from pg_class c where c.oid = r.objid)
          when 'pg_proc'::regclass then (select p.pronamespace from pg_proc p where p.oid = r.objid)
          when 'pg_type'::regclass then (select t.typnamespace from pg_type t where t.oid = r.objid)
          when 'pg_rewrite'::regclass then (select c.relnamespace from pg_rewrite w join pg_class c on c.oid = w.ev_class where w.oid = r.objid)
          when 'pg_trigger'::regclass then (select c.relnamespace from pg_trigger g join pg_class c on c.oid = g.tgrelid where g.oid = r.objid)
          when 'pg_constraint'::regclass then (select coalesce(c.relnamespace, k.connamespace) from pg_constraint k left join pg_class c on c.oid = k.conrelid where k.oid = r.objid)
          when 'pg_attrdef'::regclass then (select c.relnamespace from pg_attrdef ad join pg_class c on c.oid = ad.adrelid where ad.oid = r.objid)
          when 'pg_policy'::regclass then (select c.relnamespace from pg_policy pl join pg_class c on c.oid = pl.polrelid where pl.oid = r.objid)
          end as ns
        from ref r)
      select pg_describe_object(classid, objid, 0) as dependent, pg_describe_object(refclassid, refobjid, 0) as on
        from owner_ns where ns is distinct from (select ns from a) and ns is distinct from 'pg_toast'::regnamespace order by 1, 2`);
    expect(edges).toEqual([]);
    // Function bodies are not in pg_depend: no routine outside the schema names it, but the segregation check, which
    // reads the analytics role's allowances (analytics.role_problems) and writes nothing.
    const { rows: bodies } = await gmp.admin.query<{ fn: string; volatile: boolean }>(`
      select p.oid::regprocedure::text as fn, p.provolatile = 'v' as volatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema', 'analytics') and p.prosrc ~* '\\manalytics\\s*\\.' order by 1`);
    expect(bodies).toEqual([{ fn: 'sandbox.segregation_problems()', volatile: false }]);
    // No trigger outside the schema runs an analytics function, and no foreign key points into it.
    const { rows: triggers } = await gmp.admin.query(`
      select g.tgname from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc p on p.oid = g.tgfoid
       where c.relnamespace <> 'analytics'::regnamespace and p.pronamespace = 'analytics'::regnamespace`);
    expect(triggers).toEqual([]);
    const { rows: fks } = await gmp.admin.query(`
      select k.conname from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class f on f.oid = k.confrelid
       where k.contype = 'f' and c.relnamespace <> 'analytics'::regnamespace and f.relnamespace = 'analytics'::regnamespace`);
    expect(fks).toEqual([]);
    // The scan sees dependencies: inside the schema, the views depend on the tables (since kernel 1280 the flag views
    // read the flags through analytics.flag_grouped).
    const { rows: inside } = await gmp.admin.query<{ n: number }>(`
      select count(*)::int as n from pg_depend d join pg_rewrite w on d.classid = 'pg_rewrite'::regclass and d.objid = w.oid
       where w.ev_class = 'analytics.flag_grouped'::regclass and d.refobjid = 'analytics.flag'::regclass`);
    expect(inside[0]!.n).toBeGreaterThan(0);
  });

  it('[DI-51] no floating-point column exists outside the analytics schema', async () => {
    const { rows } = await gmp.admin.query<{ col: string; inside: boolean }>(`
      select c.oid::regclass::text || '.' || a.attname as col, c.relnamespace = 'analytics'::regnamespace as inside
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        join pg_type t on t.oid = a.atttypid
        left join pg_type b on b.oid = t.typbasetype
        left join pg_type e on e.oid = t.typelem
       where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c')
         and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%'
         and ('float4'::regtype in (t.oid, b.oid, e.oid) or 'float8'::regtype in (t.oid, b.oid, e.oid))
       order by 1`);
    expect(rows.filter((r) => !r.inside).map((r) => r.col)).toEqual([]);
    // Statistics live in the analytics schema (the review priority's score and the monitor's rates).
    expect(rows.map((r) => r.col)).toEqual(expect.arrayContaining(['analytics.review_priority_v1.score', 'analytics.method_monitor_v1.false_alarm_rate']));
  });
});

describe('the analytics tables (kernel 1241)', () => {
  it('[DI-51] analytics tables refuse update and delete, whoever writes', async () => {
    const { run, flag, output } = await finishedFlag(gmp);
    const d = await withCommand(gmp.app, again(qa), async (c) =>
      (await c.query<{ id: string }>("select analytics.record_disposition($1, 'TRUE_SIGNAL', 'confirmed on the batch record', null, null, null) as id", [flag])).rows[0]!.id,
    );
    const attempts: [string, string][] = [
      ['update analytics.run set trigger = trigger where id = $1', run],
      ['delete from analytics.run_end where run = $1', run],
      ['update analytics.output set kind = kind where id = $1', output],
      ['delete from analytics.flag where id = $1', flag],
      ["update analytics.flag_disposition set cause = 'changed afterwards!' where id = $1", d],
      ["update analytics.method_version set status = 'RETIRED' where method = $1", 'SPC.IMR'],
      ['delete from analytics.input_registry where name = $1', INPUT],
    ];
    for (const [sql, id] of attempts) {
      // Even the superuser, even inside a command with a reason and the change record: insert-only. (Without a command,
      // the configuration guard of a method version refuses the update first.)
      await expect(gmp.admin.query(sql, [id]), sql).rejects.toThrow(/EBMR-AUDIT-004|EBMR-CFG-001/);
      await expect(withCommand(gmp.admin, { ...again(underChange(qa)), reasonCode: 'CORRECTION', reasonText: 'test' }, (c) => c.query(sql, [id])), sql).rejects.toThrow(/EBMR-AUDIT-004/);
      // The application role has no privilege on a table at all.
      await expect(gmp.app.query(sql, [id]), sql).rejects.toThrow(/permission denied/);
    }
    for (const t of ['run', 'run_end', 'output', 'flag', 'flag_disposition', 'method_version', 'reference_set', 'input_registry']) {
      await expect(gmp.admin.query(`truncate analytics.${t} cascade`), t).rejects.toThrow(/EBMR-AUDIT-004/);
    }
  });

  it('[DI-52] the analytics tables are insert-only and audited: the runner\'s rows carry its identity and run, a disposition the person who gave it', async () => {
    const { rows: reg } = await gmp.admin.query<{ t: string; insert_only: boolean }>(`
      select c.oid::regclass::text as t, a.insert_only from pg_class c left join kernel.audited_table a on a.table_name = c.oid
       where c.relnamespace = 'analytics'::regnamespace and c.relkind = 'r' order by 1`);
    expect(reg).toEqual(['flag', 'flag_disposition', 'input_registry', 'method_version', 'output', 'reference_set', 'run', 'run_end'].map((t) => ({ t: `analytics.${t}`, insert_only: true })));
    expect((await gmp.admin.query<{ ok: boolean }>('select kernel.audit_triggers_ok() as ok')).rows[0]!.ok).toBe(true);
    const { run, flag } = await finishedFlag(gmp);
    const { rows: events } = await gmp.admin.query<{ table_name: string; role: string; person: string; correlation: string }>(
      `select table_name, payload -> 'actor' ->> 'role_code' as role, payload -> 'actor' ->> 'person_id' as person, correlation_id::text as correlation
         from kernel.audit_event where chain_key = $1 order by seq`,
      [`analytics_run:${run}`],
    );
    expect(events.map((e) => e.table_name)).toEqual(['analytics.run', 'analytics.output', 'analytics.run_end']);
    expect(new Set(events.map((e) => `${e.role}|${e.person}|${e.correlation}`))).toEqual(new Set([`ANALYTICS_RUNNER|00000000-0000-0000-0000-000000000000|${run}`]));
    await withCommand(gmp.app, again(qa), (c) => c.query("select analytics.record_disposition($1, 'FALSE_ALARM', 'sensor drift fixed before the batch', null, null, null)", [flag]));
    const { rows: chain } = await gmp.admin.query<{ table_name: string; role: string; person: string }>(
      `select table_name, payload -> 'actor' ->> 'role_code' as role, payload -> 'actor' ->> 'person_id' as person
         from kernel.audit_event where chain_key = $1 order by seq`,
      [`analytics_flag:${flag}`],
    );
    expect(chain).toEqual([
      { table_name: 'analytics.flag', role: 'ANALYTICS_RUNNER', person: '00000000-0000-0000-0000-000000000000' },
      { table_name: 'analytics.flag_disposition', role: 'QA_REVIEWER', person: qa.personId },
    ]);
    expect((await gmp.admin.query('select * from kernel.verify_chain($1)', [`analytics_run:${run}`])).rows).toEqual([]);
    expect((await gmp.admin.query('select * from kernel.verify_chain($1)', [`analytics_flag:${flag}`])).rows).toEqual([]);
    // The runner's identity is put in place for its own insert only: no context is left behind for a later write.
    const client = new pg.Client({ connectionString: urlFor(gmp.name, ANALYTICS_LOGIN) });
    await client.connect();
    try {
      await client.query('begin');
      await client.query("select analytics.begin_run('SPC.IMR', 1, null, 'ON_DEMAND', $1::jsonb, $2::jsonb)", [JSON.stringify(input()), JSON.stringify(RUNTIME)]);
      expect((await client.query<{ ctx: string }>("select coalesce(current_setting('ebmr.ctx', true), '') as ctx")).rows[0]!.ctx).toBe('');
      await client.query('commit');
    } finally {
      await client.end();
    }
  });

  it('[DI-52] a method version without an approved change record is refused', async () => {
    // Without a change record in the command, with one that does not exist, and without a command at all.
    await expect(writeMethodVersion(gmp, qa, 'DRIFT.TREND', 1)).rejects.toThrow(/EBMR-CFG-001/);
    await expect(writeMethodVersion(gmp, underChange(qa, 'CR-DOES-NOT-EXIST'), 'DRIFT.TREND', 1)).rejects.toThrow(/EBMR-CFG-002/);
    await expect(gmp.admin.query(
      `insert into analytics.method_version (method, version, status, title, intended_use, acceptance, parameters, parameters_sha256, code_identity, validation_ref)
       values ('DRIFT.TREND', 1, 'EFFECTIVE', 't', 'u', '{}', '{}', $1, 'c', 'v')`, [SHA],
    )).rejects.toThrow(/EBMR-CFG-001/);
    expect((await analyticsQuery(gmp, "select * from analytics.effective_methods() where method = 'DRIFT.TREND'"))).toEqual([]);
    // Under the approved change record it is a configuration version naming that record, and in force at once.
    await writeMethodVersion(gmp, underChange(qa), 'DRIFT.TREND', 1);
    const { rows } = await gmp.admin.query<{ basis: string; cr: string }>(
      `select v.basis, c.number as cr from platform.config_version v join platform.change_record c on c.id = v.change_record_id
        where v.area = 'ANALYTICS_METHOD' and v.item_key = 'DRIFT.TREND|1'`,
    );
    expect(rows).toEqual([{ basis: 'CHANGE_RECORD', cr: FIXTURE_CHANGE_RECORD }]);
    expect((await analyticsQuery<{ method: string }>(gmp, "select method from analytics.effective_methods() where method = 'DRIFT.TREND'")).map((r) => r.method)).toEqual(['DRIFT.TREND']);
    // Retiring it is a new row under change control; it is no longer in force, and a run of it is refused.
    await writeMethodVersion(gmp, underChange(qa), 'DRIFT.TREND', 1, 'RETIRED');
    expect(await analyticsQuery(gmp, "select * from analytics.effective_methods() where method = 'DRIFT.TREND'")).toEqual([]);
    await expect(beginRun(gmp, 'DRIFT.TREND')).rejects.toThrow(/EBMR-ANA-001/);
    // A reference set too needs the change record.
    const { output } = await finishedFlag(gmp);
    const refSet = (ctx: ActorContext) => withCommand(gmp.admin, again(ctx), (c) =>
      c.query(`insert into analytics.reference_set (id, method, scope, batch_ids, candidate_output, model, model_sha256, status)
               values (gen_random_uuid(), 'SPC.IMR', '{}', array[gen_random_uuid()], $1, '{}', $2, 'EFFECTIVE')`, [output, SHA]));
    await expect(refSet(qa)).rejects.toThrow(/EBMR-CFG-001/);
  });

  it('[DI-52] a reference set whose model hash differs from its candidate is refused', async () => {
    // The candidate: a MODEL_CANDIDATE output of a completed run of the method, with its model hash.
    const run = await beginRun(gmp);
    const [cand] = await analyticsQuery<{ id: string }>(gmp, "select analytics.record_output($1, 'GROUP', 'PCM-500|GRAN', 'MODEL_CANDIDATE', $2::jsonb, '[]') as id", [
      run, JSON.stringify({ modelSha256: SHA }),
    ]);
    const refSet = (outputId: string, sha: string, method = 'SPC.IMR') => withCommand(gmp.admin, again(underChange(qa)), (c) =>
      c.query<{ id: string }>(`insert into analytics.reference_set (id, method, scope, batch_ids, candidate_output, model, model_sha256, status)
               values (gen_random_uuid(), $3, '{"product": "PCM-500"}', array[gen_random_uuid()], $1, '{"centre": 7.5}', $2, 'EFFECTIVE') returning id::text`, [outputId, sha, method]));
    // Before the run completes, the candidate does not count.
    await expect(refSet(cand!.id, SHA)).rejects.toThrow(/EBMR-ANA-010/);
    await analyticsQuery(gmp, 'select analytics.finish_run($1, $2, $3)', [run, SHA, '{}']);
    await expect(refSet(cand!.id, 'b'.repeat(64))).rejects.toThrow(/EBMR-ANA-010/);
    await expect(refSet(cand!.id, SHA, 'ATA.RULES')).rejects.toThrow(/EBMR-ANA-010/);
    const { output: notCandidate } = await finishedFlag(gmp);
    await expect(refSet(notCandidate, SHA)).rejects.toThrow(/EBMR-ANA-010/);
    const ok = await refSet(cand!.id, SHA);
    const id = ok.rows[0]!.id;
    // In force now: a run may name it, and one naming another set or another method's is refused.
    const runWith = (set: string, method = 'SPC.IMR') => analyticsQuery(gmp, "select analytics.begin_run($1, 1, $2, 'SCHEDULED', $3::jsonb, $4::jsonb)", [
      method, set, JSON.stringify(input()), JSON.stringify(RUNTIME),
    ]);
    await expect(runWith(id)).resolves.toHaveLength(1);
    await expect(runWith(randomUUID())).rejects.toThrow(/EBMR-ANA-002/);
    await expect(runWith(id, 'ATA.RULES')).rejects.toThrow(/EBMR-ANA-002/);
  });
});

describe('the runner functions (kernel 1242) and the read views (kernel 1243)', () => {
  it('[DI-52] a run is refused unless its method version and reference set are in force and its inputs and runtime are complete; it records outputs and flags until it ends, once, and the views count it only when DONE', async () => {
    const begin = (method: string, version: number, trigger: string, inputs: unknown, runtime: unknown = RUNTIME) =>
      analyticsQuery(gmp, 'select analytics.begin_run($1, $2, null, $3, $4::jsonb, $5::jsonb)', [method, version, trigger, JSON.stringify(inputs), JSON.stringify(runtime)]);
    await expect(begin('SPC.IMR', 2, 'ON_DEMAND', input())).rejects.toThrow(/EBMR-ANA-001/);
    await expect(begin('CAP.INDEX', 1, 'ON_DEMAND', input())).rejects.toThrow(/EBMR-ANA-001/);
    await expect(begin('SPC.IMR', 1, 'NIGHTLY', input())).rejects.toThrow(/EBMR-ANA-003/);
    await expect(begin('SPC.IMR', 1, 'ON_DEMAND', [])).rejects.toThrow(/EBMR-ANA-003/);
    for (const bad of [{ view: 'report.exception_v1' }, { version: 2 }, { rows: -1 }, { rows: 1.5 }, { sha256: 'abc' }, { data_as_of: 'not a time' }, { filter: 'all' }]) {
      await expect(begin('SPC.IMR', 1, 'ON_DEMAND', input(bad)), JSON.stringify(bad)).rejects.toThrow(/EBMR-ANA-003/);
    }
    const { data_as_of: _d, ...noAsOf } = input()[0]!;
    void _d;
    await expect(begin('SPC.IMR', 1, 'ON_DEMAND', [noAsOf])).rejects.toThrow(/EBMR-ANA-003/);
    await expect(begin('SPC.IMR', 1, 'ON_DEMAND', input(), { package: 'x', commit: 'y', node: 'z' })).rejects.toThrow(/EBMR-ANA-003/);

    const run = await beginRun(gmp);
    const ref = randomUUID();
    const out = (r: string, kind = 'BATCH', values = '{"centre": 7.5}') =>
      analyticsQuery<{ id: string }>(gmp, "select analytics.record_output($1, $2, $3, 'CONTROL_CHART', $4::jsonb, '[]') as id", [r, kind, ref, values]);
    const flag = (r: string, reasons: string, output: string | null = null) =>
      analyticsQuery<{ id: string }>(gmp, "select analytics.record_flag($1, $2, 'BATCH', $3, 'NELSON_1', 'HIGH', $4::jsonb) as id", [r, output, ref, reasons]);
    await expect(out(randomUUID())).rejects.toThrow(/EBMR-ANA-005/);
    await expect(out(run, 'OPERATOR')).rejects.toThrow(/EBMR-ANA-011/);
    await expect(out(run, 'BATCH', '[1]')).rejects.toThrow(/EBMR-ANA-011/);
    const [o] = await out(run);
    for (const reasons of ['[]', '[{"code": "NELSON_1"}]', '[{"code": " ", "text": "x"}]', '"x"']) await expect(flag(run, reasons), reasons).rejects.toThrow(/EBMR-ANA-004/);
    const other = await beginRun(gmp);
    const [otherOut] = await out(other);
    await expect(flag(run, '[{"code": "NELSON_1", "text": "beyond 3 sigma"}]', otherOut!.id)).rejects.toThrow(/EBMR-ANA-011/);
    await flag(run, '[{"code": "NELSON_1", "text": "beyond 3 sigma"}]', o!.id);
    // Until it is finished, the views show nothing of it.
    const shown = async (r: string) => ({
      outputs: (await gmp.app.query('select * from analytics.output_v1 where run_id = $1', [r])).rowCount,
      flags: (await gmp.app.query('select * from analytics.open_flag_v1 where run_id = $1', [r])).rowCount,
    });
    expect(await shown(run)).toEqual({ outputs: 0, flags: 0 });
    await expect(analyticsQuery(gmp, 'select analytics.finish_run($1, $2, $3)', [run, 'xyz', '{}'])).rejects.toThrow(/EBMR-ANA-011/);
    await analyticsQuery(gmp, 'select analytics.finish_run($1, $2, $3)', [run, SHA, '{"outputs": 1}']);
    expect(await shown(run)).toEqual({ outputs: 1, flags: 1 });
    const { rows: v } = await gmp.app.query<{ method: string; version: number; advisory: boolean; data_as_of: Date }>(
      'select method, version, advisory, data_as_of from analytics.output_v1 where run_id = $1', [run]);
    expect(v.map((r) => ({ ...r, data_as_of: r.data_as_of.toISOString() }))).toEqual([{ method: 'SPC.IMR', version: 1, advisory: true, data_as_of: '2026-10-12T04:40:00.000Z' }]);
    // A run ends once; an ended run records nothing more.
    await expect(analyticsQuery(gmp, 'select analytics.finish_run($1, $2, $3)', [run, SHA, '{}'])).rejects.toThrow(/EBMR-ANA-006/);
    await expect(analyticsQuery(gmp, 'select analytics.fail_run($1, $2)', [run, 'late failure'])).rejects.toThrow(/EBMR-ANA-006/);
    await expect(out(run)).rejects.toThrow(/EBMR-ANA-005/);
    await expect(flag(run, '[{"code": "NELSON_1", "text": "x"}]')).rejects.toThrow(/EBMR-ANA-005/);
    // A failed run leaves no output in the views; the monitor counts it as a failure.
    await expect(analyticsQuery(gmp, 'select analytics.fail_run($1, $2)', [other, ' '])).rejects.toThrow(/EBMR-ANA-011/);
    await analyticsQuery(gmp, 'select analytics.fail_run($1, $2)', [other, 'input view timed out']);
    expect(await shown(other)).toEqual({ outputs: 0, flags: 0 });
    const { rows: monitor } = await gmp.app.query<{ runs: number; failures: number; flags: number }>(
      "select sum(runs)::int as runs, sum(failures)::int as failures, sum(flags)::int as flags from analytics.method_monitor_v1 where method = 'SPC.IMR'");
    expect(monitor[0]!.failures).toBeGreaterThanOrEqual(1);
    expect(monitor[0]!.flags).toBeGreaterThanOrEqual(1);
    expect(monitor[0]!.runs).toBeGreaterThan(monitor[0]!.failures);
  });

  it('[DI-52] a disposition is recorded by the person who gave it, audited, and superseded only with a reason', async () => {
    const { flag } = await finishedFlag(gmp);
    const dispose = (ctx: ActorContext, verdict: string, cause: string, supersedes: string | null = null, reason: string | null = null, onFlag = flag) =>
      withCommand(gmp.app, again(ctx), async (c) =>
        (await c.query<{ id: string }>('select analytics.record_disposition($1, $2, $3, null, $4, $5) as id', [onFlag, verdict, cause, supersedes, reason])).rows[0]!.id);
    // Administrators are refused first (DI-18), a person without the permission next (DI-17).
    await expect(dispose(sysAdmin, 'FALSE_ALARM', 'an administrator decides nothing here')).rejects.toThrow(/EBMR-IAM-042/);
    await expect(dispose(operator, 'FALSE_ALARM', 'an operator decides nothing here')).rejects.toThrow(/EBMR-IAM-040/);
    await expect(dispose(qa, 'IGNORED', 'not a verdict of the list')).rejects.toThrow(/EBMR-ANA-009/);
    await expect(dispose(qa, 'FALSE_ALARM', 'too short')).rejects.toThrow(/EBMR-ANA-009/);
    await expect(dispose(qa, 'FALSE_ALARM', 'an unknown flag is refused', null, null, randomUUID())).rejects.toThrow(/EBMR-ANA-009/);
    await expect(dispose(qa, 'FALSE_ALARM', 'nothing to supersede yet', randomUUID(), 'why')).rejects.toThrow(/EBMR-ANA-008/);
    const first = await dispose(qa, 'FALSE_ALARM', 'sensor offset corrected before the batch');
    // The flag is no longer open.
    expect((await gmp.app.query('select * from analytics.open_flag_v1 where flag_id = $1', [flag])).rowCount).toBe(0);
    // A second disposition must supersede the current one, with a reason, on the same flag.
    await expect(dispose(diLead, 'TRUE_SIGNAL', 'seen again on the next batch')).rejects.toThrow(/EBMR-ANA-008/);
    await expect(dispose(diLead, 'TRUE_SIGNAL', 'seen again on the next batch', first)).rejects.toThrow(/EBMR-ANA-008/);
    await expect(dispose(diLead, 'TRUE_SIGNAL', 'seen again on the next batch', first, '  ')).rejects.toThrow(/EBMR-ANA-008/);
    const { flag: otherFlag } = await finishedFlag(gmp);
    await expect(dispose(diLead, 'TRUE_SIGNAL', 'superseding across two flags', first, 'wrong flag', otherFlag)).rejects.toThrow(/EBMR-ANA-008/);
    const second = await dispose(diLead, 'TRUE_SIGNAL', 'seen again on the next batch', first, 'new evidence from batch 25');
    await expect(dispose(qa, 'NOT_ASSESSABLE', 'the earlier one is not current any more', first, 'stale')).rejects.toThrow(/EBMR-ANA-008/);
    const { rows } = await gmp.admin.query<{ id: string; person_id: string; account_id: string; supersedes: string | null; reason: string | null }>(
      'select id::text, person_id::text, account_id::text, supersedes::text, reason from analytics.flag_disposition where flag = $1 order by recorded_at', [flag]);
    expect(rows).toEqual([
      { id: first, person_id: qa.personId, account_id: qa.accountId, supersedes: null, reason: null },
      { id: second, person_id: diLead.personId, account_id: diLead.accountId, supersedes: first, reason: 'new evidence from batch 25' },
    ]);
    const { rows: audit } = await gmp.admin.query<{ person: string }>(
      "select payload -> 'actor' ->> 'person_id' as person from kernel.audit_event where chain_key = $1 and table_name = 'analytics.flag_disposition' order by seq", [`analytics_flag:${flag}`]);
    expect(audit.map((a) => a.person)).toEqual([qa.personId, diLead.personId]);
    // Outside a command nothing is recorded.
    await expect(gmp.app.query("select analytics.record_disposition($1, 'FALSE_ALARM', 'no command around this one', null, null, null)", [flag])).rejects.toThrow(/EBMR-IAM/);
  });

  it('[DI-53] a person flag is unreadable without ANALYTICS.DI_REVIEW, also through the app role directly', async () => {
    const person = randomUUID();
    const { flag } = await finishedFlag(gmp, 'PERSON', person);
    const window = "now() - interval '1 day', now() + interval '1 day'";
    const read = (ctx: ActorContext) => withCommand(gmp.app, again(ctx), async (c) => (await c.query<{ id: string }>(`select id::text from analytics.person_flags(${window})`)).rows.map((r) => r.id));
    expect(await read(diLead)).toContain(flag);
    await expect(read(qa)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(read(operator)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(read(sysAdmin)).rejects.toThrow(/EBMR-IAM-042/);
    // The application role cannot reach it by any other road: no table privilege, no view shows it.
    await expect(gmp.app.query('select * from analytics.flag')).rejects.toThrow(/permission denied/);
    await expect(gmp.app.query('select * from analytics.output')).rejects.toThrow(/permission denied/);
    for (const view of ['analytics.open_flag_v1', 'analytics.output_v1']) {
      const { rows } = await gmp.app.query(`select * from ${view} where subject_ref = $1`, [person]);
      expect(rows, view).toEqual([]);
    }
    await expect(gmp.app.query(`select * from analytics.person_flags(${window})`)).rejects.toThrow(/EBMR-IAM/);
    // A restricted flag is dispositioned only with ANALYTICS.DI_REVIEW too.
    const dispose = (ctx: ActorContext) => withCommand(gmp.app, again(ctx), (c) =>
      c.query("select analytics.record_disposition($1, 'FALSE_ALARM', 'documented shift-change entry', null, null, null)", [flag]));
    await expect(dispose(qa)).rejects.toThrow(/EBMR-ANA-007/);
    await expect(dispose(diLead)).resolves.toBeDefined();
  });

  it('[DI-17][DI-18] every analytics function the application may call refuses administrators, then checks a catalogued permission; the runner functions are the analytics role\'s alone', async () => {
    const { rows } = await gmp.admin.query<{ fn: string; src: string; app: boolean; analytics: boolean; definer: boolean; volatile: boolean }>(`
      select p.oid::regprocedure::text as fn, p.prosrc as src, has_function_privilege('ebmr_app', p.oid, 'EXECUTE') as app,
             has_function_privilege('ebmr_analytics', p.oid, 'EXECUTE') as analytics, p.prosecdef as definer, p.provolatile = 'v' as volatile
        from pg_proc p where p.pronamespace = 'analytics'::regnamespace order by 1`);
    const appVolatile = rows.filter((r) => r.app && r.volatile);
    expect(appVolatile.map((r) => r.fn)).toEqual([
      // Slice 6A-4 (kernel 1261, recipe-core 1151): the audit-trail flags by key and the entries behind them, for
      // data-integrity review only.
      'analytics.audit_flag_entries(uuid)',
      'analytics.audit_flagged_entries(uuid)',
      'analytics.audit_flags(timestamp with time zone,timestamp with time zone)',
      'analytics.person_flag_dispositions(uuid)',
      'analytics.person_flags(timestamp with time zone,timestamp with time zone)',
      'analytics.record_disposition(uuid,text,text,text,uuid,text)',
      // Slice 6A-1 (kernel 1245): method versions and reference sets under change control.
      'analytics.set_method_version(jsonb)',
      'analytics.set_reference_set(jsonb)',
      // Slice 6A-7 (kernel 1281): whether the reader may see the review priority's audit-trail term (DI-53).
      'analytics.viewer_holds_di_review()',
    ]);
    const { rows: perms } = await gmp.admin.query<{ code: string }>("select code from iam.permission where code like 'ANALYTICS.%'");
    const known = new Set(perms.map((p) => p.code));
    for (const f of appVolatile) {
      const guard = f.src.indexOf('iam.assert_not_administrator()');
      const check = f.src.indexOf('iam.require_permission(');
      expect(guard, f.fn).toBeGreaterThanOrEqual(0);
      expect(check, f.fn).toBeGreaterThan(guard);
      const literals = [...f.src.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? '');
      expect(literals.length, f.fn).toBeGreaterThan(0);
      expect(literals.filter((p) => !known.has(p)), f.fn).toEqual([]);
    }
    expect(rows.filter((r) => r.analytics).map((r) => r.fn)).toEqual([
      'analytics.begin_run(text,integer,uuid,text,jsonb,jsonb)',
      'analytics.effective_methods()',
      'analytics.fail_run(uuid,text)',
      'analytics.finish_run(uuid,text,jsonb)',
      'analytics.record_flag(uuid,uuid,text,text,text,text,jsonb)',
      'analytics.record_output(uuid,text,text,text,jsonb,jsonb)',
    ]);
    // Every definer pins its search path to pg_catalog then pg_temp.
    const { rows: paths } = await gmp.admin.query<{ fn: string; cfg: string[] | null }>(
      "select p.oid::regprocedure::text as fn, p.proconfig as cfg from pg_proc p where p.pronamespace = 'analytics'::regnamespace and p.prosecdef order by 1");
    for (const p of paths) expect(p.cfg, p.fn).toEqual(['search_path=pg_catalog, pg_temp']);
    // The permissions: VIEW and DI_REVIEW read, DISPOSITION and METHOD governance writes (no GMP data changes).
    const { rows: catalogue } = await gmp.admin.query("select code, domain, effect from iam.permission where code like 'ANALYTICS.%' order by code");
    expect(catalogue).toEqual([
      { code: 'ANALYTICS.DISPOSITION', domain: 'GOVERNANCE', effect: 'WRITE' },
      { code: 'ANALYTICS.DI_REVIEW', domain: 'READ_ONLY', effect: 'READ' },
      { code: 'ANALYTICS.METHOD', domain: 'GOVERNANCE', effect: 'WRITE' },
      { code: 'ANALYTICS.VIEW', domain: 'READ_ONLY', effect: 'READ' },
    ]);
  });
});
