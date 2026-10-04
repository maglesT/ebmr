/**
 * SQL mutation run: for every target function, create each mutant in copies of fully migrated template databases and
 * run the target's tests against them. A mutant is KILLED when a test fails, SURVIVED when every test passes, TIMEOUT
 * when a run exceeds its group's limit (counted as detected), and INVALID when PostgreSQL rejects the mutated function
 * (not counted).
 *
 * The templates are the ones the test set-ups build, made by their own builders:
 *   db      packages/kernel/test/support/global-setup.ts (kernel, site services, recipe-core, test fixtures), for the
 *           Vitest `db` project; a mutant's copy reaches the tests through EBMR_TEMPLATE_DB;
 *   server  apps/tablets-server/test/support/global-setup.ts (kernel, site services, recipe-core, tablets): a GMP and a
 *           sandbox template, both seeded, for the `server` project; a mutant's copies reach the tests through
 *           EBMR_SERVER_TEMPLATES, a JSON file (mode 0600, in a private temporary directory removed at the end: the seeds
 *           hold DEMO-ONLY credentials and keys).
 * A mutant is applied to each copy in which its function exists, as the function's owner, with CREATE OR REPLACE: the
 * owner, the grants, SECURITY DEFINER and the SET search_path clause stay as they are (checked before the first mutant:
 * re-applying every unmutated definition leaves its pg_proc row unchanged). A target whose tests span both projects runs
 * each project with its own files; a failure in either kills the mutant.
 *
 * Usage: tsx tools/sql-mutation/src/run.ts [--count] [--verify] [--baseline] [--group <name>[,<name>...]] [--only <ids>]
 *                                          [--workers <n>] [--out <dir>] [--own-cluster]
 *   --count        mutant counts per group (no database);
 *   --verify       build the templates and run the checks above, nothing else;
 *   --baseline     also run each group's tests once on the unmutated templates and report the times and limits;
 *   --own-cluster  the cluster is this run's alone (a CI job's service or a spare cluster): drop the databases the
 *                  tests left behind (sweepLeftovers). Without it nothing but the run's own databases is dropped, so
 *                  a run on a shared cluster (port 5432, where other test runs and the demo databases live) never
 *                  drops another run's templates; leftovers from cancelled test files then stay until dropped by hand.
 * Needs the same PostgreSQL superuser as the tests (EBMR_PG_ADMIN_URL).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import pg from 'pg';
import { buildTemplate, templateSources } from '../../../packages/kernel/test/support/global-setup.ts';
import {
  buildServerTemplates,
  PREPARED_TEMPLATES_ENV,
  tabletsMigrationSources,
  type ServerTemplates,
} from '../../../apps/tablets-server/test/support/global-setup.ts';
import { mutantsOf, type Mutant } from './mutators.ts';
import { functionEvents, type FunctionDef } from './sql-scan.ts';
import { TARGETS, type Target } from './targets.ts';

const ROOT = resolve(new URL('../../../', import.meta.url).pathname);
const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';
/** A run may not end sooner than this, whatever the baseline. */
const MIN_TIMEOUT_MS = 240_000;
/** A run may take this many times its group's baseline before it counts as TIMEOUT. */
const TIMEOUT_FACTOR = 3;

export interface SqlSource {
  namespace: string;
  /** Relative to the repository root (or absolute). */
  directory: string;
}

/**
 * Every SQL directory, in migration order: the server set-up's edition sources (kernel, site services, recipe-core,
 * tablets). The kernel set-up applies the same directories but tablets, in the same order (its test fixtures are not
 * mutated). A function defined in several of them is taken from the last.
 */
export function sqlSources(): SqlSource[] {
  const edition = tabletsMigrationSources().map((s) => ({ namespace: s.namespace, directory: relative(ROOT, s.directory) }));
  const kernelOrder = templateSources()
    .map((s) => s.namespace)
    .filter((n) => n !== 'test-fixtures');
  const shared = edition.map((s) => s.namespace).filter((n) => kernelOrder.includes(n));
  if (shared.join() !== kernelOrder.join()) throw new Error(`the kernel and server set-ups apply the SQL in different orders: ${kernelOrder.join()} / ${shared.join()}`);
  return edition;
}

export type Status = 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'INVALID' | 'EQUIVALENT';
export interface Result extends Omit<Mutant, 'statement'> {
  group: string;
  status: Status;
  detail?: string;
  /** Wall time of the mutant (copies, apply, tests), in milliseconds. */
  ms?: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * The live definition of every function after all migrations, keyed by identity (schema.name and argument types): a
 * later CREATE [OR REPLACE] replaces an earlier one, a DROP FUNCTION removes it.
 */
export function loadDefinitions(sources: SqlSource[] = sqlSources()): Map<string, FunctionDef> {
  const defs = new Map<string, FunctionDef>();
  for (const source of sources) {
    const dir = resolve(ROOT, source.directory);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      for (const e of functionEvents(readFileSync(join(dir, f), 'utf8'), `${relative(ROOT, dir)}/${f}`)) {
        if (e.kind === 'define') {
          defs.delete(e.def.identity);
          defs.set(e.def.identity, e.def);
        } else if (e.kind === 'drop') {
          defs.delete(e.identity);
        } else {
          for (const [k, d] of defs) if (d.name === e.name) defs.delete(k);
        }
      }
    }
  }
  return defs;
}

export type Project = 'db' | 'server';
/** The Vitest project a test file belongs to (vitest.config.ts). */
export function projectOf(test: string): Project {
  return test.startsWith('apps/tablets-server/test/') ? 'server' : 'db';
}

/**
 * The target's tests plus those written specifically to kill its mutants: <package>/test/mutation/<group>.test.ts in
 * the kernel, recipe-core and the tablets server.
 */
export function testsFor(target: Target): string[] {
  const extra = ['packages/kernel/test', 'packages/recipe-core/test', 'apps/tablets-server/test']
    .map((d) => `${d}/mutation/${target.group}.test.ts`)
    .filter((f) => existsSync(join(ROOT, f)) && !target.tests.includes(f));
  return [...target.tests, ...extra];
}

/** The target's tests by Vitest project, each run with its own files. */
export function testsByProject(target: Target): Map<Project, string[]> {
  const by = new Map<Project, string[]>();
  for (const t of testsFor(target)) by.set(projectOf(t), [...(by.get(projectOf(t)) ?? []), t]);
  return by;
}

/** Mutants reviewed as equivalent (no observable behaviour differs), with the justification. */
export function loadEquivalents(): Record<string, string> {
  const file = join(ROOT, 'tools/sql-mutation/equivalent.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
}

/** The live definitions of each function a target names (every overload). */
export function definitionsFor(target: Target, defs: Map<string, FunctionDef>): FunctionDef[] {
  const out: FunctionDef[] = [];
  for (const name of target.functions) {
    const matches = [...defs.values()].filter((d) => d.name === name);
    if (matches.length === 0) throw new Error(`target ${target.group}: function ${name} not found`);
    out.push(...matches);
  }
  return out;
}

export function mutantsFor(target: Target, defs: Map<string, FunctionDef>): Mutant[] {
  return definitionsFor(target, defs).flatMap((d) => mutantsOf(d));
}

async function admin<T>(work: (c: pg.Client) => Promise<T>, db = 'postgres'): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Databases: the templates, the copies of each mutant, and their clean-up
// ---------------------------------------------------------------------------------------------------------------------

/** The three templates a mutant may need: the kernel set-up's, and the server set-up's GMP and sandbox ones. */
type Base = 'db' | 'gmp' | 'sandbox';
const BASES_OF: Record<Project, Base[]> = { db: ['db'], server: ['gmp', 'sandbox'] };

interface Templates {
  db?: string;
  server?: ServerTemplates;
}

/** Every database this run created and has not dropped yet (dropped on exit, also after a signal). */
const created = new Set<string>();
let secretsDir: string | undefined;
/** The highest database oid when the run began: a database with a higher one was created during the run. */
let startOid = 0;

/**
 * Drops the databases the tests left behind and returns their names: with --bail a run stops at its first failure, and
 * a test file cancelled in its set-up (a hook still running, then timed out) never drops the copy it made. Only
 * databases created after the run began (a higher oid), named ebmr_*, not this run's own and with no connection are
 * dropped, and only while no test runs (between groups, at the end), and only with --own-cluster: the run's cluster
 * must then not be shared with another test run while it runs (a CI job's own service, or a spare cluster).
 */
export async function sweepLeftovers(sinceOid = startOid, keep: ReadonlySet<string> = created, like = 'ebmr\\_%'): Promise<string[]> {
  if (sinceOid === 0) return [];
  const { rows } = await admin((c) =>
    c.query<{ name: string }>(
      `select d.datname as name from pg_catalog.pg_database d
        where d.oid > $1 and d.datname like $2 and not exists (select 1 from pg_catalog.pg_stat_activity a where a.datid = d.oid)
        order by d.oid`,
      [sinceOid, like],
    ),
  );
  const dropped: string[] = [];
  for (const { name } of rows.filter((r) => !keep.has(r.name))) {
    try {
      await admin((c) => c.query(`drop database if exists ${quoteIdent(name)}`));
      dropped.push(name);
    } catch (e) {
      console.error(`could not drop ${name}, left by a test: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return dropped;
}

/** The highest database oid now. */
export async function highestDatabaseOid(): Promise<number> {
  return admin(async (c) => Number((await c.query<{ oid: string }>('select max(oid)::text as oid from pg_catalog.pg_database')).rows[0]?.oid ?? 0));
}

async function dropDatabase(name: string): Promise<void> {
  await admin((c) => c.query(`drop database if exists ${quoteIdent(name)} with (force)`));
  created.delete(name);
}

async function cleanUp(): Promise<void> {
  const left = await sweepLeftovers().catch(() => []);
  if (left.length > 0) console.log(`dropped ${left.length} databases the tests left behind: ${left.join(', ')}`);
  for (const name of [...created]) {
    try {
      await dropDatabase(name);
    } catch (e) {
      console.error(`could not drop ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  secretsDir = undefined;
}

/** A private directory (0700) for the prepared-templates files, which carry the seeds' DEMO-ONLY credentials and keys. */
function secrets(): string {
  secretsDir ??= mkdtempSync(join(tmpdir(), 'ebmr-sql-mutation-'));
  return secretsDir;
}

/** Writes a prepared-templates file (mode 0600) naming these copies; each seed names its own copy, as a built one would. */
export function writeServerTemplates(dir: string, templates: ServerTemplates, copies: { gmp: string; sandbox: string }): string {
  const file = join(dir, `server-templates-${randomBytes(6).toString('hex')}.json`);
  const content: ServerTemplates = {
    gmp: { template: copies.gmp, seed: { ...templates.gmp.seed, database: copies.gmp } },
    sandbox: { template: copies.sandbox, seed: { ...templates.sandbox.seed, database: copies.sandbox } },
  };
  writeFileSync(file, JSON.stringify(content), { mode: 0o600, flag: 'wx' });
  return file;
}

async function buildTemplates(projects: Set<Project>): Promise<Templates> {
  const templates: Templates = {};
  if (projects.has('db')) {
    const name = `ebmr_mut_base_${randomBytes(4).toString('hex')}`;
    created.add(name);
    templates.db = await buildTemplate(name);
  }
  if (projects.has('server')) {
    const server = await buildServerTemplates();
    created.add(server.gmp.template);
    created.add(server.sandbox.template);
    templates.server = server;
  }
  return templates;
}

function templateOf(t: Templates, base: Base): string {
  const name = base === 'db' ? t.db : base === 'gmp' ? t.server?.gmp.template : t.server?.sandbox.template;
  if (!name) throw new Error(`no ${base} template was built`);
  return name;
}

/**
 * Copies `template` as `name` with the template's database privileges. CREATE DATABASE ... TEMPLATE does not copy them
 * (a copy starts open to PUBLIC), while the test set-ups' templates carry the connect policy (kernel 0800, 0980) and
 * some tests read the template's own privileges (kernel sandbox/installation.test.ts): without them every mutant of
 * such a group would be killed by the copy, not by its mutation. No migration sets database-level settings.
 */
export async function copyTemplate(template: string, name: string): Promise<void> {
  await admin(async (c) => {
    await c.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
    const { rows } = await c.query<{ explicit: boolean; grantee: string | null; privilege: string | null; grantable: boolean | null }>(
      `select d.datacl is not null as explicit, case when a.grantee = 0 then 'public' else r.rolname end as grantee,
              a.privilege_type as privilege, a.is_grantable as grantable
         from pg_catalog.pg_database d
         left join lateral aclexplode(d.datacl) a on true
         left join pg_catalog.pg_roles r on r.oid = a.grantee
        where d.datname = $1`,
      [template],
    );
    if (!rows[0]?.explicit) return;
    const owner = (await c.query<{ owner: string }>('select pg_get_userbyid(datdba) as owner from pg_catalog.pg_database where datname = $1', [name])).rows[0]?.owner ?? '';
    await c.query(`revoke all on database ${quoteIdent(name)} from public, ${quoteIdent(owner)}`);
    for (const r of rows) {
      if (!r.grantee || !r.privilege) continue;
      const to = r.grantee === 'public' ? 'public' : quoteIdent(r.grantee);
      await c.query(`grant ${r.privilege} on database ${quoteIdent(name)} to ${to}${r.grantable ? ' with grant option' : ''}`);
    }
  });
}

/** What every role may do on database `a` and not on `b`, or the other way round: CONNECT, CREATE, TEMPORARY. */
export async function privilegeDifferences(a: string, b: string): Promise<string[]> {
  return admin(async (c) => {
    const { rows } = await c.query<{ role: string; privilege: string; on_a: boolean; on_b: boolean }>(
      `select r.rolname as role, p.privilege, has_database_privilege(r.oid, $1, p.privilege) as on_a, has_database_privilege(r.oid, $2, p.privilege) as on_b
         from pg_catalog.pg_roles r cross join (values ('CONNECT'), ('CREATE'), ('TEMPORARY')) p (privilege)
        where not r.rolsuper and has_database_privilege(r.oid, $1, p.privilege) is distinct from has_database_privilege(r.oid, $2, p.privilege)
        order by 1, 2`,
      [a, b],
    );
    return rows.map((r) => `${r.role} ${r.privilege}: ${a} ${String(r.on_a)}, ${b} ${String(r.on_b)}`);
  });
}

/** Names of a mutant's copies: a sandbox copy keeps a sandbox name (EBMR-SBX-004), a GMP copy never has one (DI-05). */
function copyName(base: Base, id: string): string {
  return base === 'sandbox' ? `ebmr_sandbox_mut_${id}` : base === 'gmp' ? `ebmr_mut_${id}_gmp` : `ebmr_mut_${id}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Where each target function lives, its owner, and the check that re-applying it changes nothing but its body
// ---------------------------------------------------------------------------------------------------------------------

/** Per function identity: the templates it exists in, with its owner there. */
type Placement = Map<string, Map<Base, string>>;

/**
 * A pg_proc row as compared: the parse trees of argument defaults and of a SQL-standard body carry the character
 * offset of each node in the statement text (:location), which differs when the same definition is applied alone.
 */
function comparable(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const k of ['proargdefaults', 'prosqlbody']) if (typeof out[k] === 'string') out[k] = out[k].replace(/ :location -?\d+/g, '');
  return out;
}

/** pg_proc columns CREATE OR REPLACE must leave as they are for an unchanged definition (all of them but the oid). */
const PROC_ROW = `select to_jsonb(p) - 'oid' as row, r.rolname as owner
                    from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner where p.oid = $1`;

/**
 * Where `def` lives in the database `c` is connected to, and what re-applying it there changes: undefined when the
 * function is not there; otherwise its owner and the pg_proc columns that applying `statement` (default: the unmutated
 * definition, exactly as mutantsOf builds a mutant) as that owner changes, in a transaction rolled back at the end. For
 * the unmutated definition that list must be empty: same owner, grants, SECURITY DEFINER, SET search_path and body.
 */
export async function checkDefinition(
  c: Pick<pg.Client, 'query'>,
  def: FunctionDef,
  statement = def.statement.slice(0, def.bodyStart).replace(/^create\s+(or\s+replace\s+)?function/i, 'create or replace function') + def.statement.slice(def.bodyStart),
): Promise<{ owner: string; problems: string[] } | undefined> {
  const found = await c.query<{ oid: number | null }>('select to_regprocedure($1)::oid as oid', [def.identity]);
  const oid = found.rows[0]?.oid;
  if (!oid) return undefined;
  const before = await c.query<{ row: Record<string, unknown>; owner: string }>(PROC_ROW, [oid]);
  const owner = before.rows[0]?.owner ?? '';
  const problems: string[] = [];
  await c.query('begin');
  try {
    await c.query(`set local role ${quoteIdent(owner)}`);
    await c.query(statement);
    await c.query('reset role');
    const after = await c.query<{ row: Record<string, unknown> }>(PROC_ROW, [oid]);
    const was = comparable(before.rows[0]?.row ?? {});
    const now = comparable(after.rows[0]?.row ?? {});
    const changed = Object.keys({ ...was, ...now }).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    if (changed.length > 0) problems.push(`re-applying ${def.identity} (${def.file}:${def.line}) changes ${changed.join(', ')}`);
  } catch (e) {
    problems.push(`re-applying ${def.identity} (${def.file}:${def.line}) fails: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await c.query('rollback');
  }
  return { owner, problems };
}

async function placeAndCheck(t: Templates, plan: { target: Target; defs: FunctionDef[]; projects: Project[] }[]): Promise<Placement> {
  const placement: Placement = new Map();
  const problems: string[] = [];
  const bases = new Set(plan.flatMap((p) => p.projects.flatMap((pr) => BASES_OF[pr])));
  for (const base of bases) {
    const defs = new Map(plan.filter((p) => p.projects.some((pr) => BASES_OF[pr].includes(base))).flatMap((p) => p.defs.map((d) => [d.identity, d])));
    await admin(async (c) => {
      for (const d of defs.values()) {
        const checked = await checkDefinition(c, d);
        if (!checked) continue;
        placement.set(d.identity, (placement.get(d.identity) ?? new Map<Base, string>()).set(base, checked.owner));
        problems.push(...checked.problems.map((p) => `${base}: ${p}`));
      }
    }, templateOf(t, base));
  }
  // A copy must answer for its database privileges exactly as its template does (copyTemplate).
  for (const base of bases) {
    const probe = copyName(base, `probe${randomBytes(3).toString('hex')}`);
    created.add(probe);
    try {
      await copyTemplate(templateOf(t, base), probe);
      problems.push(...(await privilegeDifferences(templateOf(t, base), probe)).map((d) => `${base}: a copy's database privileges differ from the template's: ${d}`));
    } finally {
      await dropDatabase(probe);
    }
  }
  for (const p of plan) {
    for (const d of p.defs) {
      const at = placement.get(d.identity);
      const needed = p.projects.flatMap((pr) => BASES_OF[pr]);
      if (!at || !needed.some((b) => at.has(b))) problems.push(`${p.target.group}: ${d.identity} is in none of the databases its tests use (${needed.join(', ')})`);
    }
  }
  if (problems.length > 0) throw new Error(`the run cannot mutate these functions faithfully:\n  ${problems.join('\n  ')}`);
  return placement;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

interface TestRun {
  code: number | null;
  timedOut: boolean;
  ms: number;
  /** The end of the output. */
  tail: string;
  /** The first lines naming a failed test (the end of a long diff can push them out of the tail). */
  failed: string[];
}

const VITEST = join(ROOT, 'node_modules/vitest/vitest.mjs');

function runVitest(project: Project, tests: string[], env: Record<string, string>, limitMs: number): Promise<TestRun> {
  return new Promise((done) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [VITEST, 'run', '--project', project, ...tests, '--bail=1', '--reporter=dot'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so a timeout ends Vitest's workers with it.
      detached: true,
    });
    let out = '';
    let pending = '';
    const failed: string[] = [];
    const keep = (b: Buffer) => {
      const text = b.toString();
      out = (out + text).slice(-8000);
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      // eslint-disable-next-line no-control-regex
      for (const l of lines.map((x) => x.replace(/\u001b\[[0-9;]*m/g, ''))) if (failed.length < 3 && /^\s*FAIL\s/.test(l)) failed.push(l.trim());
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, limitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, timedOut, ms: Number((process.hrtime.bigint() - started) / 1_000_000n), tail: out, failed });
    });
  });
}

/** The environment that points a project's set-up at these databases (the file, for the server, is written here). */
function envFor(project: Project, t: Templates, names: Partial<Record<Base, string>>): Record<string, string> {
  if (project === 'db') return { EBMR_TEMPLATE_DB: names.db ?? templateOf(t, 'db') };
  if (!t.server) throw new Error('no server templates were built');
  const file = writeServerTemplates(secrets(), t.server, { gmp: names.gmp ?? templateOf(t, 'gmp'), sandbox: names.sandbox ?? templateOf(t, 'sandbox') });
  return { [PREPARED_TEMPLATES_ENV]: file };
}

/**
 * The failing tests a run names (the dot reporter's FAIL lines), for the report; without any, the end of its output, so
 * a kill that is not a test's verdict (a crash, a set-up that failed) can be told apart.
 */
export function failures(tail: string, failed: string[] = []): string {
  // eslint-disable-next-line no-control-regex
  const plain = tail.replace(/\u001b\[[0-9;]*m/g, '');
  const fromTail = plain
    .split('\n')
    .filter((l) => /^\s*(FAIL|×|✗)\s/.test(l) || /Error:/.test(l))
    .filter((l) => !failed.includes(l.trim()));
  const named = [...failed.map((l) => ` ${l}`), ...fromTail].slice(0, 3).join(' | ').slice(0, 400);
  return named || `no failing test named; output ends: ${plain.trim().slice(-400).replace(/\s+/g, ' ')}`;
}

interface GroupLimits {
  baselineMs: Partial<Record<Project, number>>;
  limitMs: Partial<Record<Project, number>>;
}

async function baseline(t: Templates, target: Target): Promise<GroupLimits> {
  const limits: GroupLimits = { baselineMs: {}, limitMs: {} };
  for (const [project, tests] of testsByProject(target)) {
    const env = envFor(project, t, {});
    const r = await runVitest(project, tests, env, 30 * 60_000);
    rmSync(env[PREPARED_TEMPLATES_ENV] ?? '', { force: true });
    if (r.code !== 0) throw new Error(`baseline tests fail for ${target.group} (${project}):\n${r.tail}`);
    limits.baselineMs[project] = r.ms;
    limits.limitMs[project] = Math.max(MIN_TIMEOUT_MS, TIMEOUT_FACTOR * r.ms);
  }
  return limits;
}

async function runMutant(t: Templates, placement: Placement, target: Target, limits: GroupLimits, m: Mutant, def: FunctionDef): Promise<Result> {
  const started = process.hrtime.bigint();
  const id = randomBytes(5).toString('hex');
  const { statement: _s, ...info } = m;
  void _s;
  const byProject = testsByProject(target);
  const bases = [...byProject.keys()].flatMap((p) => BASES_OF[p]);
  const names: Partial<Record<Base, string>> = {};
  const elapsed = () => Number((process.hrtime.bigint() - started) / 1_000_000n);
  try {
    for (const base of bases) {
      const name = copyName(base, id);
      created.add(name);
      await copyTemplate(templateOf(t, base), name);
      names[base] = name;
    }
    const at = placement.get(def.identity) ?? new Map<Base, string>();
    try {
      for (const base of bases) {
        const owner = at.get(base);
        if (owner === undefined) continue;
        await admin(async (c) => {
          await c.query('begin');
          await c.query(`set local role ${quoteIdent(owner)}`);
          await c.query(m.statement);
          await c.query('commit');
        }, names[base]);
      }
    } catch (e) {
      return { ...info, group: target.group, status: 'INVALID', detail: e instanceof Error ? e.message.slice(0, 200) : String(e), ms: elapsed() };
    }
    for (const [project, tests] of byProject) {
      const env = envFor(project, t, names);
      try {
        const r = await runVitest(project, tests, env, limits.limitMs[project] ?? MIN_TIMEOUT_MS);
        if (r.timedOut) return { ...info, group: target.group, status: 'TIMEOUT', detail: `${project} after ${r.ms} ms`, ms: elapsed() };
        if (r.code !== 0) return { ...info, group: target.group, status: 'KILLED', detail: `${project}: ${failures(r.tail, r.failed)}`, ms: elapsed() };
      } finally {
        if (env[PREPARED_TEMPLATES_ENV]) rmSync(env[PREPARED_TEMPLATES_ENV], { force: true });
      }
    }
    return { ...info, group: target.group, status: 'SURVIVED', ms: elapsed() };
  } finally {
    for (const name of Object.values(names)) await dropDatabase(name);
  }
}

async function pool<T, R>(items: T[], workers: number, work: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        const item = items[i] as T;
        results[i] = await work(item, i);
      }
    }),
  );
  return results;
}

export function score(rs: Result[]): { valid: number; detected: number; survived: number; invalid: number; score: number } {
  // Invalid (rejected by PostgreSQL) and reviewed-equivalent mutants are excluded from the score.
  const valid = rs.filter((r) => r.status !== 'INVALID' && r.status !== 'EQUIVALENT').length;
  const detected = rs.filter((r) => r.status === 'KILLED' || r.status === 'TIMEOUT').length;
  const invalid = rs.filter((r) => r.status === 'INVALID').length;
  return { valid, detected, survived: valid - detected, invalid, score: valid === 0 ? 100 : (100 * detected) / valid };
}

const seconds = (ms: number | undefined): string => (ms === undefined ? '-' : (ms / 1000).toFixed(0));

async function main(): Promise<void> {
  const defs = loadDefinitions();
  // --group takes one group or several, comma-separated.
  const only = arg('group') ? new Set((arg('group') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) : undefined;
  const unknown = only ? [...only].filter((g) => !TARGETS.some((t) => t.group === g)) : [];
  if (unknown.length > 0) throw new Error(`unknown group(s): ${unknown.join(', ')}`);
  const targets = TARGETS.filter((t) => !only || only.has(t.group));
  const onlyIds = arg('only') ? new Set((arg('only') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) : undefined;
  const equivalents = loadEquivalents();
  const plan = targets
    .map((t) => {
      const tdefs = definitionsFor(t, defs);
      const mutants = tdefs.flatMap((d) => mutantsOf(d).map((m) => ({ m, d }))).filter(({ m }) => !onlyIds || onlyIds.has(m.id));
      return { target: t, defs: tdefs, mutants, projects: [...testsByProject(t).keys()] };
    })
    .filter((p) => !onlyIds || p.mutants.length > 0);
  let total = 0;
  for (const p of plan) {
    total += p.mutants.length;
    console.log(`${p.target.group}: ${p.mutants.length} mutants in ${p.target.functions.length} functions (${p.projects.join(' + ')})`);
  }
  console.log(`total: ${total} mutants in ${plan.length} groups`);
  if (onlyIds) {
    const found = new Set(plan.flatMap((p) => p.mutants.map(({ m }) => m.id)));
    const missing = [...onlyIds].filter((x) => !found.has(x));
    if (missing.length > 0) throw new Error(`--only names mutants no planned group has: ${missing.join(', ')}`);
  }
  if (process.argv.includes('--count')) return;

  const workers = Number(arg('workers') ?? '2');
  const outDir = resolve(ROOT, arg('out') ?? '.reports/sql-mutation');
  mkdirSync(outDir, { recursive: true });
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`${signal}: dropping the run's databases`);
    void cleanUp().finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const all: Result[] = [];
  const timing = new Map<string, GroupLimits>();
  // The sweep drops other databases, so it runs only on a cluster the run has to itself (--own-cluster).
  if (process.argv.includes('--own-cluster')) startOid = await highestDatabaseOid();
  try {
    const started = process.hrtime.bigint();
    const t = await buildTemplates(new Set(plan.flatMap((p) => p.projects)));
    console.log(`templates built in ${seconds(Number((process.hrtime.bigint() - started) / 1_000_000n))} s: ${[t.db, t.server?.gmp.template, t.server?.sandbox.template].filter(Boolean).join(', ')}`);
    const placement = await placeAndCheck(t, plan);
    const owners = new Map<string, number>();
    for (const at of placement.values()) for (const owner of at.values()) owners.set(owner, (owners.get(owner) ?? 0) + 1);
    console.log(`checked ${placement.size} functions: each re-applied unmutated leaves its pg_proc row unchanged; owners ${[...owners].map(([o, n]) => `${o} (${n})`).join(', ')}; a copy of each template has the template's database privileges`);
    if (process.argv.includes('--verify')) return;

    for (const p of plan) {
      const limits = await baseline(t, p.target);
      timing.set(p.target.group, limits);
      console.log(
        `${p.target.group}: baseline ${p.projects.map((pr) => `${pr} ${seconds(limits.baselineMs[pr])} s (limit ${seconds(limits.limitMs[pr])} s)`).join(', ')}`,
      );
      if (process.argv.includes('--baseline')) continue;
      const groupStarted = process.hrtime.bigint();
      const rs = await pool(p.mutants, workers, async ({ m, d }, i) => {
        const why = equivalents[m.id];
        if (why) {
          const { statement: _st, ...rest } = m;
          void _st;
          return { ...rest, group: p.target.group, status: 'EQUIVALENT' as const, detail: why };
        }
        const r = await runMutant(t, placement, p.target, limits, m, d);
        if (r.status === 'SURVIVED') console.log(`  SURVIVED ${r.id} ${r.operator} ${r.file}:${r.line} [${r.original}] -> [${r.replacement}]`);
        if (onlyIds) console.log(`  ${r.status} ${r.id} ${r.operator} [${r.original}] -> [${r.replacement}] in ${seconds(r.ms)} s${r.detail ? `: ${r.detail}` : ''}`);
        if ((i + 1) % 25 === 0) console.log(`  ${p.target.group}: ${i + 1}/${p.mutants.length}`);
        return r;
      });
      all.push(...rs);
      const left = await sweepLeftovers();
      if (left.length > 0) console.log(`  dropped ${left.length} databases the tests left behind: ${left.join(', ')}`);
      const s = score(rs);
      const secs = Number((process.hrtime.bigint() - groupStarted) / 1_000_000_000n);
      console.log(`${p.target.group}: score ${s.score.toFixed(1)} % (${s.detected}/${s.valid} detected, ${s.invalid} invalid) in ${secs} s`);
      writeFileSync(join(outDir, 'report.json'), JSON.stringify(all, null, 2));
    }
  } finally {
    await cleanUp();
  }
  if (process.argv.includes('--verify')) return;

  const lines = ['# SQL mutation report', '', '| Group | Baseline (s) | Limit (s) | Mutants | Invalid | Equivalent | Detected | Survived | Score | Target |', '|---|---|---|---|---|---|---|---|---|---|'];
  let failed = false;
  for (const p of plan) {
    const rs = all.filter((r) => r.group === p.target.group);
    const s = score(rs);
    if (rs.length > 0 && s.score < p.target.threshold) failed = true;
    const eq = rs.filter((r) => r.status === 'EQUIVALENT').length;
    const lim = timing.get(p.target.group);
    const per = (k: 'baselineMs' | 'limitMs') => p.projects.map((pr) => `${pr} ${seconds(lim?.[k][pr])}`).join(', ');
    lines.push(`| ${p.target.group} | ${per('baselineMs')} | ${per('limitMs')} | ${rs.length} | ${s.invalid} | ${eq} | ${s.detected} | ${s.survived} | ${s.score.toFixed(1)} % | ${p.target.threshold} % |`);
  }
  const survivors = all.filter((r) => r.status === 'SURVIVED');
  lines.push('', '## Surviving mutants', '');
  lines.push(...(survivors.length ? survivors.map((r) => `- ${r.group} ${r.function} (${r.file}:${r.line}) ${r.operator}: \`${r.original}\` -> \`${r.replacement}\``) : ['None.']));
  writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  await main();
}
