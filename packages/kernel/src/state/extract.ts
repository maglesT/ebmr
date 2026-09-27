/**
 * Extracts the transition table from an XState machine and computes its canonical form and
 * hash. The canonical text and hash are identical to platform.machine_canonical_text and
 * platform.machine_definition_hash in SQL, which publication checks.
 */
import { createHash } from 'node:crypto';
import type { AnyStateNode } from 'xstate';
import type { GmpTransitionMeta, MachineDescriptor } from './definition.ts';

export interface TransitionRow {
  from: string;
  event: string;
  to: string;
  guards: string[];
  signature: string | null;
  permission: string | null;
}

export interface MachineDefinition {
  machine: string;
  version: number;
  aggregate_type: string;
  description: string;
  initial: string;
  states: string[];
  final_states: string[];
  transitions: TransitionRow[];
}

const STATE = /^[A-Z][A-Z0-9_]*$/;
const EVENT = /^[A-Z][A-Z0-9_]*$/;
const CODE = /^[a-z][a-z0-9_]*$/;
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class MachineDefinitionError extends Error {
  constructor(machine: string, problem: string) {
    super(`machine ${machine}: ${problem}`);
    this.name = 'MachineDefinitionError';
  }
}

/** Code-unit order, the same as PostgreSQL COLLATE "C" for these ASCII identifiers. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function extractDefinition(descriptor: MachineDescriptor): MachineDefinition {
  const { machine, code } = descriptor;
  const fail = (problem: string): never => {
    throw new MachineDefinitionError(code, problem);
  };
  if (!CODE.test(code)) fail('the code must be lower_snake_case');
  if (machine.id !== code) fail(`the XState id ${machine.id} must equal the machine code`);
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) fail('the version must be a positive integer');
  if (!CODE.test(descriptor.aggregateType)) fail('the aggregate type must be lower_snake_case');
  const root = machine.root;
  if (root.type !== 'compound') fail('the root must be a compound state with child states');
  if (root.transitions.size > 0 || root.entry.length > 0 || root.exit.length > 0 || root.invoke.length > 0) fail('the root may not have transitions, actions or invocations');
  const initialTarget = root.initial.target;
  const initial = initialTarget[0]?.key;
  if (initialTarget.length !== 1 || initial === undefined) fail('exactly one initial state is required');

  const states: string[] = [];
  const finals: string[] = [];
  const transitions: TransitionRow[] = [];
  for (const [key, node] of Object.entries(root.states) as [string, AnyStateNode][]) {
    if (!STATE.test(key)) fail(`state ${key} must be UPPER_SNAKE_CASE`);
    if (node.type !== 'atomic' && node.type !== 'final') fail(`state ${key} is ${node.type}; only flat atomic and final states are supported`);
    if (node.entry.length > 0 || node.exit.length > 0 || node.invoke.length > 0) fail(`state ${key} may not have actions or invocations`);
    if ((node.always?.length ?? 0) > 0) fail(`state ${key} may not have eventless (always) transitions`);
    states.push(key);
    if (node.type === 'final') finals.push(key);
    for (const [event, defs] of node.transitions) {
      if (!EVENT.test(event)) fail(`event ${event} in ${key} must be UPPER_SNAKE_CASE (delayed, wildcard and internal events are not supported)`);
      if (defs.length !== 1) fail(`${key} has ${defs.length} transitions for ${event}; a GMP machine has exactly one`);
      const def = defs[0];
      if (!def) continue;
      if (def.guard !== undefined) fail(`${key} ${event}: put guard codes in meta.guards via gmp(), not in an XState guard`);
      if (def.actions.length > 0) fail(`${key} ${event}: transitions may not have actions`);
      const target = def.target;
      if (!target || target.length !== 1 || !target[0] || target[0].parent !== root) fail(`${key} ${event}: exactly one sibling target state is required`);
      transitions.push({ from: key, event, to: target?.[0]?.key ?? '', ...readMeta(code, key, event, def.meta) });
    }
  }
  states.sort(byCodeUnit);
  finals.sort(byCodeUnit);
  transitions.sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.event, b.event));
  return {
    machine: code,
    version: descriptor.version,
    aggregate_type: descriptor.aggregateType,
    description: descriptor.description,
    initial: initial ?? '',
    states,
    final_states: finals,
    transitions,
  };
}

function readMeta(machine: string, state: string, event: string, meta: unknown): GmpTransitionMeta {
  const where = `${state} ${event}`;
  if (meta === undefined) return { guards: [], signature: null, permission: null };
  if (typeof meta !== 'object' || meta === null) throw new MachineDefinitionError(machine, `${where}: meta must come from gmp()`);
  const m = meta as Partial<Record<keyof GmpTransitionMeta, unknown>>;
  const extra = Object.keys(meta).filter((k) => !['guards', 'signature', 'permission'].includes(k));
  if (extra.length > 0) throw new MachineDefinitionError(machine, `${where}: unknown meta keys ${extra.join(', ')}`);
  const guards = m.guards ?? [];
  if (!Array.isArray(guards) || !guards.every((g): g is string => typeof g === 'string' && DOTTED.test(g))) {
    throw new MachineDefinitionError(machine, `${where}: guard codes must be dotted lower_snake names`);
  }
  if (new Set(guards).size !== guards.length) throw new MachineDefinitionError(machine, `${where}: a guard is listed twice`);
  const signature = m.signature ?? null;
  if (signature !== null && (typeof signature !== 'string' || !STATE.test(signature))) {
    throw new MachineDefinitionError(machine, `${where}: the signature meaning must be UPPER_SNAKE_CASE`);
  }
  const permission = m.permission ?? null;
  if (permission !== null && (typeof permission !== 'string' || !DOTTED.test(permission))) {
    throw new MachineDefinitionError(machine, `${where}: the permission must be a dotted lower_snake name`);
  }
  return { guards: [...guards], signature, permission };
}

/** Canonical text of a definition (same as platform.machine_canonical_text). */
export function canonicalText(def: MachineDefinition): string {
  const lines = [
    `machine=${def.machine}`,
    `version=${def.version}`,
    `aggregate_type=${def.aggregate_type}`,
    `initial=${def.initial}`,
    `states=${[...def.states].sort(byCodeUnit).join(',')}`,
    `final=${[...def.final_states].sort(byCodeUnit).join(',')}`,
    ...[...def.transitions]
      .sort((a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.event, b.event))
      .map((t) => `transition=${t.from}|${t.event}|${t.to}|${t.guards.join(',')}|${t.signature ?? ''}|${t.permission ?? ''}`),
  ];
  return lines.join('\n');
}

export function definitionHash(def: MachineDefinition): string {
  return createHash('sha256').update(canonicalText(def), 'utf8').digest('hex');
}
