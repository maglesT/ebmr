/**
 * `pnpm handbook` (generate) writes the generated handbook pages (not committed; CI keeps them as an artifact);
 * `pnpm handbook:check` (check) exits non-zero when any handbook check fails (decision 0014). Both fail on a problem.
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
}
for (const p of result.problems) console.error(p);
if (result.problems.length > 0) {
  console.error(`handbook: ${result.problems.length} problem(s)`);
  process.exit(1);
}
if (command === 'check') console.log(`handbook: all checks pass (${result.model.modules.length} modules)`);
