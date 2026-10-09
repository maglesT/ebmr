/**
 * duration() between recorded instants (tablets spec C-23 hold-time compliance; injectables spec
 * C-19) and table_lookup(), the compendial acceptance-table hook.
 */
import { rational } from '../decimal/exact.ts';
import type { ExprType } from '../lang/types.ts';
import { parseUnit } from '../units/unit.ts';
import { unifyTags } from '../lang/rules.ts';
import type { LibraryFunction } from './contract.ts';
import { asQuantity } from './runtime.ts';
import { arity, fail, quantityArg, SECOND_UNIT } from './typing.ts';

export const duration: LibraryFunction = {
  name: 'duration',
  signature: 'duration(start: instant, end: instant) -> time in s',
  summary: 'Elapsed time from start to end (server-recorded instants), exact to the microsecond; an end before the start is refused.',
  reference: 'tablets spec C-23 (hold-time compliance: Elapsed = t_use,start - t_completion,previous); injectables spec C-19',
  check(args) {
    arity(args, 2, 2, this.signature);
    args.forEach((a, i) => {
      if (a.type.kind !== 'instant') fail('EXPR-FN-003', `The ${i === 0 ? 'first' : 'second'} argument of duration must be a recorded instant, not a ${a.type.kind}`, i);
    });
    return { kind: 'quantity', unit: SECOND_UNIT, tag: 'none' };
  },
  cost: () => 3,
  evaluate(args, ctx) {
    const [start, end] = args;
    if (start?.kind !== 'instant' || end?.kind !== 'instant') throw new Error('internal: duration arguments');
    const micros = end.epochMicros - start.epochMicros;
    if (micros < 0n) ctx.domain(`duration: the end (${end.text}) is before the start (${start.text})`, 1);
    return ctx.result(rational(micros, 1_000_000n), SECOND_UNIT, 'none');
  },
};

export const tableLookup: LibraryFunction = {
  name: 'table_lookup',
  signature: 'table_lookup("table-id", key) -> the table result',
  summary: 'Looks up a validated compendial acceptance table (master data with source and edition) by a key value; no row for the key is an error.',
  reference: 'brief A1 item 3 (compendial acceptance-table hook); tablets spec E.1 (rule sets as master data)',
  check(args, ctx): ExprType {
    arity(args, 2, 2, this.signature);
    const id = args[0];
    if (id === undefined || id.node.type !== 'String') fail('EXPR-FN-007', 'The first argument of table_lookup must be the table id in quotes', 0);
    const table = ctx.tables[id.node.value];
    if (table === undefined) fail('EXPR-FN-008', `There is no acceptance table "${id.node.value}" among the tables available to this calculation`, 0);
    const keyUnit = parseUnit(table.key.unit);
    const key = quantityArg(args, 1, 'table_lookup', { what: 'the key' });
    if (key.unit.dimensionKey !== keyUnit.dimensionKey) fail('EXPR-UNIT-010', `table_lookup: the key of "${table.id}" is in ${table.key.unit}, which measures something else than ${key.unit.code}`, 1);
    if (unifyTags(key.tag, table.key.tag ?? 'none') === undefined) fail('EXPR-TAG-003', `table_lookup: the key of "${table.id}" has a different meaning (tag) than the value given`, 1);
    return { kind: 'quantity', unit: parseUnit(table.result.unit), tag: table.result.tag ?? 'none' };
  },
  cost: () => 20,
  evaluate(args, ctx) {
    const id = args[0];
    if (id?.kind !== 'string') throw new Error('internal: table id');
    return ctx.lookup(id.value, asQuantity(args[1]));
  },
};
