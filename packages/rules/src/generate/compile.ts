/**
 * The SQL backend of ADR 0023: a vocabulary tree (vocabulary.ts) written as one PostgreSQL 16 expression over jsonb
 * inputs. Each node's SQL is the reading vocabulary.ts states beside it, and the conformance suite
 * (test/conformance.test.ts) proves it gives the interpreter's answer.
 *
 * A node compiles to one of two kinds:
 * - `json`: a jsonb value, SQL NULL standing for ABSENT (lit, path);
 * - `bool`: an SQL boolean that is never NULL (every other node).
 * A `bool` read as a value becomes `to_jsonb(b)` (the interpreter's JavaScript true or false); a `json` read as a truth
 * value is true only when it is JSON true (`x is not distinct from 'true'::jsonb`).
 */
import type { Node, Root } from '../vocabulary.ts';

export interface Sql {
  readonly kind: 'bool' | 'json';
  readonly text: string;
}

/** The names a root, a rule or a function may have: lower-case SQL identifiers that need no quoting rules of their own. */
export const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

export class GenerateError extends Error {}

/** An SQL string literal: single quotes doubled. Refuses a NUL, which PostgreSQL text cannot hold. */
export function quote(text: string): string {
  if (text.includes('\u0000')) throw new GenerateError('a literal holds a NUL character, which PostgreSQL text cannot hold');
  return `'${text.replaceAll("'", "''")}'`;
}

/** Whether every string of a value (object keys included) can be held by jsonb: no NUL and no lone surrogate. */
function holdable(value: unknown): boolean {
  if (typeof value === 'string') return !value.includes('\u0000') && !/\p{Cs}/u.test(value);
  // An array by its elements (Object.entries gives index keys, which hold); a number or a boolean has no entries.
  return value === null || Object.entries(value as object).every(([k, x]) => holdable(k) && holdable(x));
}

/** A jsonb literal. Refuses what jsonb cannot hold (a NUL or a lone surrogate), so the generated SQL never fails. */
export function jsonbLiteral(value: unknown): string {
  const json = canonicalJson(value);
  if (!holdable(value)) throw new GenerateError(`the literal ${json} holds a character jsonb cannot hold (a NUL or a lone surrogate)`);
  return `${quote(json)}::jsonb`;
}

/** JSON with object keys in code-unit order, so the same value always gives the same bytes (ADR 0023, decision 10). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new GenerateError(`${String(value)} is not a JSON value`);
  return text;
}

/** A root as an SQL identifier (always quoted: `values` is a reserved word). */
export function rootIdentifier(root: Root): string {
  if (!IDENTIFIER.test(root)) throw new GenerateError(`the input name "${root}" is not a lower-case identifier`);
  return `"${root}"`;
}

const asJson = (s: Sql): string => (s.kind === 'json' ? s.text : `to_jsonb(${s.text})`);
const asBool = (s: Sql): string => (s.kind === 'bool' ? s.text : `(${s.text} is not distinct from 'true'::jsonb)`);
const ORDER = { lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/**
 * Compiles a node. `roots` are the inputs in scope (a node naming any other root is refused); `indent` is the column
 * a continuation line of `and` and `or` starts at, so the generated SQL reads one clause per line.
 */
export function compile(node: Node, roots: ReadonlySet<Root>, indent = ''): Sql {
  const inner = `${indent}  `;
  switch (node.op) {
    case 'lit':
      return { kind: 'json', text: jsonbLiteral(node.value) };
    case 'path': {
      if (!roots.has(node.root)) throw new GenerateError(`the input "${node.root}" is not one of this rule's inputs (${[...roots].join(', ')})`);
      let text = rootIdentifier(node.root);
      for (const step of node.steps) {
        text += typeof step === 'string' ? ` -> ${quote(step)}` : ` -> recipe.rules_key(${asJson(compile(step, roots, inner))})`;
      }
      // No parentheses: `->` binds tighter than every operator and IS test the generator writes around it.
      return { kind: 'json', text };
    }
    case 'present': {
      const of = compile(node.of, roots, inner);
      // A truth value is always there (the interpreter's `present` of true or false is true).
      return { kind: 'bool', text: of.kind === 'bool' ? 'true' : `(${of.text} is not null)` };
    }
    case 'same': {
      const a = compile(node.a, roots, inner);
      const b = compile(node.b, roots, inner);
      if (a.kind === 'bool' && b.kind === 'bool') return { kind: 'bool', text: `(${a.text} = ${b.text})` };
      return { kind: 'bool', text: `(${asJson(a)} is not distinct from ${asJson(b)})` };
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = asJson(compile(node.a, roots, inner));
      const b = asJson(compile(node.b, roots, inner));
      return { kind: 'bool', text: `coalesce(recipe.rules_decimal(${a}) ${ORDER[node.op]} recipe.rules_decimal(${b}), false)` };
    }
    case 'and':
    case 'or': {
      if (node.of.length === 0) return { kind: 'bool', text: node.op === 'and' ? 'true' : 'false' };
      const parts = node.of.map((n) => asBool(compile(n, roots, inner)));
      if (parts.length === 1) return { kind: 'bool', text: parts[0] as string };
      return { kind: 'bool', text: `(\n${inner}${parts.join(`\n${inner}${node.op} `)}\n${indent})` };
    }
    case 'not':
      return { kind: 'bool', text: `(not ${asBool(compile(node.of, roots, indent))})` };
    case 'in':
      return { kind: 'bool', text: `recipe.rules_member(${asJson(compile(node.value, roots, inner))}, ${asJson(compile(node.list, roots, inner))})` };
  }
}

/** A node as an SQL truth value (never NULL). */
export const compileBool = (node: Node, roots: ReadonlySet<Root>, indent = ''): string => asBool(compile(node, roots, indent));

/** A node as a jsonb value (NULL for ABSENT; a truth value as JSON true or false). */
export const compileJson = (node: Node, roots: ReadonlySet<Root>, indent = ''): string => asJson(compile(node, roots, indent));
