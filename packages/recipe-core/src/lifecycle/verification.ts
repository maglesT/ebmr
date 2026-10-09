/**
 * The verification port of the MBR life cycle (outline 5.2.1, 6.3, 6.5; DI-04).
 *
 * The life cycle never validates or simulates by itself: it calls a VerificationPort, whose
 * implementation is the flow model's static validator and simulator (../validator, ../simulator).
 * They run in TypeScript before the command; the command stores their result with the exact content
 * hash (recipe.record_evidence), and the database decides PASS or FAIL from the stored report
 * (it recounts validator findings and justifications and recomputes the simulator's evidence seal).
 * The guards then require a stored PASS for the current hash; any content edit voids it.
 *
 * The report shapes built here are the contract with sql/0120_mbr_evidence.sql.
 */
import { mbrContentHash } from '../flow/canonical.ts';
import type { MbrContent } from '../flow/model.ts';
import { deltaVerification, verifyMbr, type VerificationEvidence } from '../simulator/evidence.ts';
import type { SimulationOptions, SimulationReport } from '../simulator/simulate.ts';
import type { ValidationContext, ValidationReport, WarningJustification } from '../validator/types.ts';
import { validateMbr, type RuleRegistry } from '../validator/validate.ts';
import type { MbrDiff } from '../flow/diff.ts';

export interface FullVerification {
  report: ValidationReport;
  simulation: SimulationReport;
  evidence: VerificationEvidence;
}

export type DeltaVerification =
  | { diff: MbrDiff; evidence: VerificationEvidence; report: ValidationReport; simulation: SimulationReport }
  | { diff: MbrDiff; refused: string };

/** What the life cycle needs from the validator and the simulator. */
export interface VerificationPort {
  /** The static validator (outline 6.3) on one MBR content. */
  validate(content: MbrContent): ValidationReport;
  /** Validator, simulation and sealed FULL verification evidence (outline 6.5). */
  verify(content: MbrContent, justifications: readonly WarningJustification[]): FullVerification;
  /** Delta verification against a verified predecessor (outline 6.5, L-60). */
  deltaVerify(previous: MbrContent, previousEvidence: VerificationEvidence, next: MbrContent, justifications: readonly WarningJustification[]): DeltaVerification;
}

export interface VerificationPortOptions {
  registry?: RuleRegistry;
  simulation?: SimulationOptions;
}

/** The port over the flow model's validator and simulator, with pre-loaded validation ports. */
export function createVerificationPort(context: ValidationContext, options: VerificationPortOptions = {}): VerificationPort {
  return {
    validate: (content) => validateMbr(content, context, options.registry),
    verify: (content, justifications) =>
      verifyMbr(content, context, justifications, {
        ...(options.registry ? { registry: options.registry } : {}),
        ...(options.simulation ? { simulation: options.simulation } : {}),
      }),
    deltaVerify: (previous, previousEvidence, next, justifications) => deltaVerification(previous, previousEvidence, next, context, justifications, options.registry),
  };
}

// ---------------------------------------------------------------------------------------------
// Report shapes stored with recipe.record_evidence
// ---------------------------------------------------------------------------------------------

/** VALIDATOR: the full validator report and the recorded warning justifications. */
export interface ValidatorEvidenceReport {
  validation: ValidationReport;
  justifications: WarningJustification[];
}

export function validatorEvidence(report: ValidationReport, justifications: readonly WarningJustification[] = []): ValidatorEvidenceReport {
  return { validation: report, justifications: [...justifications] };
}

/** TEST_VECTORS: the generated boundary vectors and golden cases the author confirmed. */
export interface TestVectorReport {
  contentHash: string;
  simulatorVersion: string;
  goldenCases: { id: string; status: string }[];
  boundaryVectors: number;
  confirmedBy: string;
}

export function testVectorEvidence(simulation: SimulationReport, confirmedBy: string): TestVectorReport {
  return {
    contentHash: simulation.contentHash,
    simulatorVersion: simulation.simulatorVersion,
    goldenCases: simulation.golden.map((g) => ({ id: `${g.case}/${g.calculation}`, status: g.status })),
    boundaryVectors: simulation.limits.length + simulation.guards.length + simulation.time.length,
    confirmedBy,
  };
}

/** SANDBOX_RUN: a run on the real screens in the sandbox database on this exact content (outline 6.5; DI-05). */
export interface SandboxRunReport {
  contentHash: string;
  runId: string;
  sandbox: string;
  coverage: Record<string, unknown>;
  passed: boolean;
}

export function sandboxRunEvidence(content: MbrContent, run: Omit<SandboxRunReport, 'contentHash'>): SandboxRunReport {
  return { contentHash: mbrContentHash(content), ...run };
}
