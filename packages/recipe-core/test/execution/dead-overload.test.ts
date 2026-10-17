/**
 * The dead overload recipe.check_engine_roles(jsonb, jsonb) (Phase 7 slice 7a; recipe-core 1224): since recipe-core 1100
 * the only caller, recipe.append_execution, calls the batch form (jsonb, jsonb, uuid). This proves that no SQL function
 * body and no TypeScript source calls the 2-argument form, which is what allowed the drop, and that only that overload
 * is gone.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', '.claude', 'dist', 'graphify-out', '.reports', 'coverage', '.stryker-tmp']);

/** The number of arguments of each call `name(...)` in `src` (top-level commas of the balanced argument list). */
function callArities(src: string, name: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${name.replace(/[.]/g, '\\.')}\\s*\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 0;
    let commas = 0;
    let quote: string | null = null;
    let empty = true;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const ch = src[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        empty = false;
      } else if (ch === '(' || ch === '[' || ch === '{') {
        depth++;
        empty = false;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (ch === ',' && depth === 0) {
        commas++;
      } else if (!/\s/.test(ch)) {
        empty = false;
      }
    }
    out.push(empty ? 0 : commas + 1);
  }
  return out;
}

function typescriptFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) typescriptFiles(p, acc);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) acc.push(p);
  }
  return acc;
}

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 300_000);
afterAll(async () => {
  await db.drop();
});

describe('the dead overload recipe.check_engine_roles(jsonb, jsonb) (slice 7a)', () => {
  it('[meta] the arity counter reads nested calls, quoted commas and an empty list', () => {
    expect(callArities("x := recipe.check_engine_roles(v_eng, coalesce(p_roles, '[]'), p_batch); recipe.check_engine_roles(a, 'b,c')", 'recipe.check_engine_roles')).toEqual([3, 2]);
    expect(callArities('check_engine_roles( )', 'check_engine_roles')).toEqual([0]);
  });

  it('[meta][INV-26] no SQL function body and no TypeScript calls recipe.check_engine_roles with 2 arguments (jsonb, jsonb); recipe-core 1224 drops that overload only', async () => {
    const { rows } = await db.admin.query<{ fn: string; src: string }>(
      `select p.oid::regprocedure::text as fn, p.prosrc as src from pg_catalog.pg_proc p
        where p.prosrc like '%check_engine_roles%' order by 1`,
    );
    const callers = rows.map((r) => ({ fn: r.fn, arities: callArities(r.src, 'check_engine_roles') })).filter((r) => r.arities.length > 0);
    // The batch form's one caller, recipe.append_execution (recipe-core 1100), calls it with the batch.
    expect(callers).toEqual([{ fn: expect.stringMatching(/^recipe\.append_execution\(/) as unknown, arities: [3] }]);

    const ts = typescriptFiles(ROOT)
      .map((f) => ({ file: relative(ROOT, f), arities: callArities(readFileSync(f, 'utf8'), 'check_engine_roles') }))
      .filter((r) => r.arities.length > 0 && r.file !== 'packages/recipe-core/test/execution/dead-overload.test.ts');
    expect(ts.filter((r) => r.arities.includes(2))).toEqual([]);

    const overloads = await db.admin.query<{ fn: string }>(
      "select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'recipe' and p.proname = 'check_engine_roles' order by 1",
    );
    expect(overloads.rows.map((r) => r.fn)).toEqual(['recipe.check_engine_roles(jsonb,jsonb,uuid)']);
    const kept = await db.admin.query<{ fn: string }>(
      "select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'recipe' and p.proname = 'role_evaluation_problem' order by 1",
    );
    expect(kept.rows.map((r) => r.fn)).toEqual(['recipe.role_evaluation_problem(jsonb,text,uuid)', 'recipe.role_evaluation_problem(jsonb,text,uuid,uuid)']);
  });
});
