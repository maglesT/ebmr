/**
 * `pnpm handbook` (generate) writes the generated handbook pages; `pnpm handbook:check` (check) exits non-zero when one
 * is out of date or any handbook check fails (decision 0014).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './check.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const command = process.argv[2];

if (command !== 'generate' && command !== 'check') {
  console.error('usage: cli.ts generate|check');
  process.exit(2);
}

const result = runChecks(root);
if (command === 'generate') {
  for (const [path, text] of result.generated) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  console.log(`handbook: wrote ${result.generated.size} pages (${result.model.modules.length} modules, ${result.model.migrations.length} migrations)`);
} else if (result.stale.length > 0) {
  for (const p of result.stale) console.error(`out of date: ${p} (run pnpm handbook)`);
}
for (const p of result.problems) console.error(p);
const failed = result.problems.length > 0 || (command === 'check' && result.stale.length > 0);
if (failed) {
  console.error(`handbook: ${result.problems.length} problem(s)${command === 'check' ? `, ${result.stale.length} stale page(s)` : ''}`);
  process.exit(1);
}
if (command === 'check') console.log(`handbook: all checks pass (${result.model.modules.length} modules)`);
