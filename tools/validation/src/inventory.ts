/**
 * The inventory of the evidence bundle (Phase 7 slice 7c; interfaces section 1b): what a database migrated to the
 * release holds, read over a read-only connection from pg_catalog and the kernel's registries, and what the code
 * declares (the message catalogue, the API routes).
 *
 * Every list is sorted by its key with compareText (code point order), so the same database and code give the same
 * inventory. Nothing here writes: the database work runs in one READ ONLY transaction that is rolled back.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type pg from 'pg';
import { routes } from '@ebmr/api-contract';
import { compareText, databaseInventory, type Inventory, type InvMessage, type InvRoute } from '@ebmr/validation-kit';
import { ROOT } from './sources.ts';

// The database's part moved to the validation kit (slice 7g-3, D-P7R-5): the server's IQ route runs the same code.
export { databaseInventory, LOCKED_SETTINGS, RECORDED_SETTINGS, type DbInventory } from '@ebmr/validation-kit';

const by = <T>(...keys: ((x: T) => string)[]) => (a: T, b: T): number => {
  for (const k of keys) {
    const c = compareText(k(a), k(b));
    if (c !== 0) return c;
  }
  return 0;
};

/** Removes items whose key repeats (the first, in the given order, is kept). */
function unique<T>(items: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const MESSAGE = /EBMR-[A-Z]+-\d{3,4}/g;

function filesUnder(dir: string, ext: RegExp): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries.sort()) {
    if (e === 'node_modules' || e === 'test' || e === 'fixtures') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, ext));
    else if (ext.test(e)) out.push(p);
  }
  return out;
}

/** The text that goes with a message code on its line: the quoted text around it, without SQL format markers. */
function messageText(line: string, code: string): string {
  const at = line.indexOf(code);
  const quote = (ch: string): [number, number] | null => {
    const start = line.lastIndexOf(ch, at);
    const end = line.indexOf(ch, at + code.length);
    return start >= 0 && end > start ? [start + 1, end] : null;
  };
  const span = quote("'") ?? quote('`') ?? quote('"');
  const raw = span ? line.slice(span[0], span[1]) : line.slice(at);
  const text = raw.replace(code, '').replace(/^[\s:.-]+|[\s[\]]+$/g, '').replace(/\s+/g, ' ').trim();
  return (text === '' ? '(see source)' : text).slice(0, 300);
}

/** The message catalogue: each EBMR code once, with the text of its first occurrence in the SQL and the product code. */
export function messageCatalogue(root = ROOT): InvMessage[] {
  const files = [
    ...['packages', 'apps'].flatMap((top) => {
      let dirs: string[];
      try {
        dirs = readdirSync(join(root, top)).sort();
      } catch {
        return [];
      }
      return dirs.flatMap((d) => [...filesUnder(join(root, top, d, 'sql'), /\.sql$/), ...filesUnder(join(root, top, d, 'src'), /\.tsx?$/)]);
    }),
  ].map((f) => relative(root, f).split('\\').join('/')).sort(compareText);
  const out: InvMessage[] = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    for (const line of lines) {
      for (const m of line.matchAll(MESSAGE)) out.push({ code: m[0], text: messageText(line, m[0]), sourceFile: file });
    }
  }
  return unique(out, (m) => m.code).sort(by((m) => m.code));
}

interface RouteLike {
  id: string;
  method: InvRoute['method'];
  path: string;
}
const isRoute = (x: unknown): x is RouteLike =>
  typeof x === 'object' && x !== null && typeof (x as RouteLike).id === 'string' && typeof (x as RouteLike).path === 'string' && typeof (x as RouteLike).method === 'string';

/** Every route of the API contract (the database checks the permission in the command: none is named here). */
export function routeCatalogue(): InvRoute[] {
  const out: InvRoute[] = [];
  const walk = (x: unknown): void => {
    if (isRoute(x)) {
      out.push({ namespace: x.id.split('.')[0] ?? x.id, route: x.path, method: x.method, permission: null });
      return;
    }
    if (typeof x === 'object' && x !== null) for (const v of Object.values(x)) walk(v);
  };
  walk(routes);
  return unique(out.sort(by((r) => r.namespace, (r) => r.route, (r) => r.method)), (r) => `${r.namespace} ${r.route} ${r.method}`);
}

/** The whole inventory: the database's and the code's. */
export async function inventory(client: pg.ClientBase, opts: { lockedSettings?: Readonly<Record<string, string>>; root?: string } = {}): Promise<Inventory> {
  const db = await databaseInventory(client, opts.lockedSettings);
  return { ...db, messages: messageCatalogue(opts.root), routes: routeCatalogue() };
}
