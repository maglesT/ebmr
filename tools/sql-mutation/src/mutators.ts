/**
 * Mutation operators for PL/pgSQL and SQL function bodies. Each mutant changes one place in the
 * executable code of one function; literals and comments are never touched.
 *
 *   GUARD_REMOVED   a `raise exception ... ;` statement becomes `null;` (the check no longer refuses)
 *   RELATIONAL      < <= > >= = <> are replaced by their boundary or negated neighbour
 *   LOGICAL         `and` <-> `or`
 *   NOT_REMOVED     a `not` is dropped (`not exists`, `if not found`, `is not null`, ...)
 *   BOOLEAN         `true` <-> `false`
 */
import { segments, type FunctionDef } from './sql-scan.ts';

export type Operator = 'GUARD_REMOVED' | 'RELATIONAL' | 'LOGICAL' | 'NOT_REMOVED' | 'BOOLEAN';

export interface Mutant {
  id: string;
  function: string;
  file: string;
  /** Line in the migration file. */
  line: number;
  operator: Operator;
  original: string;
  replacement: string;
  /** The complete mutated statement, as CREATE OR REPLACE. */
  statement: string;
}

interface Edit {
  operator: Operator;
  start: number;
  end: number;
  replacement: string;
}

const RELATIONAL: Record<string, string> = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '=': '<>', '<>': '=', '!=': '=' };

function codeEdits(body: string): Edit[] {
  const edits: Edit[] = [];
  const segs = segments(body);
  const isCode = (pos: number) => segs.some((s) => s.code && pos >= s.start && pos < s.end);

  for (const s of segs) {
    if (!s.code) continue;
    const text = body.slice(s.start, s.end);
    // Relational operators: longest match first, never part of := => || or a cast.
    const rel = /<=|>=|<>|!=|<|>|=/g;
    let r: RegExpExecArray | null;
    while ((r = rel.exec(text)) !== null) {
      const op = r[0];
      const at = s.start + r.index;
      const before = body[at - 1] ?? '';
      const after = body[at + op.length] ?? '';
      if (op === '=' && (before === ':' || after === '>' || before === '<' || before === '>' || before === '!')) continue;
      if ((op === '<' || op === '>') && (after === '=' || after === '>' || before === '<' || before === '-' || after === '-')) continue;
      if (op === '<' && after === '<') continue;
      const replacement = RELATIONAL[op];
      if (replacement) edits.push({ operator: 'RELATIONAL', start: at, end: at + op.length, replacement });
    }
    const words = /\b(and|or|not|true|false)\b/gi;
    let w: RegExpExecArray | null;
    while ((w = words.exec(text)) !== null) {
      const word = (w[1] ?? '').toLowerCase();
      const at = s.start + w.index;
      const prev = body.slice(Math.max(0, at - 12), at).toLowerCase();
      if (word === 'and') {
        if (/\bbetween\s+\S+\s*$/.test(prev) || /\bbetween\b[^;]*$/.test(body.slice(Math.max(0, at - 60), at).toLowerCase())) continue;
        edits.push({ operator: 'LOGICAL', start: at, end: at + 3, replacement: 'or' });
      } else if (word === 'or') {
        if (/create\s+$/.test(prev) || /\breplace\b/.test(body.slice(at, at + 12).toLowerCase())) continue;
        edits.push({ operator: 'LOGICAL', start: at, end: at + 2, replacement: 'and' });
      } else if (word === 'not') {
        // `not null` in declarations is a constraint, not logic.
        if (/^not\s+null\b/i.test(body.slice(at)) && !/\bis\s+$/i.test(prev)) continue;
        const spaced = /^not\s+/i.exec(body.slice(at));
        edits.push({ operator: 'NOT_REMOVED', start: at, end: at + (spaced ? spaced[0].length : 3), replacement: '' });
      } else {
        edits.push({ operator: 'BOOLEAN', start: at, end: at + word.length, replacement: word === 'true' ? 'false' : 'true' });
      }
    }
  }

  // Guard removal: `raise exception` up to the statement's semicolon (outside literals).
  const raise = /\braise\s+exception\b/gi;
  let g: RegExpExecArray | null;
  while ((g = raise.exec(body)) !== null) {
    if (!isCode(g.index)) continue;
    let end = -1;
    for (const s of segs) {
      if (!s.code || s.end <= g.index) continue;
      const from = Math.max(s.start, g.index);
      const semi = body.indexOf(';', from);
      if (semi >= 0 && semi < s.end) {
        end = semi;
        break;
      }
    }
    if (end > g.index) edits.push({ operator: 'GUARD_REMOVED', start: g.index, end, replacement: 'null' });
  }
  return edits;
}

export function mutantsOf(def: FunctionDef, operators?: ReadonlySet<Operator>): Mutant[] {
  const body = def.statement.slice(def.bodyStart, def.bodyEnd);
  const header = def.statement.slice(0, def.bodyStart).replace(/^create\s+(or\s+replace\s+)?function/i, 'create or replace function');
  const footer = def.statement.slice(def.bodyEnd);
  const out: Mutant[] = [];
  const edits = codeEdits(body).filter((e) => !operators || operators.has(e.operator));
  edits.sort((a, b) => a.start - b.start);
  edits.forEach((e, i) => {
    const mutatedBody = body.slice(0, e.start) + e.replacement + body.slice(e.end);
    const bodyLineOffset = def.statement.slice(0, def.bodyStart).split('\n').length - 1;
    const line = def.line + bodyLineOffset + body.slice(0, e.start).split('\n').length - 1;
    out.push({
      id: `${def.name}#${i + 1}`,
      function: def.name,
      file: def.file,
      line,
      operator: e.operator,
      original: body.slice(e.start, e.end).replace(/\s+/g, ' ').slice(0, 80),
      replacement: e.replacement,
      statement: header + mutatedBody + footer,
    });
  });
  return out;
}
