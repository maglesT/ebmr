/**
 * SQL mutation run: for every target function, create each mutant in a copy of a fully migrated
 * template database and run the target's tests against it. A mutant is KILLED when a test fails,
 * SURVIVED when every test passes, TIMEOUT when the run exceeds the limit (counted as detected),
 * and INVALID when PostgreSQL rejects the mutated function (not counted).
 *
 * Usage: tsx tools/sql-mutation/src/run.ts [--count] [--group <name>] [--workers <n>] [--out <dir>]
 * Needs the same PostgreSQL superuser as the tests (EBMR_PG_ADMIN_URL).
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { KERNEL_MIGRATIONS, migrate } from '@ebmr/kernel';
import { mutantsOf, type Mutant } from './mutators.ts';
import { findFunctions, type FunctionDef } from './sql-scan.ts';
import { TARGETS, type Target } from './targets.ts';

const ROOT = resolve(new URL('../../../', import.meta.url).pathname);
const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';
const SQL_DIRS = [join(ROOT, 'packages/kernel/sql'), join(ROOT, 'packages/site-services/sql')];
const TIMEOUT_MS = 240_000;

type Status = 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'INVALID';
interface Result extends Omit<Mutant, 'statement'> {
  group: string;
  status: Status;
  detail?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

/** The last definition of every function across all migrations, in migration order. */
export function loadDefinitions(): Map<string, FunctionDef> {
  const defs = new Map<string, FunctionDef>();
  for (const dir of SQL_DIRS) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      for (const d of findFunctions(readFileSync(join(dir, f), 'utf8'), `${dir.slice(ROOT.length + 1)}/${f}`)) defs.set(d.key, d);
    }
  }
  return defs;
}

export function mutantsFor(target: Target, defs: Map<string, FunctionDef>): Mutant[] {
  const out: Mutant[] = [];
  for (const name of target.functions) {
    const matches = [...defs.values()].filter((d) => d.name === name);
    if (matches.length === 0) throw new Error(`target ${target.group}: function ${name} not found`);
    for (const d of matches) out.push(...mutantsOf(d));
  }
  return out;
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

async function buildBase(): Promise<string> {
  const name = `ebmr_mut_base_${randomBytes(4).toString('hex')}`;
  await admin((c) => c.query(`create database ${name}`));
  await admin(async (c) => {
    await migrate(c, [
      KERNEL_MIGRATIONS,
      { namespace: 'site-services', directory: join(ROOT, 'packages/site-services/sql') },
      { namespace: 'test-fixtures', directory: join(ROOT, 'packages/kernel/test/support') },
    ]);
  }, name);
  return name;
}

function runTests(template: string, tests: string[]): Promise<{ code: number | null; timedOut: boolean; tail: string }> {
  return new Promise((done) => {
    const child = spawn('npx', ['vitest', 'run', ...tests, '--bail=1', '--reporter=dot'], {
      cwd: ROOT,
      env: { ...process.env, EBMR_TEMPLATE_DB: template },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (b: Buffer) => {
      out = (out + b.toString()).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, timedOut, tail: out });
    });
  });
}

async function runMutant(base: string, group: Target, m: Mutant): Promise<Result> {
  const db = `ebmr_mut_${randomBytes(5).toString('hex')}`;
  const { statement: _s, ...info } = m;
  void _s;
  await admin((c) => c.query(`create database ${db} template ${base}`));
  try {
    try {
      await admin(async (c) => {
        await c.query('begin');
        await c.query('set local role ebmr_owner');
        await c.query(m.statement);
        await c.query('commit');
      }, db);
    } catch (e) {
      return { ...info, group: group.group, status: 'INVALID', detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
    }
    const r = await runTests(db, group.tests);
    if (r.timedOut) return { ...info, group: group.group, status: 'TIMEOUT' };
    return { ...info, group: group.group, status: r.code === 0 ? 'SURVIVED' : 'KILLED' };
  } finally {
    await admin((c) => c.query(`drop database if exists ${db} with (force)`));
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

function score(rs: Result[]): { valid: number; detected: number; survived: number; invalid: number; score: number } {
  const valid = rs.filter((r) => r.status !== 'INVALID').length;
  const detected = rs.filter((r) => r.status === 'KILLED' || r.status === 'TIMEOUT').length;
  return { valid, detected, survived: valid - detected, invalid: rs.length - valid, score: valid === 0 ? 100 : (100 * detected) / valid };
}

async function main(): Promise<void> {
  const defs = loadDefinitions();
  const only = arg('group');
  const targets = TARGETS.filter((t) => !only || t.group === only);
  const plan = targets.map((t) => ({ target: t, mutants: mutantsFor(t, defs) }));
  for (const p of plan) console.log(`${p.target.group}: ${p.mutants.length} mutants in ${p.target.functions.length} functions`);
  if (process.argv.includes('--count')) return;

  const workers = Number(arg('workers') ?? '2');
  const outDir = resolve(ROOT, arg('out') ?? '.reports/sql-mutation');
  mkdirSync(outDir, { recursive: true });
  const base = await buildBase();
  const all: Result[] = [];
  try {
    for (const p of plan) {
      const baseline = await runTests(base, p.target.tests);
      if (baseline.code !== 0) throw new Error(`baseline tests fail for ${p.target.group}:\n${baseline.tail}`);
      const started = process.hrtime.bigint();
      const rs = await pool(p.mutants, workers, async (m, i) => {
        const r = await runMutant(base, p.target, m);
        if (r.status === 'SURVIVED') console.log(`  SURVIVED ${r.id} ${r.operator} ${r.file}:${r.line} [${r.original}] -> [${r.replacement}]`);
        if ((i + 1) % 25 === 0) console.log(`  ${p.target.group}: ${i + 1}/${p.mutants.length}`);
        return r;
      });
      all.push(...rs);
      const s = score(rs);
      const secs = Number((process.hrtime.bigint() - started) / 1_000_000_000n);
      console.log(`${p.target.group}: score ${s.score.toFixed(1)} % (${s.detected}/${s.valid} detected, ${s.invalid} invalid) in ${secs} s`);
      writeFileSync(join(outDir, 'report.json'), JSON.stringify(all, null, 2));
    }
  } finally {
    await admin((c) => c.query(`drop database if exists ${base} with (force)`));
  }

  const lines = ['# SQL mutation report', '', '| Group | Mutants | Invalid | Detected | Survived | Score | Target |', '|---|---|---|---|---|---|---|'];
  let failed = false;
  for (const p of plan) {
    const rs = all.filter((r) => r.group === p.target.group);
    const s = score(rs);
    if (s.score < p.target.threshold) failed = true;
    lines.push(`| ${p.target.group} | ${rs.length} | ${s.invalid} | ${s.detected} | ${s.survived} | ${s.score.toFixed(1)} % | ${p.target.threshold} % |`);
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
