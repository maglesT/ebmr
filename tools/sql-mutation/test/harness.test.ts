/**
 * The SQL mutation harness beyond its mutators: where the definitions come from (every SQL directory, in the order the
 * test set-ups apply them), that every target function resolves to a live definition in a database its tests use, that
 * a mutant is applied as CREATE OR REPLACE keeping everything but the body, that the server tests' set-up takes
 * prepared templates only when EBMR_SERVER_TEMPLATES names them, and the check run the weekly workflow publishes for a
 * group.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  PREPARED_TEMPLATES_ENV,
  readPreparedTemplates,
  serverTemplatesFor,
  type ServerTemplates,
} from '../../../apps/tablets-server/test/support/global-setup.ts';
import { ADMIN_URL, urlFor } from '../../../packages/kernel/test/support/db.ts';
import { checkRunPayload, TEXT_LIMIT } from '../src/check-run.ts';
import { mutantsOf } from '../src/mutators.ts';
import {
  checkDefinition,
  copyTemplate,
  definitionsFor,
  failures,
  highestDatabaseOid,
  loadDefinitions,
  privilegeDifferences,
  projectOf,
  sqlSources,
  sweepLeftovers,
  testsByProject,
  testsFor,
  writeServerTemplates,
  type Result,
} from '../src/run.ts';
import { TARGETS } from '../src/targets.ts';

const ROOT = new URL('../../../', import.meta.url).pathname;
type SiteSeed = ServerTemplates['gmp']['seed'];
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ebmr-sql-mutation-test-'));
  scratch.push(d);
  return d;
}

describe('the definitions the harness mutates', () => {
  it('[meta] come from every SQL directory, in the order the test set-ups migrate: kernel, site services, recipe-core, tablets', () => {
    expect(sqlSources()).toEqual([
      { namespace: 'kernel', directory: 'packages/kernel/sql' },
      { namespace: 'site-services', directory: 'packages/site-services/sql' },
      { namespace: 'recipe-core', directory: 'packages/recipe-core/sql' },
      { namespace: 'tablets', directory: 'apps/tablets-server/sql' },
    ]);
    const defs = loadDefinitions();
    const fileOf = (identity: string) => defs.get(identity)?.file;
    // One from each directory.
    expect(fileOf('kernel.begin_command(jsonb)')).toMatch(/^packages\/kernel\/sql\//);
    expect(fileOf('site.site_zone_row_guard()')).toBe('packages/site-services/sql/0700_batch_number_site_zone.sql');
    expect(fileOf('recipe.execution_weighing_item_check()')).toBe('packages/recipe-core/sql/0323_weighing_counted_item.sql');
    expect(fileOf('tab.bind_session(uuid, text, text)')).toBe('apps/tablets-server/sql/0480_bind_session_needs_live_role.sql');
    // A function redefined later is taken from its last definition: kernel.is_blank from kernel 0960 (first 0010),
    // recipe.check_signatures from recipe-core 0471 (seven definitions), tab.record_heartbeat from tablets 0350.
    expect(fileOf('kernel.is_blank(text)')).toBe('packages/kernel/sql/0960_visible_reason_text.sql');
    expect([...defs.values()].filter((d) => d.name === 'recipe.check_signatures').map((d) => d.file)).toEqual([
      'packages/recipe-core/sql/0471_approved_act_signatures.sql',
    ]);
    expect([...defs.values()].filter((d) => d.name === 'tab.record_heartbeat').map((d) => d.file)).toEqual([
      'apps/tablets-server/sql/0350_scale_room_locks_and_report_evidence.sql',
    ]);
    // A dropped function is gone, and a drop followed by a new signature leaves only the new one.
    expect([...defs.values()].some((d) => d.name === 'tab.chain_readable')).toBe(false);
    expect([...defs.values()].filter((d) => d.name === 'recipe.end_open_cells').map((d) => d.identity)).toEqual(['recipe.end_open_cells(uuid, uuid)']);
    expect([...defs.values()].filter((d) => d.name === 'tab.ingest_reading').map((d) => d.file)).toEqual([
      'apps/tablets-server/sql/0330_reading_freshness_challenge.sql',
    ]);
  });

  it('[meta] a definition in a later directory replaces an earlier one with the same argument types; a drop removes it; an overload stays apart', () => {
    const first = tempDir();
    const second = tempDir();
    mkdirSync(join(first, 'sql'));
    mkdirSync(join(second, 'sql'));
    const fn = (name: string, args: string, body: string) => `create or replace function ${name}(${args}) returns int language sql as $$ ${body} $$;\n`;
    writeFileSync(join(first, 'sql/0100_a.sql'), fn('demo.f', 'p_a integer', 'select 1') + fn('demo.g', 'p text', 'select 1') + fn('demo.h', 'p int', 'select 1'));
    writeFileSync(join(first, 'sql/0200_b.sql'), fn('demo.f', 'p_a int', 'select 2') + fn('demo.f', 'p_a int, p_b text', 'select 3'));
    writeFileSync(join(second, 'sql/0050_c.sql'), `${fn('demo.f', 'p_a int4', 'select 4')}drop function demo.g(text);\n`);
    const defs = loadDefinitions([
      { namespace: 'one', directory: join(first, 'sql') },
      { namespace: 'two', directory: join(second, 'sql') },
    ]);
    const bodies = [...defs.values()].map((d) => `${d.identity} ${d.statement.slice(d.bodyStart, d.bodyEnd).trim()} ${d.file.split('/').pop() ?? ''}`);
    // The second directory's 0050 comes after the first's 0200: directories in order, files in order within each.
    expect(bodies.sort()).toEqual([
      'demo.f(integer) select 4 0050_c.sql',
      'demo.f(integer, text) select 3 0200_b.sql',
      'demo.h(integer) select 1 0100_a.sql',
    ]);
  });

  it('[meta] every target function resolves to a live definition, in one group only; every group has a unique name, test files that exist, a 90 % target and a job in the weekly workflow', () => {
    const defs = loadDefinitions();
    expect(new Set(TARGETS.map((t) => t.group)).size).toBe(TARGETS.length);
    for (const t of TARGETS) {
      expect(t.threshold, t.group).toBe(90);
      expect(t.functions.length, t.group).toBeGreaterThan(0);
      expect(new Set(t.functions).size, `${t.group}: a function named twice`).toBe(t.functions.length);
      for (const f of testsFor(t)) expect(existsSync(join(ROOT, f)), `${t.group}: ${f}`).toBe(true);
      const found = definitionsFor(t, defs);
      for (const name of t.functions) expect(found.some((d) => d.name === name), `${t.group}: ${name}`).toBe(true);
      // A function of the tablets SQL exists only in the server set-up's databases, so its group needs server tests.
      const projects = [...testsByProject(t).keys()];
      for (const d of found.filter((x) => x.file.startsWith('apps/tablets-server/sql/'))) expect(projects, `${t.group}: ${d.name}`).toContain('server');
    }
    // No function is in two groups (its mutants would be run, and counted, twice).
    const names = TARGETS.flatMap((t) => t.functions);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    // The weekly workflow runs every group, one job each.
    const workflow = readFileSync(join(ROOT, '.github/workflows/mutation.yml'), 'utf8');
    const matrix = /\n\s*group: \[([^\]]*)\]/.exec(workflow)?.[1] ?? '';
    expect(matrix.split(',').map((g) => g.trim())).toEqual(TARGETS.map((t) => t.group));
  });

  it('[meta] a group runs each Vitest project with its own files: apps/tablets-server/test in server, the rest in db, kill tests included', () => {
    expect(projectOf('apps/tablets-server/test/execution/store.test.ts')).toBe('server');
    expect(projectOf('packages/recipe-core/test/execution/sql-guards.test.ts')).toBe('db');
    expect(projectOf('packages/kernel/test/mutation/signing.test.ts')).toBe('db');
    const t = TARGETS.find((x) => x.group === 'execution-commands');
    expect(t).toBeDefined();
    const by = testsByProject(t!);
    expect([...by.keys()].sort()).toEqual(['db', 'server']);
    expect(by.get('server')?.every((f) => f.startsWith('apps/tablets-server/test/'))).toBe(true);
    expect(by.get('db')?.some((f) => f.startsWith('apps/'))).toBe(false);
    // The Phase 1 groups' kill tests are picked up by group name.
    const signing = TARGETS.find((x) => x.group === 'signing');
    expect(testsFor(signing!)).toContain('packages/kernel/test/mutation/signing.test.ts');
  });
});

describe('a mutant is the function re-created, nothing else changed', () => {
  it('[meta] re-applying a definition as its owner keeps owner, grants, SECURITY DEFINER and search_path; the check names what a statement would change', async () => {
    const name = `ebmr_t_${randomBytes(6).toString('hex')}`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    await server.query(`create database ${name} template ${inject('templateDb')}`);
    try {
      const c = new pg.Client({ connectionString: urlFor(name) });
      await c.connect();
      try {
        const defs = loadDefinitions();
        const def = [...defs.values()].find((d) => d.name === 'recipe.check_signatures');
        expect(def).toBeDefined();
        const unchanged = await checkDefinition(c, def!);
        expect(unchanged).toEqual({ owner: 'ebmr_owner', problems: [] });
        const head = def!.statement.slice(0, def!.bodyStart);
        expect(head).toMatch(/security definer set search_path = /i);
        const stmt = (h: string, body = def!.statement.slice(def!.bodyStart)) => h.replace(/^create\s+(or\s+replace\s+)?function/i, 'create or replace function') + body;
        const changes = async (statement: string) => ((await checkDefinition(c, def!, statement))?.problems ?? []).join(' ');
        expect(await changes(stmt(head.replace(/security definer/i, 'security invoker')))).toMatch(/changes prosecdef$/);
        expect(await changes(stmt(head.replace(/set search_path = /i, 'set search_path = public, ')))).toMatch(/changes proconfig$/);
        // A mutant changes the body only.
        const [mutant] = mutantsOf(def!);
        expect(await changes(mutant!.statement)).toMatch(/changes prosrc$/);
        // The check leaves the database as it was, and a function not in this database is not placed in it.
        expect(await checkDefinition(c, def!)).toEqual({ owner: 'ebmr_owner', problems: [] });
        const tablets = [...defs.values()].find((d) => d.name === 'tab.bind_session');
        expect(await checkDefinition(c, tablets!)).toBeUndefined();
      } finally {
        await c.end();
      }
    } finally {
      await server.query(`drop database if exists ${name} with (force)`);
      await server.end();
    }
  });
});

describe('a mutant\'s copy of a template', () => {
  it('[meta] has the template\'s database privileges, which CREATE DATABASE ... TEMPLATE alone does not copy (a test reading the template\'s privileges would kill every mutant)', async () => {
    const template = inject('templateDb');
    const plain = `ebmr_t_${randomBytes(6).toString('hex')}`;
    const copied = `ebmr_t_${randomBytes(6).toString('hex')}`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    try {
      await server.query(`create database ${plain} template ${template}`);
      await copyTemplate(template, copied);
      // The migrations closed the template to the sandbox roles (kernel 0800, 0980); a plain copy is open to PUBLIC.
      expect(await privilegeDifferences(template, plain)).toEqual(expect.arrayContaining([`ebmr_sandbox CONNECT: ${template} false, ${plain} true`]));
      expect(await privilegeDifferences(template, copied)).toEqual([]);
    } finally {
      await server.query(`drop database if exists ${plain} with (force)`);
      await server.query(`drop database if exists ${copied} with (force)`);
      await server.end();
    }
  });

  it('[meta] the databases tests left behind are dropped: created after the run began, not the run\'s own, not in use', async () => {
    const prefix = `ebmr_sweep${randomBytes(4).toString('hex')}`;
    const older = `${prefix}_older`;
    const server = new pg.Client({ connectionString: ADMIN_URL });
    await server.connect();
    const held = new pg.Client({ connectionString: urlFor(`${prefix}_in_use`) });
    try {
      await server.query(`create database ${older}`);
      const since = await highestDatabaseOid();
      for (const n of ['left', 'own', 'in_use']) await server.query(`create database ${prefix}_${n}`);
      await held.connect();
      const dropped = await sweepLeftovers(since, new Set([`${prefix}_own`]), `${prefix}\\_%`);
      expect(dropped).toEqual([`${prefix}_left`]);
      const { rows } = await server.query<{ datname: string }>('select datname from pg_database where datname like $1 order by 1', [`${prefix}%`]);
      expect(rows.map((r) => r.datname)).toEqual([`${prefix}_in_use`, `${prefix}_older`, `${prefix}_own`]);
    } finally {
      await held.end().catch(() => undefined);
      for (const n of ['older', 'left', 'own', 'in_use']) await server.query(`drop database if exists ${prefix}_${n} with (force)`);
      await server.end();
    }
  });

  it('[meta] a kill is reported with the failing tests it names, or with the end of the output when it names none', () => {
    expect(failures(' FAIL  |db| a.test.ts > b > c\nAssertionError: expected 1 to be 2\n')).toBe(' FAIL  |db| a.test.ts > b > c | AssertionError: expected 1 to be 2');
    expect(failures('\u001b[31m FAIL \u001b[39m |db| a.test.ts > b')).toBe(' FAIL  |db| a.test.ts > b');
    expect(failures('Unhandled rejection\nconnection terminated\n')).toBe('no failing test named; output ends: Unhandled rejection connection terminated');
    // A FAIL line seen while the output streamed, when a long diff pushed it out of the tail kept.
    expect(failures('+ "sql": [],\n ❯ a.test.ts:830:78\n', ['FAIL  |db| a.test.ts > b'])).toBe(' FAIL  |db| a.test.ts > b');
    expect(failures(' FAIL  |db| a.test.ts > b\nAssertionError: x\n', ['FAIL  |db| a.test.ts > b'])).toBe(' FAIL  |db| a.test.ts > b | AssertionError: x');
  });
});

describe('prepared server templates (EBMR_SERVER_TEMPLATES)', () => {
  const seed = (installation: 'GMP' | 'SANDBOX', database: string) => ({ installation, database, siteCode: 'S', zone: 'Asia/Kolkata' }) as unknown as SiteSeed;
  const built: ServerTemplates = { gmp: { template: 'ebmr_stpl_x', seed: seed('GMP', 'ebmr_stpl_x') }, sandbox: { template: 'ebmr_sandbox_tplx', seed: seed('SANDBOX', 'ebmr_sandbox_tplx') } };

  it('[meta] the set-up builds its own pair when the variable is unset, and uses the named file, building nothing, only when it is set', async () => {
    let builds = 0;
    const build = () => {
      builds++;
      return Promise.resolve(built);
    };
    const unset = await serverTemplatesFor({}, build);
    expect(builds).toBe(1);
    expect(unset.templates).toBe(built);
    expect(unset.teardown).toBeInstanceOf(Function);

    const dir = tempDir();
    const file = writeServerTemplates(dir, built, { gmp: 'ebmr_mut_ab_gmp', sandbox: 'ebmr_sandbox_mut_ab' });
    const set = await serverTemplatesFor({ [PREPARED_TEMPLATES_ENV]: file }, build);
    expect(builds).toBe(1);
    expect(set.templates.gmp.template).toBe('ebmr_mut_ab_gmp');
    expect(set.templates.sandbox.template).toBe('ebmr_sandbox_mut_ab');
    // Kept: the teardown of prepared templates drops nothing (these names do not exist; nothing is asked of the cluster).
    await expect(set.teardown()).resolves.toBeUndefined();
  });

  it('[meta] the file the harness writes is private (0600), names each copy and gives each seed its own copy as its database', () => {
    const dir = tempDir();
    const file = writeServerTemplates(dir, built, { gmp: 'ebmr_mut_cd_gmp', sandbox: 'ebmr_sandbox_mut_cd' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const content = JSON.parse(readFileSync(file, 'utf8')) as ServerTemplates;
    expect(content.gmp).toEqual({ template: 'ebmr_mut_cd_gmp', seed: { ...built.gmp.seed, database: 'ebmr_mut_cd_gmp' } });
    expect(content.sandbox).toEqual({ template: 'ebmr_sandbox_mut_cd', seed: { ...built.sandbox.seed, database: 'ebmr_sandbox_mut_cd' } });
    expect(readPreparedTemplates(file)).toEqual(content);
  });

  it('[meta] a prepared file without both templates, with the seed of the other kind or with a GMP template under a sandbox name fails the run', () => {
    const dir = tempDir();
    const write = (content: unknown) => {
      const f = join(dir, `${randomBytes(4).toString('hex')}.json`);
      writeFileSync(f, JSON.stringify(content));
      return f;
    };
    expect(() => readPreparedTemplates(write({ gmp: built.gmp }))).toThrow(/sandbox needs a template name and the seed of a SANDBOX installation/);
    expect(() => readPreparedTemplates(write({ gmp: built.gmp, sandbox: { ...built.sandbox, seed: built.gmp.seed } }))).toThrow(/SANDBOX installation/);
    expect(() => readPreparedTemplates(write({ gmp: { ...built.gmp, template: 'ebmr_sandbox_tpl1' }, sandbox: built.sandbox }))).toThrow(/is not a GMP database name/);
    expect(() => readPreparedTemplates(write({ gmp: built.gmp, sandbox: { ...built.sandbox, template: 'ebmr_stpl_2' } }))).toThrow(/is not a SANDBOX database name/);
  });
});

describe('the check run a group\'s report is published as (.github/workflows/mutation.yml, job sql)', () => {
  const mutant = (n: number, status: Result['status'], group = 'weighing'): Result => ({
    id: `recipe.weighing_net_problem#${n}`, function: 'recipe.weighing_net_problem', file: 'packages/recipe-core/sql/0321_weighing_net_resolution.sql',
    line: 10 + n, operator: 'RELATIONAL', original: '=', replacement: '<>', group, status, ms: 1000, ...(status === 'KILLED' ? { detail: 'server: FAIL x' } : {}),
  });
  const summary = ['# SQL mutation report', '', '| Group | Baseline (s) | Limit (s) | Mutants | Invalid | Equivalent | Detected | Survived | Score | Target |',
    '|---|---|---|---|---|---|---|---|---|---|', '| weighing | server 20 | server 240 | 6 | 1 | 1 | 3 | 1 | 75.0 % | 90 % |', '', '## Surviving mutants', ''].join('\n');

  it('[meta] names the group, is success only at the group\'s threshold and neutral below it, never failure; its title is the score line, its summary the group\'s row and the counts, its text every mutant not killed, survivors first', () => {
    const report = [mutant(1, 'KILLED'), mutant(2, 'INVALID'), mutant(3, 'SURVIVED'), mutant(4, 'EQUIVALENT'), mutant(5, 'TIMEOUT'), mutant(6, 'KILLED'), mutant(7, 'KILLED', 'signing')];
    const p = checkRunPayload('weighing', 'abc123', report, summary);
    expect(p).toMatchObject({ name: 'SQL mutation report (weighing)', head_sha: 'abc123', status: 'completed', conclusion: 'neutral' });
    expect(p.output.title).toBe('weighing: 75.0 % (3/4 detected, 1 invalid)');
    expect(p.output.summary).toContain('| weighing | server 20 | server 240 | 6 | 1 | 1 | 3 | 1 | 75.0 % | 90 % |');
    expect(p.output.summary).toContain('6 mutants: KILLED 2, SURVIVED 1, TIMEOUT 1, INVALID 1, EQUIVALENT 1.');
    const lines = (p.output.text ?? '').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l['id'], l['status']])).toEqual([
      ['recipe.weighing_net_problem#3', 'SURVIVED'], ['recipe.weighing_net_problem#5', 'TIMEOUT'],
      ['recipe.weighing_net_problem#2', 'INVALID'], ['recipe.weighing_net_problem#4', 'EQUIVALENT'],
    ]);
    expect(Object.keys(lines[0] ?? {})).toEqual(['id', 'status', 'function', 'file', 'line', 'operator', 'original', 'replacement']);
    // At the threshold: success, and no text when every mutant was killed.
    const killed = Array.from({ length: 10 }, (_, i) => mutant(i + 1, i === 0 ? 'SURVIVED' : 'KILLED'));
    expect(checkRunPayload('weighing', 'abc123', killed, summary).conclusion).toBe('success');
    const all = checkRunPayload('weighing', 'abc123', killed.slice(1), summary);
    expect(all.conclusion).toBe('success');
    expect(all.output.text).toBeUndefined();
    expect(() => checkRunPayload('no-such-group', 'abc123', report, summary)).toThrow(/unknown group/);
  });

  it('[meta] a text over the limit keeps the survivors first and says what was cut; a missing or empty report is still a (neutral) check run', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ ...mutant(i + 1, i < 300 ? 'INVALID' : 'SURVIVED'), original: 'x'.repeat(80) }));
    const p = checkRunPayload('weighing', 'abc123', many, undefined);
    const text = p.output.text ?? '';
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT);
    const kept = text.trim().split('\n').map((l) => JSON.parse(l) as { status: string });
    expect(kept.length).toBeLessThan(600);
    expect(kept.slice(0, 300).every((l) => l.status === 'SURVIVED')).toBe(true);
    expect(p.output.summary).toContain(`The text lists ${kept.length} of the 600 mutants not killed`);
    expect(p.output.summary).toContain(`the other ${600 - kept.length} were cut at ${TEXT_LIMIT} characters`);
    expect(p.output.summary).toContain('summary.md has no row for this group');
    const missing = checkRunPayload('weighing', 'abc123', undefined, undefined, 'report.json is missing');
    expect(missing).toMatchObject({ conclusion: 'neutral', output: { title: 'weighing: no report' } });
    expect(missing.output.summary).toMatch(/^report\.json is missing: the mutation run ended before the group finished/);
    expect(checkRunPayload('weighing', 'abc123', [mutant(1, 'KILLED', 'signing')], summary).output.summary).toMatch(/^report\.json holds no result of weighing/);
  });
});
