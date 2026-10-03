/**
 * Static validator: findings, rules, the rule registry and the ports the validator reads.
 *
 * The validator is pure and synchronous, and identical in the designer and on the server (outline
 * 6.3). Everything outside the MBR (block catalogue, reference status, market-resolved minima, the
 * expression language) comes through ports that the caller pre-loads; `requiredLookups(mbr)` says
 * what to fetch.
 */
import type { BlockCatalog } from '../flow/blocks.ts';
import type { ExpressionService } from '../flow/expression-port.ts';
import type { Edition, Reference } from '../flow/model.ts';

export type Severity = 'ERROR' | 'WARNING';

export interface Finding {
  /** Rule id, e.g. "GMP-TIMER-SOURCE". */
  rule: string;
  /** Control and invariant ids the rule serves, e.g. ["PR-03", "INV-34"]. */
  controls: string[];
  severity: Severity;
  /** Id of the node or item the finding is about ("$" for the record as a whole). */
  subject: string;
  /** Plain language first, then the rule and controls in brackets. */
  message: string;
  /** Stable key a warning justification refers to: `${rule}@${subject}`. */
  key: string;
}

/** What a rule reports; the registry adds the rule id, controls, message suffix and key. */
export interface RuleFinding {
  severity: Severity;
  subject: string;
  text: string;
}

export type RuleEdition = 'generic' | Edition;

export interface ValidationRule<S = unknown> {
  id: string;
  title: string;
  controls: readonly string[];
  edition: RuleEdition;
  check(subject: S): RuleFinding[];
}

/** Status of a pinned reference at the validation date (outline 6.3 "all references effective"). */
export type ReferenceStatus = 'EFFECTIVE' | 'NOT_YET_EFFECTIVE' | 'SUPERSEDED' | 'RETIRED' | 'WITHDRAWN' | 'HASH_MISMATCH' | 'UNKNOWN';

export interface ReferencePort {
  status(reference: Reference): ReferenceStatus;
}

/** A content minimum resolved by the market-profile engine for the MBR's market set (outline 3.3.5, 6.3). */
export type ResolvedMinimum =
  /** Every MBR limit or time constraint bound to `ruleKey` must be at least as strict as `value`. */
  | {
      kind: 'LIMIT';
      ruleKey: string;
      /** HIGH: the MBR's upper bound (or maximum duration) may not exceed value; LOW: its lower bound may not be below it. */
      bound: 'LOW' | 'HIGH';
      value: string;
      unit: string;
      governingMarkets: string[];
      tableVersion: string;
    }
  /** A content item the market set requires; `item` is interpreted by a generic or edition rule. */
  | { kind: 'REQUIRED_ITEM'; ruleKey: string; item: string; governingMarkets: string[]; tableVersion: string }
  /** The engine could not resolve a key (e.g. a predicate is missing): validation fails closed. */
  | { kind: 'UNRESOLVED'; ruleKey: string; problem: string };

export interface MinimaRequest {
  edition: Edition;
  recordKind: 'PROCESSING' | 'PACKAGING';
  marketSet: readonly string[];
  predicates: Readonly<Record<string, string | boolean>>;
  /** Site-calendar date YYYY-MM-DD the rules are resolved for. */
  asOf: string;
  /** Rule keys the MBR binds (parameters and time constraints with a `marketRule`). */
  ruleKeys: readonly string[];
}

/** Port to the kernel market-profile engine (implemented by the kernel/edition adapter, ADR 0008). */
export interface MarketMinimaPort {
  minima(request: MinimaRequest): ResolvedMinimum[];
}

/**
 * The engine roles of the installation (review F49): the roles a session can carry on the floor (tablets:
 * recipe.engine_role_permission, reached from kernel roles through tab.engine_role_map). Every role an MBR names (who
 * performs, checks, releases a hold point, signs off a stage, may choose a branch) must be one of them, or no person
 * can ever act in that place.
 */
export interface RoleVocabularyPort {
  engineRoles: readonly string[];
}

export interface ValidationContext {
  expressions: ExpressionService;
  blocks: BlockCatalog;
  references: ReferencePort;
  /** Absent: market minima are not checked and the validation fails closed (error MKT-UNRESOLVED). */
  market?: MarketMinimaPort;
  /** Absent: the roles cannot be checked and the validation fails closed (error FLOW-ROLES). */
  roles?: RoleVocabularyPort;
  /** Validation date (YYYY-MM-DD), passed in: domain code never reads the clock. */
  asOf: string;
  /** Upper bounds for the analyses (defaults in DEFAULT_LIMITS). */
  limits?: Partial<AnalysisLimits>;
}

export interface AnalysisLimits {
  /** Representative points for the guard decision procedure. */
  guardPoints: number;
  /** Time points in the unrolled temporal network. */
  timePoints: number;
  /** Alternative-choice scenarios checked separately when the union network is inconsistent. */
  timeScenarios: number;
}

export const DEFAULT_LIMITS: AnalysisLimits = { guardPoints: 20_000, timePoints: 20_000, timeScenarios: 256 };

/** A recorded justification for a warning (outline 6.3: warnings need a recorded justification). */
export interface WarningJustification {
  key: string;
  text: string;
  /** Person id of the author who justified it. */
  by: string;
}

export interface ValidationReport {
  validatorVersion: string;
  contentHash: string;
  edition: Edition;
  /** Rule ids that ran, sorted. */
  rules: string[];
  findings: Finding[];
  errors: number;
  warnings: number;
}

export interface GateResult {
  passed: boolean;
  errors: Finding[];
  unjustifiedWarnings: Finding[];
  /** Justifications that name no current warning (stale); they do not block but are reported. */
  unusedJustifications: string[];
}
