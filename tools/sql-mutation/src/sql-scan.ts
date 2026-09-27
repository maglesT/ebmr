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

export function findFunctions(sql: string, file: string): FunctionDef[] {
  const out: FunctionDef[] = [];
  CREATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE.exec(sql)) !== null) {
    const start = m.index;
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
      name,
      key: `${name}(${normaliseArgs(args)})`,
      file,
      line: sql.slice(0, start).split('\n').length,
      statement: sql.slice(start, end),
      bodyStart: bodyStartAbs - start,
      bodyEnd: bodyEndAbs - start,
    });
    CREATE.lastIndex = end;
  }
  return out;
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
