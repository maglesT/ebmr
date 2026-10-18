/**
 * The guides (slice 7e): the generated reference pages are current (the permission list from a database built from
 * the migrations, the screen list from the web app's code); every task in the guides names a screen that exists, a
 * right and a signature meaning the database holds, and each database function a guide names exists and checks one of
 * the rights the guide gives for it; each guide builds into one self-contained HTML file whose links all resolve inside
 * it. Runs in the `db` project (it builds its own edition database on the test cluster).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL } from '../../../packages/kernel/test/support/db.ts';
import { guideHtml, guides, productVersion } from '../src/build.ts';
import { catalogueFromMigrations, renderPermissions, type Catalogue } from '../src/catalogue.ts';
import { escapeHtml, toHtml, type Resolver } from '../src/html.ts';
import { REFERENCE } from '../src/md.ts';
import { readScreens, renderScreens } from '../src/screens.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const GUIDES = 'docs/guides';
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

function mdFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(ROOT, rel)).isDirectory() ? mdFiles(rel) : n.endsWith('.md') ? [rel] : [];
  });
}

/** Every table of a page: its header cells and its rows, cells split on unescaped pipes. */
function tables(md: string): { head: string[]; rows: string[][] }[] {
  const split = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const lines = md.split('\n');
  const out: { head: string[]; rows: string[][] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').startsWith('|') || !/^\|?\s*-{3}/.test(lines[i + 1] ?? '')) continue;
    const head = split(lines[i] ?? '');
    const rows: string[][] = [];
    for (i += 2; i < lines.length && (lines[i] ?? '').startsWith('|'); i++) rows.push(split(lines[i] ?? ''));
    out.push({ head, rows });
  }
  return out;
}

const codes = (cell: string | undefined) => [...(cell ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

/** The SQL of the migration that defines `fn` last (highest number), from `create ... function fn(` to its `$$;`. */
function latestBody(fn: string): string | null {
  const dirs = ['packages/kernel/sql', 'packages/site-services/sql', 'packages/recipe-core/sql', 'apps/tablets-server/sql'];
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${fn.replace('.', '\\.')}\\s*\\(`, 'i');
  let best: { n: number; body: string } | null = null;
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.sql'))) {
      const text = read(`${d}/${f}`);
      const m = re.exec(text);
      if (!m) continue;
      const n = Number(/^(\d+)_/.exec(f)?.[1] ?? -1);
      const end = text.indexOf('$$;', m.index + m[0].length);
      if (!best || n > best.n) best = { n, body: text.slice(m.index, end === -1 ? undefined : end) };
    }
  }
  return best?.body ?? null;
}

describe('the guides (slice 7e)', () => {
  let catalogue: Catalogue;
  beforeAll(async () => {
    catalogue = await catalogueFromMigrations(ADMIN_URL);
  }, 300_000);

  it('[meta] the generated permission list is current (pnpm guides:lists)', () => {
    expect(read(`${REFERENCE}/permissions.md`)).toBe(renderPermissions(catalogue));
  });

  it('[meta] the generated screen list is current (pnpm guides:lists)', () => {
    const s = readScreens(ROOT);
    expect(s.screens.length).toBeGreaterThan(90);
    expect(s.screens.some((x) => x.path === '/about' && x.feature === 'session')).toBe(true);
    expect(read(`${REFERENCE}/screens.md`)).toBe(renderScreens(s));
  });

  it('[meta] every task names a screen that exists, a right and a signature meaning the database holds', () => {
    const screens = new Set(readScreens(ROOT).screens.map((x) => x.path));
    const rights = new Set(catalogue.permissions.map((p) => p.code));
    const meanings = new Set(catalogue.meanings.map((m) => m.code));
    const problems: string[] = [];
    let tasks = 0;
    for (const page of mdFiles(GUIDES).filter((p) => !p.startsWith(REFERENCE))) {
      for (const t of tables(read(page))) {
        const col = (name: string) => t.head.indexOf(name);
        const [screen, right, meaning] = [col('Screen'), col('Right'), col('Signature meaning')];
        if (right === -1) continue;
        for (const row of t.rows) {
          tasks += 1;
          for (const c of codes(row[screen])) if (c.startsWith('/') && !screens.has(c)) problems.push(`${page}: no screen ${c}`);
          for (const c of codes(row[right])) if (!rights.has(c)) problems.push(`${page}: no right ${c}`);
          for (const c of meaning === -1 ? [] : codes(row[meaning])) if (!meanings.has(c)) problems.push(`${page}: no signature meaning ${c}`);
        }
      }
      // A role named in a role table or list must exist too.
      for (const c of codes(read(page))) if (/^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_.]*$/.test(c) && !c.includes('*') && !rights.has(c)) problems.push(`${page}: no right ${c}`);
    }
    expect(problems).toEqual([]);
    expect(tasks).toBeGreaterThan(150);
  });

  it('[meta] each database function a guide names exists and checks one of the rights the guide gives for it', () => {
    const problems: string[] = [];
    let named = 0;
    for (const page of mdFiles(GUIDES).filter((p) => !p.startsWith(REFERENCE))) {
      for (const t of tables(read(page))) {
        const fnCol = t.head.findIndex((h) => h === 'Function' || h === 'Function or screen');
        const right = t.head.indexOf('Right');
        if (fnCol === -1 || right === -1) continue;
        for (const row of t.rows) {
          const wanted = codes(row[right]);
          for (const fn of codes(row[fnCol]).filter((c) => /^[a-z_]+\.[a-z_]+$/.test(c))) {
            named += 1;
            const body = latestBody(fn);
            if (body === null) {
              problems.push(`${page}: ${fn} is defined by no migration`);
              continue;
            }
            const checks = [...body.matchAll(/'([A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] ?? '');
            if (checks.length > 0 && !checks.some((c) => wanted.includes(c))) problems.push(`${page}: ${fn} checks ${[...new Set(checks)].join(', ')}, the guide says ${wanted.join(', ') || 'none'}`);
            if (checks.length === 0 && wanted.length > 0) problems.push(`${page}: ${fn} checks no right, the guide says ${wanted.join(', ')}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(named).toBeGreaterThan(40);
  });

  it('[meta] each guide builds into one self-contained HTML file: brand on the cover, images inline, every link inside it resolves', () => {
    const version = productVersion(ROOT);
    for (const g of guides(ROOT)) {
      const html = guideHtml(ROOT, g, version);
      expect(html, g.id).toContain('alt="Batchwright Tablets" src="data:image/svg+xml;base64,');
      expect(html, g.id).toContain('alt="Medhanta" src="data:image/png;base64,');
      // Nothing is fetched: no external script, stylesheet or image.
      expect(html.match(/<(script|link)\b/g), g.id).toBeNull();
      for (const m of html.matchAll(/<img [^>]*src="([^"]*)"/g)) expect(m[1], g.id).toMatch(/^data:image\/(svg\+xml|png);base64,/);
      const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
      const dangling = [...html.matchAll(/<a href="#([^"]+)"/g)].map((m) => m[1] ?? '').filter((id) => !ids.has(id));
      expect(dangling, g.id).toEqual([]);
      expect(g.pages[0], g.id).toBe(`${GUIDES}/${g.id}/README.md`);
    }
  });
});

describe('the guides\' Markdown to HTML', () => {
  const r: Resolver = { headingId: (s) => `p--${s}`, href: (t) => (t.endsWith('.md') ? null : t), image: (t) => `data:${t}` };

  it('[meta] escapes raw HTML, keeps code literal, and renders headings, lists, tables, quotes and links', () => {
    const html = toHtml(
      [
        '# Title <b>x</b>',
        '',
        'Text with `<code>` and **bold**, *italic* and a [link](https://example.org) and a [repo file](../x.md).',
        '',
        '- one',
        '- two',
        '  - nested',
        '',
        '1. first',
        '2. second',
        '',
        '| A | B |',
        '|---|---|',
        '| `a\\|b` | c |',
        '',
        '> quoted',
        '',
        '```',
        '<script>',
        '```',
      ].join('\n'),
      r,
    );
    expect(html).toContain('<h1 id="p--title-x">Title &lt;b&gt;x&lt;/b&gt;</h1>');
    expect(html).toContain('<code>&lt;code&gt;</code>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<a href="https://example.org">link</a>');
    expect(html).toContain('repo file <span class="path">(../x.md)</span>');
    expect(html).toContain('<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<td><code>a|b</code></td>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<pre><code>&lt;script&gt;</code></pre>');
    expect(html).not.toMatch(/<script|<b>/);
    expect(escapeHtml('"<&>')).toBe('&quot;&lt;&amp;&gt;');
  });
});
