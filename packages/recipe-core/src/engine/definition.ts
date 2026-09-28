/**
 * Batch definition: the immutable, checked "program" the engine runs for one pinned MBR version
 * (ADR 0004, 0010). Built once per MBR version and block registry; shared by every batch of it.
 *
 * `defineBatch` refuses an MBR the engine cannot run safely: library expansion problems, a graph that
 * fails the structure gates, a phase whose block version has no execution handler in the registry, a
 * block configuration that fails its schema, a step verified by zero humans (INV-31), a hold point
 * with no releasing disposition, or a calculation that does not compile. Definition warnings (for
 * example a dispensing target without a tolerance) need a recorded justification, like validator
 * warnings (outline 6.3).
 */
import { compile, type CompiledExpression, type InputDeclaration, type OutputDeclaration } from '@ebmr/expr';
import { mbrContentHash } from '../flow/canonical.ts';
import { genericBlockCatalog, type BlockCatalog } from '../flow/blocks.ts';
import { createExprService, declarationOf } from '../flow/expr-adapter.ts';
import type { ExpressionService, ExprType } from '../flow/expression-port.ts';
import type { GraphIndex } from '../flow/graph.ts';
import {
  childrenOf,
  isNodeEvent,
  type AlternativeNode,
  type FlowNode,
  type HoldPointNode,
  type JsonValue,
  type LoopNode,
  type MbrContent,
  type PhaseNode,
  type ReplicateNode,
  type StageNode,
  type TimeConstraint,
} from '../flow/model.ts';
import { boundsOf, TokenGame } from '../flow/tokens.ts';
import { Analysis, GLOBAL_SCOPE } from '../validator/analysis.ts';
import { validateGraph } from '../validator/validate.ts';
import type { BlockVersion, ConfigProblem } from '../blocks/contract.ts';
import type { BlockRegistry } from '../blocks/registry.ts';
import { validateSchema } from '../blocks/schema.ts';
import { DEFAULT_POLICY, type EnginePolicy } from './types.ts';

/** Dispositions that release a QA hold point; any other listed disposition is a negative one (documented default). */
export const RELEASING_DISPOSITIONS: readonly string[] = ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'CONTINUE', 'RELEASED', 'ACCEPTED'];

export interface StepDef {
  id: string;
  kind: 'PHASE' | 'HOLD';
  node: PhaseNode | HoldPointNode;
  graphNode: string;
  stage: string | undefined;
  /** Enclosing loop and replicate constructs, outermost first (the frames of every instance). */
  constructs: string[];
  /** Enclosing alternative branches (construct -> branch). */
  branches: { construct: string; branch: string }[];
  block?: BlockVersion;
  config: Readonly<Record<string, JsonValue>>;
  /** Roles that may perform: declared, or (two-person mode, automated phase) the stage's performer roles. */
  performRoles: string[];
  /** A SYSTEM actor ends the phase (automated phase in one-verifier mode, S5a). */
  systemPerforms: boolean;
  checkRole?: string;
  checkMeaning?: 'VERIFIED' | 'WITNESSED';
  /** Parameters the block computes from its entries (never typed, INV-25). */
  computedItems: Set<string>;
  /** Parameters and calculations the phase writes. */
  writes: Set<string>;
}

export interface RuntimeConstraint {
  tc: TimeConstraint;
  implicit: boolean;
  /** Constructs shared by both events: the constraint applies per iteration / per instance of these. */
  shared: string[];
  from: { node: string; event: 'START' | 'END'; constructs: string[] };
  to: { node: string; event: 'START' | 'END'; constructs: string[] };
  /** Graph node of the `from` event, for blocking "the step and everything downstream". */
  anchor: string;
  /** Alternative branches the `to` event lies in (the constraint is void when one is not taken). */
  toBranches: { construct: string; branch: string }[];
}

export interface DefinitionProblem {
  code: string;
  severity: 'ERROR' | 'WARNING';
  subject: string;
  message: string;
  controls: string[];
  /** Key a warning justification names: `${code}@${subject}`. */
  key: string;
}

export class EngineDefinitionError extends Error {
  constructor(readonly problems: DefinitionProblem[]) {
    super(`The MBR cannot be executed: ${problems.map((p) => p.message).join('; ')}`);
    this.name = 'EngineDefinitionError';
  }
}

export interface DefineOptions {
  registry: BlockRegistry;
  expressions?: ExpressionService;
  /** Validator catalogue used for the analysis (default: the generic catalogue). */
  catalog?: BlockCatalog;
  policy?: Partial<EnginePolicy>;
  /** Justifications for definition warnings. */
  justifications?: readonly { key: string; text: string; by: string }[];
}

export interface BatchDefinition {
  mbr: MbrContent;
  contentHash: string;
  analysis: Analysis;
  game: TokenGame;
  gi: GraphIndex;
  registry: BlockRegistry;
  expr: ExpressionService;
  policy: EnginePolicy;
  steps: Map<string, StepDef>;
  stepByGraphNode: Map<string, string>;
  stages: Map<string, StageNode>;
  loops: Map<string, LoopNode>;
  replicates: Map<string, ReplicateNode>;
  alternatives: Map<string, AlternativeNode>;
  /** Enclosing loop/replicate constructs of any tree node's event (openers for constructs). */
  eventConstructs: Map<string, string[]>;
  /** Stage enclosing each tree node. */
  stageOf: Map<string, string>;
  constraints: RuntimeConstraint[];
  /** Phases writing each item. */
  writers: Map<string, string[]>;
  /** Loops whose exit reads each endpoint parameter written inside them. */
  loopEndpoints: Map<string, string[]>;
  /** Compiled calculation programs by `${calculation}@${step}`. */
  programs: Map<string, { program: CompiledExpression; derivedInputs: Set<string> }>;
  warnings: DefinitionProblem[];
  /** Every item some step, calculation, guard, loop exit or count expression reads. */
  readItems: Set<string>;
  /** Forward reachability (with loop-back edges) between graph nodes, memoised. */
  reach: Map<string, Set<string>>;
}

function problem(code: string, severity: 'ERROR' | 'WARNING', subject: string, message: string, controls: string[]): DefinitionProblem {
  return { code, severity, subject, message: `${message} (${code}; ${controls.join(', ')})`, controls, key: `${code}@${subject}` };
}

/** Constructs (loops, replicates) a graph node lies inside, outermost first. */
export function constructsOfRegions(regions: readonly string[]): string[] {
  return regions.filter((r) => r.startsWith('loop:') || r.startsWith('rep:')).map((r) => r.slice(r.indexOf(':') + 1));
}

function branchesOfRegions(regions: readonly string[]): { construct: string; branch: string }[] {
  return regions.filter((r) => r.startsWith('alt:')).map((r) => {
    const body = r.slice(4);
    const hash = body.lastIndexOf('#');
    return { construct: body.slice(0, hash), branch: body.slice(hash + 1) };
  });
}

function outputDeclaration(t: ExprType | undefined): OutputDeclaration | undefined {
  if (!t) return undefined;
  if (t.kind === 'BOOLEAN') return { kind: 'boolean' };
  if (t.kind === 'COUNT') return { kind: 'quantity', unit: '1', tag: 'count' };
  if (t.kind === 'DECIMAL') {
    const d = declarationOf(t);
    if ('problem' in d) return undefined;
    return d.tag === undefined ? { kind: 'quantity', unit: t.unit } : { kind: 'quantity', unit: t.unit, tag: d.tag };
  }
  return undefined;
}

export function defineBatch(mbr: MbrContent, options: DefineOptions): BatchDefinition {
  const expr = options.expressions ?? createExprService();
  const policy: EnginePolicy = { ...DEFAULT_POLICY, ...options.policy };
  const analysis = new Analysis(mbr, { expressions: expr, blocks: options.catalog ?? genericBlockCatalog, references: { status: () => 'EFFECTIVE' }, asOf: 'execution' });
  const problems: DefinitionProblem[] = [];

  for (const p of analysis.expanded.problems) problems.push(problem('ENG-DEF-LIBRARY', 'ERROR', p.nodeId, p.message, ['DI-34']));
  for (const f of validateGraph(analysis.graph)) if (f.severity === 'ERROR') problems.push(problem('ENG-DEF-GRAPH', 'ERROR', f.subject, f.message, ['DI-34']));
  if (analysis.duplicateNodeIds.length > 0) problems.push(problem('ENG-DEF-IDS', 'ERROR', analysis.duplicateNodeIds.join(','), 'Two steps share an id', ['DI-34']));

  const gi = analysis.gi;
  const bounds = boundsOf(analysis.expanded.root);
  const game = new TokenGame(analysis.graph, bounds);
  const stages = new Map<string, StageNode>();
  const alternatives = new Map<string, AlternativeNode>();
  const stageOf = new Map<string, string>();
  const visit = (n: FlowNode, stage: string | undefined): void => {
    if (n.kind === 'stage') stages.set(n.id, n);
    if (n.kind === 'alternative') alternatives.set(n.id, n);
    const s = n.kind === 'stage' ? n.id : stage;
    if (s !== undefined) stageOf.set(n.id, s);
    childrenOf(n).forEach((c) => visit(c, s));
  };
  visit(analysis.expanded.root, undefined);

  const eventConstructs = new Map<string, string[]>();
  for (const [id] of analysis.nodes) {
    const gns = analysis.graphNodes(id);
    const first = gns.find((g) => g.kind === 'TASK' || g.kind === 'HOLD') ?? gns[0];
    if (first) eventConstructs.set(id, constructsOfRegions(first.regions));
  }

  // Performer roles per stage (for automated phases in two-person mode).
  const stagePerformRoles = new Map<string, Set<string>>();
  for (const p of analysis.phases) {
    const stage = stageOf.get(p.id);
    if (stage === undefined || !p.signatures.perform) continue;
    const set = stagePerformRoles.get(stage) ?? new Set<string>();
    set.add(p.signatures.perform.role);
    stagePerformRoles.set(stage, set);
  }
  const allPerformRoles = [...new Set(analysis.phases.flatMap((p) => (p.signatures.perform ? [p.signatures.perform.role] : [])))].sort();

  const steps = new Map<string, StepDef>();
  const stepByGraphNode = new Map<string, string>();
  const justified = new Set((options.justifications ?? []).filter((j) => j.text.trim().length > 0).map((j) => j.key));
  const warnings: DefinitionProblem[] = [];

  for (const [id, info] of analysis.nodes) {
    const n = info.node;
    if (n.kind !== 'phase' && n.kind !== 'holdPoint') continue;
    const g = analysis.graphNodes(id).find((x) => x.kind === 'TASK' || x.kind === 'HOLD');
    if (!g) {
      problems.push(problem('ENG-DEF-GRAPH', 'ERROR', id, `Step ${id} has no node in the execution graph`, ['DI-34']));
      continue;
    }
    const def: StepDef = {
      id,
      kind: n.kind === 'phase' ? 'PHASE' : 'HOLD',
      node: n,
      graphNode: g.id,
      stage: stageOf.get(id),
      constructs: constructsOfRegions(g.regions),
      branches: branchesOfRegions(g.regions),
      config: n.kind === 'phase' ? n.config : {},
      performRoles: [],
      systemPerforms: false,
      computedItems: new Set(),
      writes: new Set(n.kind === 'phase' ? [...n.records, ...n.computes] : []),
    };
    if (n.kind === 'phase') {
      const block = options.registry.get(n.block.type, n.block.version);
      if (!block || block.level !== 'PHASE' || !block.handler) {
        problems.push(
          problem('ENG-DEF-BLOCK', 'ERROR', id, `Step ${id} uses block ${n.block.type}@${n.block.version}, which has no execution handler in this registry`, ['DI-34', 'DI-10']),
        );
      } else {
        def.block = block;
        if (block.configSchema) {
          for (const sp of validateSchema(block.configSchema, n.config, `${id}.config`)) {
            problems.push(problem('ENG-DEF-CONFIG', 'ERROR', id, `Configuration of ${block.type}@${block.version} at ${sp.path} ${sp.message}`, block.controls));
          }
        }
        const cps: ConfigProblem[] = block.checkConfig ? block.checkConfig(n, n.config, mbr) : [];
        for (const cp of cps) {
          const p = problem(cp.code, cp.severity, id, cp.message, cp.controls);
          if (cp.severity === 'ERROR') problems.push(p);
          else {
            warnings.push(p);
            if (!justified.has(p.key)) problems.push({ ...p, severity: 'ERROR', message: `${p.message}; this warning needs a recorded justification` });
          }
        }
        for (const item of block.handler.computedItems?.(n, mbr) ?? []) def.computedItems.add(item);
      }
      if (!n.signatures.perform && !n.signatures.check) {
        problems.push(problem('ENG-DEF-ZERO-HUMANS', 'ERROR', id, `Step ${id} has neither a performer nor a checker: a step is never verified by zero humans`, ['INV-31', 'PR-14']));
      }
      if (n.signatures.perform) def.performRoles = [n.signatures.perform.role];
      else if (policy.oneVerifierMode) def.systemPerforms = true;
      else {
        const roles = def.stage !== undefined ? [...(stagePerformRoles.get(def.stage) ?? [])].sort() : [];
        def.performRoles = roles.length > 0 ? roles : allPerformRoles;
      }
      if (n.signatures.check) {
        def.checkRole = n.signatures.check.role;
        def.checkMeaning = n.signatures.check.meaning;
      }
    } else {
      if (!n.dispositions.some((d) => RELEASING_DISPOSITIONS.includes(d))) {
        problems.push(problem('ENG-DEF-HOLD', 'ERROR', id, `Hold point ${id} lists no releasing disposition (one of ${RELEASING_DISPOSITIONS.join(', ')})`, ['PR-45']));
      }
      def.performRoles = [n.role];
    }
    steps.set(id, def);
    stepByGraphNode.set(g.id, id);
  }

  // Writers and loop endpoints.
  const writers = new Map<string, string[]>();
  for (const s of steps.values()) {
    for (const item of s.writes) writers.set(item, [...(writers.get(item) ?? []), s.id]);
  }
  const loopEndpoints = new Map<string, string[]>();
  for (const [lid, loop] of bounds.loops) {
    const inside = [...(writers.get(loop.exit.endpoint) ?? [])].some((w) => steps.get(w)?.constructs.includes(lid));
    if (inside) loopEndpoints.set(loop.exit.endpoint, [...(loopEndpoints.get(loop.exit.endpoint) ?? []), lid]);
  }

  // Calculation programs, compiled per writing step (the reader position decides series types).
  const programs = new Map<string, { program: CompiledExpression; derivedInputs: Set<string> }>();
  for (const s of steps.values()) {
    if (s.node.kind !== 'phase') continue;
    const reader = gi.node.get(s.graphNode);
    for (const calcId of s.node.computes) {
      const calc = analysis.calculations.get(calcId);
      if (!calc) {
        problems.push(problem('ENG-DEF-CALC', 'ERROR', s.id, `Step ${s.id} computes ${calcId}, which is not a calculation`, ['INV-25', 'DI-33']));
        continue;
      }
      const checked = analysis.expression(calc.expression, GLOBAL_SCOPE, reader, { role: 'CALCULATION' });
      const declarations: Record<string, InputDeclaration> = {};
      const derivedInputs = new Set<string>();
      for (const r of checked.reads) {
        const t = analysis.typeAt(r, reader);
        if (!t) continue;
        const d = declarationOf(t);
        if ('problem' in d) continue;
        if (analysis.calculations.has(r) && t.kind !== 'SERIES') {
          declarations[r] = { ...d, source: 'DERIVED' };
          derivedInputs.add(r);
        } else declarations[r] = analysis.inputs.get(r)?.source === 'MASTER_DATA' ? { ...d, source: 'MASTER_DATA' } : d;
      }
      const output = outputDeclaration(analysis.declaredType(calcId));
      const c = compile(calc.expression, { name: calcId, inputs: declarations, role: 'calculation', ...(output === undefined ? {} : { output }) });
      if (!c.ok) {
        problems.push(problem('ENG-DEF-CALC', 'ERROR', calcId, `Calculation ${calcId} does not compile: ${c.diagnostics.map((d) => d.message).join('; ')}`, ['DI-33']));
        continue;
      }
      programs.set(`${calcId}@${s.id}`, { program: c.program, derivedInputs });
    }
  }

  // Time constraints: the MBR's list plus implicit hold times of intermediates and loop maximum durations.
  const all: { tc: TimeConstraint; implicit: boolean }[] = mbr.timeConstraints.map((tc) => ({ tc, implicit: false }));
  for (const i of mbr.intermediates) {
    if (!i.holdTime) continue;
    const producers = analysis.phases.filter((p) => p.produces.includes(i.id)).map((p) => p.id);
    const users = analysis.phases.filter((p) => p.uses.includes(i.id)).map((p) => p.id);
    for (const p of producers) {
      for (const u of users) {
        all.push({
          implicit: true,
          tc: {
            id: `HOLD-TIME:${i.id}:${p}>${u}`,
            name: `Hold time of ${i.name}`,
            kind: 'HOLD',
            from: { node: p, event: 'END' },
            to: { node: u, event: 'START' },
            max: i.holdTime.max,
            source: i.holdTime.source,
            breach: 'EXCEPTION_AND_BLOCK',
            pauses: 'INCLUDED',
          },
        });
      }
    }
  }
  for (const [lid, loop] of bounds.loops) {
    if (!loop.maxDuration) continue;
    all.push({
      implicit: true,
      tc: { id: `LOOP-MAX-DURATION:${lid}`, name: `Maximum duration of ${loop.name}`, kind: 'PROCESS_WINDOW', from: { node: lid, event: 'START' }, to: { node: lid, event: 'END' }, max: loop.maxDuration, breach: 'EXCEPTION', pauses: 'INCLUDED' },
    });
  }
  const constraints: RuntimeConstraint[] = [];
  for (const { tc, implicit } of all) {
    // Events outside this record (equipment cleaning end, previous batch) come with Phase 3 persistence.
    if (!isNodeEvent(tc.from) || !isNodeEvent(tc.to)) continue;
    const fc = eventConstructs.get(tc.from.node);
    const tcs = eventConstructs.get(tc.to.node);
    if (!fc || !tcs) {
      problems.push(problem('ENG-DEF-TIME', 'ERROR', tc.id, `Time constraint ${tc.id} names a node that is not in the flow`, ['INV-20']));
      continue;
    }
    const shared: string[] = [];
    for (let i = 0; i < Math.min(fc.length, tcs.length) && fc[i] === tcs[i]; i++) shared.push(fc[i] as string);
    const fromGraph = analysis.graphNodes(tc.from.node);
    const anchor = (fromGraph.find((g) => g.kind === 'TASK' || g.kind === 'HOLD') ?? fromGraph[0]);
    const toGraph = analysis.graphNodes(tc.to.node);
    const toNode = toGraph.find((g) => g.kind === 'TASK' || g.kind === 'HOLD') ?? toGraph[0];
    constraints.push({
      tc,
      implicit,
      shared,
      from: { node: tc.from.node, event: tc.from.event, constructs: fc },
      to: { node: tc.to.node, event: tc.to.event, constructs: tcs },
      anchor: anchor?.id ?? analysis.graph.start,
      toBranches: toNode ? branchesOfRegions(toNode.regions) : [],
    });
  }

  // Every item read anywhere (a step writing one of these can never be skipped).
  const readItems = new Set<string>();
  for (const p of analysis.phases) for (const r of p.reads) readItems.add(r);
  for (const c of mbr.calculations) for (const r of analysis.expression(c.expression, GLOBAL_SCOPE, undefined, { role: 'CALCULATION' }).reads) readItems.add(r);
  for (const alt of alternatives.values()) {
    for (const b of alt.branches) if (b.guard !== undefined) for (const r of analysis.expression(b.guard, alt.id, analysis.graphNodeOf(alt.id, 'XOR_SPLIT'), { role: 'CONDITION' }).reads) readItems.add(r);
  }
  for (const [lid, loop] of bounds.loops) for (const r of analysis.expression(loop.exit.condition, lid, analysis.graphNodeOf(lid, 'LOOP_TEST'), { role: 'CONDITION' }).reads) readItems.add(r);
  for (const [rid, rep] of bounds.replicates) if (rep.count.mode === 'EXPRESSION') for (const r of analysis.expression(rep.count.expression, rid, analysis.graphNodeOf(rid, 'REP_SPLIT'), { role: 'CALCULATION' }).reads) readItems.add(r);
  for (const y of mbr.yieldCheckpoints) {
    readItems.add(y.theoretical);
    readItems.add(y.result);
  }
  for (const sch of mbr.acceptanceSchemes) for (const c of sch.criteria) readItems.add(c.statistic);

  if (problems.length > 0) throw new EngineDefinitionError(problems);
  return {
    mbr,
    contentHash: mbrContentHash(mbr),
    analysis,
    game,
    gi,
    registry: options.registry,
    expr,
    policy,
    steps,
    stepByGraphNode,
    stages,
    loops: new Map(bounds.loops),
    replicates: new Map(bounds.replicates),
    alternatives,
    eventConstructs,
    stageOf,
    constraints,
    writers,
    loopEndpoints,
    programs,
    warnings,
    readItems,
    reach: new Map(),
  };
}

/** Graph nodes reachable from `from` (forward and loop-back edges), excluding `from` unless on a cycle. */
export function reachFrom(def: BatchDefinition, from: string): Set<string> {
  const hit = def.reach.get(from);
  if (hit) return hit;
  const seen = new Set<string>();
  const queue = [...(def.gi.out.get(from) ?? []).map((e) => e.to)];
  while (queue.length > 0) {
    const n = queue.shift() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of def.gi.out.get(n) ?? []) queue.push(e.to);
  }
  def.reach.set(from, seen);
  return seen;
}
