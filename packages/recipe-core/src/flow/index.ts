/**
 * MBR content model, parser, canonical hash, library expansion, compiler, execution graph, token
 * semantics, time-constraint evaluation, structured diff and the expression-language port.
 * See README.md in this folder.
 */
export * from './model.ts';
export { parseMbr, parseFlowNodeStandalone, MAX_FLOW_DEPTH, MAX_LOOP_ITERATIONS, MAX_REPLICATE_INSTANCES, type ParseProblem, type ParseResult } from './parse.ts';
export { canonicalJson, sha256Hex, mbrContentHash, libraryElementHash, flowNodeHash } from './canonical.ts';
export {
  isDecimalLiteral,
  parseDecimal,
  decimalsOf,
  canonicalDecimal,
  compareDecimal,
  addDecimal,
  subtractDecimal,
  midpointDecimal,
  durationToMicros,
  formatMicros,
  isTimeUnit,
  TIME_UNIT_MICROS,
  type ScaledDecimal,
} from './decimal.ts';
export { BLOCK_ROLES, GENERIC_BLOCKS, GENERIC_BLOCK_ALIASES, createBlockCatalog, genericBlockCatalog, type BlockCatalog, type BlockDescriptor, type BlockRole } from './blocks.ts';
export { expandLibraryCalls, resolveIdentifier, type ExpandedFlow, type ExpansionProblem, type LibraryScope } from './expand.ts';
export { compileFlow, compileMbr, type CompiledMbr } from './compile.ts';
export { indexGraph, forwardTopologicalOrder, type EdgeKind, type ExecutionGraph, type GraphEdge, type GraphIndex, type GraphNode, type GraphNodeKind, type GraphRegion, type JoinRule, type RegionKind } from './graph.ts';
export { TokenGame, boundsOf, contextKey, type Bounds, type Choice, type Enabled, type Frame, type GameException, type Marking, type Occurrence, type Token } from './tokens.ts';
export { evaluateTimeConstraint, TimeConstraintError, type TimeConstraintEvaluation, type TimeConstraintStatus, type TimeObservation } from './time.ts';
export { diffMbr, structureHash, type Change, type ChangeClass, type MbrDiff } from './diff.ts';
export { numberMbr, numberFlow, instanceNumber, NumberingError, type InstanceNumber, type MbrNumbering, type NumberedKind, type NumberedNode } from './numbering.ts';
export { CAPTURE_WORDS, CHECK_PERMISSIONS, capturedOtherwise, checkersInRun, checkRunsAsWitness, handEntriesNamingAttachment, type CheckerRoles, type CheckersInRun } from './check-in-release.ts';
export { databaseMassClass, type DatabaseMassClass } from './weighed-units.ts';
export { productLineOf, editionOfDosageForm, readDosageForm, isCapsuleForm, isShellLine, formulaRoleLabel, bomShellsLabel, SHELLS_LABEL, type DosageFormReading, type ProductLine, type UnitForm } from './dosage-form.ts';
export type {
  BoundaryVector,
  BoundComparison,
  EvaluationOutcome,
  ExpressionCheck,
  ExpressionOptions,
  ExpressionProblem,
  ExpressionService,
  ExprType,
  ExprValue,
  GuardFormula,
} from './expression-port.ts';
export { createExprService, declarationOf, type ExprAdapterOptions } from './expr-adapter.ts';
export { coatingLayerParts, contentIds, layerProblem, type CoatingLayer, type LayerParts } from './coating-layer.ts';
