/**
 * Every refusal the engine and the blocks can give is recordable on a Tablets database (owner report item 4, G3; tablets
 * 1905). Two sources had each widened recipe.refusal_problem (tablets 0844: TBnn, recipe-core 1874: LIB), and the one
 * that ran last dropped the other's prefix, so a refused library entry could not record its refusal (EBMR-EXE-126).
 * This runs every code the sources name as a refusal through the function as the migrations leave it, so a later
 * override that drops a prefix fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startExecServer, type ExecServer } from './support.ts';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SOURCES = ['packages/recipe-core/src', 'apps/tablets-server/src/blocks'];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The codes the sources pass as the first argument of refuse(...) or problem(...), including both arms of a conditional. */
function refusalCodes(): string[] {
  const out = new Set<string>();
  for (const f of SOURCES.flatMap((d) => tsFiles(join(ROOT, d)))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:refuse|problem)\(\s*([^,()]*?),/g)) {
      for (const c of (m[1] ?? '').matchAll(/'([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)'/g)) out.add(c[1] ?? '');
    }
  }
  return [...out].sort();
}

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
});
afterAll(async () => {
  await sbx.close();
});

describe('refusal codes on a Tablets database (G3)', () => {
  it('[DI-05][DI-34] every refusal code the engine and the blocks emit (ENG, LIB, Gnn, TBnn) is recorded by a refused row, whichever source defined recipe.refusal_problem last', async () => {
    const codes = refusalCodes();
    // The sources name hundreds of codes; a scan that finds few has stopped matching them.
    expect(codes.length).toBeGreaterThan(300);
    for (const prefix of ['ENG-', 'LIB-', 'G07-', 'TB07-']) expect(codes.some((c) => c.startsWith(prefix)), prefix).toBe(true);
    const refusals = codes.map((code) => ({ code, message: `${code} refused`, controls: ['PR-19', 'IN-11'] }));
    const { rows } = await sbx.db.admin.query<{ code: string; p: string | null }>(
      'select x.c ->> \'code\' as code, recipe.refusal_problem(false, x.c) as p from jsonb_array_elements($1::jsonb) x (c)',
      [JSON.stringify(refusals)],
    );
    expect(rows.filter((r) => r.p !== null)).toEqual([]);
  });

  it('[DI-05][DI-34] the refusal of an unfit vessel at a library step (LIB-EQUIPMENT-FITNESS) is recorded with its message; an unknown prefix still is not', async () => {
    const q = (code: string) =>
      sbx.db.admin.query<{ p: string | null }>('select recipe.refusal_problem(false, $1::jsonb) as p', [
        JSON.stringify({ code, message: 'Vessel V-01 is dirty and not qualified (LIB-EQUIPMENT-FITNESS; PR-19, IN-11)', controls: ['PR-19', 'IN-11'] }),
      ]);
    expect((await q('LIB-EQUIPMENT-FITNESS')).rows[0]?.p).toBeNull();
    expect((await q('LIBX-EQUIPMENT')).rows[0]?.p).toMatch(/refusal\.code has an invalid format/);
  });
});
