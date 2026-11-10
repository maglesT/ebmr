/**
 * @ebmr/expr: expression language for MBR calculations: exact decimals, UCUM units with semantic
 * tags, explicit rounding at limit comparison, a closed function library, dependency analysis and
 * evidence (ADR 0005; build outline 6.3, 6.4; controls DI-33, INV-25). Imports nothing else in the
 * repository. See src/README.md.
 */
export const PACKAGE = { name: '@ebmr/expr', version: '0.2.0' } as const;
export { EXPR_LANGUAGE_VERSION, EVALUATION_RECORD_SCHEMA } from './version.ts';

// Decimal core
export { Dec, DecError, DEC_SIGNIFICANT_DIGITS, type DecErrorCode, type RoundingMode } from './decimal/dec.ts';

// Diagnostics
export { hasErrors, type Diagnostic, type Severity, type Span } from './diagnostics.ts';

// Units
export { parseUnit, isValidUnit, sameDimension, describeDimension, UnitError, type Unit, type UnitErrorCode, type Dimension } from './units/unit.ts';
export { convertValue, compareValues, type ConversionRecord } from './units/quantity.ts';
export { TAGS, TAG_LABEL, isTag, tagUnitProblem, type Tag } from './units/tags.ts';
export {
  resolveParameterUnit,
  quantityKindNames,
  unitsOfKind,
  LEGACY_HARDNESS_ALIAS,
  type ParameterUnit,
  type ParameterUnitResult,
  type UnitAlias,
} from './units/parameter-units.ts';
export { UNIT_TABLE } from './units/unit-table.generated.ts';
export type { UnitTable, UnitAtomRecord, QuantityKindRecord, BaseAxis } from './units/unit-table-types.ts';

// Language
export { parse, type ParseResult, MAX_SOURCE_LENGTH, MAX_NESTING_DEPTH } from './lang/parser.ts';
export { print } from './lang/printer.ts';
export { stripSpans, referencedPaths, type Expr, type BinaryOp, type UnaryOp } from './lang/ast.ts';
export { compile, describeType, type CompileOptions, type CompileResult, type CompiledExpression, type TypeDescription } from './lang/compile.ts';
export { DEFAULT_MAX_COST } from './lang/checker.ts';
export type { InputDeclaration, InputDeclarations, InputSource, OutputDeclaration } from './lang/types.ts';
export { MAX_SERIES_LENGTH } from './lang/types.ts';
export type { InputValue, InputValues } from './lang/evaluator.ts';
export { ExprEvaluationError, type EvaluationErrorCode } from './lang/errors.ts';
export { toGuardFormula, type GuardFormula, type GuardComparison } from './lang/guard.ts';

// Library
export { libraryCatalogue } from './library/index.ts';
export { validateAcceptanceTable, lookupAcceptanceTable, type AcceptanceTable, type AcceptanceTableCatalog, type AcceptanceTableRow, type AcceptanceTableBound } from './library/acceptance-tables.ts';

// Rounding
export {
  compareToLimit,
  compareToBound,
  compareAllApply,
  roundForComparison,
  formatForDisplay,
  roundToIncrement,
  writtenDecimals,
  writtenSignificantFigures,
  ROUNDING_RULE_SETS,
  LimitError,
  type RoundingRuleSet,
  type Limit,
  type LimitBound,
  type LimitComparison,
  type BoundCheck,
  type Precision,
  type AllApplyCriterion,
} from './rounding/rounding.ts';

// Dependencies
export {
  buildDependencyGraph,
  classifyDependents,
  assessDecisionChange,
  assessTargetChange,
  type DependencyNode,
  type DependencyKind,
  type DependencyGraph,
  type GraphResult,
  type ClassifiedDependent,
  type DependentClass,
  type DependentAction,
  type QuantityText,
} from './deps/graph.ts';
export { checkCalculationSet, evaluateCalculationSet, type CalculationSetCheck, type CalculationOutcome } from './deps/calculation-set.ts';

// Evidence
export { evaluate, tryEvaluate, verifyEvaluationRecord, recalculate, inputsFromRecord, type EvaluateOptions, type EvaluationResult, type RecordVerification } from './evidence/record.ts';
export type { EvaluationRecord, RecordedInput, RecordedOutput, RecordedConversion, RecordedTableLookup, RecordedCorrection, Supersedes } from './evidence/record-types.ts';
export { canonicalJson, sha256Hex, contentHashOf, compareCodePoints, unstorableText, CanonicalJsonError, UnstorableTextError } from './evidence/hash.ts';
export {
  boundaryValuesForBound,
  limitBoundaryValues,
  generateCalculationVectors,
  runCalculationVectors,
  type BoundaryValue,
  type BoundaryLabel,
  type LimitVector,
  type CalculationVector,
  type CalculationVectorSet,
  type VectorCategory,
  type ExpectedOutcome,
  type VectorGenerationOptions,
} from './evidence/vectors.ts';
