/**
 * The end-to-end seed in CI (seed.ts):
 *   build <dir>   build the base set-up once and write the seed (the e2e-seed job);
 *   check <dir>   restore the seed, build the same set-up fresh in this cluster, and compare the two: row counts of every
 *                 table and every sequence's value (the lead's condition 3; a main full run). The keys and exchange files
 *                 are random per build, so they are compared only between the seed and its restore (restoreSeed).
 * The persona sets are the suite's workers + 1, as global-setup.ts builds them.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, setupStack } from '@ebmr/demo';
import config from './playwright.config.ts';
import { buildSeed, differences, fingerprint, restoreSeed, SEED_OPTIONS } from './seed.ts';

const PERSONA_SETS = Number(config.workers ?? 1) + 1;
const [command, dir] = process.argv.slice(2);
if (!dir || (command !== 'build' && command !== 'check')) throw new Error('usage: seed-cli.ts build|check <dir>');

if (command === 'build') {
  const started = performance.now();
  const meta = await buildSeed(dir, PERSONA_SETS);
  const tables = Object.values(meta.fingerprint.tables).reduce((n, t) => n + Object.keys(t).length, 0);
  console.log(`seed built in ${((performance.now() - started) / 1000).toFixed(0)} s: ${tables} tables, ${Object.keys(meta.fingerprint.files).length} files, in ${dir}`);
} else {
  const restored = await restoreSeed(dir);
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  mkdirSync(join(root, 'keys'), { recursive: true });
  await setupStack({ databases, keysDir: join(root, 'keys'), exchangeDir: join(root, 'exchange'), personaSets: PERSONA_SETS, echo: false, ...SEED_OPTIONS });
  const diff = differences(await fingerprint(restored.databases, join(restored.keysDir, '..')), await fingerprint(databases, root), { files: false });
  if (diff.length > 0) {
    console.error(`the restored seed differs from a fresh set-up (${diff.length}):\n${diff.slice(0, 60).join('\n')}`);
    process.exit(1);
  }
  console.log('the restored seed equals a fresh set-up: the same rows in every table and the same sequence values');
}
