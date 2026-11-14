/**
 * The pull-request gate's SQL mutation check (decision 0032, as the lead set it on 14 November 2026): a change may not
 * add a surviving mutant. A survivor of the head counts as old debt only when the same mutation (function, operator,
 * original and replacement; not the line or the number, which move when a migration re-creates the function) also
 * survived, or was reviewed equivalent, at the base. Group thresholds stay deployment work (decision 0008); a new
 * function, absent at the base, may have no survivor at all.
 *
 * Usage: tsx tools/sql-mutation/src/new-survivors.ts --head <report.json> [--base <report.json>...]
 *   Prints the head's survivors and the new ones; exits 1 when there is a new one. A base report that is missing (the
 *   function is new, or the base run could not run it) contributes nothing, so its survivors are all new.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Result } from './run.ts';

type Mutation = Pick<Result, 'function' | 'operator' | 'original' | 'replacement' | 'status'>;

export const mutationKey = (r: Mutation): string => [r.function, r.operator, r.original, r.replacement].join('\u0000');

/** The head's survivors that the base does not account for (counted: two equal survivors need two at the base). */
export function newSurvivors<T extends Mutation>(head: readonly T[], base: readonly Mutation[]): T[] {
  const known = new Map<string, number>();
  for (const r of base) if (r.status === 'SURVIVED' || r.status === 'EQUIVALENT') known.set(mutationKey(r), (known.get(mutationKey(r)) ?? 0) + 1);
  const out: T[] = [];
  for (const r of head) {
    if (r.status !== 'SURVIVED') continue;
    const k = mutationKey(r);
    const left = known.get(k) ?? 0;
    if (left > 0) known.set(k, left - 1);
    else out.push(r);
  }
  return out;
}

function read(file: string): Result[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Result[]) : [];
}

function main(args: string[]): void {
  const values = (flag: string): string[] => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
  const headFile = values('--head')[0];
  if (!headFile) throw new Error('usage: new-survivors.ts --head <report.json> [--base <report.json>...]');
  if (!existsSync(resolve(headFile))) throw new Error(`no head report at ${headFile}: the mutation run did not finish`);
  const head = read(resolve(headFile));
  const base = values('--base').flatMap((f) => read(resolve(f)));
  const survivors = head.filter((r) => r.status === 'SURVIVED');
  const fresh = newSurvivors(head, base);
  console.log(`${head.length} mutants at the head, ${survivors.length} survived; ${survivors.length - fresh.length} of them survive at the base too; ${fresh.length} new`);
  for (const r of fresh) console.log(`NEW SURVIVOR ${r.function} (${r.file}:${r.line}) ${r.operator}: \`${r.original}\` -> \`${r.replacement}\``);
  if (fresh.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main(process.argv.slice(2));
