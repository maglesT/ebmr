/**
 * The TypeScript backend of ADR 0023: evaluates a vocabulary tree (vocabulary.ts) over JSON inputs. Its meaning of each
 * node is the one vocabulary.ts states in SQL terms; the conformance suite (test/conformance.test.ts) runs the same
 * cases through PostgreSQL 16 and requires the same answers.
 */
import { Dec } from '@ebmr/expr';
import type { FieldRule, Node, Raise } from './vocabulary.ts';

/** A key that is not there (SQL NULL from `->`): distinct from JSON null. */
export const ABSENT: unique symbol = Symbol('ABSENT');
export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };
export type Value = Json | typeof ABSENT;
export type Inputs = Readonly<Record<string, Json | undefined>>;

const isObject = (v: Value): v is { readonly [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * jsonb equality: arrays element by element in order, objects by their own keys and values (whatever the order), and
 * every other value by `===`. A JSON number here is a double, so `===` is numeric equality (0 and -0 included), as
 * jsonb's is on the shortest decimal form the database receives. Anything else (ABSENT among them) is equal only to
 * itself.
 */
function jsonEqual(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const bs: readonly Json[] = b;
    return a.length === bs.length && (a as readonly Json[]).every((x: Json, i) => jsonEqual(x, bs[i] as Json));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    // Own keys only: a key that b only inherits (`__proto__`, `constructor`) is not one of its keys.
    return keys.length === Object.keys(b).length && keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k] as Json, b[k] as Json));
  }
  return a === b;
}

/** A decimal from a JSON number or a string Dec.parse accepts (SQL: recipe.rules_decimal); undefined otherwise. */
function decimal(v: Value): Dec | undefined {
  if (typeof v === 'number') return Dec.parse(String(v));
  return Dec.isValid(v) ? Dec.parse(v as string) : undefined;
}

const truth = (v: Value): boolean => v === true;

export function evaluate(node: Node, inputs: Inputs): Value {
  switch (node.op) {
    case 'lit':
      return node.value;
    case 'path': {
      // An input is there when it is an own key of the inputs and not undefined (an optional argument left out).
      let v: Value = Object.prototype.hasOwnProperty.call(inputs, node.root) && inputs[node.root] !== undefined ? (inputs[node.root] as Json) : ABSENT;
      for (const step of node.steps) {
        const key = typeof step === 'string' ? step : evaluate(step, inputs);
        // A key is a string and reaches into an object only (SQL: `jsonb -> text`, NULL on an array or a scalar); a key
        // computed as anything else is no key (SQL: recipe.rules_key gives NULL). Arrays are not indexed.
        if (isObject(v) && typeof key === 'string') v = Object.prototype.hasOwnProperty.call(v, key) ? (v[key] as Json) : ABSENT;
        else return ABSENT;
      }
      return v;
    }
    case 'present':
      return evaluate(node.of, inputs) !== ABSENT;
    case 'same': {
      // ABSENT is equal only to ABSENT (jsonEqual's last line), as SQL's `is not distinct from` NULL.
      return jsonEqual(evaluate(node.a, inputs), evaluate(node.b, inputs));
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
      // An element is never ABSENT, so ABSENT is in no list.
      if (!Array.isArray(list)) return false;
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
