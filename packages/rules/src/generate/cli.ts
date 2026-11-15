/**
 * pnpm rules:generate [--number N] [--slug S]: writes the generated blocks that differ from the committed migrations
 * as one new recipe-core migration (ADR 0023, decision 3); prints nothing to do when there are none.
 * pnpm rules:check: CI's static check (migrations.ts `check`); exits 1 with the problems.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationText } from './emit.ts';
import { check, MIGRATIONS_DIR, nextFile, pending, readMigrations } from './migrations.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [command, ...args] = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const migrations = readMigrations(root);
if (command === 'check') {
  const problems = check(migrations);
  for (const p of problems) console.error(`rules:check: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log('rules:check: every generated function matches the generator');
} else if (command === 'generate') {
  const blocks = pending(migrations);
  if (blocks.length === 0) {
    console.log('rules:generate: the committed migrations hold the generator\'s output; nothing to write');
  } else {
    const n = option('number');
    const file = nextFile(migrations, option('slug') ?? 'generated', n === undefined ? undefined : Number.parseInt(n, 10));
    writeFileSync(join(root, MIGRATIONS_DIR, file), migrationText(blocks));
    console.log(`rules:generate: wrote ${MIGRATIONS_DIR}/${file} (${blocks.map((b) => b.fn).join(', ')})`);
  }
} else {
  console.error('usage: rules.ts check | generate [--number N] [--slug S]');
  process.exit(2);
}
