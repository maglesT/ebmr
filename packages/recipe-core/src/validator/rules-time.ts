/**
 * Time-constraint gates (ADR 0004 decision 3; outline 6.2, 6.3 "time constraints consistent"; INV-20).
 */
import { compareDecimal, durationToMicros, isTimeUnit } from '../flow/decimal.ts';
import { isNodeEvent, type NodeEvent, type Quantity, type TimeConstraint } from '../flow/model.ts';
import type { Analysis } from './analysis.ts';
import { defineRule, error, label, warning, type Rule } from './rule-kit.ts';
import { checkTemporalNetwork, type NetConstraint } from './time-network.ts';
import type { RuleFinding } from './types.ts';

const CONTROLS = ['INV-20', 'DI-34'];

function micros(q: Quantity | undefined): bigint | undefined {
  return q ? durationToMicros(q.value, q.unit) : undefined;
}

function durationProblem(q: Quantity, what: string): string | undefined {
  if (!isTimeUnit(q.unit)) return `${what} is in ${q.unit}, which is not a time unit (use ms, s, min, h or d)`;
  if (durationToMicros(q.value, q.unit) === undefined) return `${what} (${q.value} ${q.unit}) is not a whole number of microseconds`;
  if (compareDecimal(q.value, '0') < 0) return `${what} is negative`;
  return undefined;
}

const bounds = defineRule('TIME-BOUNDS', 'Every time constraint has valid minimum and maximum durations', CONTROLS, (a) => {
  const out: RuleFinding[] = [];
  for (const t of a.mbr.timeConstraints) {
    const name = `Time constraint ${label(a, t.id)}`;
    if (!t.min && !t.max) out.push(error(t.id, `${name} has neither a minimum nor a maximum`));
    let ok = true;
    for (const [q, what] of [
      [t.min, 'its minimum'],
      [t.max, 'its maximum'],
      [t.warnBefore, 'its warning lead time'],
    ] as const) {
      if (!q) continue;
      const p = durationProblem(q, `${name}: ${what}`);
      if (p) {
        out.push(error(t.id, p));
        ok = false;
      }
    }
    if (!ok) continue;
    const min = micros(t.min);
    const max = micros(t.max);
    const warn = micros(t.warnBefore);
    if (max !== undefined && max === 0n) out.push(error(t.id, `${name} has a maximum of zero`));
    if (min !== undefined && max !== undefined && min > max) out.push(error(t.id, `${name} has a minimum (${t.min?.value} ${t.min?.unit}) above its maximum (${t.max?.value} ${t.max?.unit})`));
    if (warn !== undefined && (max === undefined || warn >= max || warn === 0n)) out.push(error(t.id, `${name} warns ${t.warnBefore?.value} ${t.warnBefore?.unit} before a maximum it does not have or does not exceed`));
    if (isNodeEvent(t.from) && isNodeEvent(t.to) && t.from.node === t.to.node && t.from.event === t.to.event) out.push(error(t.id, `${name} starts and ends at the same event`));
  }
  for (const i of a.mbr.intermediates) {
    if (!i.holdTime) continue;
    const p = durationProblem(i.holdTime.max, `The hold time of ${label(a, i.id)}`);
    if (p) out.push(error(i.id, p));
    else if (micros(i.holdTime.max) === 0n) out.push(error(i.id, `The hold time of ${label(a, i.id)} is zero`));
  }
  return out;
});

const neverApplies = defineRule('TIME-NEVER-APPLIES', 'Time constraints can apply on some path', CONTROLS, (a) => {
  const out: RuleFinding[] = [];
  for (const t of a.mbr.timeConstraints) {
    if (!isNodeEvent(t.from) || !isNodeEvent(t.to)) continue;
    if (a.nodes.has(t.from.node) && a.nodes.has(t.to.node) && a.exclusive(t.from.node, t.to.node)) {
      out.push(warning(t.id, `Time constraint ${label(a, t.id)} runs between two branches of the same alternative, so it can never apply`));
    }
  }
  return out;
});

/** Declared constraints plus the implied ones: intermediate hold times and loop maximum durations. */
export function networkConstraints(a: Analysis): NetConstraint[] {
  const out: NetConstraint[] = [];
  const valid = (e: NodeEvent): boolean => a.nodes.has(e.node);
  for (const t of a.mbr.timeConstraints as TimeConstraint[]) {
    if (!isNodeEvent(t.from) || !isNodeEvent(t.to) || !valid(t.from) || !valid(t.to)) continue;
    const c: NetConstraint = { id: t.id, label: `${t.name} (${t.id})`, from: t.from, to: t.to };
    const min = micros(t.min);
    const max = micros(t.max);
    if (min !== undefined) c.minUs = min;
    if (max !== undefined) c.maxUs = max;
    out.push(c);
  }
  for (const i of a.mbr.intermediates) {
    const max = micros(i.holdTime?.max);
    if (max === undefined) continue;
    for (const producer of a.phases.filter((p) => p.produces.includes(i.id))) {
      for (const consumer of a.phases.filter((p) => p.uses.includes(i.id))) {
        if (a.exclusive(producer.id, consumer.id)) continue;
        out.push({ id: `hold:${i.id}:${consumer.id}`, label: `hold time of ${i.name} (${i.id})`, from: { node: producer.id, event: 'END' }, to: { node: consumer.id, event: 'START' }, maxUs: max });
      }
    }
  }
  for (const info of a.nodes.values()) {
    const n = info.node;
    const max = n.kind === 'loop' ? micros(n.maxDuration) : undefined;
    if (n.kind === 'loop' && max !== undefined) out.push({ id: `loop:${n.id}`, label: `maximum duration of loop ${n.name} (${n.id})`, from: { node: n.id, event: 'START' }, to: { node: n.id, event: 'END' }, maxUs: max });
  }
  return out;
}

const consistent = defineRule('TIME-CONSISTENT', 'Time constraints can all be met together', CONTROLS, (a) => {
  if (a.duplicateNodeIds.length > 0) return [];
  const result = checkTemporalNetwork(a.expanded.root, networkConstraints(a), a.limits);
  const out: RuleFinding[] = [];
  const cycle = result.cycle.filter((l) => l !== 'flow order');
  const via = `${[...new Set(cycle)].join(', ')}${result.cycle.includes('flow order') ? ' and the order of the steps' : ''}`;
  const scenario = result.scenario.length > 0 ? ` when ${result.scenario.join(' and ')}` : '';
  if (result.status === 'INCONSISTENT') {
    out.push(error('$', `The time constraints contradict each other${scenario}: ${via} cannot all be met (with loops and replicate sections at their maximum)`));
  } else if (result.status === 'POSSIBLY_INCONSISTENT') {
    out.push(warning('$', `The time constraints may contradict each other (${via}); there were too many branch combinations to check each one separately`));
  }
  if (!result.unrolled) out.push(warning('$', 'The time constraints were checked without unrolling loops and replicate sections to their maximum, because the record is too large'));
  return out;
});

export const TIME_RULES: readonly Rule[] = [bounds, neverApplies, consistent];
