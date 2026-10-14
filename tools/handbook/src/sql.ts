/**
 * What a migration creates (read from its text, not from a database) and what a source file defines, for the database
 * catalogue and for `#sym=<name>` links. Comments are removed first, so a header that mentions a function does not
 * count as defining it. Objects created inside dynamic SQL (`execute format(...)`) are not seen.
 */

export type DbKind = 'function' | 'procedure' | 'trigger' | 'view' | 'table' | 'type';

export interface DbObject {
  readonly kind: DbKind;
  /** Schema-qualified as written; a trigger is `<name> on <table>`. */
  readonly name: string;
}

/** The text without `--` line comments and block comments (string literals are kept). */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    const n = sql.charAt(i + 1);
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '-' && n === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const NAME = String.raw`((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?)`;
const CREATE = new RegExp(
  String.raw`^[ \t]*create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged)\s+)?(constraint\s+trigger|trigger|function|procedure|materialized\s+view|recursive\s+view|view|table|type)\s+(?:if\s+not\s+exists\s+)?` +
    NAME,
  'gim',
);

function clean(name: string): string {
  return name.replace(/"/g, '').toLowerCase();
}

/** The objects a migration's text creates, in order of appearance, without repeats. */
export function dbObjects(sql: string): DbObject[] {
  const text = stripSqlComments(sql);
  const out: DbObject[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CREATE)) {
    const word = (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    let name = clean(m[2] ?? '');
    let kind: DbKind;
    if (word.endsWith('trigger')) {
      kind = 'trigger';
      const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 400);
      const on = new RegExp(String.raw`\bon\s+` + NAME, 'i').exec(rest);
      if (on) name = `${name} on ${clean(on[1] ?? '')}`;
    } else if (word.endsWith('view')) kind = 'view';
    else kind = word as DbKind;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, name });
  }
  return out;
}

const SQL_DEF = new RegExp(
  String.raw`^[ \t]*create\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged)\s+)?(?:constraint\s+trigger|trigger|function|procedure|materialized\s+view|recursive\s+view|view|table|type)\s+(?:if\s+not\s+exists\s+)?` +
    NAME,
  'gim',
);
const TS_DEF = /(?:^|[\s;{(])(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * The names a file defines: SQL `create [or replace] function|procedure|trigger|view|table|type <name>` (both the
 * schema-qualified name and the bare name), TypeScript `function|const|let|var|class|interface|type|enum <name>`.
 */
export function definedSymbols(file: string, text: string): Set<string> {
  const out = new Set<string>();
  if (file.endsWith('.sql')) {
    for (const m of stripSqlComments(text).matchAll(SQL_DEF)) {
      const name = clean(m[1] ?? '');
      out.add(name);
      if (name.includes('.')) out.add(name.slice(name.indexOf('.') + 1));
    }
  } else {
    for (const m of text.matchAll(TS_DEF)) out.add(m[1] ?? '');
  }
  return out;
}

/** Whether the file text defines `name` (see definedSymbols; SQL names compare without case). */
export function definesSymbol(file: string, text: string, name: string): boolean {
  return definedSymbols(file, text).has(file.endsWith('.sql') ? clean(name) : name);
}
