/**
 * [meta] Requirement R2 (hosted-demo trials, October 2026): nothing a person needs may be unreachable from the site. Every
 * route of the web app is reached by navigation from the home screen (a tile, a link or a button that navigates), or is
 * listed below with the reason it is not.
 *
 * Reachability is read from the source, without a browser:
 *  - each route's page is the component its feature's index.tsx gives `createRoute` (or `page(path, Component)`), in the
 *    file it is imported from; the page's code is that file and every file it imports (relative imports, followed through
 *    anything but a feature's index.tsx, whose strings count but whose imports are every page of the feature);
 *  - a link is a string or template literal in that code which matches a route's path ('$param' segments match any
 *    segment, and a template's `${...}` matches any segment);
 *  - from home: the home screen's tiles (every feature's homeTiles), the shell's code (on every page) and the home page's.
 * A route reached from home lets its page's links count, and so on until nothing new is reached.
 *
 * The test fails on a route no one can reach that is not listed, on a listed route that is now reached (remove it from the
 * list) and on a listed path that is no route.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Routes no navigation reaches, each with why that is right. */
const UNREACHABLE: Readonly<Record<string, string>> = {
  '/esig/demo': 'DEMO-ONLY developer page that signs a kernel stub entry named in its address (?stub=<entry id>); no person reaches a stub entry by navigation, and the real signing ceremony opens from every act that needs a signature',
  '/test-packages': 'the same inbox as /packages (a home tile on the sandbox), kept as the address the GMP designer gives after an export (?package=<hash>) for the other installation, which a link of this installation cannot name',
};

/** The string literals of a source file (template literals with each `${...}` as `${}`), comments skipped. */
export function literals(source: string): { text: string; before: string }[] {
  const out: { text: string; before: string }[] = [];
  let i = 0;
  const n = source.length;
  const readTemplate = (): string => {
    // At the opening backtick; returns the text with every substitution as ${}.
    let text = '';
    i += 1;
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          const c = source[i];
          if (c === '{') depth += 1;
          else if (c === '}') depth -= 1;
          else if (c === '`') readTemplate();
          else if (c === "'" || c === '"') readQuoted(c);
          i += 1;
        }
        text += '${}';
      } else {
        text += source[i];
        i += 1;
      }
    }
    return text;
  };
  const readQuoted = (quote: string): string | null => {
    // At the opening quote; ends on the closing quote. A JS string never spans a line: a newline first means this was
    // an apostrophe of JSX text, and no string is read.
    const start = i;
    i += 1;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\n') {
        i = start;
        return null;
      }
      if (source[i] === '\\') i += 1;
      i += 1;
    }
    if (i >= n) {
      i = start;
      return null;
    }
    return source.slice(start + 1, i);
  };
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      const start = i;
      const text = readQuoted(c);
      if (text !== null) out.push({ text, before: source.slice(Math.max(0, start - 12), start) });
      i += 1;
    } else if (c === '`') {
      const start = i;
      const text = readTemplate();
      out.push({ text, before: source.slice(Math.max(0, start - 12), start) });
      i += 1;
    } else i += 1;
  }
  return out;
}

/** Does a link (a literal starting with '/') navigate to the route `path`? */
export function linksTo(link: string, path: string): boolean {
  const bare = link.split(/[?#]/)[0] ?? '';
  const a = bare.split('/');
  const b = path.split('/');
  if (bare.length > 1 && bare.endsWith('/')) a.pop();
  if (a.length !== b.length) return false;
  return b.every((seg, k) => {
    const l = a[k] ?? '';
    if (seg.startsWith('$')) return l !== '';
    return l === seg || l === '${}';
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

const isFeatureIndex = (file: string): boolean => /\/features\/(.+\/)?index\.tsx$/.test(file) || file.endsWith('/app/features.ts') || file.endsWith('/app/router.tsx');

interface Route {
  path: string;
  /** The file of its page component, or null when the index does not say. */
  page: string | null;
  index: string;
}

function routesOf(): Route[] {
  const out: Route[] = [];
  for (const index of walk(join(SRC, 'features')).filter((f) => f.endsWith('/index.tsx'))) {
    const src = readFileSync(index, 'utf8');
    const imports = new Map<string, string>();
    // A page the index defines itself (a feature's hub).
    const pageIn = (name: string): string | null => (new RegExp(`function ${name}\\b|const ${name}\\b`).test(src) ? index : null);
    for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']+)'/g)) {
      const file = resolveImport(index, m[2] ?? '');
      if (!file) continue;
      for (const name of (m[1] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/).pop() ?? '')) if (name) imports.set(name, file);
    }
    for (const m of src.matchAll(/path:\s*'([^']+)'[\s\S]*?component:\s*([A-Za-z0-9_]+)/g)) {
      out.push({ path: m[1] ?? '', page: imports.get(m[2] ?? '') ?? pageIn(m[2] ?? ''), index });
    }
    for (const m of src.matchAll(/\bpage\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
      out.push({ path: m[1] ?? '', page: imports.get(m[2] ?? '') ?? pageIn(m[2] ?? ''), index });
    }
  }
  return out;
}

/** The links of a file and of every file it imports (through anything but a feature index). */
function linksOf(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const own = literals(src)
    .filter((l) => l.text.startsWith('/') && !/(path:\s*|page\(\s*)$/.test(l.before))
    .map((l) => l.text);
  if (isFeatureIndex(file)) return own;
  const deeper = [...src.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)].flatMap((m) => {
    const f = resolveImport(file, m[1] ?? '');
    return f ? linksOf(f, seen) : [];
  });
  return [...own, ...deeper];
}

function homeTileTargets(): string[] {
  return walk(join(SRC, 'features'))
    .filter((f) => f.endsWith('/index.tsx'))
    .flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      const tiles = src.indexOf('homeTiles');
      return tiles < 0 ? [] : [...src.slice(tiles).matchAll(/\bto:\s*'([^']+)'/g)].map((m) => m[1] ?? '');
    });
}

describe('[meta] R2: every web route is reached by navigation from home, or listed with its reason', () => {
  const routes = routesOf();

  it('finds the routes and the page of each', () => {
    expect(routes.length).toBeGreaterThan(100);
    const pageless = routes.filter((r) => r.page === null).map((r) => `${r.path} (${relative(SRC, r.index)})`);
    expect(pageless).toEqual([]);
  });

  it('reaches every route from the home screen', () => {
    const reached = new Set<string>(['/']);
    let frontier: string[] = [...homeTileTargets(), ...linksOf(join(SRC, 'app', 'shell.tsx'))];
    const home = routes.find((r) => r.path === '/');
    if (home?.page) frontier.push(...linksOf(home.page));
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const r of routes) {
        if (reached.has(r.path) || !frontier.some((l) => linksTo(l, r.path))) continue;
        reached.add(r.path);
        if (r.page) next.push(...linksOf(r.page));
      }
      frontier = next;
    }
    const unreachable = routes.map((r) => r.path).filter((p) => !reached.has(p));
    expect(unreachable.filter((p) => !(p in UNREACHABLE))).toEqual([]);
    expect(Object.keys(UNREACHABLE).filter((p) => reached.has(p))).toEqual([]);
    expect(Object.keys(UNREACHABLE).filter((p) => !routes.some((r) => r.path === p))).toEqual([]);
  });

  it('reads links as the app writes them', () => {
    expect(literals("const a = '/x'; // '/comment'\n<p>it's here</p> <a href=\"/y\">").map((l) => l.text)).toEqual(['/x', '/y']);
    expect(literals('to={`/runs/${run.id}/steps/${`k${i}`}`}').map((l) => l.text)).toEqual(['/runs/${}/steps/${}']);
    expect(linksTo('/runs/${}/steps/${}', '/runs/$runId/steps/$stepKey')).toBe(true);
    expect(linksTo('/runs/$runId', '/runs/$runId')).toBe(true);
    expect(linksTo('/runs?x=1', '/runs')).toBe(true);
    expect(linksTo('/runs', '/runs/$runId')).toBe(false);
  });
});
