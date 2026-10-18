/**
 * The screen list of the guides, read from the web app's code: each feature's routes (`createRoute({ path, component
 * })` in apps/tablets-web/src/features/<feature>/index.tsx and the nested index files) and its home tiles (`homeTiles`:
 * title, description, the installations that show it). Parsed with the TypeScript compiler, not run, so the generator
 * needs no browser. `pnpm guides:lists` writes docs/guides/reference/screens.md; the guides' test fails when it is out
 * of date.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { GENERATED_NOTE, table } from './md.ts';

export const FEATURES_DIR = 'apps/tablets-web/src/features';

export interface Screen {
  feature: string;
  path: string;
  component: string;
}

export interface Tile {
  feature: string;
  id: string;
  title: string;
  description: string;
  to: string;
  installations: string[];
  available: boolean;
}

function indexFiles(root: string, dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return indexFiles(root, rel);
    return name === 'index.tsx' ? [rel] : [];
  });
}

const text = (n: ts.Node | undefined): string | undefined => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);

function props(o: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>();
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) m.set(p.name.text, p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) m.set(p.name.text, p.name);
  }
  return m;
}

/** The routes and tiles of the web app's features. */
export function readScreens(root: string): { screens: Screen[]; tiles: Tile[] } {
  const screens: Screen[] = [];
  const tiles: Tile[] = [];
  for (const file of indexFiles(root, FEATURES_DIR).sort()) {
    const feature = relative(join(root, FEATURES_DIR), join(root, file)).replace(/\/index\.tsx$/, '');
    const src = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'createRoute' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        const p = props(n.arguments[0]);
        const path = text(p.get('path'));
        const component = p.get('component');
        if (path !== undefined) screens.push({ feature, path, component: component ? component.getText(src) : '' });
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'homeTiles' && n.initializer) {
        const init = ts.isAsExpression(n.initializer) || ts.isSatisfiesExpression(n.initializer) ? n.initializer.expression : n.initializer;
        if (ts.isArrayLiteralExpression(init)) {
          for (const el of init.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const p = props(el);
            const inst = p.get('installations');
            tiles.push({
              feature,
              id: text(p.get('id')) ?? '',
              title: text(p.get('title')) ?? '',
              description: text(p.get('description')) ?? '',
              to: text(p.get('to')) ?? '',
              installations: inst && ts.isArrayLiteralExpression(inst) ? inst.elements.map((e) => text(e) ?? e.getText(src)) : [],
              available: p.get('available')?.kind === ts.SyntaxKind.TrueKeyword,
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { screens, tiles };
}

/** docs/guides/reference/screens.md. */
export function renderScreens(s: { screens: Screen[]; tiles: Tile[] }): string {
  const features = [...new Set(s.screens.map((x) => x.feature))];
  const out = [
    '# Screens',
    '',
    GENERATED_NOTE,
    '',
    'Every screen of Batchwright Tablets by its address, grouped by the part of the application it belongs to, with the',
    'home-screen tile that opens it (and the installations that show the tile: GMP, the sandbox for test runs, or both).',
    'An address part written `$name` stands for a value, such as a batch or a run. A screen shows what the signed-in role',
    'may see; the server refuses anything else and says why.',
    '',
    `In all: ${s.screens.length} screens, ${s.tiles.length} home tiles.`,
    '',
  ];
  for (const f of features) {
    out.push(`## ${f}`, '');
    const rows = s.screens
      .filter((x) => x.feature === f)
      .map((x) => {
        const tiles = s.tiles.filter((t) => t.to === x.path);
        const name = tiles.map((t) => `${t.title} (${t.installations.join(', ')})${t.available ? '' : ', not available yet'}`).join('; ');
        return [`\`${x.path}\``, x.component, name, tiles.map((t) => t.description).join(' ')];
      });
    out.push(table(['Address', 'Screen', 'Home tile (shown on)', 'What it is for'], rows), '');
  }
  const orphan = s.tiles.filter((t) => !s.screens.some((x) => x.path === t.to));
  if (orphan.length > 0) {
    out.push('## Home tiles that open a screen of another part', '');
    out.push(table(['Tile', 'Opens', 'Shown on', 'What it is for'], orphan.map((t) => [t.title, `\`${t.to}\``, t.installations.join(', '), t.description])), '');
  }
  return out.join('\n');
}
