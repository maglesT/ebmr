/**
 * Static verification evidence for one MBR version (DI-04, static part; outline 5.2.1, 6.5).
 *
 * The evidence binds the validator report (with warning justifications) and the simulation report
 * to the exact content hash. The MBR life-cycle module requires evidence whose content hash equals
 * the version's hash before it can leave IN_VERIFICATION; any edit changes the hash and voids it.
 * For a version that differs from its verified predecessor only in values, `deltaVerification`
 * reuses the predecessor's structural evidence and reruns the boundary vectors of the changed items.
 */
import { canonicalJson, mbrContentHash, sha256Hex } from '../flow/canonical.ts';
import { diffMbr, type MbrDiff } from '../flow/diff.ts';
import type { MbrContent } from '../flow/model.ts';
import type { GateResult, ValidationContext, ValidationReport, WarningJustification } from '../validator/types.ts';
import { gate, validateMbr, type RuleRegistry } from '../validator/validate.ts';
import { simulate, type SimulationOptions, type SimulationReport } from './simulate.ts';

export interface VerificationEvidence {
  kind: 'FULL' | 'DELTA';
  contentHash: string;
  validator: { version: string; errors: number; warnings: number; justifiedWarnings: string[]; passed: boolean; reportHash: string };
  simulation: { version: string; reportHash: string; passed: boolean; exactPaths: string; boundHit: boolean };
  languageVersion: string;
  /** For DELTA: the predecessor's content hash and evidence hash whose structural part is reused. */
  basis?: { contentHash: string; evidenceHash: string; changedSubjects: string[] };
  verdict: 'VERIFIED' | 'NOT_VERIFIED';
  reasons: string[];
  evidenceHash: string;
}

function seal(e: Omit<VerificationEvidence, 'evidenceHash'>): VerificationEvidence {
  return { ...e, evidenceHash: sha256Hex(canonicalJson(e)) };
}

function reasonsOf(g: GateResult, sim: SimulationReport): string[] {
  return [
    ...g.errors.map((f) => f.message),
    ...g.unjustifiedWarnings.map((f) => `unjustified warning: ${f.message}`),
    ...sim.problems.map((p) => `simulation: ${p}`),
  ];
}

export function buildVerificationEvidence(mbr: MbrContent, report: ValidationReport, justifications: readonly WarningJustification[], sim: SimulationReport): VerificationEvidence {
  const hash = mbrContentHash(mbr);
  const g = gate(report, justifications);
  const reasons = reasonsOf(g, sim);
  if (report.contentHash !== hash) reasons.push('the validator report is for other content');
  if (sim.contentHash !== hash) reasons.push('the simulation report is for other content');
  return seal({
    kind: 'FULL',
    contentHash: hash,
    validator: {
      version: report.validatorVersion,
      errors: report.errors,
      warnings: report.warnings,
      justifiedWarnings: report.findings.filter((f) => f.severity === 'WARNING' && !g.unjustifiedWarnings.includes(f)).map((f) => f.key),
      passed: g.passed,
      reportHash: sha256Hex(canonicalJson(report)),
    },
    simulation: { version: sim.simulatorVersion, reportHash: sim.reportHash, passed: sim.passed, exactPaths: sim.paths.exact, boundHit: sim.paths.boundHit },
    languageVersion: sim.languageVersion,
    verdict: reasons.length === 0 ? 'VERIFIED' : 'NOT_VERIFIED',
    reasons,
  });
}

/** Validates, simulates and seals the evidence in one call. */
export function verifyMbr(
  mbr: MbrContent,
  ctx: ValidationContext,
  justifications: readonly WarningJustification[] = [],
  options: { registry?: RuleRegistry; simulation?: SimulationOptions } = {},
): { report: ValidationReport; simulation: SimulationReport; evidence: VerificationEvidence } {
  const report = validateMbr(mbr, ctx, options.registry);
  const simulation = simulate(mbr, ctx, options.simulation);
  return { report, simulation, evidence: buildVerificationEvidence(mbr, report, justifications, simulation) };
}

/** True only for VERIFIED evidence of exactly this content that has not been altered. */
export function evidenceHolds(mbr: MbrContent, evidence: VerificationEvidence): boolean {
  const { evidenceHash, ...rest } = evidence;
  return evidence.verdict === 'VERIFIED' && evidence.contentHash === mbrContentHash(mbr) && sha256Hex(canonicalJson(rest)) === evidenceHash;
}

/**
 * Delta verification (outline 6.5): allowed only when the new version differs from a verified
 * predecessor in values alone. The full validator always reruns (it is cheap and value changes can
 * break nesting or market minima); the simulation reruns boundary vectors and golden cases for the
 * changed items only, reusing the predecessor's path and coverage evidence.
 */
export function deltaVerification(
  previous: MbrContent,
  previousEvidence: VerificationEvidence,
  next: MbrContent,
  ctx: ValidationContext,
  justifications: readonly WarningJustification[] = [],
  registry?: RuleRegistry,
): { diff: MbrDiff; evidence: VerificationEvidence; report: ValidationReport; simulation: SimulationReport } | { diff: MbrDiff; refused: string } {
  const diff = diffMbr(previous, next);
  if (!evidenceHolds(previous, previousEvidence)) return { diff, refused: 'the predecessor has no valid verification evidence for its content' };
  if (diff.classification !== 'VALUE_ONLY') return { diff, refused: `the change is ${diff.classification.toLowerCase().replace('_', ' ')}; a full verification is required` };
  const report = validateMbr(next, ctx, registry);
  const simulation = simulate(next, ctx, { only: new Set(diff.changedSubjects) });
  const g = gate(report, justifications);
  const reasons = reasonsOf(g, simulation);
  const evidence = seal({
    kind: 'DELTA',
    contentHash: mbrContentHash(next),
    validator: {
      version: report.validatorVersion,
      errors: report.errors,
      warnings: report.warnings,
      justifiedWarnings: report.findings.filter((f) => f.severity === 'WARNING' && !g.unjustifiedWarnings.includes(f)).map((f) => f.key),
      passed: g.passed,
      reportHash: sha256Hex(canonicalJson(report)),
    },
    simulation: { version: simulation.simulatorVersion, reportHash: simulation.reportHash, passed: simulation.passed, exactPaths: previousEvidence.simulation.exactPaths, boundHit: previousEvidence.simulation.boundHit },
    languageVersion: simulation.languageVersion,
    basis: { contentHash: previousEvidence.contentHash, evidenceHash: previousEvidence.evidenceHash, changedSubjects: diff.changedSubjects },
    verdict: reasons.length === 0 ? 'VERIFIED' : 'NOT_VERIFIED',
    reasons,
  });
  return { diff, evidence, report, simulation };
}
