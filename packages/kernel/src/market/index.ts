/**
 * Market-profile engine (build outline 3.3, 3.5; ADR 0008; IN-52; INV-28, INV-29, INV-47).
 * See README.md in this folder.
 */
export * from './types.ts';
export { MarketRuleError, type RuleTableProblem } from './errors.ts';
export { compareDecimal, isCanonicalDecimal } from './decimal.ts';
export { bindingValue, canonicalJson, categoryRank, floorRank, isAtLeastAsStrict, isSameValue, jsonEqual, setMerge, siteLoosenable } from './strictness.ts';
export { checkedMarketSet, DEFAULT_MARKETS, isEffective, isIsoDate, resolve, selectRow, type ResolveOptions } from './resolve.ts';
export { validateRuleTableDocument, valueProblem } from './validate.ts';
export { snapshotFromDocument } from './snapshot.ts';
export {
  publishRuleTable,
  readRuleTableDirectory,
  ruleCorrectionApprovalTarget,
  readRuleTableFile,
  syncRuleTables,
  type PublishChange,
  type PublishResult,
  type RuleTableFile,
  type SyncOutcome,
} from './loader.ts';
export {
  batchFlags,
  changeImpact,
  currentRuleTableVersion,
  evaluateStubScope,
  listEvaluations,
  loadRuleTableVersion,
  resolveInDatabase,
  setSiteValue,
  siteValuePreview,
  verifyRuleTableVersion,
  type ApprovalTarget,
  type BatchFlag,
  type EvaluateStubScopeRequest,
  type ImpactItem,
  type Queryable,
  type ResolutionPoint,
  type ScopeKind,
  type ScopeRef,
  type SiteOutcome,
  type SiteValuePreview,
  type SiteValueRecord,
  type SiteValueRequest,
  type StoredEvaluation,
  type TableVersionInfo,
} from './repository.ts';
export { resolveForScope, StubResolutionContext, type MarketDerivation, type ResolutionContext, type ResolutionContextProvider, type ScopeContext } from './context.ts';
export {
  applyPolicyTightening,
  batchPolicy,
  definePolicy,
  pinPoliciesForBatch,
  policyForBatch,
  policyVersionApprovalTarget,
  setPolicyVersion,
  type BatchPolicy,
  type PolicyDefinition,
  type PolicyVersion,
} from './policy.ts';
