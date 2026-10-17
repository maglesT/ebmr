/**
 * @ebmr/analytics (ADR 0020): pure computation for advisory analytics. It imports nothing in the repository, no
 * database driver and no node core module; only the runner (apps/tablets-server/src/analytics/) and tests import it.
 * GMP values enter as decimal text through `statOf` only (ADR 0020 point 5).
 */
export { AnalyticsInputError } from './errors.ts';
export { decimalText, isDecimalText, statOf, type DecimalText } from './numeric/from-decimal.ts';
export { canonicalNumber, canonicalText, outputHash } from './numeric/canonical.ts';
export { sha256Hex, sha256HexOfBytes } from './numeric/sha256.ts';
export { betaQuantile, chiSquareQuantile, fQuantile, normalQuantile, tQuantile } from './numeric/quantiles.ts';
export { EigenvalueDecomposition, Matrix, SingularValueDecomposition } from './numeric/linalg.ts';
export { ANALYTICS_PACKAGE_VERSION, RUNTIME_LIBRARIES } from './runtime.ts';
export {
  METHOD_IDS,
  type Method,
  type MethodId,
  type MethodResult,
  type MethodVersion,
  type ParameterValue,
  type Parameters,
  type ReferenceModel,
  type Skipped,
} from './method.ts';
export { METHODS, defaultParameters, parameterProblems, type InputKind, type MethodEntry, type ParameterSpec } from './registry.ts';
export {
  OUTPUT_KINDS,
  SUBJECT_KINDS,
  type Evidence,
  type FlagDraft,
  type OutputDraft,
  type OutputKind,
  type Reason,
  type Severity,
  type SubjectKind,
} from './types.ts';
