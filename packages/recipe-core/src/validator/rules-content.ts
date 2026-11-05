/**
 * Generic GMP content gates (outline 6.3 "GMP content"; PR-03 content completeness, PR-08 limits,
 * IN-02 risk-based reductions, DI-04 computerised systems and PAT, INV-34 hold times, timers and
 * yields). Edition rule sets add their own content rules through the registry.
 */
import { computedItemsOf } from '../blocks/generic/material.ts';
import { DEFAULT_POLICY } from '../engine/types.ts';
import { CAPTURE_WORDS, CHECK_PERMISSIONS, capturedOtherwise, checkersInRun, checkRunsAsWitness, type CheckersInRun } from '../flow/check-in-release.ts';
import { compareDecimal } from '../flow/decimal.ts';
import { isCapsuleForm } from '../flow/dosage-form.ts';
import type { GraphNode } from '../flow/graph.ts';
import { childrenOf, isNodeEvent, type FlowNode, type PhaseNode, type ReferenceKind, type StageNode } from '../flow/model.ts';
import { samplingShortfalls } from '../limits/all-apply.ts';
import type { LimitSourceKind, LimitSpec } from '../limits/model.ts';
import { checkLimitSpec, checkNestingAfterRounding } from '../limits/nesting.ts';
import type { Analysis } from './analysis.ts';
import { defineRule, error, label, warning, type Rule } from './rule-kit.ts';
import type { RuleFinding } from './types.ts';

function phasesIn(node: FlowNode): PhaseNode[] {
  const out: PhaseNode[] = [];
  const visit = (n: FlowNode): void => {
    if (n.kind === 'phase') out.push(n);
    childrenOf(n).forEach(visit);
  };
  visit(node);
  return out;
}

function stages(a: Analysis): StageNode[] {
  return [...a.nodes.values()].map((i) => i.node).filter((n): n is StageNode => n.kind === 'stage');
}

/** A phase records a critical value typed in by hand with no photo or printout behind it. */
function criticalManualWithoutEvidence(a: Analysis, p: PhaseNode): string[] {
  return p.records.filter((id) => {
    const par = a.parameters.get(id);
    return par !== undefined && par.criticality === 'CRITICAL' && par.capture === 'MANUAL' && (par.evidence === undefined || par.evidence === 'NONE');
  });
}

function reducedBy(a: Analysis, kind: string, subject: string): boolean {
  return a.mbr.riskReductions.some((r) => r.kind === kind && r.subjects.includes(subject));
}

const header = defineRule('GMP-HEADER', 'Header, market set and batch sizes', ['PR-03', 'INV-28'], (a) => {
  const out: RuleFinding[] = [];
  const h = a.mbr.header;
  if (!h.marketSet.includes('IN')) out.push(error('$', 'The market set must include India (IN): every batch is made under an Indian licence, so Revised Schedule M always applies'));
  if (new Set(h.marketSet).size !== h.marketSet.length) out.push(error('$', 'A market appears twice in the market set'));
  if (h.batchSizes.length === 0) out.push(error('$', 'The MBR lists no approved batch size'));
  for (const v of h.variants) {
    if (v.values.length < 2) out.push(error(v.id, `Variant ${v.id} needs at least two values`));
    if (new Set(v.values).size !== v.values.length) out.push(error(v.id, `Variant ${v.id} lists a value twice`));
  }
  return out;
});

const typedFields = defineRule('GMP-TYPED-FIELDS', 'Every data-entry point is a typed field', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.mbr.parameters) {
    const name = `Parameter ${label(a, p.id)}`;
    if ((p.valueType === 'DECIMAL' || p.valueType === 'COUNT') && !p.precision) out.push(error(p.id, `${name} has no precision (number of decimals or significant figures)`));
    if (p.valueType === 'DECIMAL' && !p.unit) out.push(error(p.id, `${name} has no unit`));
    if (p.valueType !== 'DECIMAL' && p.unit !== undefined) out.push(error(p.id, `${name} is not a decimal but has a unit`));
    if (p.valueType === 'CATEGORY' && (!p.categories || p.categories.length < 2 || new Set(p.categories).size !== p.categories.length)) {
      out.push(error(p.id, `${name} is a choice but lists fewer than two distinct values`));
    }
    if (p.valueType === 'TEXT' && p.criticality === 'CRITICAL') out.push(error(p.id, `${name} is critical but free text; critical data must be typed (unit, precision, range or list)`));
  }
  return out;
});

const LIMIT_ROLES = new Set(['PROCESS_PARAMETER', 'IPC', 'PROCESS_ENDPOINT', 'ACCEPTANCE_TEST', 'RELEASE_TEST']);

const criticalParameters = defineRule('GMP-CRITICAL-PARAMETERS', 'Critical parameters and IPCs are complete', ['PR-03', 'PR-08', 'DI-30'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.mbr.parameters) {
    const name = `Parameter ${label(a, p.id)}`;
    const numeric = p.valueType === 'DECIMAL' || p.valueType === 'COUNT';
    // Numeric IPCs always need limits; categorical IPCs are typed by their list of values (GMP-TYPED-FIELDS).
    const needsLimits = numeric && (p.role === 'IPC' || (p.criticality === 'CRITICAL' && LIMIT_ROLES.has(p.role)));
    if (needsLimits && (!p.limits || p.limits.ranges.length === 0)) {
      out.push(error(p.id, `${name} is ${p.role === 'IPC' ? 'an in-process control' : 'a critical parameter'} but has no limits; every CPP and IPC needs limits with their source`));
    }
    if (p.criticality === 'CRITICAL' && p.capture === 'MANUAL' && !p.accuracyCheck) {
      out.push(error(p.id, `${name} is critical and entered by hand, but no accuracy check (second person or validated device) is defined`));
    }
  }
  return out;
});

const EXPECTED_REF_KIND: Record<LimitSourceKind, ReferenceKind[]> = {
  REGISTRATION: ['REGISTRATION'],
  VALIDATION_REPORT: ['VALIDATION_REPORT'],
  PHARMACOPOEIA: ['PHARMACOPOEIA', 'RULE_SET'],
  PROCESS_DATA: ['DOCUMENT', 'VALIDATION_REPORT'],
  HOLD_STUDY: ['HOLD_STUDY'],
  RULE_TABLE: ['RULE_SET'],
  COMPANY_STANDARD: ['SOP', 'DOCUMENT'],
};

function limitFindings(a: Analysis, subject: string, what: string, spec: LimitSpec): RuleFinding[] {
  const out: RuleFinding[] = [];
  const shape = checkLimitSpec(spec);
  for (const p of shape) out.push(error(subject, `${what}: ${p.message}`));
  if (shape.length === 0) for (const p of checkNestingAfterRounding(spec, a.ctx.expressions)) out.push(error(subject, `${what}: ${p.message}`));
  for (const r of spec.ranges) {
    const tier = r.tier.toLowerCase().replace('_', ' ');
    if (r.tier === 'REGISTERED' && r.source.kind !== 'REGISTRATION' && r.source.kind !== 'PHARMACOPOEIA') {
      out.push(error(subject, `${what}: the registered limit must cite the registration or the pharmacopoeia, not ${r.source.kind.toLowerCase().replace('_', ' ')}`));
    }
    if (r.tier === 'VALIDATED' && r.source.kind !== 'VALIDATION_REPORT') out.push(error(subject, `${what}: the validated range must cite a validation report`));
    if (r.source.kind === 'PHARMACOPOEIA' && !r.pharmacopoeia) out.push(error(subject, `${what}: the ${tier} range comes from a pharmacopoeia but does not name the pharmacopoeia and edition`));
    const ref = a.references.get(r.source.ref);
    if (ref && !EXPECTED_REF_KIND[r.source.kind].includes(ref.kind)) {
      out.push(error(subject, `${what}: the ${tier} range cites ${r.source.ref} as ${r.source.kind.toLowerCase().replace('_', ' ')}, but that reference is a ${ref.kind.toLowerCase().replace('_', ' ')}`));
    }
  }
  return out;
}

const limitNesting = defineRule('GMP-LIMITS', 'Limit tiers are nested and sourced', ['PR-08', 'PR-03'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.mbr.parameters) if (p.limits) out.push(...limitFindings(a, p.id, `Limits of ${label(a, p.id)}`, p.limits));
  for (const c of a.mbr.calculations) if (c.limits) out.push(...limitFindings(a, c.id, `Limits of ${label(a, c.id)}`, c.limits));
  for (const y of a.mbr.yieldCheckpoints) if (y.limits) out.push(...limitFindings(a, y.id, `Limits of yield checkpoint ${label(a, y.id)}`, y.limits));
  return out;
});

const significantSteps = defineRule('GMP-SIGNIFICANT-STEPS', 'Performer plus checker on significant steps', ['PR-03', 'IN-02'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const d = a.describe(p);
    if (!d) continue;
    const automated = d.roles.includes('AUTOMATED_PHASE');
    const clearance = d.roles.includes('CLEARANCE');
    // Critical data typed by hand always needs a second person (PR-14; outline 7.2 S5), with or without a photo.
    const criticalManual = p.records.some((id) => a.parameters.get(id)?.criticality === 'CRITICAL' && a.parameters.get(id)?.capture === 'MANUAL');
    const significant = d.significant || p.significant || criticalManual;
    const name = label(a, p.id);
    if (!p.signatures.perform) {
      if (!automated) out.push(error(p.id, `${name} has no performer signature`));
      else if (!p.signatures.check) out.push(error(p.id, `${name} is automated but no person checks it; at least one human verifier is always required`));
      else if (!reducedBy(a, 'ONE_VERIFIER', p.id)) {
        out.push(error(p.id, `${name} is checked by one person only (one-verifier mode, S5a); that is a risk-based reduction and needs a declared reduction with a risk class and rationale`));
      }
    }
    if (significant && !p.signatures.check) {
      if (clearance) {
        if (!reducedBy(a, 'NO_SECOND_PERSON_CLEARANCE', p.id)) out.push(error(p.id, `${name} is a line clearance without a second person; that is a risk-based reduction (S24) and needs a declared reduction with a risk class and rationale`));
      } else {
        out.push(error(p.id, `${name} is a significant step (${d.significant ? d.title.toLowerCase() : criticalManual ? 'critical data entered by hand' : 'marked significant'}) and needs a checker who is not the performer`));
      }
    }
  }
  return out;
});

const witnessed = defineRule('GMP-WITNESS', 'WITNESSED where a critical value has no objective evidence', ['PR-03', 'DI-30'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const ids = criticalManualWithoutEvidence(a, p);
    if (ids.length > 0 && p.signatures.check && p.signatures.check.meaning !== 'WITNESSED') {
      out.push(error(p.id, `${label(a, p.id)} records ${ids.join(', ')} by hand with no device capture, scan, photo or printout, so the checker must witness the act (WITNESSED), not review it later (VERIFIED)`));
    }
  }
  return out;
});

/**
 * Phase 2 exit follow-up T12.DOC (DI-30, PR-14, DI-35): a later review (VERIFIED) is allowed where a critical value typed
 * by hand has a photo or printout behind it (GMP-WITNESS), but in this release no hand entry can carry an attachment
 * (EBMR-EXE-122, until an attachment store exists), so the engine and the database check such a step by a witness
 * (engine 1.4.0, recipe-core 0325; decision T12.1) and, once no witness is possible, by the later review with an exception
 * for QA (engine 1.5.0, recipe-core 0333; T12.2). The author and the approver are told before approval what the floor
 * will run: a warning, which needs a justification before verification starts, like every warning.
 *
 * Round 2: whatever capture the MBR names (device, scan, LIMS, automation), every value a step records is typed by hand
 * in this release and the engine checks it so, so the warning covers those too and says so; never an item the step's
 * block computes from its entries (a weighing step's mass totals), which is not typed (blocks computedItemsOf).
 *
 * Round 3: a phase whose MBR names no check is warned about too. The engine asks for a second person for every critical
 * value typed by hand, so such a phase is checked all the same, by a person in the fallback verifier roles (the
 * engine's policy), as the timed witness and then the later review with WITNESS_LATE; the author and the approver saw
 * no check at all.
 *
 * Round 4: the warning names the people the run accepts, not every role the check names. The kernel signs a witness only
 * in a role holding STEP.WITNESS and a later review only in one holding STEP.VERIFY, so of the roles the check names (the
 * MBR's check role, else the fallback verifier roles) it names those the installation's checker roles allow for each
 * (flow `checkersInRun`; as delivered, a witness by PRODUCTION_VERIFIER or QA and a later review by PRODUCTION_VERIFIER:
 * a production supervisor holds neither permission). Round 3 named PRODUCTION_SUPERVISOR and let QA give the later review,
 * both of which the run refuses. The witness window is the site's (the kernel's), 5 minutes by default.
 */
const witnessedInThisRelease = defineRule('GMP-WITNESS-NO-ATTACHMENT', 'A later review of a value typed by hand from a printout runs as a witness in this release', ['PR-03', 'DI-30', 'PR-14', 'DI-35'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const parameter = (id: string) => a.parameters.get(id);
    const ids = checkRunsAsWitness(parameter, p, computedItemsOf(p, a.mbr));
    if (ids.length === 0) continue;
    const otherwise = capturedOtherwise(parameter, ids);
    const captured =
      otherwise.length === 0
        ? ''
        : ` The MBR captures ${andList(otherwise.map((x) => `${x.id} ${CAPTURE_WORDS[x.capture]}`))}, but in this release every value of a step is typed by hand on the step screen (a scanned code is recorded as typed by hand).`;
    const named = p.signatures.check ? 'its check is a later review (VERIFIED)' : 'the MBR names no check for it';
    const roles = p.signatures.check ? [p.signatures.check.role] : [...DEFAULT_POLICY.fallbackVerifierRoles];
    const how = p.signatures.check
      ? 'this check runs as a witness (WITNESSED)'
      : `the step is checked all the same, as a witness (WITNESSED), by a person in one of the engine's verifier roles where the MBR names no check (${andList(roles)}) whose role holds the check's permission`;
    const checkers = a.ctx.roles ? checkersInRun(p, DEFAULT_POLICY.fallbackVerifierRoles, a.ctx.roles.checkers) : undefined;
    out.push(
      warning(
        p.id,
        `${label(a, p.id)} records ${ids.join(', ')} by hand from the printout or photo the MBR names as ${ids.length === 1 ? 'its' : 'their'} evidence, and ${named}.${captured} In this release no printout or photo can be attached to a value typed by hand, so ${how}: ${witnessThenReview(checkers, roles)}`,
      ),
    );
  }
  return out;
});

/**
 * Who gives a check that runs as a witness in this release, and then its later review, naming the people the run accepts
 * (T12.DOC round 4): `c` from the installation's checker roles; undefined where the validator was not given them (then
 * FLOW-ROLES fails closed), and the roles the check names (`named`) are given with the permission each check needs.
 */
function witnessThenReview(c: CheckersInRun | undefined, named: readonly string[]): string {
  const holders = (roles: readonly string[] | undefined, permission: string): string | undefined =>
    roles === undefined ? `${orList(named)} whose role holds ${permission}` : roles.length > 0 ? `${orList(roles)} (${permission})` : undefined;
  const witness = holders(c?.witness, CHECK_PERMISSIONS.witness);
  const review = holders(c?.review, CHECK_PERMISSIONS.review);
  const watch =
    witness !== undefined
      ? `a second person holding ${witness} watches the entry within the site's witness window (5 minutes by default) after the step is signed performed, and before the run moves on.`
      : `no person may witness it, as no role of this installation that carries ${orList(named)} holds ${CHECK_PERMISSIONS.witness}; the step waits until the site's witness window (5 minutes by default) has passed or the run moved on.`;
  const later =
    review !== undefined
      ? `Once no witness is possible, the later review by a person holding ${review} completes the step and records an exception (WITNESS_LATE) that QA must disposition`
      : `Once no witness is possible, no person may give the later review that completes the step, as no role of this installation that carries ${orList(named)} holds ${CHECK_PERMISSIONS.review}: the run cannot complete this step`;
  return `${watch} ${later}`;
}

/**
 * Phase 2 exit follow-up T12.DOC round 4 (PR-14, DI-35, INV-26): a person of this installation may give every check the
 * MBR names. The engine asks for the check's role, and the kernel signs a witness only in a role holding STEP.WITNESS and
 * a later review (VERIFIED, or a block's own check meaning) only in one holding STEP.VERIFY. A check whose role is carried
 * by no kernel role holding that permission (as delivered: a later review by PRODUCTION_SUPERVISOR or QA, a witness by
 * PRODUCTION_SUPERVISOR) can never be given, so the run would stop at the step for good while the document names that
 * role as its checker. A role outside the vocabulary is FLOW-ROLES' error; without the installation's roles FLOW-ROLES
 * fails closed and this rule says nothing more.
 */
const checkPermission = defineRule('GMP-CHECK-PERMISSION', 'A person of this installation may give every check the MBR names', ['PR-14', 'DI-35', 'INV-26'], (a) => {
  const roles = a.ctx.roles;
  if (!roles) return [];
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const check = p.signatures.check;
    if (!check || !roles.engineRoles.includes(check.role)) continue;
    const kind = check.meaning === 'WITNESSED' ? 'witness' : 'review';
    if (roles.checkers[kind].includes(check.role)) continue;
    out.push(
      error(
        p.id,
        `${label(a, p.id)} is checked ${check.meaning} by ${check.role}, but no role of this installation that carries ${check.role} holds ${CHECK_PERMISSIONS[kind]}, the permission ${kind === 'witness' ? 'a witness' : 'a later review'} is signed with, so no person could ever give this check and the run would stop at this step`,
      ),
    );
  }
  return out;
});

/** "a", "a and b", "a, b and c". */
function andList(parts: readonly string[]): string {
  return joinList(parts, 'and');
}

/** "a", "a or b", "a, b or c". */
function orList(parts: readonly string[]): string {
  return joinList(parts, 'or');
}

function joinList(parts: readonly string[], last: 'and' | 'or'): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${last} ${parts[parts.length - 1] ?? ''}`;
}

/** Roles allowed after a stage's yield or reconciliation step. */
const AFTER_YIELD = new Set(['SIGN_OFF', 'INSTRUCTION', 'SAMPLING', 'TIMER', 'VERIFICATION', 'OUTPUT_CONTAINER', 'YIELD_RECONCILIATION']);

const stageClearance = defineRule('GMP-STAGE-CLEARANCE', 'Each stage starts with clearance', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => {
    const p = a.phaseOf(n);
    const stage = p ? a.nodes.get(p.id)?.stage : undefined;
    return p && stage && a.hasRole(p, 'CLEARANCE') ? [`clear:${stage}`] : [];
  });
  if (!facts) return out;
  for (const s of stages(a)) {
    const bound = s.purpose === 'MATERIAL' || s.binding.rooms.length > 0 || s.binding.line !== undefined;
    if (!bound) continue;
    const ps = phasesIn(s.body);
    if (!ps.some((p) => a.hasRole(p, 'CLEARANCE'))) {
      out.push(error(s.id, `Stage ${label(a, s.id)} has no line or room clearance step; each stage starts with clearance`));
      continue;
    }
    for (const p of ps) {
      if (a.hasRole(p, 'CLEARANCE') || a.hasRole(p, 'INSTRUCTION')) continue;
      const t = a.taskOf(p.id);
      if (t && !facts.get(t.id)?.has(`clear:${s.id}`)) out.push(error(p.id, `${label(a, p.id)} can run before the clearance of stage ${label(a, s.id)}; each stage starts with clearance`));
    }
  }
  return out;
});

const stageYield = defineRule('GMP-STAGE-YIELD', 'Each material stage ends with yield or reconciliation', ['PR-03', 'PR-31'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => {
    const p = a.phaseOf(n);
    const stage = p ? a.nodes.get(p.id)?.stage : undefined;
    return p && stage && a.hasRole(p, 'YIELD_RECONCILIATION') ? [`yield:${stage}`] : [];
  });
  if (!facts) return out;
  for (const s of stages(a)) {
    if (s.purpose !== 'MATERIAL') continue;
    const end = a.graphNodeOf(s.id, 'SCOPE_END');
    if (end && !facts.get(end.id)?.has(`yield:${s.id}`)) {
      out.push(error(s.id, `Stage ${label(a, s.id)} can end without a yield or reconciliation step; each material stage ends with its yield`));
      continue;
    }
    // Nothing that processes material may follow the stage's yield step.
    const inStage = new Set(phasesIn(s.body).map((p) => p.id));
    const starts = phasesIn(s.body).filter((p) => a.hasRole(p, 'YIELD_RECONCILIATION'));
    const seen = new Set<string>();
    const queue: GraphNode[] = starts.map((p) => a.taskOf(p.id)).filter((g): g is GraphNode => g !== undefined);
    while (queue.length > 0) {
      const g = queue.shift() as GraphNode;
      for (const e of a.gi.out.get(g.id) ?? []) {
        const next = a.gi.node.get(e.to) as GraphNode;
        if (seen.has(next.id) || next.id === end?.id) continue;
        seen.add(next.id);
        queue.push(next);
        const p = a.phaseOf(next);
        if (!p || !inStage.has(p.id)) continue;
        const d = a.describe(p);
        const benign = d !== undefined && d.roles.length > 0 && d.roles.every((r) => AFTER_YIELD.has(r)) && p.consumes.length === 0 && p.produces.length === 0 && !p.equipment.some((x) => x.use === 'USE');
        if (!benign) out.push(error(p.id, `${label(a, p.id)} can run after the yield of stage ${label(a, s.id)}; the yield must close the stage's processing`));
      }
    }
  }
  return out;
});

const nonMaterialStages = defineRule('GMP-STAGE-NON-MATERIAL', 'Non-material stages move no material', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  for (const s of stages(a)) {
    if (s.purpose !== 'NON_MATERIAL') continue;
    for (const p of phasesIn(s.body)) {
      if (p.consumes.length > 0 || p.produces.length > 0) out.push(error(p.id, `${label(a, p.id)} consumes or produces material in stage ${label(a, s.id)}, which is declared non-material (and so has no yield)`));
    }
  }
  return out;
});

const equipmentStatus = defineRule('GMP-EQUIPMENT-STATUS', 'Equipment use is preceded by a status check', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => {
    const p = a.phaseOf(n);
    const stage = p ? a.nodes.get(p.id)?.stage : undefined;
    return p && stage ? p.equipment.filter((e) => e.use === 'STATUS_CHECK').map((e) => `${stage}:${e.ref}`) : [];
  });
  if (!facts) return out;
  for (const p of a.phases) {
    const info = a.nodes.get(p.id);
    const stage = info?.stage ? a.nodes.get(info.stage)?.node : undefined;
    if (stage?.kind !== 'stage') continue;
    const t = a.taskOf(p.id);
    for (const e of p.equipment) {
      if (e.use !== 'USE') continue;
      const kind = stage.binding.equipment.find((x) => x.ref === e.ref)?.kind;
      if (kind === 'UTILITY' || kind === undefined) continue;
      const checkedHere = p.equipment.some((x) => x.ref === e.ref && x.use === 'STATUS_CHECK');
      if (!checkedHere && t && !facts.get(t.id)?.has(`${stage.id}:${e.ref}`)) {
        out.push(error(p.id, `${label(a, p.id)} uses ${e.ref} before its status (clean, qualified, calibrated) is checked in stage ${label(a, stage.id)} on every path`));
      }
    }
  }
  return out;
});

const bomConsumed = defineRule('GMP-BOM-CONSUMED', 'Every BOM line is consumed on every completing path', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => a.phaseOf(n)?.consumes ?? []);
  if (!facts) return out;
  const atEnd = facts.get(a.graph.end) ?? new Set<string>();
  for (const b of a.mbr.bom) {
    if (!atEnd.has(b.id)) {
      const anywhere = a.phases.some((p) => p.consumes.includes(b.id));
      out.push(error(b.id, anywhere ? `BOM line ${b.id} is not consumed on every path through the batch (some branch completes without it)` : `BOM line ${b.id} is never consumed by any step`));
    }
  }
  return out;
});

const yields = defineRule('GMP-YIELDS', 'Yield checkpoints have a basis, minimum and maximum, and a step', ['PR-03', 'INV-34', 'PR-31', 'PR-39'], (a) => {
  const out: RuleFinding[] = [];
  for (const y of a.mbr.yieldCheckpoints) {
    const name = `Yield checkpoint ${label(a, y.id)}`;
    const ranges = y.limits?.ranges ?? [];
    if (!ranges.some((r) => r.low !== undefined && r.high !== undefined)) out.push(error(y.id, `${name} has no minimum and maximum; every yield and reconciliation checkpoint needs both, with their source`));
    const steps = a.phases.filter((p) => p.yieldCheckpoint === y.id);
    if (steps.length === 0) out.push(error(y.id, `${name} is not evaluated by any yield or reconciliation step`));
    for (const p of steps) {
      if (!a.hasRole(p, 'YIELD_RECONCILIATION')) out.push(error(p.id, `${label(a, p.id)} evaluates ${name} but is not a yield or reconciliation block`));
      if (!p.computes.includes(y.result)) out.push(error(p.id, `${label(a, p.id)} evaluates ${name} but does not compute its result ${y.result}; yields are computed, never typed`));
    }
  }
  for (const p of a.phases) {
    if (a.hasRole(p, 'YIELD_RECONCILIATION') && p.yieldCheckpoint === undefined) out.push(error(p.id, `${label(a, p.id)} is a yield or reconciliation step but names no yield checkpoint`));
  }
  return out;
});

const intermediates = defineRule('GMP-INTERMEDIATES', 'Every intermediate has a hold time and is produced before use', ['PR-03', 'INV-34', 'IN-13'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => a.phaseOf(n)?.produces ?? []);
  for (const i of a.mbr.intermediates) {
    const name = `Intermediate ${label(a, i.id)}`;
    if (!i.holdTime) out.push(error(i.id, `${name} has no hold time; every intermediate needs a maximum hold time from a hold-time study`));
    else if (i.holdTime.source.kind !== 'HOLD_STUDY' && i.holdTime.source.kind !== 'VALIDATION_REPORT') {
      out.push(error(i.id, `The hold time of ${name} cites a ${i.holdTime.source.kind.toLowerCase().replace('_', ' ')}; it must cite a hold-time study or validation report`));
    }
    const producers = a.phases.filter((p) => p.produces.includes(i.id));
    const users = a.phases.filter((p) => p.uses.includes(i.id));
    if (producers.length === 0) out.push(error(i.id, `${name} is never produced by any step`));
    if (users.length === 0 && i.finalOutput !== true) out.push(error(i.id, `${name} is never used by any step (mark it as a final output if it leaves the procedure)`));
    if (facts) {
      for (const u of users) {
        const t = a.taskOf(u.id);
        if (t && producers.length > 0 && !facts.get(t.id)?.has(i.id)) out.push(error(u.id, `${label(a, u.id)} uses ${name} before it is produced on every path`));
      }
    }
  }
  return out;
});

const TIMER_SOURCES = new Set(['VALIDATION_REPORT', 'HOLD_STUDY', 'REGISTRATION', 'PHARMACOPOEIA', 'RULE_TABLE']);

const timers = defineRule('GMP-TIMERS', 'Every timer has limits and a validation reference', ['PR-03', 'INV-34', 'PR-30'], (a) => {
  const out: RuleFinding[] = [];
  for (const t of a.mbr.timeConstraints) {
    if (!t.source) out.push(error(t.id, `Timer ${label(a, t.id)} lacks a validation reference`));
    else if (!TIMER_SOURCES.has(t.source.kind)) out.push(error(t.id, `Timer ${label(a, t.id)} cites a ${t.source.kind.toLowerCase().replace('_', ' ')}, which is not a validation or hold-study reference`));
  }
  for (const p of a.phases) {
    if (!a.hasRole(p, 'TIMER')) continue;
    const limited = a.mbr.timeConstraints.some((t) => (isNodeEvent(t.from) && t.from.node === p.id) || (isNodeEvent(t.to) && t.to.node === p.id));
    if (!limited) out.push(error(p.id, `Timer step ${label(a, p.id)} has no time constraint giving its limits`));
  }
  return out;
});

const specimens = defineRule(
  'GMP-SPECIMENS',
  'Every printed component has an approved specimen',
  ['PR-03', 'IN-14'],
  (a) => {
    const out: RuleFinding[] = [];
    for (const b of a.mbr.bom) {
      if (b.role !== 'PRINTED_COMPONENT') continue;
      if (!b.specimen) out.push(error(b.id, `Printed component ${b.id} has no approved specimen`));
      else if (a.references.get(b.specimen)?.kind !== 'SPECIMEN') out.push(error(b.id, `Printed component ${b.id} cites ${b.specimen}, which is not a specimen`));
    }
    return out;
  },
  { covers: ['SPECIMEN_EVERY_PRINTED_COMPONENT'] },
);

const REF_KIND_OF: [string, (a: Analysis) => [string, string | undefined][], ReferenceKind[]][] = [
  ['material', (a) => a.mbr.bom.map((b) => [b.id, b.material]), ['MATERIAL']],
  ['risk scale', (a) => [['$', a.mbr.riskScale.ref]], ['RISK_SCALE']],
  ['risk assessment', (a) => a.mbr.riskReductions.map((r) => [r.id, r.rationale]), ['RISK_ASSESSMENT']],
  ['computerised system', (a) => a.phases.map((p) => [p.id, p.system?.ref]), ['COMPUTERISED_SYSTEM']],
  ['equipment class', (a) => stages(a).flatMap((s) => s.binding.equipment.map((e): [string, string] => [s.id, e.equipmentClass])), ['EQUIPMENT_CLASS']],
];

const referencesEffective = defineRule('GMP-REFERENCES', 'Every reference is pinned and effective', ['PR-03', 'DI-04'], (a) => {
  const out: RuleFinding[] = [];
  for (const r of a.mbr.references) {
    if (r.hash === undefined) out.push(error(r.id, `Reference ${r.id} (${r.kind.toLowerCase()} ${r.code} v${r.version}) is not pinned by hash`));
    const status = a.ctx.references.status(r);
    if (status !== 'EFFECTIVE') {
      const why: Record<string, string> = {
        NOT_YET_EFFECTIVE: 'is not yet effective',
        SUPERSEDED: 'has been superseded',
        RETIRED: 'has been retired',
        WITHDRAWN: 'has been withdrawn',
        HASH_MISMATCH: 'does not match its pinned hash',
        UNKNOWN: 'is unknown to the document and master-data registers',
      };
      out.push(error(r.id, `Reference ${r.id} (${r.kind.toLowerCase()} ${r.code} v${r.version}) ${why[status] ?? status} on ${a.ctx.asOf}`));
    }
  }
  for (const [what, list, kinds] of REF_KIND_OF) {
    for (const [subject, id] of list(a)) {
      if (id === undefined) continue;
      const ref = a.references.get(id);
      if (ref && !kinds.includes(ref.kind)) out.push(error(subject, `${label(a, subject)} cites ${id} as ${what}, but that reference is a ${ref.kind.toLowerCase().replace('_', ' ')}`));
    }
  }
  return out;
});

const risk = defineRule('GMP-RISK', 'Every risk-based reduction has a risk class and a rationale', ['IN-02'], (a) => {
  const out: RuleFinding[] = [];
  const classes = a.mbr.riskScale.classes;
  if (classes.length < 2 || new Set(classes).size !== classes.length) out.push(error('$', 'The risk scale must list at least two distinct classes'));
  const inScale = (subject: string, cls: string | undefined, what: string): void => {
    if (cls !== undefined && !classes.includes(cls)) out.push(error(subject, `${what} has risk class ${JSON.stringify(cls)}, which is not on the controlled risk scale`));
  };
  for (const p of a.phases) inScale(p.id, p.riskClass, label(a, p.id));
  for (const p of a.mbr.parameters) inScale(p.id, p.riskClass, `Parameter ${label(a, p.id)}`);
  for (const c of a.mbr.calculations) inScale(c.id, c.riskClass, `Calculation ${label(a, c.id)}`);
  for (const r of a.mbr.riskReductions) {
    const name = `Risk-based reduction ${r.id} (${r.kind.toLowerCase().replace(/_/g, ' ')})`;
    if (r.riskClass === undefined) out.push(error(r.id, `${name} has no risk class; a reduction cannot be saved without one`));
    else inScale(r.id, r.riskClass, name);
    if (r.rationale === undefined) out.push(error(r.id, `${name} has no linked risk assessment with a written rationale`));
    else if (a.references.has(r.rationale) && a.references.get(r.rationale)?.kind !== 'RISK_ASSESSMENT') out.push(error(r.id, `${name} links ${r.rationale}, which is not a risk assessment`));
    if (r.subjects.length === 0) out.push(error(r.id, `${name} applies to nothing`));
    if (r.kind === 'REVIEW_BY_EXCEPTION' && (r.validationRef === undefined || r.validationRef.trim() === '')) {
      out.push(error(r.id, `${name} has no validation reference; review by exception on a step is enabled only with one, under change control (PR-52)`));
    }
    for (const s of r.subjects) {
      const node = a.nodes.get(s)?.node;
      const phase = node?.kind === 'phase' ? node : undefined;
      const fits =
        r.kind === 'ONE_VERIFIER'
          ? phase !== undefined && a.hasRole(phase, 'AUTOMATED_PHASE')
          : r.kind === 'NO_SECOND_PERSON_CLEARANCE'
            ? phase !== undefined && a.hasRole(phase, 'CLEARANCE')
            : r.kind === 'REDUCED_IPC_FREQUENCY'
              ? phase !== undefined && (a.hasRole(phase, 'IPC') || a.hasRole(phase, 'SAMPLING'))
              : r.kind === 'REVIEW_BY_EXCEPTION'
                ? phase !== undefined
                : phase !== undefined || a.parameters.get(s)?.criticality === 'NON_CRITICAL' || a.calculations.get(s)?.criticality === 'NON_CRITICAL';
      if (!fits && (node !== undefined || a.data.has(s))) out.push(error(r.id, `${name} cannot apply to ${label(a, s)}`));
    }
  }
  for (const item of [...a.mbr.parameters, ...a.mbr.calculations]) {
    if (item.criticality === 'NON_CRITICAL' && !reducedBy(a, 'MINOR_CLASSIFICATION', item.id)) {
      out.push(error(item.id, `${label(a, item.id)} is classified non-critical without a linked risk-based reduction (risk class and rationale); until then it is treated as critical`));
    }
  }
  return out;
});

const AUTOMATION = new Set(['PLC', 'SCADA', 'STERILISER_CONTROLLER', 'LYO_CONTROLLER']);

const systems = defineRule('GMP-SYSTEMS', 'Steps name the computerised systems they rely on', ['DI-04'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const d = a.describe(p);
    const devices = p.records.filter((id) => ['DEVICE', 'AUTOMATION'].includes(a.parameters.get(id)?.capture ?? ''));
    if ((d?.requiresSystem || devices.length > 0) && !p.system) {
      out.push(error(p.id, `${label(a, p.id)} relies on ${d?.requiresSystem ? 'automated equipment' : `device-captured values (${devices.join(', ')})`} but names no computerised system`));
    }
    if (p.system && (AUTOMATION.has(p.system.kind) || d?.requiresSystem) && (!p.system.recipe || !p.system.recipeVersion)) {
      out.push(error(p.id, `${label(a, p.id)} runs on ${p.system.kind} ${p.system.ref} but does not name the recipe and recipe version it expects`));
    }
  }
  return out;
});

const pat = defineRule('GMP-PAT', 'PAT steps define method, model version and acceptance criteria', ['DI-04'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    if (a.hasRole(p, 'PAT') && !p.pat) out.push(error(p.id, `${label(a, p.id)} is a PAT step but defines no method, model version or acceptance criteria`));
    if (p.pat && !p.pat.acceptance) out.push(error(p.id, `${label(a, p.id)} is a PAT step without acceptance criteria; it cannot be approved`));
  }
  return out;
});

const reprocessing = defineRule('GMP-REPROCESSING', 'Reprocessing and recovery steps declare their case and limits', ['PR-03'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const name = label(a, p.id);
    if (a.hasRole(p, 'REPROCESSING') && !p.reprocessing) out.push(error(p.id, `${name} is a reprocessing or recovery step but does not declare its case`));
    const r = p.reprocessing;
    if (!r) continue;
    if ((r.case === 'REPROCESSING_ADDITION' || r.case === 'RECOVERY') && (r.maxPercent === undefined || r.maxAge === undefined || r.maxSourceBatches === undefined)) {
      out.push(error(p.id, `${name} adds material from other batches but does not set the maximum percentage, maximum age and maximum number of source batches`));
    }
    if (r.maxPercent !== undefined && (compareDecimal(r.maxPercent, '0') <= 0 || compareDecimal(r.maxPercent, '100') > 0)) out.push(error(p.id, `${name} has a maximum percentage outside 0-100`));
    if (r.case === 'VALIDATED_RETREATMENT' && !(a.nodes.get(p.id)?.ancestors ?? []).some((id) => a.nodes.get(id)?.node.kind === 'loop')) {
      out.push(error(p.id, `${name} is a validated re-treatment, which must be a bounded loop on a process endpoint`));
    }
  }
  return out;
});

const acceptance = defineRule('GMP-ACCEPTANCE-SCHEMES', 'ALL_APPLY schemes are complete and their sampling serves every criterion', ['PR-08', 'PR-03'], (a) => {
  const out: RuleFinding[] = [];
  for (const s of a.mbr.acceptanceSchemes) {
    if (s.criteria.length === 0) out.push(error(s.id, `Acceptance scheme ${s.id} has no criterion`));
    const ids = new Set<string>();
    for (const c of s.criteria) {
      if (ids.has(c.id)) out.push(error(s.id, `Acceptance scheme ${s.id} lists criterion ${c.id} twice`));
      ids.add(c.id);
      if (c.governingMarkets.length === 0) out.push(error(s.id, `Criterion ${c.id} of ${s.id} names no governing market`));
      for (const m of c.governingMarkets) if (!a.mbr.header.marketSet.includes(m)) out.push(error(s.id, `Criterion ${c.id} of ${s.id} is governed by ${m}, which is not in the market set`));
      out.push(...limitFindings(a, s.id, `Criterion ${c.id} of ${s.id}`, { unit: c.unit, ranges: [c.range] }));
    }
    const users = a.phases.filter((p) => p.acceptanceScheme === s.id);
    if (users.length === 0) out.push(warning(s.id, `Acceptance scheme ${s.id} is not used by any step`));
    for (const p of users) {
      for (const gap of samplingShortfalls(s, p.sampling ?? [])) {
        out.push(error(p.id, `The sampling plan of ${label(a, p.id)} takes ${gap.planned} unit(s) for ${gap.purpose} at ${gap.point}, but criteria ${gap.criteria.join(', ')} of ${s.id} need ${gap.needed}`));
      }
    }
  }
  return out;
});

// Capsules edition C3 (docs/build-plan/capsules/plan.md, section 4): two post-fill duties the library blocks carry. The
// library step types are written out (LIB-<code>, library/block-version.ts) so the validator does not depend on the library.
const CAPS_BAND = 'LIB-PROC-CAPS-BAND';
const CAPS_PRINT = 'LIB-PROC-CAPS-PRINT';
const isType = (p: PhaseNode | undefined, type: string): boolean => p?.block.type === type;

const capsuleSealing = defineRule('GMP-CAPSULE-SEAL', 'An OTC two-piece hard capsule is banded or sealed on every completing path', ['PR-41'], (a) => {
  // 21 CFR 211.132(b)(2): a two-piece hard capsule for US OTC retail sale is sealed with a tamper-evident technology. A soft
  // gel is one piece and needs no band.
  const form = a.mbr.header.product.dosageForm;
  if (a.mbr.header.predicates['usOtcRetail'] !== true || !isCapsuleForm(form) || /soft[\s-]*gel/i.test(form)) return [];
  const facts = a.mustBefore([], (n) => (isType(a.phaseOf(n), CAPS_BAND) ? [CAPS_BAND] : []));
  if (facts?.get(a.graph.end)?.has(CAPS_BAND)) return [];
  return [error('$', `The master is for US OTC retail packs of a two-piece hard capsule (${form}) and does not band or seal the capsules (a ${CAPS_BAND.slice(4)} step) on every path`)];
});

const printingHeld = defineRule('GMP-CAPSULE-PRINT-HELD', 'Printed capsules wait at a hold point before the record ends (QC approval before packaging)', ['IN-37'], (a) => {
  // Schedule M Part VIII 6: printed capsules are approved by QC after printing and before packaging. A forward pass over
  // the graph carries the prints not yet held on SOME path (joins unite); a hold point clears them. A print that can reach
  // the end of the record unheld is refused. Printing on one branch only, or a hold in each branch, passes.
  if (!a.topo) return [];
  const unheld = new Map<string, Set<string>>();
  for (const id of a.topo) {
    const n = a.gi.node.get(id) as GraphNode;
    const facts = new Set((a.gi.in.get(id) ?? []).filter((e) => e.kind !== 'LOOP_BACK').flatMap((e) => [...(unheld.get(e.from) ?? [])]));
    if (a.nodes.get(n.source)?.node.kind === 'holdPoint') facts.clear();
    const p = a.phaseOf(n);
    if (p && isType(p, CAPS_PRINT)) facts.add(p.id);
    unheld.set(id, facts);
  }
  return [...(unheld.get(a.graph.end) ?? [])].sort().map((id) => error(id, `${label(a, id)} prints the capsules, and on some path no hold point after it holds them for QC approval before packaging`));
});

export const CONTENT_RULES: readonly Rule[] = [
  header,
  typedFields,
  criticalParameters,
  limitNesting,
  significantSteps,
  witnessed,
  witnessedInThisRelease,
  checkPermission,
  stageClearance,
  stageYield,
  nonMaterialStages,
  equipmentStatus,
  bomConsumed,
  yields,
  intermediates,
  timers,
  specimens,
  referencesEffective,
  risk,
  systems,
  pat,
  reprocessing,
  acceptance,
  capsuleSealing,
  printingHeld,
];

/** Content-minimum items the generic rules always enforce (India always applies, outline 3.3.6). */
export const GENERIC_COVERED_ITEMS = ['HOLD_TIME_EVERY_INTERMEDIATE', 'SPECIMEN_EVERY_PRINTED_COMPONENT', 'YIELD_LIMITS_EVERY_CHECKPOINT', 'TIMER_VALIDATION_REFERENCE'] as const;
