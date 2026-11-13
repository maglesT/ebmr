/**
 * The static validator (outline 6.3): runs the generic rules plus the edition's rule set on one MBR
 * and returns a deterministic report. Errors block; warnings need a recorded justification (`gate`).
 * Identical in the designer and on the server: pure and synchronous over pre-loaded ports.
 */
import { mbrContentHash } from '../flow/canonical.ts';
import type { ExecutionGraph } from '../flow/graph.ts';
import { childrenOf, type FlowNode, type MbrContent } from '../flow/model.ts';
import { Analysis } from './analysis.ts';
import { checkGraph } from './graph-checks.ts';
import type { Rule } from './rule-kit.ts';
import { CONTENT_RULES, GENERIC_COVERED_ITEMS } from './rules-content.ts';
import { DATA_RULES } from './rules-data.ts';
import { boundRuleKeys, marketRule } from './rules-market.ts';
import { graphRuleFor, STRUCTURE_RULES } from './rules-structure.ts';
import { TIME_RULES } from './rules-time.ts';
import type { Finding, GateResult, RuleFinding, ValidationContext, ValidationReport, WarningJustification } from './types.ts';

/**
 * 1.1.0: FLOW-ROLES (every role the master names is an engine role of the installation; review F49).
 * 1.2.0: TIME-MIN-AT-ARRIVAL (a minimum never ends at a start the run records by itself; SQL mutation defect D6) and
 * FLOW-LOOPS refuses a loop inside a loop on the same endpoint (D12). A report of an earlier version checked neither.
 * 1.3.0: MKT-EU-BLOCKS-AFTER (an EU-market master follows its filling step with the assessment of its alarms, ST-06;
 * lead ruling, I-6 B2).
 */
export const VALIDATOR_VERSION = '1.3.0';

/** Rules registered per edition. Editions add theirs with `withEditionRules`; generic rules always run. */
export class RuleRegistry {
  private readonly rules: Rule[] = [];

  constructor(rules: readonly Rule[] = []) {
    for (const r of rules) this.register(r);
  }

  register(rule: Rule): this {
    if (this.rules.some((r) => r.id === rule.id)) throw new Error(`validator rule ${rule.id} is registered twice`);
    this.rules.push(rule);
    return this;
  }

  /** Rules that apply to an MBR of this edition, in registration order. */
  rulesFor(edition: MbrContent['header']['edition']): Rule[] {
    return this.rules.filter((r) => r.edition === 'generic' || r.edition === edition);
  }

  /** Content-minimum items the rules for an edition enforce. */
  coveredItems(edition: MbrContent['header']['edition']): Set<string> {
    return new Set([...GENERIC_COVERED_ITEMS, ...this.rulesFor(edition).flatMap((r) => r.covers ?? [])]);
  }

  all(): readonly Rule[] {
    return this.rules;
  }
}

/** The generic registry (structure, data, time, GMP content, market minima). */
export function createGenericRegistry(): RuleRegistry {
  const registry = new RuleRegistry([...STRUCTURE_RULES, ...DATA_RULES, ...TIME_RULES, ...CONTENT_RULES]);
  registry.register(marketRule((edition) => registry.coveredItems(edition)));
  return registry;
}

/** A registry with edition rule sets added (e.g. the Tablets rules in Phase 3). */
export function withEditionRules(rules: readonly Rule[]): RuleRegistry {
  const registry = createGenericRegistry();
  for (const r of rules) {
    if (r.edition === 'generic') throw new Error(`edition rule ${r.id} must name its edition`);
    registry.register(r);
  }
  return registry;
}

function toFinding(rule: Rule, f: RuleFinding): Finding {
  const controls = [...rule.controls];
  return {
    rule: rule.id,
    controls,
    severity: f.severity,
    subject: f.subject,
    message: `${f.text} (${rule.id}; ${controls.join(', ')})`,
    key: `${rule.id}@${f.subject}`,
  };
}

function compareFindings(a: Finding, b: Finding): number {
  const order = (x: Finding): string => `${x.severity === 'ERROR' ? '0' : '1'}\u0000${x.rule}\u0000${x.subject}\u0000${x.message}`;
  const x = order(a);
  const y = order(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Validates MBR content with every applicable rule. */
export function validateMbr(mbr: MbrContent, ctx: ValidationContext, registry: RuleRegistry = createGenericRegistry()): ValidationReport {
  const analysis = new Analysis(mbr, ctx);
  const rules = registry.rulesFor(mbr.header.edition);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    let produced: RuleFinding[];
    try {
      produced = rule.check(analysis);
    } catch (e) {
      // A rule that cannot run is a failed check, never a pass.
      produced = [{ severity: 'ERROR', subject: '$', text: `Rule ${rule.id} could not complete (${e instanceof Error ? e.message : String(e)})` }];
    }
    for (const f of produced) {
      const finding = toFinding(rule, f);
      const k = `${finding.key}\u0000${finding.message}`;
      if (seen.has(k)) continue;
      seen.add(k);
      findings.push(finding);
    }
  }
  findings.sort(compareFindings);
  return {
    validatorVersion: VALIDATOR_VERSION,
    contentHash: mbrContentHash(mbr),
    edition: mbr.header.edition,
    rules: rules.map((r) => r.id).sort(),
    findings,
    errors: findings.filter((f) => f.severity === 'ERROR').length,
    warnings: findings.filter((f) => f.severity === 'WARNING').length,
  };
}

/**
 * The gate (outline 5.2.1 DRAFT -> IN_VERIFICATION): passes with zero errors and every warning
 * justified by a non-empty recorded justification.
 */
export function gate(report: ValidationReport, justifications: readonly WarningJustification[] = []): GateResult {
  const justified = new Set(justifications.filter((j) => j.text.trim().length > 0 && j.by.trim().length > 0).map((j) => j.key));
  const errors = report.findings.filter((f) => f.severity === 'ERROR');
  const unjustifiedWarnings = report.findings.filter((f) => f.severity === 'WARNING' && !justified.has(f.key));
  const current = new Set(report.findings.filter((f) => f.severity === 'WARNING').map((f) => f.key));
  return {
    passed: errors.length === 0 && unjustifiedWarnings.length === 0,
    errors,
    unjustifiedWarnings,
    unusedJustifications: justifications.map((j) => j.key).filter((k) => !current.has(k)),
  };
}

/** Structure gates on any execution graph (for graphs built or stored outside `compileMbr`). */
export function validateGraph(graph: ExecutionGraph): Finding[] {
  return checkGraph(graph)
    .map((p) => {
      const rule = graphRuleFor(p.code);
      const subject = p.node ?? p.edge ?? '$';
      return { rule, controls: ['DI-34'], severity: 'ERROR' as const, subject, message: `${p.message} (${rule}; DI-34)`, key: `${rule}@${subject}` };
    })
    .sort(compareFindings);
}

/** What the caller must pre-load before validating: references to resolve and rule keys to resolve. */
export function requiredLookups(mbr: MbrContent): { references: MbrContent['references']; ruleKeys: string[]; blockTypes: string[] } {
  const blockTypes = new Set<string>();
  const visit = (n: FlowNode): void => {
    if (n.kind === 'phase') blockTypes.add(`${n.block.type}@${n.block.version}`);
    childrenOf(n).forEach(visit);
  };
  visit(mbr.procedure.body);
  for (const e of mbr.library) visit(e.body);
  return { references: mbr.references, ruleKeys: boundRuleKeys({ mbr }), blockTypes: [...blockTypes].sort() };
}
