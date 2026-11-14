/**
 * Generic GMP content gates (outline 6.3 "GMP content"; PR-03 content completeness, PR-08 limits,
 * IN-02 risk-based reductions, DI-04 computerised systems and PAT, INV-34 hold times, timers and
 * yields). Edition rule sets add their own content rules through the registry.
 */
import { computedItemsOf } from '../blocks/generic/material.ts';
import { DEFAULT_POLICY } from '../engine/types.ts';
import { CAPTURE_WORDS, CHECK_PERMISSIONS, capturedOtherwise, checkersInRun, checkRunsAsWitness, type CheckersInRun } from '../flow/check-in-release.ts';
import { compareDecimal } from '../flow/decimal.ts';
import type { GraphNode } from '../flow/graph.ts';
import { childrenOf, isNodeEvent, NON_PRODUCT_KINDS, type FlowNode, type PhaseNode, type ReferenceKind, type StageNode } from '../flow/model.ts';
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
  // A non-product master is a process simulation (media fill) and nothing else (21 CFR 211.113(b); Annex 1 9.32).
  if (h.nonProduct !== undefined && !(NON_PRODUCT_KINDS as readonly string[]).includes(h.nonProduct)) {
    out.push(error('$', `A master that makes no product is a process simulation (PROCESS_SIMULATION), not ${String(h.nonProduct)}`));
  }
  // Aseptic process simulation is a sterile-processing concept (Annex 1 section 9), and its licence skip must never reach
  // product: the mark belongs to an injectables processing master only (recipe-core 1896, EBMR-RCP-435).
  if (h.nonProduct !== undefined && (h.edition !== 'injectables' || h.recordKind !== 'PROCESSING')) {
    out.push(error('$', `Only an injectables processing master may be a process simulation; this master is ${h.edition}, ${h.recordKind.toLowerCase()}`));
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
    // R-rest A4: no clause forbids critical free text; the binding part is the accuracy check on critical data entered by
    // hand (EU Annex 11 section 6, DI-30), which GMP-CRITICAL-PARAMETERS still asks for. A warning suggests a list.
    if (p.valueType === 'TEXT' && p.criticality === 'CRITICAL') out.push(warning(p.id, `${name} is critical but free text; a choice list or a typed value is easier to check`));
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

const significantSteps = defineRule('GMP-SIGNIFICANT-STEPS', 'Performer plus checker on significant steps', ['PR-14'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const d = a.describe(p);
    if (!d) continue;
    const automated = d.roles.includes('AUTOMATED_PHASE');
    const clearance = d.roles.includes('CLEARANCE');
    // Critical data typed by hand always needs a second person (PR-14; outline 7.2 S5), with or without a photo.
    const criticalManual = p.records.some((id) => a.parameters.get(id)?.criticality === 'CRITICAL' && a.parameters.get(id)?.capture === 'MANUAL');
    // R-rest A5: a line clearance is not a significant step by its block alone. 21 CFR 211.130(e) and EU GMP 5.50 ask
    // for the clearance and its record, not a second person; 211.188(b)(11) asks for one on a significant step, so a
    // clearance the author marks significant, or one with critical data typed by hand, keeps it. Revised Schedule M
    // (G.S.R. 922(E), 28 December 2023) Part VIII, which binds oral solid dosage forms (tablets and capsules: the
    // tablets edition), 7.1 asks for a second person's recorded check of the counting, strip and blister equipment before
    // each new batch of tablets or capsules is handled. The master does not say which machines
    // a packaging line has, so a tablets packaging clearance keeps its second person (or the declared S24 reduction for
    // a line without them).
    const oralSolidPacking = a.mbr.header.recordKind === 'PACKAGING' && a.mbr.header.edition === 'tablets';
    const significant = (clearance && !oralSolidPacking ? false : d.significant) || p.significant || criticalManual;
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
    // R-rest A6: EU GMP 4.18(c) and 5.50 ask that the area is cleared before an operation starts, not that each stage
    // clears again. A stage may continue the clearance of an earlier stage in the same room or on the same line (the
    // batch has not left the cleared area); its steps then need that stage's clearance before them.
    let cleared = s.id;
    if (s.clearanceFrom !== undefined) {
      const from = a.nodes.get(s.clearanceFrom)?.node;
      const sameArea = from?.kind === 'stage' && (from.binding.rooms.some((r) => s.binding.rooms.includes(r)) || (from.binding.line !== undefined && from.binding.line === s.binding.line));
      if (from?.kind !== 'stage' || from.id === s.id) {
        out.push(error(s.id, `Stage ${label(a, s.id)} continues the clearance of ${s.clearanceFrom}, which is not another stage of the master`));
        continue;
      }
      if (!sameArea) {
        out.push(error(s.id, `Stage ${label(a, s.id)} continues the clearance of ${label(a, from.id)}, but they share no room or line; a stage in another area starts with its own clearance`));
        continue;
      }
      if (!ps.some((p) => a.hasRole(p, 'CLEARANCE'))) cleared = from.id;
    }
    if (cleared === s.id && !ps.some((p) => a.hasRole(p, 'CLEARANCE'))) {
      out.push(error(s.id, `Stage ${label(a, s.id)} has no line or room clearance step; each stage starts with clearance, or continues the clearance of an earlier stage in the same room or line`));
      continue;
    }
    for (const p of ps) {
      if (a.hasRole(p, 'CLEARANCE') || a.hasRole(p, 'INSTRUCTION')) continue;
      const t = a.taskOf(p.id);
      if (t && !facts.get(t.id)?.has(`clear:${cleared}`)) out.push(error(p.id, `${label(a, p.id)} can run before the clearance of stage ${label(a, cleared)}; each stage starts with clearance`));
    }
  }
  return out;
});

// 21 CFR 211.103 asks for the actual yield and its percentage of theoretical at the end of each appropriate phase of
// manufacturing; the master decides which phases are appropriate. So a material stage ends with its yield, or names on
// the stage why it has none (`noYieldReason`, approved with the master; R-flow item 4). Processing after the yield step
// is a warning: no clause forbids it, but the yield then does not close the stage's processing.
const stageYield = defineRule('GMP-STAGE-YIELD', 'Each material stage ends with yield or reconciliation, or says why it has none', ['PR-03', 'PR-31'], (a) => {
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
    if (s.noYieldReason !== undefined && s.noYieldReason.trim() !== '' && !phasesIn(s.body).some((p) => a.hasRole(p, 'YIELD_RECONCILIATION'))) continue;
    if (end && !facts.get(end.id)?.has(`yield:${s.id}`)) {
      out.push(error(s.id, `Stage ${label(a, s.id)} can end without a yield or reconciliation step; each material stage ends with its yield, or states on the stage why it has none`));
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
        if (!benign) out.push(warning(p.id, `${label(a, p.id)} can run after the yield of stage ${label(a, s.id)}; the yield does not close the stage's processing`));
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
  // R-rest A7: 211.67 and EU GMP 5.x ask for clean, fit equipment before use, not for a check in each stage. A check of
  // the same equipment (reference and class) earlier on every path, in a stage that shares a room with this one, counts.
  const roomKeys = (stage: StageNode, ref: string): string[] => {
    const cls = stage.binding.equipment.find((x) => x.ref === ref)?.equipmentClass ?? '';
    return stage.binding.rooms.map((r) => `room:${r}:${ref}:${cls}`);
  };
  const facts = a.mustBefore([], (n) => {
    const p = a.phaseOf(n);
    const sid = p ? a.nodes.get(p.id)?.stage : undefined;
    const stage = sid ? a.nodes.get(sid)?.node : undefined;
    if (!p || !sid) return [];
    const checked = p.equipment.filter((e) => e.use === 'STATUS_CHECK');
    return [...checked.map((e) => `${sid}:${e.ref}`), ...(stage?.kind === 'stage' ? checked.flatMap((e) => roomKeys(stage, e.ref)) : [])];
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
      const before = t ? facts.get(t.id) : undefined;
      if (!checkedHere && t && !before?.has(`${stage.id}:${e.ref}`) && !roomKeys(stage, e.ref).some((k) => before?.has(k))) {
        out.push(error(p.id, `${label(a, p.id)} uses ${e.ref} before its status (clean, qualified, calibrated) is checked in stage ${label(a, stage.id)}, or earlier in the same room, on every path`));
      }
    }
  }
  return out;
});

/**
 * Demo finding of 13 November 2026 (MGL-SR-BL, r13 bug 1): the site-services equipment status step (G-09 from version 2)
 * starts the use of each unit it checks, its STATUS_CHECK equipment, and the database accepts only a unit the stage
 * binds (recipe-core 0521; EBMR-EXE-210). A step that checks no unit offers nothing on the floor and can never be signed
 * (G09-INCOMPLETE), so the batch stops there. Version 1, the sandbox attestation, takes any unit the person names.
 */
const equipmentStatusUnits = defineRule('GMP-EQUIPMENT-STATUS-UNITS', 'An equipment status step checks at least one unit its stage binds', ['PR-23', 'PR-03'], (a) => {
  const out: RuleFinding[] = [];
  const never = 'on the floor the step would offer no unit to start and could never be signed';
  for (const p of a.phases) {
    if (p.block.type !== 'G-09' || p.block.version === '1' || p.equipment.some((e) => e.use === 'STATUS_CHECK')) continue;
    const sid = a.nodes.get(p.id)?.stage;
    const stage = sid ? a.nodes.get(sid)?.node : undefined;
    const what = `${label(a, p.id)} checks the status of no unit`;
    if (stage?.kind !== 'stage') {
      out.push(error(p.id, `${what} and belongs to no stage that could bind one; ${never}`));
      continue;
    }
    const refs = stage.binding.equipment.map((e) => e.ref);
    if (refs.length === 0) {
      out.push(error(p.id, `${what}, and its stage ${label(a, stage.id)} binds no equipment: add the stage's equipment (each unit the stage uses, with its equipment class) and tick "checks its status" for it on this step; ${never}`));
    } else {
      out.push(error(p.id, `${what}: tick "checks its status" on this step for the stage's ${refs.join(', ')} that it must check before use; ${never}`));
    }
  }
  return out;
});

/**
 * D-6 (owner's MGL-SR-BL report, item 9): a library block's equipment class is one of the plant's classes. The binding
 * duty is that the instructions name the principal equipment (LIB-USE-EQUIPMENT-CLASS, 21 CFR 211.186(b)(9)); no clause
 * refuses a master over a class missing from the plant register, and the run refuses a unit of another class
 * (recipe-core 0521). So a class the plant does not hold is a WARNING: define it in Plant master data, or justify it.
 */
const plantClasses = defineRule('GMP-EQUIPMENT-CLASS-PLANT', "A library block's equipment class is a class of the plant", ['PR-03'], (a) => {
  const known = a.ctx.plantClasses;
  if (!known) return [];
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const named = (p.config as Record<string, unknown> | undefined)?.['equipmentClasses'];
    if (typeof named !== 'object' || named === null || Array.isArray(named)) continue;
    for (const [slot, cls] of Object.entries(named as Record<string, unknown>)) {
      if (typeof cls !== 'string' || cls.trim() === '' || known.includes(cls.trim())) continue;
      out.push(warning(p.id, `${label(a, p.id)} names the equipment class ${cls.trim()} for ${slot}, which is not a class of the plant: define it in Plant master data, or justify it`));
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
      // R-rest A8: a line consumed only in some branches (an optional material, a variant's material) is bound to those
      // paths; no clause asks that each path use every line, and the batch's reconciliation shows a line not used. A
      // warning asks the author to confirm it; a line no step consumes stays an error (record integrity: the master lists a
      // material its batch record can never account for).
      if (anywhere) out.push(warning(b.id, `BOM line ${b.id} is consumed on some paths only; a batch that takes another branch completes without it`));
      else out.push(error(b.id, `BOM line ${b.id} is never consumed by any step`));
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
    if (!a.hasRole(p, 'YIELD_RECONCILIATION') || p.yieldCheckpoint !== undefined) continue;
    const own = libraryYieldSlots(a, p);
    if (own === undefined) out.push(error(p.id, `${label(a, p.id)} is a yield or reconciliation step but names no yield checkpoint`));
    // Basis (demo finding D-1): a yield outside its limits must be investigated (PR-31: 21 CFR 211.192, EU GMP 4.17;
    // PR-39: reconciliation of bulk and printed materials with set limits), so a library yield step of the master
    // carries both its minimum and its maximum, with their source, as the yield checkpoints above do.

    for (const slot of own ?? []) {
      const ranges = limitsOf(p)[slot]?.ranges ?? [];
      if (!ranges.some((r) => r.low !== undefined && r.high !== undefined)) out.push(error(p.id, `${label(a, p.id)} gives its calculated ${slot} no minimum and maximum; every yield and reconciliation needs both, with their source`));
    }
  }
  return out;
});

/**
 * A library yield or reconciliation block computes its own yield (a critical CALC field with a limit slot) and the
 * step carries that limit, so it stands as its own checkpoint (demo finding D-1): the limit slots of those fields, or
 * undefined when the step is no such library step. Narrowed after #155 (lead ruling, 7 November 2026): 21 CFR 211.103
 * asks for the product's actual yield against theoretical at each phase, while a reconciliation of printed packaging or
 * labels answers 211.125 (labeling reconciliation) and is no yield of the stage's product, so those blocks never stand as
 * the stage's yield checkpoint.
 */
const LABELING_RECONCILIATIONS: ReadonlySet<string> = new Set(['CTRL-PRINTED-RECON', 'PACK-LABEL-RECON']);

function libraryYieldSlots(a: Analysis, p: PhaseNode): string[] | undefined {
  if (!p.block.type.startsWith('LIB-')) return undefined;
  const code = p.block.type.slice('LIB-'.length);
  if (LABELING_RECONCILIATIONS.has(code)) return undefined;
  const def = (a.mbr.blockDefinitions ?? []).find((d) => d['code'] === code && (typeof d['version'] === 'number' || typeof d['version'] === 'string') && String(d['version']) === p.block.version) as { sections?: { fields?: { type?: string; limitSlot?: string; critical?: boolean }[] }[] } | undefined;
  const slots = (def?.sections ?? []).flatMap((s) => s.fields ?? []).filter((f) => f.type === 'CALC' && f.critical === true && typeof f.limitSlot === 'string').map((f) => f.limitSlot as string);
  return slots.length > 0 ? slots : undefined;
}

function limitsOf(p: PhaseNode): Record<string, LimitSpec | undefined> {
  const l = p.config['limits'];
  return l !== null && typeof l === 'object' && !Array.isArray(l) ? (l as unknown as Record<string, LimitSpec | undefined>) : {};
}

/** Sources accepted with a warning for a hold time or a timer (R-rest A9). */
const WRITTEN_BASIS = new Set(['PROCESS_DATA', 'COMPANY_STANDARD']);

const intermediates = defineRule('GMP-INTERMEDIATES', 'Every intermediate has a hold time and is produced before use', ['PR-03', 'INV-34', 'IN-13'], (a) => {
  const out: RuleFinding[] = [];
  const facts = a.mustBefore([], (n) => a.phaseOf(n)?.produces ?? []);
  for (const i of a.mbr.intermediates) {
    const name = `Intermediate ${label(a, i.id)}`;
    if (!i.holdTime) out.push(error(i.id, `${name} has no hold time; every intermediate needs a maximum hold time from a hold-time study`));
    // R-rest A9: INV-34 asks for a source; no clause names its kind (211.111 asks for time limits for the phases of
    // production where appropriate). Process data or a company SOP is accepted with a warning that asks for the written basis.
    else if (WRITTEN_BASIS.has(i.holdTime.source.kind)) {
      out.push(warning(i.id, `The hold time of ${name} cites ${i.holdTime.source.kind === 'PROCESS_DATA' ? 'process data' : 'a company standard (SOP)'}; keep the written basis (the data or the SOP's study) with it`));
    } else if (i.holdTime.source.kind !== 'HOLD_STUDY' && i.holdTime.source.kind !== 'VALIDATION_REPORT') {
      out.push(error(i.id, `The hold time of ${name} cites a ${i.holdTime.source.kind.toLowerCase().replace('_', ' ')}; it must cite a hold-time study, a validation report, process data or a company SOP`));
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
    else if (WRITTEN_BASIS.has(t.source.kind)) out.push(warning(t.id, `Timer ${label(a, t.id)} cites ${t.source.kind === 'PROCESS_DATA' ? 'process data' : 'a company standard (SOP)'}; keep the written basis (the data or the SOP's study) with it`));
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
  // R-rest A11 (lead, 7 November): an MBR-level criticality assessment, named on the header and approved with the
  // master, stands as the rationale for every non-critical item (ICH Q9 asks for a documented assessment, not one per item).
  const assessment = a.mbr.header.criticalityAssessment;
  const assessed = assessment !== undefined && a.references.get(assessment)?.kind === 'RISK_ASSESSMENT';
  if (assessment !== undefined && !assessed) out.push(error('$', `The criticality assessment ${assessment} named on the header is not a pinned risk assessment of the master`));
  for (const item of [...a.mbr.parameters, ...a.mbr.calculations]) {
    if (item.criticality === 'NON_CRITICAL' && !assessed && !reducedBy(a, 'MINOR_CLASSIFICATION', item.id)) {
      out.push(error(item.id, `${label(a, item.id)} is classified non-critical without a linked risk-based reduction (risk class and rationale) or a criticality assessment named on the master; until then it is treated as critical`));
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

const reprocessing = defineRule('GMP-REPROCESSING', 'Reprocessing and recovery steps declare their case and limits', ['PR-47', 'IN-19'], (a) => {
  const out: RuleFinding[] = [];
  for (const p of a.phases) {
    const name = label(a, p.id);
    if (a.hasRole(p, 'REPROCESSING') && !p.reprocessing) out.push(error(p.id, `${name} is a reprocessing or recovery step but does not declare its case`));
    const r = p.reprocessing;
    if (!r) continue;
    // R-rest A10: Schedule M 14.32-14.34 and 211.115 ask for an authorised procedure, not for each cap. The maximum
    // percentage stays required for an engine and database need: the addition is judged against it (G-24, recipe-core
    // 0622), and is refused without it. The maximum age and number of source batches are checked when set.
    if ((r.case === 'REPROCESSING_ADDITION' || r.case === 'RECOVERY') && r.maxPercent === undefined) {
      out.push(error(p.id, `${name} adds material from other batches but does not set the maximum percentage of the batch it may add`));
    }
    if (r.maxPercent !== undefined && (compareDecimal(r.maxPercent, '0') <= 0 || compareDecimal(r.maxPercent, '100') > 0)) out.push(error(p.id, `${name} has a maximum percentage outside 0-100`));
    if (r.case === 'VALIDATED_RETREATMENT' && !(a.nodes.get(p.id)?.ancestors ?? []).some((id) => a.nodes.get(id)?.node.kind === 'loop')) {
      // R-rest A10: no clause asks for the loop; a re-treatment done once is a warning.
      out.push(warning(p.id, `${name} is a validated re-treatment outside a loop; it runs once, with no process endpoint deciding a repeat`));
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

/**
 * Blocks a market's binding clause makes mandatory on a master, stated as data (lead ruling, I-6 B2). A block's `markets`
 * tag is metadata the engine does not read (owner Q0), so this table says when a master for a market must carry a block:
 * each step of `trigger` has a step of `required` on every path AFTER it (the required block follows) or BEFORE it (the
 * required block precedes), or (PRESENT; lead, B5) the master has a step of `required` anywhere, a parallel branch
 * included, where the clause fixes no order to the trigger. A block no binding clause makes mandatory stays optional and
 * has no entry.
 */
export const MARKET_REQUIRED_BLOCKS: readonly { market: string; trigger: string; required: string; relation: 'AFTER' | 'BEFORE' | 'PRESENT'; control: string; clause: string }[] = [
  // ST-06: process and equipment alarms are acknowledged and evaluated (A1 5.2); the filling step records them and the
  // assessment block after it evaluates each one. No clause of Schedule M or 21 CFR 211 asks it, so only the EU.
  { market: 'EU', trigger: 'INJ-FILL', required: 'INJ-ALARM-ASSESSMENT', relation: 'AFTER', control: 'ST-06', clause: 'EU GMP Annex 1 5.2: alarms acknowledged and evaluated' },
  // ST-52: the sterilised filter assembly is integrity tested before use (PUPSIT, A1 8.87). INJ-PUPSIT is its own step,
  // after the filter's sterilisation and before the filtration step; INJ-STERILE-FILTER's own pre-use test is the base
  // test of every market and is not PUPSIT. So on an EU master each filtration step has a PUPSIT step before it (where
  // PUPSIT is not feasible, the block itself records the risk assessment's reference). Only the EU asks it.
  { market: 'EU', trigger: 'INJ-STERILE-FILTER', required: 'INJ-PUPSIT', relation: 'BEFORE', control: 'ST-52', clause: 'EU GMP Annex 1 8.87: sterilised filter assembly integrity tested before use (PUPSIT)' },
  // IN-48: a liquid sterilising filter serves a single batch (A1 8.94). Schedule M 6.11.2.8 limits only the working day,
  // which INJ-STERILE-FILTER asks on every market; so on an EU master each filtration step has the single-batch check of
  // its filter before it. Only the EU asks it.
  { market: 'EU', trigger: 'INJ-STERILE-FILTER', required: 'INJ-FILTER-SINGLE-BATCH', relation: 'BEFORE', control: 'IN-48', clause: 'EU GMP Annex 1 8.94: a liquid sterilising filter discarded after a single batch' },
  // I-6 B5 (lead rulings of 13 November 2026): a clause whose condition is a block of the master (the technology the
  // trigger step uses) is an entry too; a condition known only from an answer at run time is not.
  // ST-79: each piece of a single-use system is checked, and the check documented, before it is used (A1 8.138). INJ-SUS
  // names the assembly where it is used, so the check (INJ-SUS-INTEGRITY) comes before it.
  { market: 'EU', trigger: 'INJ-SUS', required: 'INJ-SUS-INTEGRITY', relation: 'BEFORE', control: 'ST-79', clause: 'EU GMP Annex 1 8.138: each single-use system checked, and the check documented, before use' },
  // ST-58: the lyophiliser's air leakage is checked against its maximum at the start of every cycle and the vent filter's
  // integrity result is part of batch certification (A1 8.124). INJ-LYO-EU records them per load, with each load's
  // sterility samples (A1 10.6(iii)), which exist only once the loads are made, so it follows INJ-LYO.
  { market: 'EU', trigger: 'INJ-LYO', required: 'INJ-LYO-EU', relation: 'AFTER', control: 'ST-58', clause: 'EU GMP Annex 1 8.124: chamber leak test at the start of every cycle, vent filter integrity result part of certification' },
  // ST-62: manual inspection is done under suitable, controlled illumination (A1 8.31). INJ-VISUAL-INSPECT is the manual
  // (and semi-automatic) inspection; the booth's illumination check (INJ-INSPECT-LIGHT) comes before it.
  { market: 'EU', trigger: 'INJ-VISUAL-INSPECT', required: 'INJ-INSPECT-LIGHT', relation: 'BEFORE', control: 'ST-62', clause: 'EU GMP Annex 1 8.31: manual inspection under suitable and controlled illumination' },
  // ST-78: form-fill-seal critical parameters, a batch-specific seal-strength test among them, are verified and recorded
  // during production (A1 8.101(v), 8.102). INJ-FFS-EU reads the settings and tests the units the machine made, after it.
  { market: 'EU', trigger: 'INJ-FFS', required: 'INJ-FFS-EU', relation: 'AFTER', control: 'ST-78', clause: 'EU GMP Annex 1 8.101(v), 8.102: FFS critical parameters recorded, batch-specific seal-strength test' },
  // ST-77: blow-fill-seal critical parameters, a batch-specific wall-thickness test among them, are verified and recorded
  // during production (A1 8.115(vi), 8.116). INJ-BFS-EU reads the settings and measures the units made, after INJ-BFS.
  { market: 'EU', trigger: 'INJ-BFS', required: 'INJ-BFS-EU', relation: 'AFTER', control: 'ST-77', clause: 'EU GMP Annex 1 8.115(vi), 8.116: BFS critical parameters recorded, batch-specific wall-thickness test' },
  // ST-62: an automated inspection machine is challenged with representative defects before start-up and at intervals
  // through the batch (A1 8.32). INJ-AVI-CHALLENGE-EU records both, so it runs before and alongside INJ-AVI: the master
  // has it anywhere, a parallel branch included (PRESENT; lead, B5).
  { market: 'EU', trigger: 'INJ-AVI', required: 'INJ-AVI-CHALLENGE-EU', relation: 'PRESENT', control: 'ST-62', clause: 'EU GMP Annex 1 8.32: automated inspection challenged with representative defects before start-up and through the batch' },
  // Not entries (I-6 B5): INJ-STERILE-PACK-INDICATOR (A1 8.44 allows indicators, asks none); INJ-ASEPTIC-TRANSFER (A1
  // 8.47 applies to items sterilised in sealed packs and passed into Grade A, not through a double-ended steriliser
  // (4.11): no block of the master says which); INJ-VHP and INJ-GLOVE-TEST (A1 4.22(i), 4.21: isolators and RABS, and no
  // block of a master declares an isolator or RABS, so neither is required automatically for the EU: owner residual,
  // lead ruling); INJ-RADIATION-EU (EU GMP Annex 12, not yet extracted among the checked sources: owner residual).
];

function libraryCode(p: PhaseNode): string | undefined {
  return p.block.type.startsWith('LIB-') ? p.block.type.slice('LIB-'.length) : undefined;
}

const requiredBlocks = defineRule('MKT-REQUIRED-BLOCKS', 'A master carries the blocks its market set makes mandatory', ['PR-03', 'IN-52', ...new Set(MARKET_REQUIRED_BLOCKS.map((e) => e.control))], (a) => {
  const out: RuleFinding[] = [];
  for (const entry of MARKET_REQUIRED_BLOCKS) {
    if (!a.mbr.header.marketSet.includes(entry.market)) continue;
    const triggers = a.phases.filter((p) => libraryCode(p) === entry.trigger);
    if (triggers.length === 0) continue;
    // The facts before each task: the phases of the code that ran on every path to it.
    const before = (code: string) =>
      a.mustBefore([], (n) => {
        const p = a.phaseOf(n);
        return p !== undefined && libraryCode(p) === code ? [p.id] : [];
      });
    const required = a.phases.filter((p) => libraryCode(p) === entry.required);
    const ran = (facts: Map<string, Set<string>> | undefined, at: PhaseNode, earlier: PhaseNode) => {
      const t = a.taskOf(at.id);
      return t !== undefined && facts?.get(t.id)?.has(earlier.id) === true;
    };
    const facts = entry.relation === 'PRESENT' ? undefined : before(entry.relation === 'AFTER' ? entry.trigger : entry.required);
    for (const t of triggers) {
      const met =
        entry.relation === 'PRESENT' ? required.length > 0 : entry.relation === 'AFTER' ? required.some((r) => ran(facts, r, t)) : required.some((r) => ran(facts, t, r));
      if (!met) {
        const where = entry.relation === 'PRESENT' ? 'in the master' : `${entry.relation === 'AFTER' ? 'after' : 'before'} it on every path`;
        out.push(error(t.id, `${label(a, t.id)} uses ${entry.trigger} on a master for the ${entry.market} market, which needs a step of ${entry.required} ${where} (${entry.control}; ${entry.clause})`));
      }
    }
  }
  return out;
});

export const CONTENT_RULES: readonly Rule[] = [
  requiredBlocks,
  header,
  plantClasses,
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
  equipmentStatusUnits,
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
];

/** Content-minimum items the generic rules always enforce (India always applies, outline 3.3.6). */
export const GENERIC_COVERED_ITEMS = ['HOLD_TIME_EVERY_INTERMEDIATE', 'SPECIMEN_EVERY_PRINTED_COMPONENT', 'YIELD_LIMITS_EVERY_CHECKPOINT', 'TIMER_VALIDATION_REFERENCE'] as const;
