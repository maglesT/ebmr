/**
 * Database access for the market-profile engine: load a published table version as a snapshot for
 * the pure resolver, resolve in the database, record evaluations (INV-29), set site values, read
 * flags and change impact, verify a version. Writes must run inside a command (withCommand).
 */
import type pg from 'pg';
import { MarketRuleError } from './errors.ts';
import type {
  FloorType,
  Market,
  Predicates,
  Resolution,
  ResolveRequest,
  RuleKeyDoc,
  RuleTableCode,
  RuleTableSnapshot,
  RuleValue,
  SnapshotRow,
  StatedMethod,
  StatedMethodName,
  VerificationStatus,
} from './types.ts';

export type Queryable = pg.Pool | pg.PoolClient | pg.Client;

/** Rethrow a database refusal as a MarketRuleError when it carries an EBMR code. */
async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = (error as Error).message;
    const code = /^(EBMR-[A-Z]+-[0-9]{3})\s/.exec(message)?.[1];
    if (code) throw new MarketRuleError(code, message.slice(code.length + 1));
    throw error;
  }
}

export interface TableVersionInfo {
  id: string;
  table: RuleTableCode;
  version: number;
  contentHash: string;
  changeKind: string;
  publishedAt: string;
}

export async function currentRuleTableVersion(db: Queryable, table: RuleTableCode): Promise<TableVersionInfo | null> {
  const { rows } = await db.query<{ id: string; table_code: RuleTableCode; version: number; hash: string; change_kind: string; published_at: string }>(
    `select id, table_code, version, encode(content_hash, 'hex') as hash, change_kind, to_char(published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as published_at
       from market.rule_table_version where table_code = $1 order by version desc limit 1`,
    [table],
  );
  const r = rows[0];
  return r ? { id: r.id, table: r.table_code, version: r.version, contentHash: r.hash, changeKind: r.change_kind, publishedAt: r.published_at } : null;
}

/** A published version as an immutable snapshot for the pure resolver (values stay JSON; no numbers). */
export async function loadRuleTableVersion(db: Queryable, versionId: string): Promise<RuleTableSnapshot> {
  const head = await db.query<{ table_code: RuleTableCode; version: number }>('select table_code, version from market.rule_table_version where id = $1', [versionId]);
  const v = head.rows[0];
  if (!v) throw new MarketRuleError('EBMR-MKT-040', `unknown rule-table version ${versionId}`);
  const keys = await db.query<{
    key: string;
    title: string;
    method: RuleKeyDoc['method'];
    value_type: RuleKeyDoc['valueType'];
    unit: string;
    ordered_values: string[] | null;
    stated_method: StatedMethodName | null;
    india_governs: boolean;
    predicate_domain: Record<string, (string | boolean)[]>;
    catalog_refs: string[];
    description: string | null;
  }>('select * from market.rule_key where version_id = $1 order by key', [versionId]);
  const rows = await db.query<{
    id: string;
    row_ref: string;
    key: string;
    market: Market;
    predicate: Predicates;
    value: RuleValue;
    unit: string;
    floor_type: FloorType;
    hard_floor: RuleValue;
    source: string;
    verification: VerificationStatus;
    effective_from: string;
    effective_to: string | null;
    note: string | null;
  }>(
    `select id, row_ref, key, market, predicate, value, unit, floor_type, hard_floor, source, verification,
            to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to, note
       from market.rule_row where version_id = $1 order by key, market, row_ref`,
    [versionId],
  );
  const keyMap = new Map<string, RuleKeyDoc>();
  for (const k of keys.rows) {
    keyMap.set(k.key, {
      key: k.key,
      title: k.title,
      method: k.method,
      valueType: k.value_type,
      unit: k.unit,
      orderedValues: k.ordered_values,
      statedMethod: k.stated_method,
      indiaGoverns: k.india_governs,
      predicates: k.predicate_domain,
      catalogRefs: k.catalog_refs,
      description: k.description,
    });
  }
  const snapshotRows: SnapshotRow[] = rows.rows.map((r) => ({
    id: r.id,
    ref: r.row_ref,
    key: r.key,
    market: r.market,
    predicate: r.predicate,
    value: r.value,
    unit: r.unit,
    floor: r.floor_type,
    hardFloor: r.hard_floor,
    source: r.source,
    verification: r.verification,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    note: r.note,
  }));
  return Object.freeze({ versionId, tableCode: v.table_code, version: v.version, keys: keyMap, rows: Object.freeze(snapshotRows) });
}

/** Resolve with market.resolve (the database twin of the pure engine). */
export async function resolveInDatabase(db: Queryable, versionId: string, request: ResolveRequest): Promise<Resolution> {
  return run(async () => {
    const { rows } = await db.query<{ r: Resolution }>('select market.resolve($1, $2, $3::text[], $4::jsonb, $5::date, $6::jsonb) as r', [
      versionId,
      request.key,
      request.marketSet,
      JSON.stringify(request.predicates ?? {}),
      request.asOf,
      request.stated === undefined || request.stated === null ? null : JSON.stringify(request.stated),
    ]);
    return rows[0]?.r as Resolution;
  });
}

export async function verifyRuleTableVersion(db: Queryable, versionId: string): Promise<string[]> {
  const { rows } = await db.query<{ problem: string }>('select problem from market.verify_table_version($1)', [versionId]);
  return rows.map((r) => r.problem);
}

export type ScopeKind = 'PRODUCT' | 'PACK' | 'SITE' | 'LINE' | 'ROOM' | 'EQUIPMENT' | 'PERSON' | 'MATERIAL_LOT';
export type ResolutionPoint =
  | 'MBR_APPROVAL'
  | 'BATCH_ISSUE'
  | 'EXECUTION'
  | 'CONSUMPTION'
  | 'RELEASE'
  | 'SAMPLE_RETENTION'
  | 'ARCHIVING'
  | 'MARKET_SET_CHANGE'
  | 'LINE_QUALIFICATION'
  | 'QA_RE_RESOLUTION';

export interface ScopeRef {
  kind: ScopeKind;
  /** PRODUCT: the batch id; PACK: the pack id; otherwise the entity id. */
  id: string;
  /** MATERIAL_LOT: the batch that consumes the lot (required). */
  consumingBatchId?: string;
}

/**
 * A Phase 1 evaluation request. What the scope fixes (its markets and predicates, its site, a pack's
 * destination, the subject the evaluation is filed under) the request can repeat but never change.
 */
export interface EvaluateStubScopeRequest {
  key: string;
  scope: ScopeRef;
  resolutionPoint: ResolutionPoint;
  asOf: string;
  tableVersionId?: string;
  /** Extra predicate attributes the scope does not fix (a different value for a fixed one: EBMR-MKT-055). */
  predicates?: Predicates;
  /** PER_DESTINATION keys; for a PACK scope the destination is the pack's own (another one: EBMR-MKT-057). */
  stated?: StatedMethod;
  /**
   * Defaults to the scope (a PRODUCT scope's batch). Another subject only where the scope entails it:
   * a PACK's batch, a MATERIAL_LOT's consuming batch, a batch made at a SITE or of a product qualified
   * on a LINE, ROOM or EQUIPMENT (anything else: EBMR-MKT-058).
   */
  subject?: { type: string; id: string };
  /** Assert-only: the site is always the scope's own; any other value, or null for a sited scope, is refused (EBMR-MKT-056). */
  siteId?: string | null;
}

export type SiteOutcome = 'NO_SITE_VALUE' | 'SITE_TIGHTER' | 'SITE_EQUAL' | 'SITE_LOOSENED' | 'SITE_VALUE_INADMISSIBLE';

/** A stored evaluation (market.evaluation). */
export interface StoredEvaluation {
  id: string;
  recordedAt: string;
  subjectType: string;
  subjectId: string;
  resolutionPoint: ResolutionPoint;
  scopeKind: ScopeKind;
  scopeId: string;
  consumingBatchId: string | null;
  siteId: string | null;
  key: string;
  tableCode: RuleTableCode;
  tableVersionId: string;
  tableVersion: number;
  asOf: string;
  marketSet: Market[];
  marketDerivation: unknown[];
  predicates: Predicates;
  applicable: boolean;
  resolvedValue: RuleValue;
  governingMarkets: Market[];
  predicateBranch: Record<Market, Predicates>;
  floorType: FloorType | null;
  siteValueId: string | null;
  siteOutcome: SiteOutcome;
  effectiveValue: RuleValue;
  resolution: Resolution;
  inputsHash: string;
}

type EvaluationJson = Record<string, unknown>;

export function toStoredEvaluation(e: EvaluationJson): StoredEvaluation {
  const hash = typeof e['inputs_hash'] === 'string' ? e['inputs_hash'] : '';
  return {
    id: e['id'] as string,
    recordedAt: e['recorded_at'] as string,
    subjectType: e['subject_type'] as string,
    subjectId: e['subject_id'] as string,
    resolutionPoint: e['resolution_point'] as ResolutionPoint,
    scopeKind: e['scope_kind'] as ScopeKind,
    scopeId: e['scope_id'] as string,
    consumingBatchId: (e['consuming_batch_id'] as string | null) ?? null,
    siteId: (e['site_id'] as string | null) ?? null,
    key: e['key'] as string,
    tableCode: e['table_code'] as RuleTableCode,
    tableVersionId: e['table_version_id'] as string,
    tableVersion: e['table_version'] as number,
    asOf: e['as_of'] as string,
    marketSet: e['market_set'] as Market[],
    marketDerivation: e['market_derivation'] as unknown[],
    predicates: e['predicates'] as Predicates,
    applicable: e['applicable'] as boolean,
    resolvedValue: (e['resolved_value'] as RuleValue) ?? null,
    governingMarkets: e['governing_markets'] as Market[],
    predicateBranch: e['predicate_branch'] as Record<Market, Predicates>,
    floorType: (e['floor_type'] as FloorType | null) ?? null,
    siteValueId: (e['site_value_id'] as string | null) ?? null,
    siteOutcome: e['site_outcome'] as SiteOutcome,
    effectiveValue: (e['effective_value'] as RuleValue) ?? null,
    resolution: e['resolution'] as Resolution,
    inputsHash: hash.startsWith('\\x') ? hash.slice(2) : hash,
  };
}

/** Phase 1: resolve for a stub scope and store the evaluation (market.evaluate_stub_scope). */
export async function evaluateStubScope(client: Queryable, request: EvaluateStubScopeRequest): Promise<StoredEvaluation> {
  return run(async () => {
    const { rows } = await client.query<{ e: EvaluationJson }>('select market.evaluate_stub_scope($1::jsonb) as e', [
      JSON.stringify({ ...request, consumingBatchId: request.scope.consumingBatchId }),
    ]);
    return toStoredEvaluation(rows[0]?.e ?? {});
  });
}

export async function listEvaluations(db: Queryable, subjectId: string): Promise<StoredEvaluation[]> {
  const { rows } = await db.query<{ e: EvaluationJson }>('select to_jsonb(e) as e from market.evaluation e where subject_id = $1 order by recorded_at, id', [subjectId]);
  return rows.map((r) => toStoredEvaluation(r.e));
}

export interface SiteValueRequest {
  siteId: string;
  key: string;
  value: RuleValue;
  effectiveFrom: string;
  /** Needed to loosen a GUIDANCE or adopted EXAMPLE value: the CCS (justification) reference. */
  justificationRef?: string;
  /**
   * Needed to loosen a GUIDANCE or adopted EXAMPLE value: the id of the QA approver's
   * SITE_VALUE_LOOSENING_APPROVED e-signature of exactly this loosening (siteValuePreview names the
   * aggregate), signed by someone other than the person setting the value. Read only for a loosening.
   */
  qaApprovalId?: string;
  tableVersionId?: string;
  predicates?: Predicates;
}

export interface SiteValueRecord {
  id: string;
  siteId: string;
  key: string;
  value: RuleValue;
  outcome: 'TIGHTER' | 'EQUAL' | 'LOOSENED';
  justificationRef: string | null;
  /** LOOSENED only: the QA approval e-signature and the person who signed it. */
  qaApprovalId: string | null;
  qaApproverId: string | null;
  tableVersionId: string;
}

export async function setSiteValue(client: Queryable, request: SiteValueRequest): Promise<SiteValueRecord> {
  return run(async () => {
    const { rows } = await client.query<{ sv: Record<string, unknown> }>('select market.set_site_value($1, $2, $3::jsonb, $4::date, $5::jsonb) as sv', [
      request.siteId,
      request.key,
      JSON.stringify(request.value),
      request.effectiveFrom,
      JSON.stringify({
        justificationRef: request.justificationRef,
        qaApprovalId: request.qaApprovalId,
        tableVersionId: request.tableVersionId,
        predicates: request.predicates,
      }),
    ]);
    const sv = rows[0]?.sv ?? {};
    return {
      id: sv['id'] as string,
      siteId: sv['site_id'] as string,
      key: sv['key'] as string,
      value: sv['value'] as RuleValue,
      outcome: sv['outcome'] as SiteValueRecord['outcome'],
      justificationRef: (sv['justification_ref'] as string | null) ?? null,
      qaApprovalId: (sv['qa_approval_id'] as string | null) ?? null,
      qaApproverId: (sv['qa_approver_id'] as string | null) ?? null,
      tableVersionId: sv['table_version_id'] as string,
    };
  });
}

/** What an approver e-signs to approve a market loosening: the signature type and the signed aggregate. */
export interface ApprovalTarget {
  meaning: string;
  aggregateType: string;
  aggregateId: string;
}

export interface SiteValuePreview {
  outcome: 'TIGHTER' | 'EQUAL' | 'LOOSENING' | 'REFUSED';
  code?: string;
  message?: string;
  resolution: Resolution;
  /** For a loosening with a justification reference: what the QA approver signs. */
  approval: ApprovalTarget | null;
}

/** What market.set_site_value would decide for a candidate value, without writing anything. */
export async function siteValuePreview(db: Queryable, request: Omit<SiteValueRequest, 'qaApprovalId'>): Promise<SiteValuePreview> {
  return run(async () => {
    const { rows } = await db.query<{ p: SiteValuePreview }>('select market.site_value_preview($1, $2, $3::jsonb, $4::date, $5::jsonb) as p', [
      request.siteId,
      request.key,
      JSON.stringify(request.value),
      request.effectiveFrom,
      JSON.stringify({ justificationRef: request.justificationRef, tableVersionId: request.tableVersionId, predicates: request.predicates }),
    ]);
    const p = rows[0]?.p;
    if (!p) throw new MarketRuleError('EBMR-MKT-062', 'the site-value preview returned no result');
    return { ...p, approval: p.approval ?? null };
  });
}

export interface BatchFlag {
  evaluationId: string;
  key: string;
  siteOutcome: SiteOutcome;
  siteValueId: string | null;
  resolvedValue: RuleValue;
  effectiveValue: RuleValue;
}

/** Evaluations of a subject that used a loosened site value or could not apply one (shown on the batch). */
export async function batchFlags(db: Queryable, subjectId: string): Promise<BatchFlag[]> {
  const { rows } = await db.query<{ evaluation_id: string; key: string; site_outcome: SiteOutcome; site_value_id: string | null; resolved_value: RuleValue; effective_value: RuleValue }>(
    'select * from market.batch_flags($1)',
    [subjectId],
  );
  return rows.map((r) => ({
    evaluationId: r.evaluation_id,
    key: r.key,
    siteOutcome: r.site_outcome,
    siteValueId: r.site_value_id,
    resolvedValue: r.resolved_value,
    effectiveValue: r.effective_value,
  }));
}

export interface ImpactItem {
  refType: 'MBR_LIMIT' | 'SITE_VALUE';
  refId: string;
  refLabel: string;
  key: string;
  marketSet: Market[];
  pinnedValue: RuleValue;
  requiredValue: RuleValue;
  governingMarkets: Market[];
  dueBy: string;
  problem: string | null;
  note: string | null;
}

/** The change-impact list written when a table version was published (build outline 3.3.5). */
export async function changeImpact(db: Queryable, versionId: string): Promise<ImpactItem[]> {
  const { rows } = await db.query<{
    ref_type: ImpactItem['refType'];
    ref_id: string;
    ref_label: string;
    key: string;
    market_set: Market[];
    pinned_value: RuleValue;
    required_value: RuleValue;
    governing_markets: Market[];
    due_by: string;
    problem: string | null;
    note: string | null;
  }>(
    `select ref_type, ref_id, ref_label, key, market_set, pinned_value, required_value, governing_markets,
            to_char(due_by, 'YYYY-MM-DD') as due_by, problem, note
       from market.change_impact where version_id = $1 order by ref_type, ref_label, key`,
    [versionId],
  );
  return rows.map((r) => ({
    refType: r.ref_type,
    refId: r.ref_id,
    refLabel: r.ref_label,
    key: r.key,
    marketSet: r.market_set,
    pinnedValue: r.pinned_value,
    requiredValue: r.required_value,
    governingMarkets: r.governing_markets,
    dueBy: r.due_by,
    problem: r.problem,
    note: r.note,
  }));
}
