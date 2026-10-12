/**
 * Writes the generated migrations that publish site-services' machine versions, with the kernel's seed
 * generator (state.machineSeedSql), into packages/site-services/sql.
 *
 *   npx tsx packages/site-services/src/lots/write-seeds.ts          write missing seed files
 *   npx tsx packages/site-services/src/lots/write-seeds.ts --check  exit 1 if a file is missing or differs
 *
 * An existing seed file is never overwritten: a published migration is immutable. A changed machine gets a
 * new version with its own seed file (add it to SITE_MACHINES).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { state } from '@ebmr/kernel';
import { MATERIAL_LOT_V1, MATERIAL_LOT_V2, MATERIAL_LOT_V3 } from './machine.ts';

export interface SiteMachine {
  descriptor: state.MachineDescriptor;
  /** Repository-relative path of the TypeScript source, written into the generated header. */
  source: string;
}

/** Every published machine version of site-services. Add entries; never edit a published one. */
export const SITE_MACHINES: readonly SiteMachine[] = [
  { descriptor: MATERIAL_LOT_V1, source: 'packages/site-services/src/lots/machine.ts' },
  { descriptor: MATERIAL_LOT_V2, source: 'packages/site-services/src/lots/machine.ts' },
  { descriptor: MATERIAL_LOT_V3, source: 'packages/site-services/src/lots/machine.ts' },
];

export const SITE_SQL_DIR = new URL('../../sql', import.meta.url).pathname;

const KERNEL_GENERATOR = 'by packages/kernel/src/state/write-seeds.ts';
const SITE_GENERATOR = 'by packages/site-services/src/lots/write-seeds.ts (kernel state.machineSeedSql)';

/** The seed migration of a site-services machine: the kernel generator's output with this generator named in the header. */
export function siteMachineSeedSql(machine: SiteMachine): string {
  const sql = state.machineSeedSql(machine.descriptor, machine.source);
  if (!sql.includes(KERNEL_GENERATOR)) throw new Error('the kernel seed header changed; update siteMachineSeedSql');
  return sql.replace(KERNEL_GENERATOR, SITE_GENERATOR);
}

export interface SiteSeedStatus {
  file: string;
  status: 'up-to-date' | 'missing' | 'differs';
}

export function siteSeedStatus(sqlDir = SITE_SQL_DIR): SiteSeedStatus[] {
  return SITE_MACHINES.map((m) => {
    const path = join(sqlDir, m.descriptor.seedFile);
    if (!existsSync(path)) return { file: m.descriptor.seedFile, status: 'missing' };
    return { file: m.descriptor.seedFile, status: readFileSync(path, 'utf8') === siteMachineSeedSql(m) ? 'up-to-date' : 'differs' };
  });
}

function main(args: string[]): number {
  const check = args.includes('--check');
  let problems = 0;
  for (const m of SITE_MACHINES) {
    const path = join(SITE_SQL_DIR, m.descriptor.seedFile);
    const sql = siteMachineSeedSql(m);
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
