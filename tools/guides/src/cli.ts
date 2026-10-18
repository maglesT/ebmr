/**
 * `pnpm guides:lists` writes the generated reference pages of the guides (docs/guides/reference: permissions.md from a
 * database built from the migrations, screens.md from the web app's code); `pnpm guides:build` builds each guide into
 * one self-contained HTML file and a PDF under .reports/guides (not committed; D-P7-13).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuides } from './build.ts';
import { catalogueFromMigrations, renderPermissions } from './catalogue.ts';
import { REFERENCE } from './md.ts';
import { readScreens, renderScreens } from './screens.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const command = process.argv[2];
if (command === 'lists') {
  const pages: [string, string][] = [
    [`${REFERENCE}/permissions.md`, renderPermissions(await catalogueFromMigrations())],
    [`${REFERENCE}/screens.md`, renderScreens(readScreens(root))],
  ];
  for (const [path, text] of pages) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  console.log(`guides: wrote ${pages.map(([p]) => p).join(', ')}`);
} else if (command === 'build') {
  const out = await buildGuides(root, join(root, '.reports/guides'), { pdf: !process.argv.includes('--no-pdf') });
  for (const f of out) console.log(`guides: wrote ${f}`);
} else {
  console.error('usage: cli.ts lists|build [--no-pdf]');
  process.exit(2);
}
