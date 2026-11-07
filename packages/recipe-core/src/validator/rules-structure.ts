/**
 * Structure gates (outline 6.3 "Structure"; ADR 0004 decisions 2 and 6; DI-34, INV-19).
 * Tree rules check the ISA-88 levels and each construct's own contract; graph rules check the
 * compiled execution graph (graph-checks.ts).
 */
import { childrenOf, type FlowNode, type Level } from '../flow/model.ts';
import { isTimeUnit, durationToMicros, compareDecimal } from '../flow/decimal.ts';
import { calculationOptions, CONDITION, GLOBAL_SCOPE, type Analysis } from './analysis.ts';
import { checkGraph, type GraphProblem, type GraphProblemCode } from './graph-checks.ts';
import { defineRule, error, label, warning, type Rule } from './rule-kit.ts';
import type { RuleFinding } from './types.ts';

const SEQ = ['DI-34'];

function hasStep(node: FlowNode): boolean {
  if (node.kind === 'phase' || node.kind === 'holdPoint' || node.kind === 'libraryCall') return true;
  return childrenOf(node).some(hasStep);
}

const idsUnique = defineRule('FLOW-ID-UNIQUE', 'Every id is unique', SEQ, (a) => {
  const out: RuleFinding[] = [];
  for (const id of new Set(a.duplicateNodeIds)) out.push(error(id, `Two steps or constructs share the id ${id}; every node needs its own id`));
  const lists: [string, readonly { id: string }[]][] = [
    ['parameter', a.mbr.parameters],
    ['calculation', a.mbr.calculations],
    ['input', a.mbr.inputs],
    ['BOM line', a.mbr.bom],
    ['intermediate', a.mbr.intermediates],
    ['yield checkpoint', a.mbr.yieldCheckpoints],
    ['acceptance scheme', a.mbr.acceptanceSchemes],
    ['time constraint', a.mbr.timeConstraints],
    ['risk-based reduction', a.mbr.riskReductions],
    ['reference', a.mbr.references],
    ['golden case', a.mbr.goldenCases],
    ['batch size', a.mbr.header.batchSizes],
    ['variant', a.mbr.header.variants],
  ];
  for (const [what, list] of lists) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) out.push(error(item.id, `The ${what} id ${item.id} is used twice`));
      seen.add(item.id);
    }
  }
  const dataSeen = new Map<string, string>();
  for (const [what, list] of [
    ['input', a.mbr.inputs],
    ['parameter', a.mbr.parameters],
    ['calculation', a.mbr.calculations],
  ] as const) {
    for (const item of list) {
      const prev = dataSeen.get(item.id);
      if (prev && prev !== what) out.push(error(item.id, `${item.id} names both a ${prev} and a ${what}; expressions could not tell them apart`));
      dataSeen.set(item.id, what);
    }
  }
  const librarySeen = new Set<string>();
  for (const e of a.mbr.library) {
    if (librarySeen.has(e.ref)) out.push(error(e.ref, `Library element ${e.ref} is embedded twice`));
    librarySeen.add(e.ref);
  }
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind === 'parallel' || n.kind === 'alternative') {
      const branchIds = new Set<string>();
      for (const b of n.branches) {
        if (branchIds.has(b.id)) out.push(error(n.id, `${label(a, n.id)} has two branches with the id ${b.id}`));
        branchIds.add(b.id);
      }
    }
  }
  return out;
});

// ADR 0004 decision 1 (amended 7 November 2026, R-flow): the operation level is optional. A phase may sit in an
// operation or directly in a stage; the engine, the graph, the numbering and the database need an enclosing stage,
// not an operation. Kept, for the engine and the record: a stage only at the procedure level (a stage is the unit a
// room, line or train is bound to and its yield is taken in), no stage in a stage, and no step outside a stage.
const PLACEMENT: Record<string, Level[]> = {
  stage: ['PROCEDURE'],
  operation: ['STAGE'],
  phase: ['STAGE', 'OPERATION'],
};

const levels = defineRule('FLOW-LEVELS', 'Procedure -> stage -> (operation ->) phase', SEQ, (a) => {
  const out: RuleFinding[] = [];
  const where: Record<Level, string> = { PROCEDURE: 'directly in the procedure', STAGE: 'directly in a stage', OPERATION: 'inside an operation' };
  for (const info of a.nodes.values()) {
    const allowed = PLACEMENT[info.node.kind];
    if (allowed && !allowed.includes(info.level)) {
      const need = info.node.kind === 'stage' ? 'the procedure level' : info.node.kind === 'operation' ? 'a stage' : 'a stage or an operation of a stage';
      out.push(error(info.node.id, `${label(a, info.node.id)} is a ${info.node.kind} placed ${where[info.level]}; a ${info.node.kind} belongs in ${need} (ISA-88 procedure -> stage -> operation -> phase)`));
    }
    // An empty stage is an error: it would be bound and opened with nothing to record. An empty operation is only a
    // grouping with nothing in it, so it warns.
    if (info.node.kind === 'stage' && !hasStep(info.node.body)) out.push(error(info.node.id, `${label(a, info.node.id)} contains no step`));
    if (info.node.kind === 'operation' && !hasStep(info.node.body)) out.push(warning(info.node.id, `${label(a, info.node.id)} contains no step`));
  }
  const stages = [...a.nodes.values()].filter((i) => i.node.kind === 'stage').length;
  if (stages === 0) out.push(error('$', 'The procedure has no stage; every step runs inside a stage bound to a room, line or equipment train'));
  return out;
});

const constructs = defineRule('FLOW-CONSTRUCTS', 'Every construct is well formed', SEQ, (a) => {
  const out: RuleFinding[] = [];
  const failedCalls = new Set(a.expanded.problems.map((p) => p.nodeId));
  for (const info of a.nodes.values()) {
    const n = info.node;
    switch (n.kind) {
      case 'sequence':
        if (n.children.length === 0 && !failedCalls.has(n.id)) out.push(error(n.id, `Sequence ${n.id} is empty`));
        break;
      case 'parallel':
        if (n.branches.length < 2) out.push(error(n.id, `Parallel ${n.id} needs at least two branches`));
        for (const b of n.branches) if (!hasStep(b.body)) out.push(error(n.id, `Branch ${b.id} of parallel ${n.id} contains no step`));
        break;
      case 'alternative': {
        if (n.branches.length < 2) out.push(error(n.id, `Alternative ${n.id} needs at least two branches`));
        const empty = n.branches.filter((b) => !b.body || !hasStep(b.body));
        if (empty.length > 1) out.push(error(n.id, `Alternative ${n.id} has ${empty.length} empty branches; at most one "no action" branch is allowed`));
        break;
      }
      case 'loop':
        if (!hasStep(n.body)) out.push(error(n.id, `Loop ${label(a, n.id)} contains no step`));
        break;
      case 'replicate':
        if (!hasStep(n.body)) out.push(error(n.id, `Replicate section ${label(a, n.id)} contains no step`));
        break;
      case 'holdPoint':
        if (n.dispositions.length === 0) out.push(error(n.id, `Hold point ${label(a, n.id)} lists no disposition the ${n.role} can sign`));
        break;
      default:
        break;
    }
  }
  return out;
});

const library = defineRule('FLOW-LIBRARY', 'Library calls use pinned, intact element versions', ['DI-34', 'DI-04'], (a) =>
  a.expanded.problems.map((p) => error(p.nodeId, p.message)),
);

const blocks = defineRule('FLOW-BLOCKS', 'Every phase is a registered block version', ['DI-04'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const d = a.ctx.blocks.describe(p.block.type);
    if (!d) out.push(error(p.id, `${label(a, p.id)} uses block type ${p.block.type}, which is not registered`));
    else if (!d.versions.includes(p.block.version)) out.push(error(p.id, `${label(a, p.id)} uses ${p.block.type} version ${p.block.version}, which is not a registered (non-retired) version`));
    else if (!d.phase.allowed) out.push(error(p.id, `${label(a, p.id)} uses ${p.block.type} (${d.title}) as a step; ${d.phase.reason}`));
    else if (d.edition !== 'generic' && d.edition !== a.mbr.header.edition) out.push(error(p.id, `${label(a, p.id)} uses the ${d.edition} block ${p.block.type} in a ${a.mbr.header.edition} MBR`));
  }
  return out;
});

const loops = defineRule('FLOW-LOOPS', 'Loops are bounded and exit on a process endpoint written inside', ['DI-34', 'INV-19'], (a) => {
  const out: RuleFinding[] = [];
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind !== 'loop') continue;
    if (!Number.isSafeInteger(n.maxIterations) || n.maxIterations < 1) out.push(error(n.id, `Loop ${label(a, n.id)} has no valid maximum number of iterations`));
    if (n.maxDuration) {
      if (!isTimeUnit(n.maxDuration.unit)) out.push(error(n.id, `The maximum duration of loop ${label(a, n.id)} is not a time (${n.maxDuration.unit})`));
      else if (durationToMicros(n.maxDuration.value, n.maxDuration.unit) === undefined || compareDecimal(n.maxDuration.value, '0') <= 0) {
        out.push(error(n.id, `The maximum duration of loop ${label(a, n.id)} must be positive and a whole number of microseconds`));
      }
    }
    const endpoint = a.parameters.get(n.exit.endpoint);
    if (!endpoint) {
      out.push(error(n.id, `Loop ${label(a, n.id)} exits on ${n.exit.endpoint}, which is not a declared parameter`));
      continue;
    }
    if (endpoint.role !== 'PROCESS_ENDPOINT') {
      const what = endpoint.role === 'ACCEPTANCE_TEST' || endpoint.role === 'RELEASE_TEST' ? 'an acceptance or release test' : `a ${endpoint.role.toLowerCase().replace('_', ' ')}`;
      out.push(
        error(
          n.id,
          `Loop ${label(a, n.id)} would repeat until ${endpoint.name} passes, but ${endpoint.name} is ${what}; a loop may only repeat on a process endpoint (LOD, pH, weight gain). Repeating a test until it passes is refused: a failure goes to investigation and any rework is a separately approved reprocessing procedure`,
        ),
      );
    }
    // D12 (decision D12.1): a loop inside a loop on the same endpoint. The inner exit judges the endpoint's last
    // reading; the outer exit would judge that reading again (engine data.ts raiseForEvaluationAtExit) and, outside its
    // limits, raise a second limit breach, and the database refuses that exit row either way (recipe-core 0303, 0305).
    for (const outerId of info.ancestors) {
      const outer = a.nodes.get(outerId)?.node;
      if (outer?.kind !== 'loop' || outer.exit.endpoint !== n.exit.endpoint) continue;
      const ep = label(a, endpoint.id);
      out.push(
        error(
          n.id,
          `Loop ${label(a, n.id)} lies inside loop ${label(a, outer.id)}, and both exit on ${ep}. The inner loop's exit judges the last reading of ${ep} against its limits; the outer loop's exit would judge that same reading again, and raise a second limit breach for it when it is outside them, which the database refuses, so the batch would stop at the outer loop's exit. Give the outer loop an endpoint of its own, recorded inside it, or keep only one of the two loops`,
        ),
      );
    }
    const bodyPhases = new Set<string>();
    const collect = (x: FlowNode): void => {
      if (x.kind === 'phase') bodyPhases.add(x.id);
      childrenOf(x).forEach(collect);
    };
    collect(n.body);
    const writers = a.writers.get(endpoint.id) ?? [];
    if (!writers.some((w) => bodyPhases.has(w))) {
      out.push(error(n.id, `The exit condition of loop ${label(a, n.id)} reads ${endpoint.name}, but no step inside the loop records it, so the loop could never see a new value`));
    }
    const test = a.graphNodeOf(n.id, 'LOOP_TEST');
    const checked = a.expression(n.exit.condition, n.id, test, CONDITION);
    if (checked.check.ok && !checked.reads.includes(endpoint.id)) {
      out.push(error(n.id, `The exit condition of loop ${label(a, n.id)} does not read its endpoint ${endpoint.name}`));
    }
    // No test result may drive the loop, not even through a calculation.
    for (const t of testsBehind(a, checked.reads)) {
      if (t === endpoint.id) continue;
      const p = a.parameters.get(t);
      out.push(error(n.id, `The exit condition of loop ${label(a, n.id)} depends on ${p?.name ?? t}, an acceptance or release test; a loop may only repeat on process endpoints, never until a test passes`));
    }
  }
  return out;
});

/** Acceptance and release test parameters an expression depends on, directly or through calculations. */
function testsBehind(a: Analysis, reads: readonly string[]): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = a.parameters.get(id);
    if (p && (p.role === 'ACCEPTANCE_TEST' || p.role === 'RELEASE_TEST')) found.add(id);
    const c = a.calculations.get(id);
    if (c) for (const r of a.expression(c.expression, GLOBAL_SCOPE, undefined, calculationOptions(a, c.id)).reads) visit(r);
  };
  reads.forEach(visit);
  return [...found].sort();
}

const replicates = defineRule('FLOW-REPLICATES', 'Replicate sections are bounded', ['DI-34', 'INV-19'], (a) => {
  const out: RuleFinding[] = [];
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind !== 'replicate') continue;
    if (n.count.min > n.count.max) out.push(error(n.id, `Replicate section ${label(a, n.id)} has a minimum count (${n.count.min}) above its maximum (${n.count.max})`));
  }
  return out;
});

const decisions = defineRule('FLOW-DECISIONS', 'Alternatives say how the branch is decided', SEQ, (a) => {
  const out: RuleFinding[] = [];
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind !== 'alternative') continue;
    const d = n.decision;
    if (d.mode === 'DATA') {
      const otherwise = n.branches.filter((b) => b.otherwise === true);
      if (otherwise.length > 1) out.push(error(n.id, `Alternative ${n.id} has more than one "otherwise" branch`));
      for (const b of n.branches) {
        if (b.variantValues) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} lists variant values, but the branch is decided by recorded data`));
        if (b.otherwise === true && b.guard !== undefined) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} has both a condition and "otherwise"`));
        if (b.otherwise !== true && b.guard === undefined) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} has no condition; every branch decided by data needs one (or is the single "otherwise" branch)`));
      }
    } else if (d.mode === 'OPERATOR_CHOICE') {
      if (d.roles.length === 0) out.push(error(n.id, `Alternative ${n.id} is an operator choice but names no role allowed to choose`));
      for (const b of n.branches) {
        if (b.guard !== undefined || b.otherwise !== undefined || b.variantValues) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} carries a condition, but the operator chooses (with a reason)`));
      }
    } else {
      const variant = a.mbr.header.variants.find((v) => v.id === d.variant);
      if (!variant) {
        out.push(error(n.id, `Alternative ${n.id} is decided at issue by variant ${d.variant}, which the header does not declare`));
        continue;
      }
      const seen = new Map<string, string>();
      for (const b of n.branches) {
        if (b.guard !== undefined || b.otherwise !== undefined) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} carries a condition, but the branch is fixed at issue by variant ${variant.id}`));
        if (!b.variantValues || b.variantValues.length === 0) {
          out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} lists no value of variant ${variant.id}`));
          continue;
        }
        for (const v of b.variantValues) {
          if (!variant.values.includes(v)) out.push(error(n.id, `Branch ${b.id} of alternative ${n.id} names ${JSON.stringify(v)}, which is not a value of variant ${variant.id}`));
          const other = seen.get(v);
          if (other) out.push(error(n.id, `Variant value ${JSON.stringify(v)} selects both branch ${other} and branch ${b.id} of alternative ${n.id}`));
          seen.set(v, b.id);
        }
      }
      for (const v of variant.values) if (!seen.has(v)) out.push(error(n.id, `No branch of alternative ${n.id} applies when variant ${variant.id} is ${JSON.stringify(v)}`));
    }
  }
  return out;
});

/**
 * Every role the master names is an engine role of the installation (review F49; INV-26): who performs and checks a
 * step, who releases a hold point, who signs off a stage and who may choose a branch. A role outside the vocabulary
 * (a kernel role such as QA_SHOP_FLOOR, a typing error) is one no session ever carries, so the step could never be
 * done. Fails closed when the installation's vocabulary is not supplied. The database refuses such content too
 * (recipe-core 0324, EBMR-RCP-123).
 */
const roles = defineRule('FLOW-ROLES', 'Every role is an engine role of the installation', ['INV-26', 'PR-14', 'PR-45'], (a) => {
  const vocabulary = a.ctx.roles?.engineRoles;
  if (!vocabulary) return [error('$', 'The engine roles of this installation were not supplied, so the roles this master names cannot be checked')];
  const known = new Set(vocabulary);
  const out: RuleFinding[] = [];
  const check = (subject: string, role: string, what: string): void => {
    if (!known.has(role)) out.push(error(subject, `${what} is ${JSON.stringify(role)}, which is not an engine role of this installation (${vocabulary.join(', ')}); no person could ever act there`));
  };
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind === 'phase') {
      if (n.signatures.perform) check(n.id, n.signatures.perform.role, `The performer of ${label(a, n.id)}`);
      if (n.signatures.check) check(n.id, n.signatures.check.role, `The checker of ${label(a, n.id)}`);
    } else if (n.kind === 'holdPoint') check(n.id, n.role, `The releaser of hold point ${label(a, n.id)}`);
    else if (n.kind === 'stage') check(n.id, n.responsibleRole, `The person responsible for stage ${label(a, n.id)}`);
    else if (n.kind === 'alternative' && n.decision.mode === 'OPERATOR_CHOICE') for (const r of n.decision.roles) check(n.id, r, `A role allowed to choose a branch of ${n.id}`);
  }
  return out;
});

// ---------------------------------------------------------------------------------------------
// Graph gates

const GRAPH_RULES: { id: string; title: string; codes: GraphProblemCode[] }[] = [
  { id: 'GRAPH-START-END', title: 'One start and one end', codes: ['START_END'] },
  { id: 'GRAPH-REACHABLE', title: 'Every step can be reached', codes: ['UNREACHABLE'] },
  { id: 'GRAPH-TERMINATES', title: 'Every step can finish and reach the end', codes: ['NO_COMPLETION'] },
  { id: 'GRAPH-DECLARED-CYCLES', title: 'Only declared loops repeat', codes: ['UNDECLARED_CYCLE', 'BAD_BACK_EDGE'] },
  { id: 'GRAPH-MATCHED', title: 'Splits and joins are matched', codes: ['UNMATCHED', 'NOT_ENCLOSED', 'DEGREE', 'JOIN_RULE', 'DUPLICATE_ID', 'DANGLING_EDGE'] },
  { id: 'GRAPH-BOUNDARIES', title: 'No path crosses a parallel, loop or replicate boundary', codes: ['CROSSING'] },
];

const graphCache = new WeakMap<Analysis, GraphProblem[]>();
function graphProblems(a: Analysis): GraphProblem[] {
  let p = graphCache.get(a);
  if (!p) {
    p = checkGraph(a.graph);
    graphCache.set(a, p);
  }
  return p;
}

/** Rule id for a graph problem code (used by `validateGraph` too). */
export function graphRuleFor(code: GraphProblemCode): string {
  return (GRAPH_RULES.find((r) => r.codes.includes(code)) as { id: string }).id;
}

const graphRules: Rule[] = GRAPH_RULES.map((r) =>
  defineRule(r.id, r.title, SEQ, (a) =>
    graphProblems(a)
      .filter((p) => r.codes.includes(p.code))
      .map((p) => error(p.node ? (a.gi.node.get(p.node)?.source ?? p.node) : (p.edge ?? '$'), p.message)),
  ),
);

export const STRUCTURE_RULES: readonly Rule[] = [idsUnique, levels, constructs, library, blocks, loops, replicates, decisions, roles, ...graphRules];
