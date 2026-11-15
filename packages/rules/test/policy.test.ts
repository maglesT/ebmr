/**
 * The catalogue guard on decimal input (the lead's advisory on #267): while the policy for a JSON number in a decimal
 * position is UNSETTLED, no catalogued definition may order a value (`lt`, `lte`, `gt`, `gte`). The family that first
 * needs one (6.3, limits) settles the policy first (src/policy.ts).
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, type Definition } from '../src/catalog.ts';
import { DECIMAL_INPUT_POLICY } from '../src/policy.ts';
import { and, lit, path, type Node } from '../src/vocabulary.ts';

/** Every order comparison in a tree, as the path of ops that leads to it. */
function orders(node: Node, at: string): string[] {
  const here = `${at}/${node.op}`;
  switch (node.op) {
    case 'lit':
      return [];
    case 'path':
      return node.steps.flatMap((s, i) => (typeof s === 'string' ? [] : orders(s, `${here}[${i}]`)));
    case 'present':
    case 'not':
      return orders(node.of, here);
    case 'and':
    case 'or':
      return node.of.flatMap((n, i) => orders(n, `${here}[${i}]`));
    case 'in':
      return [...orders(node.value, here), ...orders(node.list, here)];
    case 'same':
      return [...orders(node.a, here), ...orders(node.b, here)];
    default:
      return [here, ...orders(node.a, here), ...orders(node.b, here)];
  }
}

function definitionOrders(d: Definition): string[] {
  if (d.kind === 'predicate') return orders(d.def.body, d.def.name);
  const r = d.def;
  return [...orders(r.applies, `${r.name}.applies`), ...orders(r.breached, `${r.name}.breached`), ...r.raise.flatMap((x, i) => (x.when ? orders(x.when, `${r.name}.raise[${i}]`) : []))];
}

describe('decimal input policy', () => {
  it('[meta] no catalogued definition orders a value while the decimal input policy is UNSETTLED', () => {
    expect(['UNSETTLED', 'REFUSE', 'FLAG']).toContain(DECIMAL_INPUT_POLICY);
    const found = CATALOG.flatMap((e) => definitionOrders(e.definition).map((p) => `${e.source} ${e.exportName}: ${p}`));
    if (DECIMAL_INPUT_POLICY === 'UNSETTLED') expect(found).toEqual([]);
  });

  it('[meta] the guard finds an order comparison anywhere in a tree, and nothing in a tree without one', () => {
    const lt: Node = { op: 'lt', a: path('values', 'x'), b: lit('1') };
    const deep: Node = and({ op: 'not', of: { op: 'present', of: path('values', { op: 'or', of: [lit(true), { op: 'gte', a: lit('1'), b: { op: 'in', value: lit('1'), list: { op: 'same', a: lit('1'), b: lt } } }] }) } });
    expect(orders(deep, 'd')).toEqual(['d/and[0]/not/present/path[0]/or[1]/gte', 'd/and[0]/not/present/path[0]/or[1]/gte/in/same/lt']);
    const field = (when: Node) => definitionOrders({ kind: 'field-rule', def: { name: 'r', version: 1, doc: '', applies: lit(true), breached: lit(true), raise: [{ when, then: { type: 'T', severity: 'ACTION', category: 'OUT_OF_LIMIT', controls: [] } }, { then: { type: 'T', severity: 'ACTION', category: 'OUT_OF_LIMIT', controls: [] } }] } });
    expect(field(lt)).toEqual(['r.raise[0]/lt']);
    expect(field(lit(true))).toEqual([]);
    expect(definitionOrders({ kind: 'field-rule', def: { name: 'r', version: 1, doc: '', applies: lt, breached: { op: 'gt', a: lit('1'), b: lit('2') }, raise: [] } })).toEqual(['r.applies/lt', 'r.breached/gt']);
    expect(definitionOrders({ kind: 'predicate', def: { name: 'p', version: 1, doc: '', inputs: ['values'], body: { op: 'lte', a: lit('1'), b: lit('2') } } })).toEqual(['p/lte']);
  });
});
