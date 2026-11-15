/**
 * The generated blocks against the committed migrations (ADR 0023, decision 3). `check` is CI's rules:check: the latest
 * committed block of every generated function must equal the generator's output byte for byte, no migration may define
 * a generated function outside its markers, and no committed block may outlive its definition. `pending` is what
 * rules:generate writes as a new migration: the blocks whose output differs from the latest committed one. An existing
 * migration is never edited.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BEGIN, END, generateBlocks, type Block } from './emit.ts';

/** recipe-core's migrations, relative to the repository root: the generated functions live in its `recipe` schema. */
export const MIGRATIONS_DIR = 'packages/recipe-core/sql';

export interface Migration {
  readonly file: string;
  readonly text: string;
}

export function readMigrations(root: string): Migration[] {
  const dir = join(root, MIGRATIONS_DIR);
  // The migrator's own order (kernel db/migrate.ts: the file names, sorted).
  // Stryker disable next-line MethodExpression: Node's readdirSync (libuv scandir) already returns the names sorted, so
  // the explicit sort, kept to match the migrator, cannot be told apart; equivalent.
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
}

interface Committed {
  readonly file: string;
  readonly text: string;
}

const GENERATED_FN = /create\s+(?:or\s+replace\s+)?function\s+recipe\.([a-z0-9_]+)\s*\(/gi;

/**
 * The blocks of one migration, and the problems of its text outside them: a definition there of a function in
 * `generated` (or of any `recipe.rules_` primitive). A hand-written function that only shares the `rule_` prefix, such as
 * recipe.rule_table_versions (0170), is not the generator's.
 */
function scan(m: Migration, generated: ReadonlySet<string>): { blocks: Map<string, string>; problems: string[] } {
  const blocks = new Map<string, string>();
  const problems: string[] = [];
  const lines = m.text.split('\n');
  // Stryker disable next-line ArrayDeclaration: a seeded line ("Stryker was here") names no function, so the scan of the
  // lines outside the blocks finds the same definitions; equivalent.
  const outside: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith(BEGIN)) {
      if (line.startsWith(END)) problems.push(`${m.file}:${i + 1}: "${line}" closes no block`);
      outside.push(line);
      continue;
    }
    const fn = line.slice(BEGIN.length);
    const end = lines.indexOf(`${END}${fn}`, i + 1);
    const inner = end === -1 ? undefined : lines.slice(i + 1, end);
    if (inner === undefined || inner.some((l) => l.startsWith(BEGIN) || l.startsWith(END))) {
      problems.push(`${m.file}:${i + 1}: the block of ${fn} is not closed by "${END}${fn}" before another marker`);
      continue;
    }
    if (blocks.has(fn)) problems.push(`${m.file}:${i + 1}: a second block of ${fn}`);
    blocks.set(fn, `${lines.slice(i, end + 1).join('\n')}\n`);
    i = end;
  }
  for (const hit of outside.join('\n').matchAll(GENERATED_FN)) {
    const fn = `recipe.${(hit[1] as string).toLowerCase()}`;
    if (generated.has(fn) || fn.startsWith('recipe.rules_')) {
      problems.push(`${m.file}: defines ${fn} outside the generator's markers (generated functions are only written by pnpm rules:generate)`);
    }
  }
  return { blocks, problems };
}

/** The latest committed block of each function, and the problems found on the way. */
export function committed(migrations: readonly Migration[], wanted: readonly Block[]): { latest: Map<string, Committed>; problems: string[] } {
  const latest = new Map<string, Committed>();
  const problems: string[] = [];
  // Every function the generator writes now or wrote in any migration.
  const generated = new Set(wanted.map((b) => b.fn));
  for (const m of migrations) for (const fn of scan(m, new Set()).blocks.keys()) generated.add(fn);
  for (const m of migrations) {
    const s = scan(m, generated);
    problems.push(...s.problems);
    for (const [fn, text] of s.blocks) latest.set(fn, { file: m.file, text });
  }
  return { latest, problems };
}

/** The generator's blocks that differ from (or are missing in) the committed migrations. */
export function pending(migrations: readonly Migration[], blocks: readonly Block[] = generateBlocks()): Block[] {
  const { latest } = committed(migrations, blocks);
  return blocks.filter((b) => latest.get(b.fn)?.text !== b.text);
}

/** rules:check: every problem, or none. */
export function check(migrations: readonly Migration[], blocks: readonly Block[] = generateBlocks()): string[] {
  const { latest, problems } = committed(migrations, blocks);
  for (const b of blocks) {
    const c = latest.get(b.fn);
    if (c === undefined) problems.push(`${b.fn}: no migration holds its generated block (run pnpm rules:generate)`);
    else if (c.text !== b.text) problems.push(`${b.fn}: its latest block (${c.file}) differs from the generator's output (run pnpm rules:generate)`);
  }
  const wanted = new Set(blocks.map((b) => b.fn));
  for (const [fn, c] of latest) {
    if (!wanted.has(fn)) problems.push(`${fn}: generated in ${c.file}, but no definition or primitive generates it any more`);
  }
  return problems;
}

/**
 * The file name of the next migration: `number` (or one above the highest committed), four digits, then `rules_` and
 * `slug` (the handbook claims the generated migrations by that prefix).
 */
export function nextFile(migrations: readonly Migration[], slug: string, number?: number): string {
  // A migration's number is the integer its name starts with (README.sql and the like have none).
  const numberOf = (m: Migration): number => Number.parseInt(m.file, 10);
  const highest = Math.max(0, ...migrations.map(numberOf).filter((n) => Number.isInteger(n)));
  const n = number ?? highest + 1;
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error(`a migration number is 1 to 9999, not ${String(n)}`);
  const taken = migrations.find((m) => numberOf(m) === n);
  if (taken) throw new Error(`migration number ${String(n)} is taken by ${taken.file}`);
  if (!/^[a-z0-9_]+$/.test(slug)) throw new Error(`a migration slug is lower-case letters, digits and underscores, not "${slug}"`);
  return `${String(n).padStart(4, '0')}_rules_${slug}.sql`;
}
