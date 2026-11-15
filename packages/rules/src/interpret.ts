/**
 * The TypeScript backend of ADR 0023: evaluates a vocabulary tree (vocabulary.ts) over JSON inputs. Its meaning of each
 * node is the one vocabulary.ts states in SQL terms; the conformance suite (a later PR) runs the same cases through
 * PostgreSQL 16 and requires the same answers.
 */
import { Dec } from '@ebmr/expr';
import type { FieldRule, Node, Raise } from './vocabulary.ts';

/** A key that is not there (SQL NULL from `->`): distinct from JSON null. */
export const ABSENT: unique symbol = Symbol('ABSENT');
export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export type Value = Json | typeof ABSENT;
export type Inputs = Readonly<Record<string, Json | undefined>>;

const isObject = (v: Value): v is { readonly [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** jsonb equality: objects by key set and values, arrays in order, numbers numerically, strings exactly. */
function jsonEqual(a: Json, b: Json): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Dec.parse(String(a)).eq(Dec.parse(String(b)));
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const bs: readonly Json[] = b;
    return (a as readonly Json[]).every((x: Json, i) => jsonEqual(x, bs[i] as Json));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual(a[k] as Json, b[k] as Json));
  }
  return a === b;
}

/** A decimal from a JSON string or number (SQL: `(x #>> '{}')::numeric`); undefined when it is not one. */
function decimal(v: Value): Dec | undefined {
  if (typeof v === 'number') return Dec.parse(String(v));
  if (typeof v === 'string' && Dec.isValid(v)) return Dec.parse(v);
  return undefined;
}

const truth = (v: Value): boolean => v === true;

export function evaluate(node: Node, inputs: Inputs): Value {
  switch (node.op) {
    case 'lit':
      return node.value;
    case 'path': {
      let v: Value = node.root in inputs && inputs[node.root] !== undefined ? (inputs[node.root] as Json) : ABSENT;
      for (const step of node.steps) {
        const key = typeof step === 'string' ? step : evaluate(step, inputs);
        if (v === ABSENT) return ABSENT;
        if (isObject(v) && typeof key === 'string') v = Object.prototype.hasOwnProperty.call(v, key) ? (v[key] as Json) : ABSENT;
        else if (Array.isArray(v) && typeof key === 'number' && Number.isInteger(key)) v = key >= 0 && key < v.length ? (v[key] as Json) : ABSENT;
        else return ABSENT;
      }
      return v;
    }
    case 'present':
      return evaluate(node.of, inputs) !== ABSENT;
    case 'same': {
      const a = evaluate(node.a, inputs);
      const b = evaluate(node.b, inputs);
      if (a === ABSENT || b === ABSENT) return a === b;
      return jsonEqual(a, b);
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const a = decimal(evaluate(node.a, inputs));
      const b = decimal(evaluate(node.b, inputs));
      if (a === undefined || b === undefined) return false;
      return node.op === 'lt' ? a.lt(b) : node.op === 'lte' ? a.lte(b) : node.op === 'gt' ? a.gt(b) : a.gte(b);
    }
    case 'and':
      return node.of.every((n) => truth(evaluate(n, inputs)));
    case 'or':
      return node.of.some((n) => truth(evaluate(n, inputs)));
    case 'not':
      return !truth(evaluate(node.of, inputs));
    case 'in': {
      const v = evaluate(node.value, inputs);
      const list = evaluate(node.list, inputs);
      if (v === ABSENT || !Array.isArray(list)) return false;
      return (list as readonly Json[]).some((x: Json) => jsonEqual(x, v));
    }
  }
}

/** Whether a predicate's body holds (true only when it evaluates to JSON true). */
export const holds = (node: Node, inputs: Inputs): boolean => truth(evaluate(node, inputs));

/** The exception a field rule requires of one field, or undefined when the field is out of its scope or within it. */
export function fieldRuleRaise(rule: FieldRule, inputs: Inputs): Raise | undefined {
  if (!holds(rule.applies, inputs) || !holds(rule.breached, inputs)) return undefined;
  return rule.raise.find((r) => r.when === undefined || holds(r.when, inputs))?.then;
}
