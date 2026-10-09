/**
 * Automated simulation and verification evidence (outline 6.5; DI-04 static part). See README.md in
 * this folder.
 */
export { simulate, pathSteps, SIMULATOR_VERSION, type Coverage, type SimulationOptions, type SimulationReport } from './simulate.ts';
export { exactPathCount, enumeratePaths, runOnce, targetedRun, decisionOptions, coveredOptions, RunawayError, type PathResult } from './paths.ts';
export { limitVectors, guardVectors, timeVectors, type GuardVectorResult, type LimitVectorResult, type TimeVectorResult } from './boundary.ts';
export { runGoldenCase, calculationOrder, type GoldenResult } from './golden.ts';
export { buildVerificationEvidence, verifyMbr, evidenceHolds, deltaVerification, type VerificationEvidence } from './evidence.ts';
