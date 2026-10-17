/**
 * The evidence bundle v1 as TypeScript types (docs/build-plan/phase-7/slice-7-0-interfaces.md section 1).
 *
 * Written by hand beside `bundle.schema.json`; test/bundle.test.ts checks at compile time and at run time that every
 * object type here names exactly the properties and required keys of its schema definition. This is validation
 * tooling, not GMP domain code: durations, counts and sizes are plain numbers; GMP values in records travel as text.
 */

export type Edition = 'tablets' | 'injectables';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type ControlType = 'ENFORCED' | 'CONFIGURABLE' | 'DESIGN_CHOICE';
export type RunKind = 'vitest' | 'golden' | 'playwright' | 'load' | 'drill' | 'security' | 'accessibility' | 'mutation';
export type ResultStatus = 'passed' | 'failed' | 'skipped';
export type ClauseTraceStatus = 'PROVEN' | 'DEFERRED' | 'MISSING';
export type ControlClass = 'core' | 'other';
export type ExpertStatus = 'PENDING' | 'FOLLOW' | 'DONT_FOLLOW' | 'MODIFY';
export type BuildStatus = 'SPECIFIED' | 'IMPLEMENTED' | 'VERIFIED';
export type RecordKind = 'load' | 'soak' | 'restore' | 'upgrade' | 'migration-dry-run' | 'security' | 'accessibility' | 'mutation' | 'iq' | 'oq';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Release {
  product: string;
  maker: string;
  version: string;
  /** The git commit (lowercase hex). */
  commit: string;
  /** The commit time, ISO 8601 UTC. */
  commitTime: string;
  /** Lowercase hex SHA-256 over the migration ledger, as `platform.schema_release()` computes it (section 4). */
  schemaRelease: string;
}

export interface Deferral {
  phase: number;
  reason: string;
}

export interface Clause {
  clause: string;
  tests: string[];
  deferred?: Deferral;
}

export interface DeferredScope {
  scope: string;
  phase: number;
  reason: string;
}

export interface ExpertDecision {
  status: ExpertStatus;
  reviewer: string | null;
  date: string | null;
  packVersion: string;
}

export interface Control {
  id: string;
  title: string;
  editions: Edition[];
  type: ControlType[];
  targetPhase: number;
  sources: string;
  behaviour: string;
  catalogTest: string;
  requirementRows: number[];
  implementedBy: Record<string, string[]>;
  clauses: Clause[];
  deferredScope: DeferredScope[];
  expertDecision: ExpertDecision;
  buildStatus: BuildStatus;
  /** True for the status-U drafts. */
  draft: boolean;
  class: ControlClass;
}

export interface Requirement {
  n: number;
  source: string;
  verification: 'primary' | 'secondary' | 'unverified';
  paraphrase: string;
}

export interface Register {
  controls: Control[];
  requirements: Requirement[];
}

export interface Host {
  cpu: string;
  memory: string;
  os: string;
  node: string;
  postgres: string | null;
}

export interface Run {
  id: string;
  kind: RunKind;
  commit: string;
  startedAt: string;
  finishedAt: string;
  reportFile: string;
  reportSha256: string;
  host: Host;
}

export interface Result {
  /** The `<file> > ... > title` form the register uses. */
  test: string;
  run: string;
  status: ResultStatus;
  durationMs: number;
  controls: string[];
  /** The browser suite's step record. */
  evidence?: Record<string, unknown>;
}

export interface TraceClause {
  clause: string;
  status: ClauseTraceStatus;
}

export interface TraceControl {
  control: string;
  passing: string[];
  clauses: TraceClause[];
}

export interface Trace {
  phase: number;
  editions: Edition[];
  ok: boolean;
  controls: TraceControl[];
}

export interface InvMigration {
  namespace: string;
  name: string;
  sha256: string;
}
export interface InvFunction {
  schema: string;
  name: string;
  argTypes: string;
  securityDefiner: boolean;
  owner: string;
  executeRoles: string[];
}
export interface InvTrigger {
  table: string;
  name: string;
  enabled: boolean;
  function: string;
}
export interface InvConstraint {
  table: string;
  name: string;
  kind: string;
  definitionSha256: string;
}
export interface InvPrivilege {
  role: string;
  object: string;
  privilege: string;
}
export interface InvRole {
  name: string;
  login: boolean;
  superuser: boolean;
  createRole: boolean;
  bypassRls: boolean;
  inherit: boolean;
  connectionLimit: number;
}
export interface InvSetting {
  name: string;
  value: string;
  expected: string | null;
}
export interface InvAuditedTable {
  table: string;
}
export interface InvPermission {
  permission: string;
  roles: string[];
  scopeKinds: string[];
}
export interface InvMeaning {
  meaning: string;
}
export interface InvMessage {
  code: string;
  text: string;
  sourceFile: string;
}
export interface InvTransition {
  from: string;
  event: string;
  to: string;
}
export interface InvStateChart {
  machine: string;
  states: string[];
  transitions: InvTransition[];
}
export interface InvBlock {
  blockType: string;
  version: number;
  controls: string[];
}
export interface InvRuleKey {
  key: string;
}
export interface InvRoute {
  namespace: string;
  route: string;
  method: HttpMethod;
  permission: string | null;
}

export interface Inventory {
  migrations: InvMigration[];
  functions: InvFunction[];
  triggers: InvTrigger[];
  constraints: InvConstraint[];
  privileges: InvPrivilege[];
  roles: InvRole[];
  settings: InvSetting[];
  auditedTables: InvAuditedTable[];
  permissions: InvPermission[];
  meanings: InvMeaning[];
  messages: InvMessage[];
  stateCharts: InvStateChart[];
  blocks: InvBlock[];
  ruleKeys: InvRuleKey[];
  routes: InvRoute[];
}

export interface CriticalLimit {
  key: string;
  description: string;
  controls: string[];
  boundaryTests: string[];
}

export interface OpenFixed {
  open: number;
  fixed: number;
}

export interface FindingCounts {
  critical: OpenFixed;
  high: OpenFixed;
  medium: OpenFixed;
  low: OpenFixed;
}

export interface Review {
  id: string;
  date: string;
  scope: string[];
  findings: FindingCounts;
}

export interface OpenFinding {
  id: string;
  severity: Severity;
  controls: string[];
  summary: string;
  source: string;
}

export interface AnalyticsMethod {
  id: string;
  versions: string[];
  intendedUse: string;
  changesGmpData: boolean;
}

export interface Analytics {
  methods: AnalyticsMethod[];
}

export interface Measure {
  name: string;
  /** Decimal text. */
  value: string;
  unit: string;
  limit: string | null;
}

/** A Phase 7 record (load, soak, restore, ...); named PhaseRecord so it does not shadow TypeScript's Record. */
export interface PhaseRecord {
  kind: RecordKind;
  file: string;
  sha256: string;
  passed: boolean;
  summary: string;
  measures: Measure[];
}

export interface Sbom {
  file: string;
  sha256: string;
  format: 'CycloneDX 1.5';
}

export interface KnownIssue {
  id: string;
  severity: Severity;
  controls: string[];
  text: string;
}

export interface Bundle {
  bundleVersion: 1;
  edition: Edition;
  release: Release;
  register: Register;
  runs: Run[];
  results: Result[];
  trace: Trace;
  inventory: Inventory;
  criticalLimits: CriticalLimit[];
  reviews: Review[];
  openFindings: OpenFinding[];
  analytics: Analytics;
  records: PhaseRecord[];
  sbom: Sbom;
  knownIssues: KnownIssue[];
}
