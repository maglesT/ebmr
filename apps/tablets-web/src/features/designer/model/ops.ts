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
 * targets, limit bounds of parameters, calculations and yields (with whether each bound value itself passes),
 * time-constraint bounds and hold times.
 * Construct editing (wrap and unwrap) comes in A2.
 *
 * Text no record can hold (U+0000, a UTF-16 surrogate without its other half) never enters the content: the operation
 * that would bring it in is refused, naming the field (review F31, round 2). A browser keeps U+0000 in an input's
 * value, and the editor hashes the content it shows (canonical JSON refuses such text), so letting it in would bring
 * the editor down instead of pointing the author at the field.
 */
import { ENGINE_ROLES, PINNED_POLICY_ROLES } from '@ebmr/api-contract';
import { unstorableText } from '@ebmr/expr';
import { flow, library, type limits } from '@ebmr/recipe-core/pure';
import { coatingLayerParts, layerProblem, type CoatingLayer } from './coating-layer.ts';

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
  | { kind: 'SET_CRITICALITY_ASSESSMENT'; reference: flow.Reference | null }
  | { kind: 'INSERT_STEP'; sequenceId: string; index: number; step: Step }
  | { kind: 'MOVE_STEP'; nodeId: string; direction: -1 | 1 }
  | { kind: 'DELETE_STEP'; nodeId: string }
  | { kind: 'UPDATE_PHASE'; nodeId: string; patch: PhasePatch }
  | { kind: 'UPDATE_HOLD'; nodeId: string; patch: Partial<Pick<flow.HoldPointNode, 'name' | 'role'>> }
  /**
   * Sets or removes (value null) one bound of a limit range. A bound that exists keeps whether its value itself passes
   * unless `inclusive` says otherwise; a bound that does not exist yet is created only with `inclusive` stated, so a
   * cleared exclusive bound typed again never comes back inclusive (a wider limit) by default (review F47).
   */
  | { kind: 'SET_LIMIT_BOUND'; owner: 'parameter' | 'calculation' | 'yield'; id: string; tier: Tier; side: 'low' | 'high'; value: string | null; inclusive?: boolean }
  /** Whether the value of an existing bound itself passes (at least / at most) or fails (more than / less than). */
  | { kind: 'SET_LIMIT_INCLUSIVE'; owner: 'parameter' | 'calculation' | 'yield'; id: string; tier: Tier; side: 'low' | 'high'; inclusive: boolean }
  | { kind: 'SET_TARGET'; parameterId: string; value: string | null }
  | { kind: 'SET_TIME_BOUND'; constraintId: string; side: 'min' | 'max'; value: string | null }
  | { kind: 'SET_HOLD_TIME'; intermediateId: string; value: string }
  // Slice 7j (R4, D-7j-8): stages of the top-level sequence, their rooms and equipment classes.
  | { kind: 'ADD_STAGE'; afterStageId: string | null; stage: flow.StageNode }
  | { kind: 'MOVE_STAGE'; stageId: string; direction: -1 | 1 }
  | { kind: 'DELETE_STAGE'; stageId: string }
  | { kind: 'UPDATE_STAGE'; stageId: string; patch: { name?: string; rooms?: string[]; noYieldReason?: string; clearanceFrom?: string } }
  | { kind: 'ADD_STAGE_EQUIPMENT'; stageId: string; equipment: flow.StageEquipment; reference?: flow.Reference }
  | { kind: 'REMOVE_STAGE_EQUIPMENT'; stageId: string; ref: string }
  // Slice 7o (R4, R8 C3; D-7o-2): one more coat of the same tablets after a step (coating-layer.ts).
  | { kind: 'ADD_COATING_LAYER'; stepId: string; place: 'BEFORE' | 'AFTER'; layer: CoatingLayer }
  // Decision 0026 slice S9: an approved library block as a step, its snapshot carried by the master (pinned by hash).
  | { kind: 'ADD_LIBRARY_BLOCK'; sequenceId: string; index: number; stepId: string; definition: library.BlockDefinition };

export const KNOWN_MARKETS = ['IN', 'US', 'EU'] as const;

const MAX_TEXT = 200;

function checkName(text: string, what: string): string {
  const unstorable = unstorableText(text);
  if (unstorable !== null) throw new OpError(`${what} holds ${unstorable}, which no record can hold: enter it again without it.`);
  const t = text.trim();
  if (t === '') throw new OpError(`${what} cannot be empty.`);
  if (t.length > MAX_TEXT) throw new OpError(`${what} is longer than ${MAX_TEXT} characters.`);
  return t;
}

/** Refuses a configuration value holding text no record can hold in any string or member name, naming the field. */
function checkConfigText(value: unknown, path: readonly string[]): void {
  if (typeof value === 'string') {
    const problem = unstorableText(value);
    if (problem !== null) throw new OpError(`The configuration field ${path.join('.')} holds ${problem}, which no record can hold: enter it again without it.`);
  } else if (Array.isArray(value)) {
    value.forEach((v: unknown, i) => checkConfigText(v, [...path, String(i)]));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const problem = unstorableText(k);
      if (problem !== null) throw new OpError(`The configuration has a field name holding ${problem}, which no record can hold.`);
      checkConfigText(v, [...path, k]);
    }
  }
}

/** A role an MBR names is an engine role (review F49); a hold point is released by QA (PR-45; review F48). */
function checkRole(role: string, what: string, allowed: readonly string[]): string {
  if (!allowed.includes(role)) throw new OpError(`${what} must be one of ${allowed.join(', ')} (${JSON.stringify(role)} is not).`);
  return role;
}

function checkDecimal(value: string, what: string, opts: { positive?: boolean } = {}): string {
  if (!flow.isDecimalLiteral(value)) throw new OpError(`${what} must be a decimal number such as 12.5 (${JSON.stringify(value)} is not one).`);
  if (opts.positive && flow.compareDecimal(value, '0') <= 0) throw new OpError(`${what} must be greater than zero.`);
  return value;
}

/** Every id used in the content: tree nodes and list items (new ids never collide with any of them). */
export function allIds(c: Content): Set<string> {
  return flow.contentIds(c);
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
    case 'ADD_STAGE':
    case 'MOVE_STAGE':
    case 'DELETE_STAGE':
    case 'UPDATE_STAGE':
    case 'ADD_STAGE_EQUIPMENT':
    case 'REMOVE_STAGE_EQUIPMENT':
      applyStageOp(c, op);
      return;
    case 'ADD_COATING_LAYER': {
      const problem = layerProblem(op.layer);
      if (problem) throw new OpError(problem);
      // Next to the step, or next to the construct holding it when it is a loop's or a branch's body (a coating step).
      let anchor = locate(c, op.stepId);
      if (!anchor) throw new OpError(`There is no step ${op.stepId} to add the layer next to.`);
      if (!anchor.parent) {
        let chain: flow.FlowNode[] = [];
        flow.walk(c.procedure.body, (n, ancestors) => {
          if (n.id === op.stepId) chain = [...ancestors];
        });
        anchor = chain.reverse().map((a) => locate(c, a.id)).find((x) => x?.parent) ?? undefined;
      }
      if (!anchor?.parent) throw new OpError('A layer is added next to a step of a sequence.');
      const parts = coatingLayerParts(c, op.layer, allIds(c));
      anchor.parent.children.splice(op.place === 'BEFORE' ? anchor.index : anchor.index + 1, 0, ...parts.steps);
      c.parameters.push(...parts.parameters);
      return;
    }
    case 'ADD_LIBRARY_BLOCK': {
      const l = locate(c, op.sequenceId);
      if (!l || l.node.kind !== 'sequence') throw new OpError(`There is no sequence ${op.sequenceId} to insert into.`);
      if (op.index < 0 || op.index > l.node.children.length || !Number.isInteger(op.index)) throw new OpError('The position is outside the sequence.');
      if (allIds(c).has(op.stepId)) throw new OpError(`The id ${op.stepId} is already used.`);
      let snapshots: Content['blockDefinitions'];
      try {
        snapshots = library.withSnapshot(c, op.definition);
      } catch (e) {
        throw new OpError(e instanceof Error ? e.message : 'The library block cannot be added.');
      }
      l.node.children.splice(op.index, 0, library.libraryPhase(op.definition, op.stepId, defaultRiskClass(c)));
      c.blockDefinitions = snapshots;
      return;
    }
    case 'SET_TITLE':
      c.header.title = checkName(op.title, 'The title');
      return;
    // R-rest A11: the master's criticality assessment (a pinned risk assessment), the rationale for its non-critical items.
    case 'SET_CRITICALITY_ASSESSMENT': {
      if (op.reference === null) {
        delete c.header.criticalityAssessment;
        return;
      }
      if (op.reference.kind !== 'RISK_ASSESSMENT') throw new OpError('The criticality assessment is a risk assessment.');
      if (!c.references.some((r) => r.id === op.reference?.id)) c.references.push(structuredClone(op.reference));
      c.header.criticalityAssessment = op.reference.id;
      return;
    }
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
      if (patch.config !== undefined) checkConfigText(patch.config, []);
      if (patch.signatures?.perform) checkRole(patch.signatures.perform.role, 'The performer', ENGINE_ROLES);
      if (patch.signatures?.check) checkRole(patch.signatures.check.role, 'The checker', ENGINE_ROLES);
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
      if (op.patch.role !== undefined) s.role = checkRole(checkName(op.patch.role, 'The releasing role'), 'The releasing role of a QA hold point', PINNED_POLICY_ROLES.qaRoles);
      return;
    }
    case 'SET_LIMIT_BOUND': {
      const { holder, name } = limitSpecOf(c, op.owner, op.id);
      const range = holder.limits?.ranges.find((r) => r.tier === op.tier);
      if (!range) throw new OpError(`${name} has no ${op.tier.toLowerCase().replace('_', ' ')} range.`);
      if (op.value === null) {
        delete range[op.side];
        return;
      }
      const value = checkDecimal(op.value, `The ${op.side === 'low' ? 'lower' : 'upper'} limit`);
      const inclusive = op.inclusive ?? range[op.side]?.inclusive;
      if (inclusive === undefined) {
        throw new OpError(`Say whether the ${op.side === 'low' ? 'lower' : 'upper'} limit value itself passes (${op.side === 'low' ? 'at least' : 'at most'}) or fails (${op.side === 'low' ? 'more than' : 'less than'}).`);
      }
      range[op.side] = { value, inclusive };
      return;
    }
    case 'SET_LIMIT_INCLUSIVE': {
      const { holder, name } = limitSpecOf(c, op.owner, op.id);
      const bound = holder.limits?.ranges.find((r) => r.tier === op.tier)?.[op.side];
      if (!bound) throw new OpError(`${name} has no ${op.side === 'low' ? 'lower' : 'upper'} ${op.tier.toLowerCase().replace('_', ' ')} limit to change.`);
      bound.inclusive = op.inclusive;
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

/** The top-level sequence whose children are the stages (slice 7j). */
function stageSequence(c: Content): flow.SequenceNode {
  if (c.procedure.body.kind !== 'sequence') throw new OpError('The procedure is not a sequence of stages, so its stages cannot be edited here.');
  return c.procedure.body;
}

function stageAt(c: Content, stageId: string): { seq: flow.SequenceNode; index: number; stage: flow.StageNode } {
  const seq = stageSequence(c);
  const index = seq.children.findIndex((n) => n.id === stageId && n.kind === 'stage');
  if (index < 0) throw new OpError(`There is no stage ${stageId}.`);
  return { seq, index, stage: seq.children[index] as flow.StageNode };
}

const ROOM = /^[A-Z0-9][A-Z0-9-]{0,31}$/;

function applyStageOp(c: Content, op: Extract<Op, { kind: 'ADD_STAGE' | 'MOVE_STAGE' | 'DELETE_STAGE' | 'UPDATE_STAGE' | 'ADD_STAGE_EQUIPMENT' | 'REMOVE_STAGE_EQUIPMENT' }>): void {
  switch (op.kind) {
    case 'ADD_STAGE': {
      const seq = stageSequence(c);
      const parsed = flow.parseFlowNodeStandalone(op.stage);
      if (!parsed.ok || op.stage.kind !== 'stage') throw new OpError(`The new stage is not well formed: ${parsed.ok ? 'not a stage' : parsed.problems.map((p) => p.message).join('; ')}`);
      const used = allIds(c);
      for (const id of treeIds({ ...c, procedure: { ...c.procedure, body: op.stage } })) if (used.has(id)) throw new OpError(`The id ${id} is already used.`);
      const at = op.afterStageId === null ? 0 : stageAt(c, op.afterStageId).index + 1;
      seq.children.splice(at, 0, structuredClone(op.stage));
      return;
    }
    case 'MOVE_STAGE': {
      // Past the neighbouring stage (a hold point between stages stays where it is).
      const { seq, index } = stageAt(c, op.stageId);
      const stageIdx = seq.children.map((n, i) => (n.kind === 'stage' ? i : -1)).filter((i) => i >= 0);
      const at = stageIdx.indexOf(index);
      const other = stageIdx[at + op.direction];
      if (other === undefined) throw new OpError(op.direction < 0 ? 'The stage is already first.' : 'The stage is already last.');
      const [moved] = seq.children.splice(index, 1);
      seq.children.splice(other, 0, moved as flow.FlowNode);
      return;
    }
    case 'DELETE_STAGE': {
      const { seq, index } = stageAt(c, op.stageId);
      if (seq.children.filter((n) => n.kind === 'stage').length <= 1) throw new OpError('A master keeps at least one stage.');
      seq.children.splice(index, 1);
      return;
    }
    case 'UPDATE_STAGE': {
      const { stage } = stageAt(c, op.stageId);
      if (op.patch.name !== undefined) stage.name = checkName(op.patch.name, 'The stage name');
      if (op.patch.rooms !== undefined) {
        const rooms = op.patch.rooms.map((r) => r.trim()).filter((r) => r !== '');
        const bad = rooms.filter((r) => !ROOM.test(r));
        if (bad.length > 0) throw new OpError(`A room is 1 to 32 capitals, digits or dashes (${bad.join(', ')} is not).`);
        if (rooms.length === 0) throw new OpError('A stage is bound to at least one room.');
        stage.binding = { ...stage.binding, rooms: [...new Set(rooms)] };
      }
      // R-flow item 4: a material stage with no yield says why on the stage; an empty text takes the reason away.
      if (op.patch.noYieldReason !== undefined) {
        if (op.patch.noYieldReason.trim() === '') delete stage.noYieldReason;
        else stage.noYieldReason = checkName(op.patch.noYieldReason, 'The reason for no yield');
      }
      // R-rest A6: the stage continues an earlier stage's clearance (the validator checks the room or line); empty removes it.
      if (op.patch.clearanceFrom !== undefined) {
        if (op.patch.clearanceFrom === '') delete stage.clearanceFrom;
        else stage.clearanceFrom = op.patch.clearanceFrom;
      }
      return;
    }
    case 'ADD_STAGE_EQUIPMENT': {
      const { stage } = stageAt(c, op.stageId);
      const ref = op.equipment.ref.trim();
      if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(ref)) throw new OpError('An equipment reference is 1 to 32 capitals, digits, dashes or underscores, starting with a capital.');
      if (stage.binding.equipment.some((e) => e.ref === ref)) throw new OpError(`The stage already has equipment ${ref}.`);
      if (op.reference && !c.references.some((r) => r.id === op.reference?.id)) c.references.push(structuredClone(op.reference));
      if (!c.references.some((r) => r.id === op.equipment.equipmentClass && r.kind === 'EQUIPMENT_CLASS')) throw new OpError(`${op.equipment.equipmentClass} is not an equipment class this master pins.`);
      stage.binding = { ...stage.binding, equipment: [...stage.binding.equipment, { ...op.equipment, ref }] };
      return;
    }
    case 'REMOVE_STAGE_EQUIPMENT': {
      const { stage } = stageAt(c, op.stageId);
      if (!stage.binding.equipment.some((e) => e.ref === op.ref)) throw new OpError(`The stage has no equipment ${op.ref}.`);
      let used = false;
      const visit = (n: flow.FlowNode): void => {
        if (n.kind === 'phase' && n.equipment.some((e) => e.ref === op.ref)) used = true;
        flow.childrenOf(n).forEach(visit);
      };
      visit(stage.body);
      if (used) throw new OpError(`A step of the stage still checks or uses ${op.ref}: change the step first.`);
      stage.binding = { ...stage.binding, equipment: stage.binding.equipment.filter((e) => e.ref !== op.ref) };
      return;
    }
  }
}

/**
 * A new stage (slice 7j): bound to `room`, responsible the production supervisor, a material stage whose first
 * operation, "<name>: preparation", holds its room clearance and its equipment status check (the database-backed
 * versions a GMP batch takes, when offered). The author inserts the stage's own steps (its process blocks, its yield
 * step) after them in that operation, or directly in the stage: the operation level is optional (FLOW-LEVELS, ADR 0004
 * decision 1 as amended).
 */
export function newStage(c: Content, palette: readonly PaletteEntry[], name: string, room: string): flow.StageNode {
  const latest = (type: string): PaletteEntry | undefined => palette.filter((b) => b.type === type).sort((a, b) => (Number(a.version) < Number(b.version) ? 1 : -1))[0];
  const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'STAGE';
  const id = newStepId(c, `S-${slug}`);
  const steps: flow.FlowNode[] = [];
  const probe: Content = structuredClone(c);
  const opId = newStepId(c, `O-${slug}-PREP`);
  const operation: flow.OperationNode = { kind: 'operation', id: opId, name: `${name.trim()}: preparation`, body: { kind: 'sequence', id: `${opId}-seq`, children: steps } };
  const stage: flow.StageNode = { kind: 'stage', id, name: name.trim(), binding: { rooms: [room.trim()], equipment: [] }, purpose: 'MATERIAL', responsibleRole: 'PRODUCTION_SUPERVISOR', body: { kind: 'sequence', id: `${id}-seq`, children: [operation] } };
  if (probe.procedure.body.kind === 'sequence') probe.procedure.body.children.push(stage);
  for (const type of ['G-10', 'G-09']) {
    const block = latest(type);
    if (!block) continue;
    const step = newStep(probe, block);
    if (step.kind === 'phase') step.name = type === 'G-10' ? `${name.trim()}: room clearance` : `${name.trim()}: equipment status`;
    steps.push(step);
  }
  return structuredClone(stage);
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
