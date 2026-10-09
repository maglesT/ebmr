/**
 * Writes the generated migrations that publish the plant machines (./machine.ts) into packages/recipe-core/sql, with
 * the same generator as the MBR life cycle (lifecycle/write-seeds.ts, kernel state.machineSeedSql).
 *
 *   npx tsx packages/recipe-core/src/plant/write-seeds.ts          write missing seed files
 *   npx tsx packages/recipe-core/src/plant/write-seeds.ts --check  exit 1 if a file is missing or differs
 *
 * An existing seed file is never overwritten: a published migration is immutable.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECIPE_SQL_DIR, recipeMachineSeedSql, type RecipeMachine } from '../lifecycle/write-seeds.ts';
import { AREA_STATUS_V1, EQUIPMENT_CLEANLINESS_V1 } from './machine.ts';

const SOURCE = 'packages/recipe-core/src/plant/machine.ts';
const LIFECYCLE_WRITER = 'packages/recipe-core/src/lifecycle/write-seeds.ts';
const PLANT_WRITER = 'packages/recipe-core/src/plant/write-seeds.ts';

/** Every published plant machine version. Add entries; never edit a published one. */
export const PLANT_MACHINES: readonly RecipeMachine[] = [
  { descriptor: EQUIPMENT_CLEANLINESS_V1, source: SOURCE },
  { descriptor: AREA_STATUS_V1, source: SOURCE },
];

/** The seed migration of a plant machine, naming this writer in the header. */
export function plantMachineSeedSql(machine: RecipeMachine): string {
  const sql = recipeMachineSeedSql(machine);
  if (!sql.includes(LIFECYCLE_WRITER)) throw new Error('the recipe seed header changed; update plantMachineSeedSql');
  return sql.replace(LIFECYCLE_WRITER, PLANT_WRITER);
}

export function plantSeedStatus(sqlDir = RECIPE_SQL_DIR): { file: string; status: 'up-to-date' | 'missing' | 'differs' }[] {
  return PLANT_MACHINES.map((m) => {
    const path = join(sqlDir, m.descriptor.seedFile);
    if (!existsSync(path)) return { file: m.descriptor.seedFile, status: 'missing' as const };
    return {
      file: m.descriptor.seedFile,
      status: readFileSync(path, 'utf8') === plantMachineSeedSql(m) ? ('up-to-date' as const) : ('differs' as const),
    };
  });
}

function main(args: string[]): number {
  const check = args.includes('--check');
  let problems = 0;
  for (const m of PLANT_MACHINES) {
    const path = join(RECIPE_SQL_DIR, m.descriptor.seedFile);
    const sql = plantMachineSeedSql(m);
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
