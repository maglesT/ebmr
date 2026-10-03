/**
 * Finds function definitions in migration files and splits a function body into code and
 * non-code (string literals, comments, nested dollar-quoted strings), so that mutators only
 * touch executable code.
 */

export interface FunctionDef {
  /** Schema-qualified name, e.g. esig.sign. */
  name: string;
  /** Name plus normalised argument list: distinguishes overloads, matches redefinitions. */
  key: string;
  /**
   * Name plus the types of the input arguments, as PostgreSQL identifies a function (argument names, OUT arguments,
   * defaults and type modifiers left out; common type aliases spelt out), e.g. `recipe.check_state(jsonb, text)`.
   * A later definition with the same identity replaces an earlier one; a DROP FUNCTION names it; to_regprocedure()
   * finds the function by it.
   */
  identity: string;
  file: string;
  /** Line of the `create` keyword in the file (1-based). */
  line: number;
  /** The whole CREATE FUNCTION statement, up to and including the final semicolon. */
  statement: string;
  /** Offsets of the body inside `statement` (between the dollar-quote tags). */
  bodyStart: number;
  bodyEnd: number;
}

const CREATE = /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gi;

function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced parentheses in function arguments');
}

/** Index of the closing quote of a single-quoted literal starting at `i`. */
function skipQuoted(text: string, i: number): number {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "'") {
      if (text[j + 1] === "'") {
        j++;
        continue;
      }
      return j;
    }
  }
  throw new Error('unterminated string literal');
}

function normaliseArgs(args: string): string {
  return args
    .split(',')
    .map((a) => a.replace(/\s+default\s+[\s\S]*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase())
    .join(',');
}

/** Splits an argument list at the commas outside parentheses and literals. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "'") i = skipQuoted(args, i);
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(from, i));
      from = i + 1;
    }
  }
  out.push(args.slice(from));
  return out.map((a) => a.trim()).filter((a) => a !== '');
}

/** Types whose name is more than one word or that a bare word would be mistaken for an argument name. */
const MULTI_WORD_TYPE = /^(double\s+precision|character\s+varying|bit\s+varying|national\s+character|timestamp|time|interval|character|char|varchar)\b/i;
const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
  varchar: 'character varying',
  char: 'character',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
};

/** The type of one input argument as PostgreSQL identifies it, or undefined for an OUT argument. */
function argumentType(arg: string): string | undefined {
  let rest = arg
    .replace(/\s+default\s+[\s\S]*$/i, '')
    .replace(/\s*=\s*[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const mode = /^(in|out|inout|variadic)\s+/.exec(rest);
  if (mode) {
    if (mode[1] === 'out') return undefined;
    rest = rest.slice(mode[0].length);
  }
  // An argument name, when there is one, comes before the type: `p_at timestamptz`, `"x" text`.
  if (!MULTI_WORD_TYPE.test(rest)) {
    const named = /^("[^"]+"|[a-z_][a-z0-9_$]*)\s+(\S[\s\S]*)$/.exec(rest);
    if (named?.[2]) rest = named[2];
  }
  // Type modifiers are not part of a function's identity: numeric(10, 2) and varchar(20) are numeric and varchar.
  rest = rest.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[\s*\d*\s*\]/g, '[]');
  const array = rest.endsWith('[]') ? '[]' : '';
  const base = array ? rest.slice(0, -2).trim() : rest;
  return `${TYPE_ALIASES[base] ?? base}${array}`;
}

/** `schema.name(type, type)`: the identity of a function with this argument list (OUT arguments left out). */
export function functionIdentity(name: string, args: string): string {
  const types = splitArgs(args).map(argumentType).filter((t): t is string => t !== undefined);
  return `${name.toLowerCase()}(${types.join(', ')})`;
}

/** Offset ranges of `sql` that are code (outside comments, literals and dollar-quoted bodies). */
function codeAt(sql: string): (pos: number) => boolean {
  const code = segments(sql).filter((s) => s.code);
  return (pos) => code.some((s) => pos >= s.start && pos < s.end);
}

export function findFunctions(sql: string, file: string): FunctionDef[] {
  return scanFunctions(sql, file).map((f) => f.def);
}

function scanFunctions(sql: string, file: string): { at: number; def: FunctionDef }[] {
  const out: { at: number; def: FunctionDef }[] = [];
  const isCode = codeAt(sql);
  const create = new RegExp(CREATE.source, CREATE.flags);
  let m: RegExpExecArray | null;
  while ((m = create.exec(sql)) !== null) {
    const start = m.index;
    // A CREATE FUNCTION quoted in a comment or a literal defines nothing.
    if (!isCode(start)) continue;
    const name = (m[1] ?? '').toLowerCase();
    const open = start + m[0].length - 1;
    const close = matchParen(sql, open);
    const args = sql.slice(open + 1, close);
    const asMatch = /\bas\s+(\$[a-z_0-9]*\$)/i.exec(sql.slice(close));
    if (!asMatch) throw new Error(`${file}: no dollar-quoted body for ${name}`);
    const tag = asMatch[1] ?? '$$';
    const bodyStartAbs = close + asMatch.index + asMatch[0].length;
    const bodyEndAbs = sql.indexOf(tag, bodyStartAbs);
    if (bodyEndAbs < 0) throw new Error(`${file}: unterminated body for ${name}`);
    const semi = sql.indexOf(';', bodyEndAbs + tag.length);
    const end = semi < 0 ? sql.length : semi + 1;
    out.push({
      at: start,
      def: {
        name,
        key: `${name}(${normaliseArgs(args)})`,
        identity: functionIdentity(name, args),
        file,
        line: sql.slice(0, start).split('\n').length,
        statement: sql.slice(start, end),
        bodyStart: bodyStartAbs - start,
        bodyEnd: bodyEndAbs - start,
      },
    });
    create.lastIndex = end;
  }
  return out;
}

/** What a migration does to functions, in file order: a definition, or the drop of one (by identity, or every overload of a name). */
export type FunctionEvent = { kind: 'define'; def: FunctionDef } | { kind: 'drop'; identity: string } | { kind: 'drop-all'; name: string };

const DROP = /drop\s+function\s+(?:if\s+exists\s+)?/gi;
const DROP_ITEM = /\s*([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*(\()?/iy;

/** The definitions and drops of a migration file, in the order PostgreSQL applies them. */
export function functionEvents(sql: string, file: string): FunctionEvent[] {
  const events: { at: number; event: FunctionEvent }[] = scanFunctions(sql, file).map(({ at, def }) => ({ at, event: { kind: 'define', def } }));
  const isCode = codeAt(sql);
  const drop = new RegExp(DROP.source, DROP.flags);
  let d: RegExpExecArray | null;
  while ((d = drop.exec(sql)) !== null) {
    if (!isCode(d.index)) continue;
    // DROP FUNCTION a.f(int), b.g(text) [CASCADE | RESTRICT];
    let pos = d.index + d[0].length;
    for (;;) {
      DROP_ITEM.lastIndex = pos;
      const item = DROP_ITEM.exec(sql);
      if (!item) break;
      const name = (item[1] ?? '').toLowerCase();
      if (item[2]) {
        const open = pos + item[0].length - 1;
        const close = matchParen(sql, open);
        events.push({ at: d.index, event: { kind: 'drop', identity: functionIdentity(name, sql.slice(open + 1, close)) } });
        pos = close + 1;
      } else {
        events.push({ at: d.index, event: { kind: 'drop-all', name } });
        pos += item[0].length;
      }
      const comma = /^\s*,/.exec(sql.slice(pos));
      if (!comma) break;
      pos += comma[0].length;
    }
  }
  return events.sort((a, b) => a.at - b.at).map((e) => e.event);
}

export interface Segment {
  code: boolean;
  start: number;
  end: number;
}

/** Splits `text` into code and non-code segments (literals, comments, nested dollar quotes). */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let codeStart = 0;
  const pushCode = (end: number) => {
    if (end > codeStart) out.push({ code: true, start: codeStart, end });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    let skipTo = -1;
    if (ch === "'") skipTo = skipQuoted(text, i) + 1;
    else if (ch === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      skipTo = nl < 0 ? text.length : nl;
    } else if (ch === '/' && next === '*') {
      const endc = text.indexOf('*/', i + 2);
      skipTo = endc < 0 ? text.length : endc + 2;
    } else if (ch === '$') {
      const tag = /^\$[a-z_0-9]*\$/i.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        skipTo = close < 0 ? text.length : close + tag[0].length;
      }
    }
    if (skipTo > i) {
      pushCode(i);
      out.push({ code: false, start: i, end: skipTo });
      codeStart = skipTo;
      i = skipTo - 1;
    }
  }
  pushCode(text.length);
  return out;
}
