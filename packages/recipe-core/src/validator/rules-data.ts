/**
 * Data gates (outline 6.3 "Data"; ADR 0004 decision 6): references resolve; every value is written
 * before it is read on every path; one writer per value; expressions parse, type- and unit-check;
 * no calculation cycles; branch conditions cover every case and never overlap; parallel branches
 * never write the same value or claim the same equipment or BOM line unsequenced.
 */
import type { ExpressionOptions, ExprType, GuardFormula } from '../flow/expression-port.ts';
import type { GraphNode } from '../flow/graph.ts';
import { childrenOf, isNodeEvent, type FlowNode, type PhaseNode } from '../flow/model.ts';
import { calculationOptions, CONDITION, GLOBAL_SCOPE, type Analysis, type CheckedExpression } from './analysis.ts';
import { analyseGuards, describePoint, type GuardBranch } from './guards.ts';
import { defineRule, error, label, warning, type Rule } from './rule-kit.ts';
import type { RuleFinding } from './types.ts';


/** A replicate count: a derived plain number (converted to a count). */
const COUNT_EXPRESSION: ExpressionOptions = { role: 'CALCULATION', output: { kind: 'COUNT' } };

function phasesIn(node: FlowNode): PhaseNode[] {
  const out: PhaseNode[] = [];
  const visit = (n: FlowNode): void => {
    if (n.kind === 'phase') out.push(n);
    childrenOf(n).forEach(visit);
  };
  visit(node);
  return out;
}

const references = defineRule('DATA-REFERENCES', 'Every id a record refers to exists', ['PR-03', 'DI-04'], (a) => {
  const out: RuleFinding[] = [];
  const ref = (subject: string, id: string | undefined, what: string): void => {
    if (id !== undefined && !a.references.has(id)) out.push(error(subject, `${label(a, subject)} cites ${what} ${id}, which is not in the list of pinned references`));
  };
  for (const p of a.phases) {
    const info = a.nodes.get(p.id);
    const stage = info?.stage ? a.nodes.get(info.stage)?.node : undefined;
    const stageEquipment = stage?.kind === 'stage' ? new Set(stage.binding.equipment.map((e) => e.ref)) : new Set<string>();
    for (const id of p.records) if (!a.parameters.has(id)) out.push(error(p.id, `${label(a, p.id)} records ${id}, which is not a declared parameter`));
    for (const id of p.computes) if (!a.calculations.has(id)) out.push(error(p.id, `${label(a, p.id)} computes ${id}, which is not a declared calculation`));
    for (const id of p.reads) if (!a.data.has(id)) out.push(error(p.id, `${label(a, p.id)} reads ${id}, which is not a declared value`));
    for (const id of p.consumes) if (!a.bom.has(id)) out.push(error(p.id, `${label(a, p.id)} consumes ${id}, which is not a BOM line`));
    for (const id of [...p.produces, ...p.uses]) if (!a.intermediates.has(id)) out.push(error(p.id, `${label(a, p.id)} names intermediate ${id}, which is not declared`));
    for (const e of p.equipment) if (!stageEquipment.has(e.ref)) out.push(error(p.id, `${label(a, p.id)} uses equipment ${e.ref}, which its stage does not bind`));
    if (p.yieldCheckpoint !== undefined && !a.yields.has(p.yieldCheckpoint)) out.push(error(p.id, `${label(a, p.id)} names yield checkpoint ${p.yieldCheckpoint}, which is not declared`));
    if (p.acceptanceScheme !== undefined && !a.schemes.has(p.acceptanceScheme)) out.push(error(p.id, `${label(a, p.id)} names acceptance scheme ${p.acceptanceScheme}, which is not declared`));
    ref(p.id, p.system?.ref, 'computerised system');
  }
  for (const info of a.nodes.values()) {
    if (info.node.kind === 'stage') for (const e of info.node.binding.equipment) ref(info.node.id, e.equipmentClass, 'equipment class');
  }
  for (const x of a.mbr.inputs) ref(x.id, x.ref, 'master data');
  for (const p of a.mbr.parameters) for (const r of p.limits?.ranges ?? []) ref(p.id, r.source.ref, 'limit source');
  for (const c of a.mbr.calculations) for (const r of c.limits?.ranges ?? []) ref(c.id, r.source.ref, 'limit source');
  for (const y of a.mbr.yieldCheckpoints) {
    if (!a.data.has(y.theoretical)) out.push(error(y.id, `Yield checkpoint ${label(a, y.id)} takes its theoretical basis from ${y.theoretical}, which is not a declared value`));
    if (!a.calculations.has(y.result)) out.push(error(y.id, `Yield checkpoint ${label(a, y.id)} names ${y.result} as its result, which is not a declared calculation; yields are computed, never typed`));
    for (const r of y.limits?.ranges ?? []) ref(y.id, r.source.ref, 'limit source');
  }
  for (const s of a.mbr.acceptanceSchemes) {
    for (const c of s.criteria) {
      if (!a.data.has(c.statistic)) out.push(error(s.id, `Criterion ${c.id} of scheme ${s.id} evaluates ${c.statistic}, which is not a declared value`));
      ref(s.id, c.range.source.ref, 'limit source');
    }
  }
  for (const b of a.mbr.bom) {
    ref(b.id, b.material, 'material');
    ref(b.id, b.specimen, 'specimen');
  }
  for (const i of a.mbr.intermediates) ref(i.id, i.holdTime?.source.ref, 'hold-time study');
  for (const t of a.mbr.timeConstraints) {
    for (const e of [t.from, t.to]) if (isNodeEvent(e) && !a.nodes.has(e.node)) out.push(error(t.id, `Time constraint ${label(a, t.id)} refers to step ${e.node}, which does not exist`));
    ref(t.id, t.source?.ref, 'validation source');
  }
  for (const r of a.mbr.riskReductions) {
    for (const s of r.subjects) if (!a.nodes.has(s) && !a.data.has(s)) out.push(error(r.id, `Risk-based reduction ${r.id} applies to ${s}, which is neither a step nor a value`));
    ref(r.id, r.rationale, 'risk assessment');
  }
  ref('$', a.mbr.riskScale.ref, 'risk scale');
  for (const g of a.mbr.goldenCases) {
    for (const id of [...Object.keys(g.inputs), ...Object.keys(g.expected)]) if (!a.data.has(id)) out.push(error(g.id, `Golden case ${g.id} names ${id}, which is not a declared value`));
  }
  return out;
});

function writesOf(n: GraphNode, a: Analysis): string[] {
  const p = a.phaseOf(n);
  return p ? [...p.records, ...p.computes] : [];
}

const writtenBeforeRead = defineRule('DATA-WRITTEN-BEFORE-READ', 'Every value is written before it is read, on every path', ['DI-34', 'DI-04'], (a) => {
  const out: RuleFinding[] = [];
  const avail = a.mustBefore(a.inputs.keys(), (n) => writesOf(n, a));
  if (!avail) return out;
  const missing = (have: ReadonlySet<string>, reads: readonly string[]): string[] => reads.filter((r) => a.data.has(r) && !have.has(r));
  const say = (subject: string, where: string, ids: string[]): void => {
    for (const id of ids) {
      out.push(error(subject, `${where} reads ${label(a, id)} before it is recorded on every path to this point (it may be unrecorded, recorded later, or recorded only in another branch)`));
    }
  };
  for (const [id, have] of avail) {
    const g = a.gi.node.get(id) as GraphNode;
    const info = a.nodes.get(g.source);
    if (g.kind === 'TASK') {
      const p = a.phaseOf(g);
      if (!p) continue;
      const set = new Set([...have, ...p.records]);
      for (const c of p.computes) {
        const calc = a.calculations.get(c);
        if (!calc) continue;
        say(p.id, `Calculation ${label(a, c)} in ${label(a, p.id)}`, missing(set, a.expression(calc.expression, GLOBAL_SCOPE, g, calculationOptions(a, c)).reads));
        set.add(c);
      }
      say(p.id, label(a, p.id), missing(set, p.reads));
      if (p.pat?.acceptance) say(p.id, `The PAT acceptance criteria of ${label(a, p.id)}`, missing(set, a.expression(p.pat.acceptance, p.id, g, CONDITION).reads));
    } else if (g.kind === 'XOR_SPLIT' && info?.node.kind === 'alternative' && info.node.decision.mode === 'DATA') {
      for (const b of info.node.branches) if (b.guard) say(info.node.id, `The condition of branch ${b.id}`, missing(have, a.expression(b.guard, info.node.id, g, CONDITION).reads));
    } else if (g.kind === 'LOOP_TEST' && info?.node.kind === 'loop') {
      say(info.node.id, `The exit condition of loop ${label(a, info.node.id)}`, missing(have, a.expression(info.node.exit.condition, info.node.id, g, CONDITION).reads));
    } else if (g.kind === 'REP_SPLIT' && info?.node.kind === 'replicate' && info.node.count.mode === 'EXPRESSION') {
      say(info.node.id, `The instance count of ${label(a, info.node.id)}`, missing(have, a.expression(info.node.count.expression, info.node.id, g, COUNT_EXPRESSION).reads));
    }
  }
  return out;
});

const singleWriter = defineRule('DATA-SINGLE-WRITER', 'Each value has one writing step', ['DI-04'], (a) => {
  const out: RuleFinding[] = [];
  for (const [id, writers] of a.writers) {
    if (a.inputs.has(id)) out.push(error(id, `${label(a, id)} comes from the batch header or master data, but step ${writers.join(', ')} records it`));
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const w1 = writers[i] as string;
        const w2 = writers[j] as string;
        if (!a.exclusive(w1, w2)) out.push(error(id, `${label(a, id)} is written by both ${label(a, w1)} and ${label(a, w2)}, which can run on the same path; give each its own value`));
      }
    }
  }
  for (const p of a.mbr.parameters) if (!a.writers.has(p.id)) out.push(warning(p.id, `Parameter ${label(a, p.id)} is never recorded by any step`));
  for (const c of a.mbr.calculations) if (!a.writers.has(c.id)) out.push(warning(c.id, `Calculation ${label(a, c.id)} is never computed by any step`));
  return out;
});

function typeName(t: ExprType): string {
  switch (t.kind) {
    case 'DECIMAL':
      return `a decimal in ${t.unit}${t.tag ? ` (${t.tag})` : ''}`;
    case 'SERIES':
      return `a series of ${typeName(t.of)}`;
    default:
      return `a ${t.kind.toLowerCase()}`;
  }
}

const expressions = defineRule('DATA-EXPRESSIONS', 'Expressions parse, type-check and unit-check', ['DI-04', 'DI-33'], (a) => {
  const out: RuleFinding[] = [];
  const seen = new Set<string>();
  const push = (f: RuleFinding): void => {
    const k = `${f.subject}\u0000${f.text}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(f);
    }
  };
  const report = (subject: string, what: string, checked: CheckedExpression): boolean => {
    for (const p of checked.check.problems) push(p.severity === 'ERROR' ? error(subject, `${what}: ${p.message}`) : warning(subject, `${what}: ${p.message}`));
    for (const u of checked.unbound) push(error(subject, `${what} reads ${u}, which the library element does not declare as a bound symbol`));
    return checked.check.ok && checked.unbound.length === 0;
  };
  const expectBoolean = (subject: string, what: string, checked: CheckedExpression): void => {
    if (report(subject, what, checked) && checked.check.type && checked.check.type.kind !== 'BOOLEAN') push(error(subject, `${what} must be true or false, but it gives ${typeName(checked.check.type)}`));
  };
  for (const calc of a.mbr.calculations) {
    const where = (a.writers.get(calc.id) ?? []).map((w) => a.taskOf(w));
    for (const g of where.length > 0 ? where : [undefined]) {
      const checked = a.expression(calc.expression, GLOBAL_SCOPE, g, calculationOptions(a, calc.id));
      const what = `Calculation ${label(a, calc.id)}`;
      if (!report(calc.id, what, checked) || !checked.check.type) continue;
      const t = checked.check.type;
      const o = calc.output;
      if (o.valueType === 'DECIMAL') {
        if (t.kind !== 'DECIMAL') push(error(calc.id, `${what} gives ${typeName(t)}, but it is declared as a decimal in ${o.unit ?? '1'}`));
        else {
          if (a.ctx.expressions.convert('1', t.unit, o.unit ?? '1') === undefined) push(error(calc.id, `${what} gives a value in ${t.unit}, which cannot be expressed in its declared unit ${o.unit ?? '1'}`));
          if (o.semanticTag !== undefined && t.tag !== undefined && o.semanticTag !== t.tag) push(error(calc.id, `${what} gives ${t.tag}, but it is declared as ${o.semanticTag}`));
        }
      } else if (o.valueType !== t.kind) push(error(calc.id, `${what} gives ${typeName(t)}, but it is declared as a ${o.valueType.toLowerCase()}`));
    }
  }
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind === 'alternative' && n.decision.mode === 'DATA') {
      const g = a.graphNodeOf(n.id, 'XOR_SPLIT');
      for (const b of n.branches) if (b.guard) expectBoolean(n.id, `The condition of branch ${b.id} of ${n.id}`, a.expression(b.guard, n.id, g, CONDITION));
    } else if (n.kind === 'loop') {
      expectBoolean(n.id, `The exit condition of loop ${label(a, n.id)}`, a.expression(n.exit.condition, n.id, a.graphNodeOf(n.id, 'LOOP_TEST'), CONDITION));
    } else if (n.kind === 'replicate' && n.count.mode === 'EXPRESSION') {
      const checked = a.expression(n.count.expression, n.id, a.graphNodeOf(n.id, 'REP_SPLIT'), COUNT_EXPRESSION);
      const what = `The instance count of ${label(a, n.id)}`;
      if (report(n.id, what, checked) && checked.check.type) {
        const t = checked.check.type;
        const ok = t.kind === 'COUNT' || (t.kind === 'DECIMAL' && a.ctx.expressions.convert('1', t.unit, '1') !== undefined);
        if (!ok) push(error(n.id, `${what} must be a count, but it gives ${typeName(t)}`));
      }
    } else if (n.kind === 'phase' && n.pat?.acceptance) {
      expectBoolean(n.id, `The PAT acceptance criteria of ${label(a, n.id)}`, a.expression(n.pat.acceptance, n.id, a.taskOf(n.id), CONDITION));
    }
  }
  return out;
});

const calcCycles = defineRule('DATA-CALC-CYCLES', 'No calculation depends on itself', ['DI-04', 'DI-33'], (a) => {
  const out: RuleFinding[] = [];
  const deps = new Map<string, string[]>();
  for (const c of a.mbr.calculations) deps.set(c.id, a.expression(c.expression, GLOBAL_SCOPE, undefined, calculationOptions(a, c.id)).reads.filter((r) => a.calculations.has(r)));
  // Tarjan's strongly connected components.
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (deps.get(v) ?? []).includes(v)) {
        const cycle = comp.sort();
        out.push(error(cycle[0] as string, `Calculations ${cycle.join(', ')} depend on each other in a cycle, so none of them can ever be computed`));
      }
    }
  };
  for (const c of [...deps.keys()].sort()) if (!idx.has(c)) strong(c);
  return out;
});

const guards = defineRule('DATA-GUARDS', 'Branch conditions cover every case and never overlap', ['DI-34'], (a) => {
  const out: RuleFinding[] = [];
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind !== 'alternative' || n.decision.mode !== 'DATA') continue;
    const split = a.graphNodeOf(n.id, 'XOR_SPLIT');
    const env = a.envAt(n.id, split);
    const branches: GuardBranch[] = [];
    let checkable = true;
    for (const b of n.branches) {
      if (b.otherwise === true) {
        branches.push({ id: b.id, formula: undefined });
        continue;
      }
      if (!b.guard) {
        checkable = false;
        continue;
      }
      const checked = a.expression(b.guard, n.id, split, CONDITION);
      if (!checked.check.ok || checked.check.type?.kind !== 'BOOLEAN') {
        checkable = false;
        continue;
      }
      const formula: GuardFormula = a.ctx.expressions.guard(b.guard, env);
      branches.push({ id: b.id, formula });
    }
    if (!checkable) continue;
    const r = analyseGuards(branches, env, a.limits.guardPoints);
    if (!r.decided) {
      out.push(warning(n.id, `It cannot be proven that the conditions of alternative ${n.id} cover every case exactly once (${r.reason ?? 'not decidable'}); justify, or rewrite them as comparisons with constants or add an "otherwise" branch`));
      continue;
    }
    if (r.uncovered) out.push(error(n.id, `No branch of alternative ${n.id} applies when ${describePoint(r.uncovered)}; add a branch or an "otherwise" branch`));
    for (const o of r.overlaps) out.push(error(n.id, `Branches ${o.a} and ${o.b} of alternative ${n.id} both apply when ${describePoint(o.at)}; conditions must never overlap`));
    for (const d of r.dead) out.push(error(n.id, `Branch ${d} of alternative ${n.id} can never be taken`));
  }
  return out;
});

const parallel = defineRule('DATA-PARALLEL', 'Parallel work never writes or claims the same thing unsequenced', ['DI-34'], (a) => {
  const out: RuleFinding[] = [];
  const claims = (p: PhaseNode): { writes: string[]; equipment: string[]; bom: string[] } => {
    const info = a.nodes.get(p.id);
    const stage = info?.stage ? a.nodes.get(info.stage)?.node : undefined;
    const kinds = new Map(stage?.kind === 'stage' ? stage.binding.equipment.map((e) => [e.ref, e.kind]) : []);
    return {
      writes: [...p.records, ...p.computes],
      equipment: p.equipment.filter((e) => e.use === 'USE' && kinds.get(e.ref) === 'PROCESS').map((e) => `${info?.stage ?? '?'}:${e.ref}`),
      bom: [...p.consumes],
    };
  };
  for (const info of a.nodes.values()) {
    const n = info.node;
    if (n.kind === 'parallel') {
      const sets = n.branches.map((b) => {
        const ps = phasesIn(b.body).map(claims);
        return { id: b.id, writes: new Set(ps.flatMap((c) => c.writes)), equipment: new Set(ps.flatMap((c) => c.equipment)), bom: new Set(ps.flatMap((c) => c.bom)) };
      });
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const x = sets[i] as (typeof sets)[number];
          const y = sets[j] as (typeof sets)[number];
          for (const w of x.writes) if (y.writes.has(w)) out.push(error(n.id, `Parallel branches ${x.id} and ${y.id} of ${n.id} both write ${label(a, w)}`));
          for (const e of x.equipment) if (y.equipment.has(e)) out.push(error(n.id, `Parallel branches ${x.id} and ${y.id} of ${n.id} both use equipment ${e.split(':')[1] ?? e} at the same time`));
          for (const b of x.bom) if (y.bom.has(b)) out.push(error(n.id, `Parallel branches ${x.id} and ${y.id} of ${n.id} both consume BOM line ${b}`));
        }
      }
    } else if (n.kind === 'replicate' && n.instances === 'CONCURRENT') {
      for (const p of phasesIn(n.body)) {
        for (const e of claims(p).equipment) {
          out.push(error(n.id, `Instances of ${label(a, n.id)} run concurrently, but ${label(a, p.id)} uses process equipment ${e.split(':')[1] ?? e}; make the section sequential or give each instance its own equipment`));
        }
      }
    }
  }
  return out;
});

const units = defineRule('DATA-UNITS', 'Units are valid and limits are in commensurable units', ['PR-08', 'PR-03'], (a) => {
  const out: RuleFinding[] = [];
  const valid = (subject: string, unit: string | undefined, what: string): boolean => {
    if (unit === undefined) return false;
    const u = a.ctx.expressions.unit(unit);
    if (!u.ok) out.push(error(subject, `${what} has an invalid unit ${JSON.stringify(unit)}: ${u.message}`));
    return u.ok;
  };
  const commensurable = (subject: string, from: string, to: string, what: string): void => {
    if (a.ctx.expressions.convert('1', from, to) === undefined) out.push(error(subject, `${what}: ${from} cannot be converted to ${to}`));
  };
  for (const p of a.mbr.parameters) {
    if (p.valueType === 'DECIMAL' && valid(p.id, p.unit, `Parameter ${label(a, p.id)}`) && p.limits && valid(p.id, p.limits.unit, `The limits of ${label(a, p.id)}`)) {
      commensurable(p.id, p.limits.unit, p.unit as string, `The limits of ${label(a, p.id)} are in another dimension than the parameter`);
    }
  }
  for (const c of a.mbr.calculations) {
    if (c.output.valueType === 'DECIMAL' && valid(c.id, c.output.unit ?? '1', `Calculation ${label(a, c.id)}`) && c.limits && valid(c.id, c.limits.unit, `The limits of ${label(a, c.id)}`)) {
      commensurable(c.id, c.limits.unit, c.output.unit ?? '1', `The limits of ${label(a, c.id)} are in another dimension than the result`);
    }
  }
  for (const y of a.mbr.yieldCheckpoints) {
    const result = a.calculations.get(y.result);
    if (y.limits && valid(y.id, y.limits.unit, `The limits of yield checkpoint ${label(a, y.id)}`) && result?.output.valueType === 'DECIMAL') {
      commensurable(y.id, y.limits.unit, result.output.unit ?? '1', `The limits of yield checkpoint ${label(a, y.id)} do not match its result`);
    }
  }
  for (const s of a.mbr.acceptanceSchemes) {
    for (const c of s.criteria) {
      if (!valid(s.id, c.unit, `Criterion ${c.id} of acceptance scheme ${s.id}`)) continue;
      const t = a.declaredType(c.statistic);
      const unit = t?.kind === 'DECIMAL' ? t.unit : undefined;
      if (unit !== undefined) commensurable(s.id, c.unit, unit, `Criterion ${c.id} of ${s.id} is in another dimension than ${c.statistic}`);
    }
  }
  for (const b of a.mbr.bom) valid(b.id, b.quantity.unit, `BOM line ${b.id}`);
  for (const b of a.mbr.header.batchSizes) valid(b.id, b.quantity.unit, `Batch size ${b.id}`);
  for (const i of a.mbr.inputs) if (i.valueType === 'DECIMAL') valid(i.id, i.unit, `Input ${label(a, i.id)}`);
  return out;
});

export const DATA_RULES: readonly Rule[] = [references, writtenBeforeRead, singleWriter, expressions, calcCycles, guards, parallel, units];
