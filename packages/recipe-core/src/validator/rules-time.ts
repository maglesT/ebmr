/**
 * Time-constraint gates (ADR 0004 decision 3; outline 6.2, 6.3 "time constraints consistent"; INV-20).
 */
import { compareDecimal, durationToMicros, isTimeUnit } from '../flow/decimal.ts';
import { childrenOf, isNodeEvent, type FlowNode, type NodeEvent, type Quantity } from '../flow/model.ts';
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

/**
 * The starts the engine records by itself when the token arrives (engine advance.ts: tryFire records a hold point's
 * START with the token, afterFire the START of a stage or an operation at its scope start, of a parallel section at its
 * split, of an alternative once its branch is decided, of a loop at its first entry and of a replicate section at its
 * split). The engine neither refuses nor flags such a start before a minimum ending at it (flagEarlyAutomaticEvent is
 * called for ends only; recipe-core 0308 skips these starts the same way), while its INV-20 check (invariants.ts
 * checkTime) counts it as a violation. Every other node event that can end a minimum is a person's act the engine
 * refuses before the minimum (a phase's start or end; the end of a hold point, a stage or a loop) or an automatic end it
 * flags with a TIME_MIN_BREACH (the end of an operation, a parallel or alternative section, a replicate section).
 */
const ARRIVAL_STARTS: Readonly<Partial<Record<FlowNode['kind'], string>>> = {
  stage: 'stage',
  operation: 'operation',
  parallel: 'parallel section',
  alternative: 'alternative',
  replicate: 'replicate section',
  loop: 'loop',
  holdPoint: 'hold point',
};

/**
 * The first acts of a person on every path into `node`, where the run holds the act back until a minimum ending there has
 * passed: the start of the first phase, or the release (end) of the first hold point; for a parallel section or an
 * alternative, the first act of each branch.
 */
function firstActs(a: Analysis, node: FlowNode): string[] {
  switch (node.kind) {
    case 'phase':
      return [`the start of ${label(a, node.id)}`];
    case 'holdPoint':
      return [`the release of hold point ${label(a, node.id)} (its end)`];
    case 'sequence': {
      for (const child of node.children) {
        const acts = firstActs(a, child);
        if (acts.length > 0) return acts;
      }
      return [];
    }
    default:
      return childrenOf(node).flatMap((child) => firstActs(a, child));
  }
}

/**
 * D6 (Phase 2 exit, SQL mutation defects; decision D6.1): a minimum may end only where the run can hold the event back or
 * flag it, never at a start the engine records by itself when the token arrives (ARRIVAL_STARTS). The author is told to
 * end it at the first act of a person inside instead.
 */
const minimumAtArrival = defineRule('TIME-MIN-AT-ARRIVAL', 'A minimum never ends at a start the run records by itself', ['INV-20', 'PR-30'], (a) => {
  const out: RuleFinding[] = [];
  for (const t of a.mbr.timeConstraints) {
    if (!t.min || !isNodeEvent(t.to) || t.to.event !== 'START') continue;
    const node = a.nodes.get(t.to.node)?.node;
    const kind = node ? ARRIVAL_STARTS[node.kind] : undefined;
    if (!node || kind === undefined) continue;
    const acts = firstActs(a, node);
    const instead =
      node.kind === 'holdPoint'
        ? 'End the minimum at the release of the hold point instead (its end): the run holds the release back until the minimum has passed'
        : acts.length === 0
          ? 'End the minimum at the start of a step instead, where a person acts and the run holds the act back until the minimum has passed'
          : `End the minimum at the first step inside instead, where a person acts and the run holds the act back until the minimum has passed: ${acts.join(' and ')}${acts.length > 1 ? ' (one time constraint for each)' : ''}`;
    out.push(
      error(
        t.id,
        `Time constraint ${label(a, t.id)} has a minimum of ${t.min.value} ${t.min.unit} that ends at the start of ${kind} ${label(a, node.id)}. The run starts it by itself as soon as what comes before it is done, so nothing holds that start back until the minimum has passed, and the run would break the minimum without a refusal or an exception. ${instead}`,
      ),
    );
  }
  return out;
});

/** Declared constraints plus the implied ones: intermediate hold times and loop maximum durations. */
export function networkConstraints(a: Analysis): NetConstraint[] {
  const out: NetConstraint[] = [];
  const valid = (e: NodeEvent): boolean => a.nodes.has(e.node);
  for (const t of a.mbr.timeConstraints) {
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

export const TIME_RULES: readonly Rule[] = [bounds, neverApplies, minimumAtArrival, consistent];
