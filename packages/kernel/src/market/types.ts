/**
 * Market-profile engine types (build outline 3.3; ADR 0008).
 *
 * Rule values are JSON without numbers: a decimal is a canonical decimal string, so no GMP value
 * ever passes through a JavaScript `number` (CLAUDE.md). The only numbers here are version counters.
 */

/** Market codes are data (market.market); India ('IN') always applies (INV-28). */
export type Market = string;
export const INDIA: Market = 'IN';

export const RULE_TABLES = ['kernel', 'tablets', 'sterile'] as const;
export type RuleTableCode = (typeof RULE_TABLES)[number];
export const KEY_PREFIX: Record<RuleTableCode, string> = { kernel: 'kernel.', tablets: 'tablets.', sterile: 'sterile.' };

export const COMPARISON_METHODS = [
  'SMALLER_STRICTER',
  'LARGER_STRICTER',
  'ORDERED',
  'REQUIRED_IF_ANY',
  'SET_UNION',
  'ALL_APPLY',
  'NOT_COMPARABLE',
] as const;
export type ComparisonMethod = (typeof COMPARISON_METHODS)[number];

export const VALUE_TYPES = ['DECIMAL', 'BOOLEAN', 'CATEGORY', 'SET', 'CRITERIA', 'ANY'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

export const FLOOR_TYPES = ['HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN'] as const;
/** HARD = binding number; GUIDANCE = guidance value; EXAMPLE = a regulator's example we adopted; DESIGN = our product choice. */
export type FloorType = (typeof FLOOR_TYPES)[number];

export const VERIFICATION_STATUSES = ['P', 'P~', 'S', 'U', 'CHK', 'GK'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const STATED_METHODS = ['PER_DESTINATION'] as const;
export type StatedMethodName = (typeof STATED_METHODS)[number];

/** JSON value without numbers. */
export type RuleValue = string | boolean | null | RuleValue[] | { [key: string]: RuleValue };
export type PredicateValue = string | boolean;
export type Predicates = Record<string, PredicateValue>;

/** A criterion of an ALL_APPLY key: an object with an identifier. */
export interface Criterion {
  id: string;
  [field: string]: RuleValue;
}

/** Key definition as written in a rule-table file (document form). */
export interface RuleKeyDoc {
  key: string;
  title: string;
  method: ComparisonMethod;
  valueType: ValueType;
  unit: string;
  orderedValues?: string[] | null;
  statedMethod?: StatedMethodName | null;
  indiaGoverns: boolean;
  /** Allowed values of each predicate attribute the key's rows may use. */
  predicates?: Record<string, PredicateValue[]>;
  catalogRefs?: string[];
  description?: string | null;
}

/** Rule row as written in a rule-table file (document form). */
export interface RuleRowDoc {
  ref: string;
  key: string;
  market: Market;
  predicate?: Predicates;
  value: RuleValue;
  unit: string;
  floor: FloorType;
  hardFloor?: RuleValue;
  source: string;
  verification: VerificationStatus;
  /** YYYY-MM-DD; the window is [effectiveFrom, effectiveTo). */
  effectiveFrom: string;
  effectiveTo?: string | null;
  note?: string | null;
}

export type ChangeKind = 'INITIAL' | 'UPDATE' | 'SOURCE_CORRECTION';

export interface RuleTableChange {
  kind: ChangeKind;
  description: string;
  citation?: string;
  vendorNoticeRef?: string;
}

/** A rule-table file: the full content of one table version. */
export interface RuleTableDocument {
  table: RuleTableCode;
  version: number;
  title?: string;
  change?: RuleTableChange;
  keys: RuleKeyDoc[];
  rows: RuleRowDoc[];
}

/** A row inside a snapshot: document form plus its identity, with defaults filled in. */
export interface SnapshotRow {
  id: string;
  ref: string;
  key: string;
  market: Market;
  predicate: Predicates;
  value: RuleValue;
  unit: string;
  floor: FloorType;
  hardFloor: RuleValue;
  source: string;
  verification: VerificationStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
}

/** One immutable table version, ready for the pure resolver. */
export interface RuleTableSnapshot {
  versionId: string;
  tableCode: RuleTableCode;
  version: number;
  keys: ReadonlyMap<string, RuleKeyDoc>;
  rows: readonly SnapshotRow[];
}

/** For a NOT_COMPARABLE key: the author's stated method and its regulatory decision reference. */
export interface StatedMethod {
  method: StatedMethodName;
  destination?: Market;
  decisionRef?: string;
}

export interface ResolveRequest {
  key: string;
  marketSet: readonly Market[];
  predicates?: Predicates;
  /** Site-calendar date, YYYY-MM-DD. */
  asOf: string;
  stated?: StatedMethod | null;
}

export interface Contribution {
  market: Market;
  rowId: string;
  rowRef: string;
  value: RuleValue;
  floorType: FloorType;
  hardFloor: RuleValue;
  predicate: Predicates;
}

/** For SET_UNION and ALL_APPLY: each element with the markets that require it. */
export interface Component {
  value: RuleValue;
  markets: Market[];
  floorType: FloorType;
}

export interface ResolutionInputs {
  key: string;
  tableVersionId: string;
  marketSet: Market[];
  predicates: Predicates;
  asOf: string;
  stated: StatedMethod | null;
}

/** The result of resolving one atomic key; identical in shape to market.resolve in SQL. */
export interface Resolution {
  key: string;
  tableCode: RuleTableCode;
  tableVersionId: string;
  tableVersion: number;
  method: ComparisonMethod;
  valueType: ValueType;
  unit: string;
  /** False when no market in the set has a row for the key (a key India does not govern). */
  applicable: boolean;
  value: RuleValue;
  governingMarkets: Market[];
  floorType: FloorType | null;
  /** The strictest binding value (HARD values and hard floors); no site value may pass it. */
  hardFloor: RuleValue;
  predicateBranch: Record<Market, Predicates>;
  contributions: Contribution[];
  components: Component[] | null;
  stated: { method: StatedMethodName; destination: Market; decisionRef: string } | null;
  inputs: ResolutionInputs;
}
