/**
 * Writes the generated migrations that publish the kernel's machine versions.
 *
 *   npx tsx packages/kernel/src/state/write-seeds.ts          write missing seed files
 *   npx tsx packages/kernel/src/state/write-seeds.ts --check  exit 1 if a file is missing or differs
 *
 * An existing seed file is never overwritten: a published migration is immutable. If a machine
 * changed, add a new version with its own seed file instead.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KERNEL_MACHINES } from './machines/index.ts';
import { machineSeedSql } from './seed.ts';

export const KERNEL_SQL_DIR = new URL('../../sql', import.meta.url).pathname;

export interface SeedStatus {
  file: string;
  status: 'up-to-date' | 'missing' | 'differs';
}

export function seedStatus(sqlDir = KERNEL_SQL_DIR): SeedStatus[] {
  return KERNEL_MACHINES.map(({ descriptor, source }) => {
    const path = join(sqlDir, descriptor.seedFile);
    if (!existsSync(path)) return { file: descriptor.seedFile, status: 'missing' };
    return { file: descriptor.seedFile, status: readFileSync(path, 'utf8') === machineSeedSql(descriptor, source) ? 'up-to-date' : 'differs' };
  });
}

function main(args: string[]): number {
  const check = args.includes('--check');
  let problems = 0;
  for (const { descriptor, source } of KERNEL_MACHINES) {
    const path = join(KERNEL_SQL_DIR, descriptor.seedFile);
    const sql = machineSeedSql(descriptor, source);
    if (!existsSync(path)) {
      if (check) {
        console.error(`missing: ${descriptor.seedFile}`);
        problems++;
      } else {
        writeFileSync(path, sql);
        console.log(`written: ${descriptor.seedFile}`);
      }
    } else if (readFileSync(path, 'utf8') !== sql) {
      console.error(`differs: ${descriptor.seedFile} (published migrations are immutable: add a new machine version)`);
      problems++;
    } else {
      console.log(`up to date: ${descriptor.seedFile}`);
    }
  }
  return problems === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
