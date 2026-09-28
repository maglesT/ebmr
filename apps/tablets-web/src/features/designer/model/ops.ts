/**
 * Pure edit operations of the document-first designer, with undo and redo (module C2; plan section 8).
 *
 * Every operation takes MBR content and returns new content (the input is never mutated) or throws OpError with a
 * plain message. Operations keep the content well-formed (flow.parseMbr accepts it) and every id unique; whether
 * the content is a sound, complete MBR is the validator's question, answered in the findings panel. GMP values are
 * decimal strings from DecimalField, never JavaScript numbers.
 *
 * A1 scope: title and markets (India locked), insert, move (within its sequence) and delete of a step, a step's
 * name, configuration, signatures, significance, risk class, data and equipment lists, hold points, parameter
 * targets, limit bounds of parameters, calculations and yields, time-constraint bounds and hold times.
 * Construct editing (wrap and unwrap) comes in A2.
 */
import { flow, limits } from '@ebmr/recipe-core/pure';

export type Content = flow.MbrContent;
export type Step = flow.PhaseNode | flow.HoldPointNode;
export type Tier = limits.LimitTier;

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

export type PhasePatch = Partial<
  Pick<flow.PhaseNode, 'name' | 'config' | 'signatures' | 'significant' | 'riskClass' | 'records' | 'computes' | 'reads' | 'consumes' | 'produces' | 'uses' | 'equipment'>
> & { system?: flow.ComputerisedSystem | null };

export type Op =
  | { kind: 'SET_TITLE'; title: string }
  | { kind: 'SET_MARKETS'; markets: string[] }
  | { kind: 'INSERT_STEP'; sequenceId: string; index: number; step: Step }
  | { kind: 'MOVE_STEP'; nodeId: string; direction: -1 | 1 }
  | { kind: 'DELETE_STEP'; nodeId: string }
  | { kind: 'UPDATE_PHASE'; nodeId: string; patch: PhasePatch }
  | { kind: 'UPDATE_HOLD'; nodeId: string; patch: Partial<Pick<flow.HoldPointNode, 'name' | 'role'>> }
  | { kind: 'SET_LIMIT_BOUND'; owner: 'parameter' | 'calculation' | 'yield'; id: string; tier: Tier; side: 'low' | 'high'; value: string | null }
  | { kind: 'SET_TARGET'; parameterId: string; value: string | null }
  | { kind: 'SET_TIME_BOUND'; constraintId: string; side: 'min' | 'max'; value: string | null }
  | { kind: 'SET_HOLD_TIME'; intermediateId: string; value: string };

export const KNOWN_MARKETS = ['IN', 'US', 'EU'] as const;

const MAX_TEXT = 200;

function checkName(text: string, what: string): string {
  const t = text.trim();
  if (t === '') throw new OpError(`${what} cannot be empty.`);
  if (t.length > MAX_TEXT) throw new OpError(`${what} is longer than ${MAX_TEXT} characters.`);
  return t;
}

function checkDecimal(value: string, what: string, opts: { positive?: boolean } = {}): string {
  if (!flow.isDecimalLiteral(value)) throw new OpError(`${what} must be a decimal number such as 12.5 (${JSON.stringify(value)} is not one).`);
  if (opts.positive && flow.compareDecimal(value, '0') <= 0) throw new OpError(`${what} must be greater than zero.`);
  return value;
}

/** Every id used in the content: tree nodes and list items (new ids never collide with any of them). */
export function allIds(c: Content): Set<string> {
  const ids = new Set<string>();
  const visit = (n: flow.FlowNode): void => {
    ids.add(n.id);
    if (n.kind === 'parallel') for (const b of n.branches) ids.add(b.id);
    if (n.kind === 'alternative') for (const b of n.branches) ids.add(b.id);
    flow.childrenOf(n).forEach(visit);
  };
  ids.add(c.procedure.id);
  visit(c.procedure.body);
  for (const e of c.library) visit(e.body);
  for (const list of [c.references, c.inputs, c.bom, c.intermediates, c.parameters, c.calculations, c.yieldCheckpoints, c.acceptanceSchemes, c.timeConstraints, c.riskReductions, c.goldenCases]) {
    for (const x of list) ids.add(x.id);
  }
  return ids;
}

/** Tree node ids (procedure body only) in document order, with duplicates kept (for the uniqueness check). */
export function treeIds(c: Content): string[] {
  const out: string[] = [];
  const visit = (n: flow.FlowNode): void => {
    out.push(n.id);
    flow.childrenOf(n).forEach(visit);
  };
  visit(c.procedure.body);
  return out;
}

/** A new step id from a base ("p-weigh"), unique in the content. */
export function newStepId(c: Content, base: string): string {
  const ids = allIds(c);
  const stem = base.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').replace(/-$/, '') || 'p-step';
  if (!ids.has(stem)) return stem;
  for (let n = 2; ; n += 1) if (!ids.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

interface Located {
  node: flow.FlowNode;
  parent: flow.SequenceNode | null;
  index: number;
}

/** Finds a node of the procedure tree, with its parent sequence (null when the parent is not a sequence). */
export function locate(c: Content, id: string): Located | undefined {
  let found: Located | undefined;
  const visit = (n: flow.FlowNode, parent: flow.FlowNode | null, index: number): void => {
    if (found) return;
    if (n.id === id) {
      found = { node: n, parent: parent?.kind === 'sequence' ? parent : null, index };
      return;
    }
    if (n.kind === 'sequence') n.children.forEach((ch, i) => visit(ch, n, i));
    else flow.childrenOf(n).forEach((ch) => visit(ch, n, -1));
  };
  visit(c.procedure.body, null, -1);
  return found;
}

function stepOf(c: Content, id: string): Step {
  const l = locate(c, id);
  if (!l || (l.node.kind !== 'phase' && l.node.kind !== 'holdPoint')) throw new OpError(`There is no step ${id}.`);
  return l.node;
}

function limitSpecOf(c: Content, owner: 'parameter' | 'calculation' | 'yield', id: string): { holder: { limits?: limits.LimitSpec }; name: string } {
  const list = owner === 'parameter' ? c.parameters : owner === 'calculation' ? c.calculations : c.yieldCheckpoints;
  const holder = (list as { id: string; name: string; limits?: limits.LimitSpec }[]).find((x) => x.id === id);
  if (!holder) throw new OpError(`There is no ${owner} ${id}.`);
  return { holder, name: holder.name };
}

function applyInPlace(c: Content, op: Op): void {
  switch (op.kind) {
    case 'SET_TITLE':
      c.header.title = checkName(op.title, 'The title');
      return;
    case 'SET_MARKETS': {
      if (!op.markets.includes('IN')) throw new OpError('India (IN) stays in every market set (Revised Schedule M always applies).');
      const unknown = op.markets.filter((m) => !(KNOWN_MARKETS as readonly string[]).includes(m));
      if (unknown.length > 0) throw new OpError(`Unknown market ${unknown.join(', ')}.`);
      c.header.marketSet = KNOWN_MARKETS.filter((m) => op.markets.includes(m));
      return;
    }
    case 'INSERT_STEP': {
      const l = locate(c, op.sequenceId);
      if (!l || l.node.kind !== 'sequence') throw new OpError(`There is no sequence ${op.sequenceId} to insert into.`);
      if (op.index < 0 || op.index > l.node.children.length || !Number.isInteger(op.index)) throw new OpError('The position is outside the sequence.');
      const parsed = flow.parseFlowNodeStandalone(op.step);
      if (!parsed.ok) throw new OpError(`The new step is not well formed: ${parsed.problems.map((p) => p.message).join('; ')}`);
      if (op.step.kind !== 'phase' && op.step.kind !== 'holdPoint') throw new OpError('Only a step or a hold point can be inserted.');
      if (allIds(c).has(op.step.id)) throw new OpError(`The id ${op.step.id} is already used.`);
      l.node.children.splice(op.index, 0, structuredClone(op.step));
      return;
    }
    case 'MOVE_STEP': {
      const l = locate(c, op.nodeId);
      if (!l || (l.node.kind !== 'phase' && l.node.kind !== 'holdPoint')) throw new OpError(`There is no step ${op.nodeId}.`);
      if (!l.parent) throw new OpError('This step is not in a sequence, so it cannot be moved.');
      const to = l.index + op.direction;
      if (to < 0 || to >= l.parent.children.length) throw new OpError(op.direction < 0 ? 'The step is already first in its sequence.' : 'The step is already last in its sequence.');
      const [moved] = l.parent.children.splice(l.index, 1);
      l.parent.children.splice(to, 0, moved as flow.FlowNode);
      return;
    }
    case 'DELETE_STEP': {
      const l = locate(c, op.nodeId);
      if (!l || (l.node.kind !== 'phase' && l.node.kind !== 'holdPoint')) throw new OpError(`There is no step ${op.nodeId}.`);
      if (!l.parent) throw new OpError('This step is not in a sequence, so it cannot be deleted here (construct editing comes later).');
      l.parent.children.splice(l.index, 1);
      return;
    }
    case 'UPDATE_PHASE': {
      const s = stepOf(c, op.nodeId);
      if (s.kind !== 'phase') throw new OpError(`${op.nodeId} is a hold point, not a step.`);
      const { system, ...patch } = op.patch;
      const next: flow.PhaseNode = { ...s, ...structuredClone(patch) };
      if (patch.name !== undefined) next.name = checkName(patch.name, 'The step name');
      if (system === null) delete next.system;
      else if (system !== undefined) next.system = structuredClone(system);
      const parsed = flow.parseFlowNodeStandalone(next);
      if (!parsed.ok) throw new OpError(`The step would not be well formed: ${parsed.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
      Object.assign(s, next);
      if (system === null) delete (s as { system?: unknown }).system;
      return;
    }
    case 'UPDATE_HOLD': {
      const s = stepOf(c, op.nodeId);
      if (s.kind !== 'holdPoint') throw new OpError(`${op.nodeId} is a step, not a hold point.`);
      if (op.patch.name !== undefined) s.name = checkName(op.patch.name, 'The hold point name');
      if (op.patch.role !== undefined) s.role = checkName(op.patch.role, 'The releasing role');
      return;
    }
    case 'SET_LIMIT_BOUND': {
      const { holder, name } = limitSpecOf(c, op.owner, op.id);
      const range = holder.limits?.ranges.find((r) => r.tier === op.tier);
      if (!range) throw new OpError(`${name} has no ${op.tier.toLowerCase().replace('_', ' ')} range.`);
      if (op.value === null) delete range[op.side];
      else range[op.side] = { value: checkDecimal(op.value, `The ${op.side === 'low' ? 'lower' : 'upper'} limit`), inclusive: range[op.side]?.inclusive ?? true };
      return;
    }
    case 'SET_TARGET': {
      const p = c.parameters.find((x) => x.id === op.parameterId);
      if (!p) throw new OpError(`There is no parameter ${op.parameterId}.`);
      if (op.value === null) delete p.target;
      else p.target = checkDecimal(op.value, 'The target');
      return;
    }
    case 'SET_TIME_BOUND': {
      const t = c.timeConstraints.find((x) => x.id === op.constraintId);
      if (!t) throw new OpError(`There is no time constraint ${op.constraintId}.`);
      const unit = t[op.side]?.unit ?? t.max?.unit ?? t.min?.unit ?? 'min';
      if (op.value === null) delete t[op.side];
      else t[op.side] = { value: checkDecimal(op.value, `The ${op.side === 'min' ? 'minimum' : 'maximum'}`, { positive: true }), unit };
      return;
    }
    case 'SET_HOLD_TIME': {
      const i = c.intermediates.find((x) => x.id === op.intermediateId);
      if (!i?.holdTime) throw new OpError(`Intermediate ${op.intermediateId} has no hold time to change.`);
      i.holdTime = { ...i.holdTime, max: { value: checkDecimal(op.value, 'The maximum hold time', { positive: true }), unit: i.holdTime.max.unit } };
      return;
    }
  }
}

/** Applies one operation (pure: returns new content, or throws OpError and leaves the input as it was). */
export function applyOp(content: Content, op: Op): Content {
  const next = structuredClone(content);
  applyInPlace(next, op);
  const ids = treeIds(next);
  if (new Set(ids).size !== ids.length) throw new OpError('The change would give two steps the same id.');
  return next;
}

// ---------------------------------------------------------------------------------------------
// Undo and redo

export interface History {
  past: Content[];
  present: Content;
  future: Content[];
}

export const HISTORY_LIMIT = 200;

export function initHistory(content: Content): History {
  return { past: [], present: content, future: [] };
}

/** Applies an operation to the present; the previous content goes on the undo stack and redo is cleared. */
export function perform(h: History, op: Op): History {
  const next = applyOp(h.present, op);
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo(h: History): History {
  const prev = h.past.at(-1);
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

// ---------------------------------------------------------------------------------------------
// New steps from the palette

export interface PaletteEntry {
  key: string;
  type: string;
  version: string;
  plainName: string;
  level: string;
  significant: boolean;
  defaultConfig: Record<string, unknown>;
}

/** The middle class of the risk scale (a new step's starting risk class; the author reviews it). */
export function defaultRiskClass(c: Content): string {
  const classes = c.riskScale.classes;
  return classes[Math.floor((classes.length - 1) / 2)] ?? classes[0] ?? 'MEDIUM';
}

/** A new, empty step of a palette block (performer operator; checker verifier when the block is significant). */
export function newStep(c: Content, block: PaletteEntry): Step {
  if (block.level === 'HOLD_POINT') {
    return { kind: 'holdPoint', id: newStepId(c, 'H-QA'), name: block.plainName, role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] };
  }
  return {
    kind: 'phase',
    id: newStepId(c, `p-${block.type.toLowerCase()}`),
    name: block.plainName,
    block: { type: block.type, version: block.version },
    config: structuredClone(block.defaultConfig) as Record<string, flow.JsonValue>,
    records: [],
    computes: [],
    reads: [],
    consumes: [],
    produces: [],
    uses: [],
    equipment: [],
    signatures: block.significant ? { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } : { perform: { role: 'PRODUCTION_OPERATOR' } },
    significant: block.significant,
    riskClass: defaultRiskClass(c),
  };
}

/** Where a new step goes after `afterId` (a step), or at the start of `sequenceId`. */
export function insertionPoint(c: Content, afterId: string): { sequenceId: string; index: number } | undefined {
  const l = locate(c, afterId);
  if (l?.parent) return { sequenceId: l.parent.id, index: l.index + 1 };
  if (l?.node.kind === 'sequence') return { sequenceId: l.node.id, index: 0 };
  if (l && (l.node.kind === 'operation' || l.node.kind === 'stage') && l.node.body.kind === 'sequence') return { sequenceId: l.node.body.id, index: 0 };
  return undefined;
}
