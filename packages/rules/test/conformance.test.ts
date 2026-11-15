/**
 * The conformance suite (ADR 0023, decision 2): every primitive of the vocabulary, run through the TypeScript
 * interpreter and through real PostgreSQL 16, must give the same answer, case by case, with zero differences.
 *
 * The SQL side is what the database runs: a copy of the test template, which applies every committed migration, so
 * the primitives (recipe.rules_key, rules_member, rules_decimal) and the generated rules are the committed ones; an
 * arbitrary tree is compiled by the generator into one expression over them.
 *
 * The domain is the application's: an input is a JavaScript value, and the database receives its JSON.stringify, as
 * the server writes an entry. (A JSON number is therefore always the shortest form of a double, and a string never
 * holds a NUL or a lone surrogate, which jsonb refuses.)
 *
 * Three sets of cases: the named cases below, each with the answer PostgreSQL gave pinned beside it; a fixed-seed
 * random corpus of trees over a pool of awkward values; and the two library rules through their generated functions.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { canonicalJson, compileJson } from '../src/generate/compile.ts';
import { ABSENT, evaluate, fieldRuleRaise, holds, type Json, type Value } from '../src/interpret.ts';
import { FIELD_SHOWN, UNEXPECTED_ANSWER } from '../src/library.ts';
import { and, lit, not, or, path, present, same, type Node } from '../src/vocabulary.ts';

const ADMIN_URL = process.env['EBMR_PG_ADMIN_URL'] ?? 'postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres';
const ROOTS = ['v', 'w', 'key'] as const;
type Root = (typeof ROOTS)[number];
type CaseInputs = Partial<Record<Root, Json>>;

let server: pg.Client;
let db: pg.Client;
let name: string;

beforeAll(async () => {
  name = `ebmr_rules_${randomBytes(6).toString('hex')}`;
  server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  await server.query(`create database ${name} template ${inject('templateDb')}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
  await server?.query(`drop database if exists ${name} with (force)`);
  await server?.end();
});

/** The JSON text the database receives for an input, or SQL NULL for an input that is not there. */
const sent = (v: Json | undefined): string | null => (v === undefined ? null : JSON.stringify(v));
/** An answer as canonical JSON, or null for ABSENT, so the two sides compare as text. */
const tsAnswer = (v: Value): string | null => (v === ABSENT ? null : canonicalJson(v));

async function sqlAnswer(node: Node, inputs: CaseInputs): Promise<string | null> {
  const expr = compileJson(node, new Set<string>(ROOTS));
  const { rows } = await db.query<{ r: string | null }>(
    `select (${expr})::text as r from (values ($1::jsonb, $2::jsonb, $3::jsonb)) as i("v", "w", "key")`,
    ROOTS.map((r) => sent(inputs[r])),
  );
  const r = rows[0]?.r ?? null;
  return r === null ? null : canonicalJson(JSON.parse(r) as Json);
}

const ord = (op: 'lt' | 'lte' | 'gt' | 'gte', a: Node, b: Node): Node => ({ op, a, b });
const inList = (value: Node, list: Node): Node => ({ op: 'in', value, list });
const v = (...steps: (string | Node)[]): Node => path('v', ...steps);

/** A named case: a tree, its inputs and the answer (canonical JSON, or null for ABSENT) both backends must give. */
interface Case {
  readonly name: string;
  readonly node: Node;
  readonly inputs: CaseInputs;
  readonly answer: string | null;
}

const V: Json = { a: '1.0', b: 1, n: null, t: true, f: false, s: 'x', arr: ['p', 'q'], obj: { k: '2.50' }, nested: [[1, 2]], objs: [{ a: 1, b: 2 }] };
const T = 'true';
const F = 'false';

/** The named cases (built when the test runs, so the vocabulary's builders are exercised per test). */
const cases = (): readonly Case[] => [
  // lit
  { name: 'lit string', node: lit("it's"), inputs: {}, answer: '"it\'s"' },
  { name: 'lit null is a value', node: lit(null), inputs: {}, answer: 'null' },
  { name: 'lit boolean', node: lit(false), inputs: {}, answer: F },
  // path
  { name: 'path reads a key', node: v('a'), inputs: { v: V }, answer: '"1.0"' },
  { name: 'path reads JSON null', node: v('n'), inputs: { v: V }, answer: 'null' },
  { name: 'path of a missing key is ABSENT', node: v('missing'), inputs: { v: V }, answer: null },
  { name: 'path into a scalar is ABSENT', node: v('s', 'deeper'), inputs: { v: V }, answer: null },
  { name: 'path into an array is ABSENT (no indexing)', node: v('arr', '0'), inputs: { v: V }, answer: null },
  { name: 'path of a missing input is ABSENT', node: path('w', 'a'), inputs: { v: V }, answer: null },
  { name: 'path of JSON null input is ABSENT one step on', node: path('w', 'a'), inputs: { w: null }, answer: null },
  { name: 'path with no step is the input', node: path('key'), inputs: { key: 'a' }, answer: '"a"' },
  { name: 'computed step from a string', node: v(path('key')), inputs: { v: V, key: 'a' }, answer: '"1.0"' },
  { name: 'computed step from a number is no key', node: v(path('key')), inputs: { v: { '1': 'one' }, key: 1 }, answer: null },
  { name: 'computed step from a truth value is no key', node: v(present(v('a'))), inputs: { v: { true: 'yes' } }, answer: null },
  { name: 'computed step from ABSENT is no key', node: v(path('key')), inputs: { v: V }, answer: null },
  { name: 'empty key', node: v(''), inputs: { v: { '': 'e' } }, answer: '"e"' },
  // present
  { name: 'present of null', node: present(v('n')), inputs: { v: V }, answer: T },
  { name: 'present of missing', node: present(v('missing')), inputs: { v: V }, answer: F },
  { name: 'present of a truth value', node: present(present(v('missing'))), inputs: { v: V }, answer: T },
  // same
  { name: 'same ABSENT ABSENT', node: same(v('missing'), path('w')), inputs: { v: V }, answer: T },
  { name: 'same ABSENT null', node: same(v('missing'), lit(null)), inputs: { v: V }, answer: F },
  { name: 'same null null', node: same(v('n'), lit(null)), inputs: { v: V }, answer: T },
  { name: 'same true "true"', node: same(v('t'), lit('true')), inputs: { v: V }, answer: F },
  { name: 'same decimal strings are text', node: same(v('a'), lit('1')), inputs: { v: V }, answer: F },
  { name: 'same numbers numerically', node: same(v('b'), path('w')), inputs: { v: V, w: 1.0 }, answer: T },
  { name: 'same number and string', node: same(v('b'), lit('1')), inputs: { v: V }, answer: F },
  { name: 'same objects whatever the key order', node: same(path('v'), path('w')), inputs: { v: { a: 1, b: [2, '3'] }, w: { b: [2, '3'], a: 1 } }, answer: T },
  { name: 'same objects with another key', node: same(path('v'), path('w')), inputs: { v: { a: 1 }, w: { a: 1, b: null } }, answer: F },
  { name: 'same arrays in order', node: same(path('v'), path('w')), inputs: { v: [1, 2], w: [2, 1] }, answer: F },
  { name: 'same truth values', node: same(present(v('a')), not(v('f'))), inputs: { v: V }, answer: T },
  { name: 'same truth value and JSON true', node: same(present(v('a')), lit(true)), inputs: { v: V }, answer: T },
  { name: 'same unicode strings exactly', node: same(path('v'), path('w')), inputs: { v: 'é', w: 'é' }, answer: F },
  // order
  { name: 'order string and number', node: ord('gte', v('a'), v('b')), inputs: { v: V }, answer: T },
  { name: 'order strict', node: ord('gt', v('a'), v('b')), inputs: { v: V }, answer: F },
  { name: 'order beyond binary precision', node: ord('lt', lit('0.1000000000000000000000000000000001'), lit('0.1000000000000000000000000000000002')), inputs: {}, answer: T },
  { name: 'order ABSENT', node: ord('lte', v('missing'), lit('1')), inputs: { v: V }, answer: F },
  { name: 'order not a decimal', node: ord('lt', v('s'), lit('1')), inputs: { v: V }, answer: F },
  { name: 'order a leading point is no decimal', node: ord('lt', lit('.5'), lit('1')), inputs: {}, answer: F },
  { name: 'order a plus sign is no decimal', node: ord('lt', lit('+0.5'), lit('1')), inputs: {}, answer: F },
  { name: 'order a trailing newline is no decimal', node: ord('lt', lit('0.5\n'), lit('1')), inputs: {}, answer: F },
  { name: 'order an exponent', node: ord('gt', lit('1E+2'), lit('99.9')), inputs: {}, answer: T },
  { name: 'order 34 significant digits', node: ord('lt', lit('1234567890123456789012345678901234'), lit('1234567890123456789012345678901235')), inputs: {}, answer: T },
  { name: 'order 35 significant digits is no decimal', node: ord('lt', lit('12345678901234567890123456789012345'), lit('9e40')), inputs: {}, answer: F },
  { name: 'order trailing zeros are not significant', node: ord('lt', lit('1234567890123456789012345678901234000000'), lit('9e40')), inputs: {}, answer: T },
  { name: 'order exponent 1000', node: ord('gt', lit('1e1000'), lit('9e999')), inputs: {}, answer: T },
  { name: 'order exponent 1001 is no decimal', node: ord('gt', lit('1e1001'), lit('1')), inputs: {}, answer: F },
  { name: 'order exponent -1000 at 34 digits', node: ord('gt', lit('1.234567890123456789012345678901234e-1000'), lit('0')), inputs: {}, answer: T },
  { name: 'order exponent -1001 is no decimal', node: ord('gt', lit('1e-1001'), lit('-1')), inputs: {}, answer: F },
  { name: 'order zero with any exponent', node: ord('gte', lit('0e999999999999'), lit('-0')), inputs: {}, answer: T },
  { name: 'order 401 characters is no decimal', node: ord('gt', lit(`0.${'0'.repeat(398)}1`), lit('-1')), inputs: {}, answer: F },
  { name: 'order 400 characters', node: ord('gt', lit(`0.${'0'.repeat(397)}1`), lit('0')), inputs: {}, answer: T },
  { name: 'order a large double', node: ord('gt', path('w'), lit('1e21')), inputs: { w: 1.7976931348623157e308 }, answer: T },
  { name: 'order the smallest double', node: ord('gt', path('w'), lit('0')), inputs: { w: 5e-324 }, answer: T },
  { name: 'order minus zero', node: ord('gte', path('w'), lit('0')), inputs: { w: -0 }, answer: T },
  { name: 'order a boolean', node: ord('lt', v('t'), lit('2')), inputs: { v: V }, answer: F },
  { name: 'order a truth value', node: ord('lt', present(v('a')), lit('2')), inputs: { v: V }, answer: F },
  { name: 'order a non-ASCII digit is no decimal', node: ord('lt', lit('١'), lit('2')), inputs: {}, answer: F },
  // logic
  { name: 'and of JSON true', node: and(lit(true), v('t')), inputs: { v: V }, answer: T },
  { name: 'and of a string is false', node: and(lit(true), v('s')), inputs: { v: V }, answer: F },
  { name: 'or of ABSENT and false', node: or(v('missing'), v('f')), inputs: { v: V }, answer: F },
  { name: 'not ABSENT', node: not(v('missing')), inputs: { v: V }, answer: T },
  { name: 'not null', node: not(v('n')), inputs: { v: V }, answer: T },
  { name: 'and of nothing', node: and(), inputs: {}, answer: T },
  { name: 'or of nothing', node: or(), inputs: {}, answer: F },
  { name: 'and of one', node: and(v('f')), inputs: { v: V }, answer: F },
  // in
  { name: 'in finds an element', node: inList(lit('q'), v('arr')), inputs: { v: V }, answer: T },
  { name: 'in misses', node: inList(lit('z'), v('arr')), inputs: { v: V }, answer: F },
  { name: 'in ABSENT', node: inList(v('missing'), v('arr')), inputs: { v: V }, answer: F },
  { name: 'in a non-array', node: inList(lit('q'), v('s')), inputs: { v: V }, answer: F },
  { name: 'in an object is no list', node: inList(lit('2.50'), v('obj')), inputs: { v: V }, answer: F },
  { name: 'in is equality, not containment (arrays)', node: inList(path('w'), v('nested')), inputs: { v: V, w: [1] }, answer: F },
  { name: 'in is equality, not containment (objects)', node: inList(path('w'), v('objs')), inputs: { v: V, w: { a: 1 } }, answer: F },
  { name: 'in an equal object', node: inList(path('w'), v('objs')), inputs: { v: V, w: { b: 2, a: 1 } }, answer: T },
  { name: 'in null', node: inList(lit(null), path('w')), inputs: { w: [null] }, answer: T },
  { name: 'in a truth value', node: inList(present(v('a')), path('w')), inputs: { v: V, w: [true] }, answer: T },
  { name: 'in a number equal in value', node: inList(path('w'), path('v')), inputs: { v: [1, 2], w: 2.0 }, answer: T },
  // The decimal's point at every position the SQL writes out: after the first digit, further in, before it.
  { name: 'order point after the first digit', node: ord('gt', lit('2.50'), lit('2.4')), inputs: {}, answer: T },
  { name: 'order point after the first digit, below', node: ord('lt', lit('2.50'), lit('2.6')), inputs: {}, answer: T },
  { name: 'order point after the first digit, against an integer', node: and(ord('gt', lit('2.5'), lit('2')), ord('lt', lit('2.5'), lit('3'))), inputs: {}, answer: T },
  { name: 'order point after the first digit, against the next power of ten', node: ord('lt', lit('9.5'), lit('10')), inputs: {}, answer: T },
  { name: 'order point after the first digit, against a smaller one', node: ord('gt', lit('1.5'), lit('0.9')), inputs: {}, answer: T },
  { name: 'order point further in', node: ord('gt', lit('12.5'), lit('12.4')), inputs: {}, answer: T },
  { name: 'order point further in, below', node: ord('lt', lit('12.5'), lit('12.6')), inputs: {}, answer: T },
  { name: 'order below one', node: ord('lt', lit('0.25'), lit('0.3')), inputs: {}, answer: T },
  { name: 'order below one, above', node: ord('gt', lit('0.25'), lit('0.2')), inputs: {}, answer: T },
  { name: 'order negative', node: ord('lt', lit('-2.5'), lit('-2.4')), inputs: {}, answer: T },
  { name: 'order an exponent moves the point', node: and(ord('gte', lit('1.25e1'), lit('12.5')), ord('lte', lit('1.25e1'), lit('12.5'))), inputs: {}, answer: T },
  { name: 'order a negative exponent', node: and(ord('gte', lit('125e-2'), lit('1.25')), ord('lte', lit('125e-2'), lit('1.25'))), inputs: {}, answer: T },
  { name: 'order leading and trailing zeros', node: and(ord('gte', lit('00012.500'), lit('12.5')), ord('lte', lit('00012.500'), lit('12.5'))), inputs: {}, answer: T },
  { name: 'order a string against a number', node: and(ord('gte', lit('2.50'), path('w')), not(ord('gt', lit('2.50'), path('w')))), inputs: { w: 2.5 }, answer: T },
  { name: 'order lt is strict', node: ord('lt', lit('2.5'), lit('2.50')), inputs: {}, answer: F },
  { name: 'order lte at equality', node: ord('lte', lit('2.5'), lit('2.50')), inputs: {}, answer: T },
  { name: 'order gte below', node: ord('gte', lit('2.4'), lit('2.5')), inputs: {}, answer: F },
  // jsonb equality, part by part.
  { name: 'same objects of one size, another key', node: same(path('v'), path('w')), inputs: { v: { a: 1, b: 2 }, w: { a: 1, c: 2 } }, answer: F },
  { name: 'same objects, one value differs', node: same(path('v'), path('w')), inputs: { v: { a: 1, b: 2 }, w: { a: 1, b: 3 } }, answer: F },
  { name: 'same objects, the first value differs', node: same(path('v'), path('w')), inputs: { v: { a: 0, b: 2 }, w: { a: 1, b: 2 } }, answer: F },
  { name: 'same nested objects', node: same(path('v'), path('w')), inputs: { v: { a: { x: [1, { y: null }] } }, w: { a: { x: [1.0, { y: null }] } } }, answer: T },
  { name: 'same arrays of another length', node: same(path('v'), path('w')), inputs: { v: [1], w: [1, 2] }, answer: F },
  { name: 'same arrays, the last element differs', node: same(path('v'), path('w')), inputs: { v: [1, 2], w: [1, 3] }, answer: F },
  { name: 'same arrays, the first element differs', node: same(path('v'), path('w')), inputs: { v: [0, 2], w: [1, 2] }, answer: F },
  { name: 'same empty array and empty object', node: same(path('v'), path('w')), inputs: { v: [], w: {} }, answer: F },
  { name: 'same empty object and empty array', node: same(path('v'), path('w')), inputs: { v: {}, w: [] }, answer: F },
  { name: 'same array and string', node: same(path('v'), path('w')), inputs: { v: ['a'], w: 'a' }, answer: F },
  { name: 'same object and null', node: same(path('v'), path('w')), inputs: { v: {}, w: null }, answer: F },
  { name: 'same minus zero and zero', node: same(path('v'), path('w')), inputs: { v: -0, w: 0 }, answer: T },
  { name: 'same numbers that differ', node: same(path('v'), path('w')), inputs: { v: 0.1, w: 0.2 }, answer: F },
  { name: 'same strings that differ', node: same(path('v'), path('w')), inputs: { v: 'a', w: 'b' }, answer: F },
  { name: 'same a value and ABSENT', node: same(path('v'), path('w')), inputs: { v: 'a' }, answer: F },
  { name: 'same objects, both with keys out of order', node: same(path('v'), path('w')), inputs: { v: { b: 1, a: 2 }, w: { a: 2, b: 1 } }, answer: T },
  { name: 'same an own __proto__ key and an inherited one', node: same(path('v'), path('w')), inputs: { v: JSON.parse('{"__proto__":{}}') as Json, w: { x: 1 } }, answer: F },
  { name: 'same own __proto__ keys', node: same(path('v'), path('w')), inputs: { v: JSON.parse('{"__proto__":{"a":1}}') as Json, w: JSON.parse('{"__proto__":{"a":1}}') as Json }, answer: T },
  { name: 'path of an inherited key is ABSENT', node: v('constructor'), inputs: { v: { a: 1 } }, answer: null },
  { name: 'path of an inherited __proto__ is ABSENT', node: v('__proto__'), inputs: { v: { a: 1 } }, answer: null },
  { name: 'path of an own __proto__ key', node: v('__proto__'), inputs: { v: JSON.parse('{"__proto__":"x"}') as Json }, answer: '"x"' },
  { name: 'order lte below', node: ord('lte', lit('2.4'), lit('2.5')), inputs: {}, answer: T },
  { name: 'order lte above', node: ord('lte', lit('2.6'), lit('2.5')), inputs: {}, answer: F },
  { name: 'order lt below', node: ord('lt', lit('2.4'), lit('2.5')), inputs: {}, answer: T },
  { name: 'order gt above', node: ord('gt', lit('2.6'), lit('2.5')), inputs: {}, answer: T },
  { name: 'order gt at equality', node: ord('gt', lit('2.5'), lit('2.50')), inputs: {}, answer: F },
  { name: 'order gte at equality', node: ord('gte', lit('2.5'), lit('2.50')), inputs: {}, answer: T },
];

describe('the conformance suite: the interpreter and PostgreSQL 16 agree', () => {
  it('[meta] every named case gives its pinned answer on both backends', async () => {
    const differences: string[] = [];
    for (const c of cases()) {
      const ts = tsAnswer(evaluate(c.node, c.inputs));
      const sql = await sqlAnswer(c.node, c.inputs);
      if (ts !== c.answer || sql !== c.answer) differences.push(`${c.name}: expected ${String(c.answer)}, interpreter ${String(ts)}, PostgreSQL ${String(sql)}`);
    }
    expect(differences).toEqual([]);
  });

  it('[meta] a fixed-seed random corpus of trees gives the same answer on both backends (zero differences)', async () => {
    const corpus = randomCorpus(0x5eed_0023, 2500);
    const differences: string[] = [];
    const kinds = new Set<string>();
    for (const c of corpus) {
      kinds.add(c.node.op);
      const ts = tsAnswer(evaluate(c.node, c.inputs));
      let sql: string | null;
      try {
        sql = await sqlAnswer(c.node, c.inputs);
      } catch (e) {
        sql = `ERROR ${(e as Error).message}`;
      }
      if (ts !== sql) differences.push(`${JSON.stringify(c.node)} on ${JSON.stringify(c.inputs)}: interpreter ${String(ts)}, PostgreSQL ${String(sql)}`);
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // Every operation of the vocabulary is at the root of some case.
    expect([...kinds].sort()).toEqual(['and', 'gt', 'gte', 'in', 'lit', 'lt', 'lte', 'not', 'or', 'path', 'present', 'same']);
  });

  it('[meta] the generated recipe.rule_library_field_shown agrees with FIELD_SHOWN on a corpus of fields and entries', async () => {
    const differences: string[] = [];
    for (const { field, values } of ruleCorpus(0x5eed_0061, 600)) {
      const ts = holds(FIELD_SHOWN.body, { field, values });
      const { rows } = await db.query<{ r: boolean }>('select recipe.rule_library_field_shown($1::jsonb, $2::jsonb) as r', [sent(field), sent(values)]);
      if (rows[0]?.r !== ts) differences.push(`${JSON.stringify({ field, values })}: interpreter ${String(ts)}, PostgreSQL ${String(rows[0]?.r)}`);
    }
    expect(differences.slice(0, 5)).toEqual([]);
  });

  it('[meta] the generated recipe.rule_library_unexpected_answer agrees with UNEXPECTED_ANSWER on a corpus of fields and entries', async () => {
    const differences: string[] = [];
    let raised = 0;
    for (const { field, values } of ruleCorpus(0x5eed_0062, 600)) {
      const r = fieldRuleRaise(UNEXPECTED_ANSWER, { field, values });
      if (r) raised++;
      const ts = r === undefined ? null : canonicalJson(r);
      const { rows } = await db.query<{ r: string | null }>('select recipe.rule_library_unexpected_answer($1::jsonb, $2::jsonb, null)::text as r', [sent(field), sent(values)]);
      const sql = rows[0]?.r == null ? null : canonicalJson(JSON.parse(rows[0].r) as Json);
      if (sql !== ts) differences.push(`${JSON.stringify({ field, values })}: interpreter ${String(ts)}, PostgreSQL ${String(sql)}`);
    }
    expect(differences.slice(0, 5)).toEqual([]);
    // The corpus reaches the rule: some entries require the exception, most do not.
    expect(raised).toBeGreaterThan(20);
  });
});

// ---- The random corpora (a fixed seed: the same cases on every run) ---------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['a', 'b', 'k', 'x', '1', '', 'showWhen'] as const;
const SCALARS: readonly Json[] = [
  '1', '1.0', '01', '-0', '0', '2.50', '2.5', '1e2', '1E+2', '100', '.5', '5.', '+1', ' 1', '1\n', 'abc', '', 'true', 'null', 'a', 'b', 'k',
  '0.1000000000000000000000000000000001', '12345678901234567890123456789012345', '1e1000', '1e1001', '1e-1001', '0e99999999', '١', 'é',
  0, -0, 1, 1.5, 2.5, 100, -3, 0.1, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 123456789012345680000,
  true, false, null,
];

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

function randomValue(r: () => number, depth: number): Json {
  const x = r();
  if (depth <= 0 || x < 0.55) return pick(r, SCALARS);
  if (x < 0.75) return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth - 1));
  const o: Record<string, Json> = {};
  for (let i = Math.floor(r() * 4); i > 0; i--) o[pick(r, KEYS)] = randomValue(r, depth - 1);
  return o;
}

function randomNode(r: () => number, depth: number): Node {
  const x = r();
  if (depth <= 0 || x < 0.25) {
    if (r() < 0.3) return lit(pick(r, ['1', '2.5', 'a', 'k', '', 'true', true, false, null] as const));
    const steps: (string | Node)[] = Array.from({ length: Math.floor(r() * 3) }, () => (r() < 0.8 || depth <= 0 ? pick(r, KEYS) : randomNode(r, depth - 1)));
    return path(pick(r, ROOTS), ...steps);
  }
  const op = pick(r, ['present', 'same', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'in'] as const);
  const sub = (): Node => randomNode(r, depth - 1);
  switch (op) {
    case 'present':
    case 'not':
      return { op, of: sub() };
    case 'and':
    case 'or':
      return { op, of: Array.from({ length: Math.floor(r() * 4) }, sub) };
    case 'in':
      return { op, value: sub(), list: sub() };
    default:
      return { op, a: sub(), b: sub() };
  }
}

function randomCorpus(seed: number, n: number): { node: Node; inputs: CaseInputs }[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const inputs: CaseInputs = {};
    for (const root of ROOTS) {
      if (r() < 0.85) inputs[root] = root === 'key' ? pick(r, [...KEYS, 1, true, null]) : randomValue(r, 3);
    }
    return { node: randomNode(r, 4), inputs };
  });
}

/** Fields and entries for the library rules: yes/no and other fields, expected answers, showWhen, odd values. */
function ruleCorpus(seed: number, n: number): { field: Json; values: Json }[] {
  const r = rng(seed);
  const answers: readonly Json[] = [true, false, 'true', 'false', null, 'yes', 1, 0];
  return Array.from({ length: n }, () => {
    const field: Record<string, Json> = { id: pick(r, ['clean', 'used', 'reason']), type: pick(r, ['YES_NO', 'YES_NO', 'CHOICE', 'TEXT']) };
    if (r() < 0.7) field['expected'] = pick(r, answers);
    if (r() < 0.3) field['unexpectedCritical'] = pick(r, [true, false, 'true']);
    if (r() < 0.4) field['showWhen'] = r() < 0.9 ? { field: pick(r, ['used', 'clean', 'missing']), equals: pick(r, answers) } : pick(r, [null, 'used', {}]);
    const values: Record<string, Json> = {};
    for (const k of ['clean', 'used', 'reason']) if (r() < 0.7) values[k] = pick(r, answers);
    return { field, values };
  });
}
