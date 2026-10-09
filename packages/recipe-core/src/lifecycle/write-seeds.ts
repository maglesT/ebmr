/**
 * Writes the generated migrations that publish recipe-core's machine versions, with the kernel's
 * seed generator (state.machineSeedSql), into packages/recipe-core/sql.
 *
 *   npx tsx packages/recipe-core/src/lifecycle/write-seeds.ts          write missing seed files
 *   npx tsx packages/recipe-core/src/lifecycle/write-seeds.ts --check  exit 1 if a file is missing or differs
 *
 * An existing seed file is never overwritten: a published migration is immutable. A changed machine
 * gets a new version with its own seed file (add it to RECIPE_MACHINES).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { state } from '@ebmr/kernel';
import { OUTPUT_CONTAINER_V1 } from '../containers/machine.ts';
import { MBR_VERSION_V1 } from './machine.ts';

export interface RecipeMachine {
  descriptor: state.MachineDescriptor;
  /** Repository-relative path of the TypeScript source, written into the generated header. */
  source: string;
}

/** Every published machine version of recipe-core. Add entries; never edit a published one. */
export const RECIPE_MACHINES: readonly RecipeMachine[] = [
  { descriptor: MBR_VERSION_V1, source: 'packages/recipe-core/src/lifecycle/machine.ts' },
  { descriptor: OUTPUT_CONTAINER_V1, source: 'packages/recipe-core/src/containers/machine.ts' },
];

export const RECIPE_SQL_DIR = new URL('../../sql', import.meta.url).pathname;

const KERNEL_GENERATOR = 'by packages/kernel/src/state/write-seeds.ts';
const RECIPE_GENERATOR = 'by packages/recipe-core/src/lifecycle/write-seeds.ts (kernel state.machineSeedSql)';

/** The seed migration of a recipe-core machine: the kernel generator's output with this generator named in the header. */
export function recipeMachineSeedSql(machine: RecipeMachine): string {
  const sql = state.machineSeedSql(machine.descriptor, machine.source);
  if (!sql.includes(KERNEL_GENERATOR)) throw new Error('the kernel seed header changed; update recipeMachineSeedSql');
  return sql.replace(KERNEL_GENERATOR, RECIPE_GENERATOR);
}

export interface SeedStatus {
  file: string;
  status: 'up-to-date' | 'missing' | 'differs';
}

export function seedStatus(sqlDir = RECIPE_SQL_DIR): SeedStatus[] {
  return RECIPE_MACHINES.map((m) => {
    const path = join(sqlDir, m.descriptor.seedFile);
    if (!existsSync(path)) return { file: m.descriptor.seedFile, status: 'missing' };
    return { file: m.descriptor.seedFile, status: readFileSync(path, 'utf8') === recipeMachineSeedSql(m) ? 'up-to-date' : 'differs' };
  });
}

function main(args: string[]): number {
  const check = args.includes('--check');
  let problems = 0;
  for (const m of RECIPE_MACHINES) {
    const path = join(RECIPE_SQL_DIR, m.descriptor.seedFile);
    const sql = recipeMachineSeedSql(m);
    if (!existsSync(path)) {
      if (check) {
        console.error(`missing: ${m.descriptor.seedFile}`);
        problems++;
      } else {
        writeFileSync(path, sql);
        console.log(`written: ${m.descriptor.seedFile}`);
      }
    } else if (readFileSync(path, 'utf8') !== sql) {
      console.error(`differs: ${m.descriptor.seedFile} (published migrations are immutable: add a new machine version)`);
      problems++;
    } else {
      console.log(`up to date: ${m.descriptor.seedFile}`);
    }
  }
  return problems === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
