/**
 * The handbook link checker (decision 0014 3c). Every relative link in docs/handbook/**.md must reach an existing file
 * (or a page listed as pending in modules.yaml); `#sym=<name>` needs the target to define `<name>`; `#anchor` into a
 * Markdown page needs a heading with that GitHub slug. Links inside code spans and fenced code are not links.
 */
import { existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { read } from './repo.ts';
import { definedSymbols } from './sql.ts';

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slug(heading: string): string {
  const text = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** The text without fenced code blocks (kept as blank lines) and with inline code spans blanked. */
export function withoutCode(md: string): string {
  const lines = md.split('\n');
  let fence: string | undefined;
  return lines
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && (f[1] ?? '').startsWith(fence)) fence = undefined;
        return '';
      }
      if (f) {
        fence = f[1];
        return '';
      }
      return line.replace(/(`+)(?:(?!\1).)+?\1/g, (m) => 'x'.repeat(m.length));
    })
    .join('\n');
}

/** Every anchor a Markdown page offers: heading slugs (with GitHub's -1, -2 for repeats) and explicit ids. */
export function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  const raw = md.split('\n');
  const plain = withoutCode(md).split('\n');
  plain.forEach((line, i) => {
    if (!/^#{1,6}\s/.test(line)) return;
    const original = (raw[i] ?? '').replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '');
    const base = slug(original);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  });
  for (const m of md.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1] ?? '');
  return out;
}

export interface LinkContext {
  readonly root: string;
  /** Pending pages, repository-relative. */
  readonly pending: ReadonlySet<string>;
  /** Content to use instead of the file on disk (generated pages before they are written). */
  readonly overlay?: ReadonlyMap<string, string>;
}

/** The problems of one Markdown page (repository-relative path) with the given text. */
export function checkLinks(ctx: LinkContext, page: string, text: string, cache = new Map<string, string>(), symbols = new Map<string, Set<string>>()): string[] {
  // `symbols` caches each target's defined names, and (under `#<path>`) each Markdown page's anchors.
  const problems: string[] = [];
  const body = withoutCode(text);
  const readCached = (rel: string): string => {
    const o = ctx.overlay?.get(rel);
    if (o !== undefined) return o;
    let t = cache.get(rel);
    if (t === undefined) {
      t = read(ctx.root, rel);
      cache.set(rel, t);
    }
    return t;
  };
  for (const m of body.matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1] ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const hash = target.indexOf('#');
    const where = `${page}: link ${target}`;
    let pathPart: string;
    let fragment: string | undefined;
    try {
      pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
      fragment = hash === -1 ? undefined : decodeURIComponent(target.slice(hash + 1));
    } catch {
      problems.push(`${where}: malformed percent-encoding`);
      continue;
    }
    const rel = pathPart === '' ? page : posix.normalize(posix.join(posix.dirname(page), pathPart)).replace(/\/+$/, '');
    if (rel.startsWith('../')) {
      problems.push(`${where} leaves the repository`);
      continue;
    }
    const exists = ctx.overlay?.has(rel) === true || existsSync(join(ctx.root, rel));
    if (!exists) {
      if (!ctx.pending.has(rel)) problems.push(`${where}: ${rel} does not exist`);
      continue;
    }
    if (fragment === undefined) continue;
    const isDir = ctx.overlay?.has(rel) !== true && statSync(join(ctx.root, rel)).isDirectory();
    if (fragment.startsWith('sym=')) {
      const name = fragment.slice(4);
      let defined = symbols.get(rel);
      if (!isDir && defined === undefined) {
        defined = definedSymbols(rel, readCached(rel));
        symbols.set(rel, defined);
      }
      const key = rel.endsWith('.sql') ? name.replace(/"/g, '').toLowerCase() : name;
      if (isDir || defined?.has(key) !== true) problems.push(`${where}: ${rel} does not define ${name}`);
    } else if (/^L\d+/.test(fragment)) {
      problems.push(`${where}: line-number links drift; link a symbol with #sym=<name>`);
    } else if (rel.endsWith('.md') && !isDir) {
      let found = symbols.get(`#${rel}`);
      if (found === undefined) {
        found = anchors(readCached(rel));
        symbols.set(`#${rel}`, found);
      }
      if (!found.has(fragment)) problems.push(`${where}: ${rel} has no heading #${fragment}`);
    } else {
      problems.push(`${where}: a fragment on a non-Markdown file must be #sym=<name>`);
    }
  }
  return problems;
}
