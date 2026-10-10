/**
 * The database-backed execution store (Phase 2 apps plan section 7; module C3): thin, typed calls of the
 * recipe schema's definer functions (sql/0200, 0210). Every writer runs inside a command (kernel
 * withCommand: the actor is declared first); the database re-checks the actor, the permission, the
 * clock, the sequence, the hashes, the roles, the signatures and the badge tap.
 */
import type pg from 'pg';
import { decode, decodeState, encode, encodeEvents, encodeState, hashJson, type JsonValue } from '../engine/codec.ts';
import type { AggregateContent, AggregateType } from '../engine/signing-content.ts';
import type { ExecutionRow, ExecutionRowKind } from '../engine/replay.ts';
import type { BatchState, EngineEvent, Refusal } from '../engine/types.ts';
import type { TestPackageV1 } from './test-package.ts';

export type Queryable = Pick<pg.PoolClient, 'query'> | Pick<pg.Pool, 'query'>;

/** A stored authority evaluation behind an engine role (INV-26). */
export interface RoleEvidence {
  role: string;
  permission: string;
  evaluationId: string;
}

export interface BatchExecutionRecord {
  id: string;
  batchNumber: string;
  /** SANDBOX (a test run of a test package) or GMP (a batch of a control recipe; recipe-core 0500). */
  installation: string;
  /** The test package a sandbox test run executes ('' for a GMP batch). */
  packageHash: string;
  /** The control recipe a GMP batch executes (null for a test run). */
  controlRecipeId: string | null;
  contentHash: string;
  engineVersion: string;
  registryFingerprint: string;
  policy: JsonValue;
  policyHash: string;
  issueRequest: JsonValue;
  marketSet: string[];
  batchSize: string;
  siteCode: string;
  roomCode: string | null;
  siteZone: string;
  issuedAtUs: bigint;
  issuedByPerson: string;
}

export interface CommandActorFacts {
  personId: string;
  accountId: string;
  roleCode: string;
  sessionId: string;
  deviceId: string | null;
  deviceClass: string;
  roomCode: string | null;
  siteCode: string | null;
  source: string;
  legalName: string | null;
  commandAuthEvent: string | null;
}

export interface LockedExecution {
  batch: BatchExecutionRecord;
  state: BatchState;
  stateVersion: number;
  lastSeq: bigint;
  nowUs: bigint;
  actor: CommandActorFacts;
}

export class ExecutionStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${message} [${code}]`);
    this.name = 'ExecutionStoreError';
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' ? String(v) : '');
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function batchRecord(row: Record<string, unknown>): BatchExecutionRecord {
  return {
    id: str(row['id']),
    batchNumber: str(row['batch_number']),
    installation: str(row['installation']),
    packageHash: str(row['package_hash']),
    controlRecipeId: optStr(row['control_recipe_id']),
    contentHash: str(row['content_hash']),
    engineVersion: str(row['engine_version']),
    registryFingerprint: str(row['registry_fingerprint']),
    policy: row['policy'] as JsonValue,
    policyHash: str(row['policy_hash']),
    issueRequest: row['issue_request'] as JsonValue,
    marketSet: Array.isArray(row['market_set']) ? (row['market_set'] as unknown[]).map(String) : [],
    batchSize: str(row['batch_size']),
    siteCode: str(row['site_code']),
    roomCode: optStr(row['room_code']),
    siteZone: str(row['site_zone']),
    issuedAtUs: BigInt(str(row['issued_at_us']) || '0'),
    issuedByPerson: str(row['issued_by_person']),
  };
}

function actorFacts(a: Record<string, unknown>): CommandActorFacts {
  return {
    personId: str(a['person_id']),
    accountId: str(a['account_id']),
    roleCode: str(a['role_code']),
    sessionId: str(a['session_id']),
    deviceId: optStr(a['device_id']),
    deviceClass: str(a['device_class']),
    roomCode: optStr(a['room_code']),
    siteCode: optStr(a['site_code']),
    source: str(a['source']),
    legalName: optStr(a['legal_name']),
    commandAuthEvent: optStr(a['command_auth_event']),
  };
}

/** Locks a batch for this command and returns its state and the trusted time (INV-16). */
export async function lockExecution(client: Queryable, batchId: string): Promise<LockedExecution>;
/** With skipLocked (the sweeper): undefined when another command holds the batch. */
export async function lockExecution(client: Queryable, batchId: string, skipLocked: true): Promise<LockedExecution | undefined>;
export async function lockExecution(client: Queryable, batchId: string, skipLocked = false): Promise<LockedExecution | undefined> {
  const { rows } = await client.query<{ r: Record<string, unknown> | null }>('select recipe.lock_execution($1, $2) as r', [batchId, skipLocked]);
  const r = rows[0]?.r;
  if (!r && skipLocked) return undefined;
  if (!r || !r['state']) throw new ExecutionStoreError('EBMR-EXE-010', 'The test batch has no stored state');
  return {
    batch: batchRecord(r['batch'] as Record<string, unknown>),
    state: decodeState(r['state']),
    stateVersion: Number(r['state_version']),
    lastSeq: BigInt(str(r['last_seq'])),
    nowUs: BigInt(str(r['now_us'])),
    actor: actorFacts(r['actor'] as Record<string, unknown>),
  };
}

export interface AppendInput {
  batchId: string;
  expectedSeq: bigint;
  kind: Exclude<ExecutionRowKind, 'ISSUE'>;
  /** The encoded row command (codec JSON): an engine command, {type: PREPARE, target, actor} or {type: SWEEP}. */
  command: JsonValue;
  commandId: string;
  nowUs: bigint;
  accepted: boolean;
  refusal?: Refusal | undefined;
  state: BatchState;
  events: readonly EngineEvent[];
  roles: readonly RoleEvidence[];
  contents: readonly AggregateContent[];
  evidence?: JsonValue;
}

export interface AppendResult {
  seq: bigint;
  rowHash: string;
  stateHash: string;
  signatureIds: string[];
}

function contentsJson(contents: readonly AggregateContent[]): string {
  return JSON.stringify(contents.map((c) => ({ type: c.type, key: c.key, content: c.content, contentHash: c.contentHash })));
}

/** Appends one engine call to a locked batch (the database re-checks it; see sql/0210). */
export async function appendExecution(client: Queryable, input: AppendInput): Promise<AppendResult> {
  const state = encodeState(input.state);
  const events = encodeEvents(input.events);
  const { rows } = await client.query<{ r: Record<string, unknown> }>(
    'select recipe.append_execution($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb) as r',
    [
      input.batchId,
      input.expectedSeq.toString(),
      input.kind,
      JSON.stringify(input.command),
      input.commandId,
      input.nowUs.toString(),
      input.accepted,
      input.refusal ? JSON.stringify(input.refusal) : null,
      JSON.stringify(state),
      hashJson(state),
      JSON.stringify(events),
      hashJson(events),
      JSON.stringify(input.roles),
      contentsJson(input.contents),
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  const r = rows[0]?.r ?? {};
  return { seq: BigInt(str(r['seq'])), rowHash: str(r['row_hash']), stateHash: str(r['state_hash']), signatureIds: Array.isArray(r['signature_ids']) ? (r['signature_ids'] as unknown[]).map(String) : [] };
}

/** The trusted time and the allocated TEST- number of a batch about to be issued. */
export async function beginIssue(client: Queryable, batchId: string): Promise<{ nowUs: bigint; batchNumber: string; siteCode: string | null; roomCode: string | null }> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select recipe.begin_issue($1) as r', [batchId]);
  const r = rows[0]?.r ?? {};
  return { nowUs: BigInt(str(r['now_us'])), batchNumber: str(r['batch_number']), siteCode: optStr(r['site_code']), roomCode: optStr(r['room_code']) };
}

export interface IssueInput {
  batchId: string;
  packageHash: string;
  batchNumber: string;
  /** The encoded issue request (codec JSON). */
  request: JsonValue;
  policy: JsonValue;
  registryFingerprint: string;
  engineVersion: string;
  nowUs: bigint;
  state: BatchState;
  events: readonly EngineEvent[];
  contents: readonly AggregateContent[];
  evidence?: JsonValue;
}

export async function issueExecution(client: Queryable, input: IssueInput): Promise<{ seq: bigint; rowHash: string }> {
  const state = encodeState(input.state);
  const events = encodeEvents(input.events);
  const { rows } = await client.query<{ r: Record<string, unknown> }>(
    'select recipe.issue_execution($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb) as r',
    [
      input.batchId,
      input.packageHash,
      input.batchNumber,
      JSON.stringify(input.request),
      JSON.stringify(input.policy),
      hashJson(input.policy),
      input.registryFingerprint,
      input.engineVersion,
      input.nowUs.toString(),
      JSON.stringify(state),
      hashJson(state),
      JSON.stringify(events),
      hashJson(events),
      contentsJson(input.contents),
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  const r = rows[0]?.r ?? {};
  return { seq: BigInt(str(r['seq'])), rowHash: str(r['row_hash']) };
}

/** What a GMP batch is planned with (recipe.prepare_gmp_issue): its MBR family, market set and scope. */
export interface GmpBatchPlan {
  familyId: string;
  markets: readonly string[];
  site: string;
  line: string;
  /** The id of one of the family's approved batch sizes. */
  batchSize: string;
  /** A number the site's register already holds for this batch (otherwise one is allocated now). */
  allocationId?: string;
  /** A packaging order (record kind PACKAGING): the issued processing batch it packs (D-S4-2; recipe-core 0582). */
  parentBatch?: string;
}

export interface PlannedGmpBatch {
  batchId: string;
  batchNumber: string;
  allocationId: string;
  pinId: string;
  versionId: string;
  versionNumber: number;
  contentHash: string;
  rule: string;
  markets: string[];
  controlRecipeId: string;
  snapshotHash: string;
}

/**
 * Plans a GMP batch from an effective MBR version (recipe-core 0501): selection, register number, pin and control
 * recipe in this command. The issuer then signs aggregate `batch_issue` (id: the batch id) with the meaning ISSUED.
 */
export async function prepareGmpIssue(client: Queryable, batchId: string, plan: GmpBatchPlan): Promise<PlannedGmpBatch> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select recipe.prepare_gmp_issue($1, $2::jsonb) as r', [batchId, JSON.stringify(plan)]);
  const r = rows[0]?.r ?? {};
  return {
    batchId: str(r['batch_id']),
    batchNumber: str(r['batch_number']),
    allocationId: str(r['allocation_id']),
    pinId: str(r['pin_id']),
    versionId: str(r['version_id']),
    versionNumber: Number(str(r['version_number'])),
    contentHash: str(r['content_hash']),
    rule: str(r['rule']),
    markets: Array.isArray(r['markets']) ? (r['markets'] as unknown[]).map(String) : [],
    controlRecipeId: str(r['control_recipe_id']),
    snapshotHash: str(r['snapshot_hash']),
  };
}

export interface BegunGmpIssue {
  nowUs: bigint;
  batchNumber: string;
  siteCode: string;
  line: string;
  roomCode: string | null;
  marketSet: string[];
  batchSize: string;
  contentHash: string;
  controlRecipeId: string;
  snapshotHash: string;
  /** The control recipe's snapshot; `snapshot.mbr.content` is the MBR content the engine issues the batch from. */
  snapshot: JsonValue;
}

/** The trusted time of a GMP batch's issue and the control recipe it is issued from (recipe.begin_gmp_issue). */
export async function beginGmpIssue(client: Queryable, batchId: string): Promise<BegunGmpIssue> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select recipe.begin_gmp_issue($1) as r', [batchId]);
  const r = rows[0]?.r ?? {};
  return {
    nowUs: BigInt(str(r['now_us'])),
    batchNumber: str(r['batch_number']),
    siteCode: str(r['site_code']),
    line: str(r['line']),
    roomCode: optStr(r['room_code']),
    marketSet: Array.isArray(r['market_set']) ? (r['market_set'] as unknown[]).map(String) : [],
    batchSize: str(r['batch_size']),
    contentHash: str(r['content_hash']),
    controlRecipeId: str(r['control_recipe_id']),
    snapshotHash: str(r['snapshot_hash']),
    snapshot: r['snapshot'] as JsonValue,
  };
}

export interface GmpIssueInput extends Omit<IssueInput, 'packageHash'> {
  /** The issuer's ISSUED signature on aggregate `batch_issue` of this batch. */
  signatureId: string;
}

/** Issues a planned GMP batch under the issuer's ISSUED signature (recipe.issue_gmp_execution). */
export async function issueGmpExecution(client: Queryable, input: GmpIssueInput): Promise<{ seq: bigint; rowHash: string }> {
  const state = encodeState(input.state);
  const events = encodeEvents(input.events);
  const { rows } = await client.query<{ r: Record<string, unknown> }>(
    'select recipe.issue_gmp_execution($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb) as r',
    [
      input.batchId,
      input.signatureId,
      input.batchNumber,
      JSON.stringify(input.request),
      JSON.stringify(input.policy),
      hashJson(input.policy),
      input.registryFingerprint,
      input.engineVersion,
      input.nowUs.toString(),
      JSON.stringify(state),
      hashJson(state),
      JSON.stringify(events),
      hashJson(events),
      contentsJson(input.contents),
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  const r = rows[0]?.r ?? {};
  return { seq: BigInt(str(r['seq'])), rowHash: str(r['row_hash']) };
}

/** Imports a parsed test package (the database recomputes both hashes and checks the GMP origin). */
export async function importTestPackage(client: Queryable, pkg: TestPackageV1, fileName: string): Promise<{ packageHash: string }> {
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select recipe.import_test_package($1::jsonb, $2) as r', [JSON.stringify(pkg), fileName]);
  return { packageHash: str(rows[0]?.r?.['package_hash']) };
}

/** The stored rows of a batch, in order (for replay). */
export async function loadRows(db: Queryable, batchId: string): Promise<ExecutionRow[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    'select c.seq::text as seq, c.kind, c.command, c.now_us::text as now_us, c.accepted, c.state_hash, c.events_hash from recipe.execution_command c where c.batch_id = $1 order by c.seq',
    [batchId],
  );
  return rows.map((r) => ({
    seq: BigInt(str(r['seq'])),
    kind: str(r['kind']) as ExecutionRowKind,
    command: r['command'] as JsonValue,
    nowUs: BigInt(str(r['now_us'])),
    accepted: r['accepted'] === true,
    stateHash: str(r['state_hash']),
    eventsHash: str(r['events_hash']),
  }));
}

export async function loadBatch(db: Queryable, batchId: string): Promise<BatchExecutionRecord | undefined> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>('select to_jsonb(b) as r from recipe.batch_execution b where b.id = $1', [batchId]);
  return rows[0] ? batchRecord(rows[0].r) : undefined;
}

/** The stored state of a batch (projection), with its version and last row. */
export async function loadState(db: Queryable, batchId: string): Promise<{ state: BatchState; version: number; lastSeq: bigint; stateHash: string } | undefined> {
  const { rows } = await db.query<{ state: unknown; state_version: number; last_seq: string; state_hash: string }>(
    'select state, state_version, last_seq::text as last_seq, state_hash from recipe.execution_state where batch_id = $1',
    [batchId],
  );
  const r = rows[0];
  return r ? { state: decodeState(r.state), version: r.state_version, lastSeq: BigInt(r.last_seq), stateHash: r.state_hash } : undefined;
}

/** The latest content version and hash of every signable aggregate of a batch, keyed `${type}:${key}`. */
export async function loadContentHeads(db: Queryable, batchId: string): Promise<Map<string, { version: number; hash: string }>> {
  const { rows } = await db.query<{ type: string; key: string; version: number; hash: string }>(
    `select distinct on (type, key) type, key, version, hash from (
       select 'batch_step' as type, aggregate_key as key, content_version as version, content_hash as hash from recipe.execution_step_content where batch_id = $1
       union all select 'batch_stage', aggregate_key, content_version, content_hash from recipe.execution_stage_content where batch_id = $1
       union all select 'batch_exception', aggregate_key, content_version, content_hash from recipe.execution_exception_content where batch_id = $1
       union all select 'batch_point', aggregate_key, content_version, content_hash from recipe.execution_point_content where batch_id = $1) x
     order by type, key, version desc`,
    [batchId],
  );
  return new Map(rows.map((r) => [`${r.type}:${r.key}`, { version: r.version, hash: r.hash }]));
}

/** One stored content version of a signable aggregate: the row that stored it and its hash. */
export interface ContentVersionRecord {
  type: AggregateType;
  key: string;
  version: number;
  hash: string;
  rowSeq: bigint;
}

/** Every stored content version of every signable aggregate of a batch, in the order of the rows that stored them. */
export async function loadContentVersions(db: Queryable, batchId: string): Promise<ContentVersionRecord[]> {
  const { rows } = await db.query<{ type: AggregateType; key: string; version: number; hash: string; row_seq: string }>(
    `select type, key, version, hash, row_seq::text as row_seq from (
       select 'batch_step' as type, aggregate_key as key, content_version as version, content_hash as hash, row_seq from recipe.execution_step_content where batch_id = $1
       union all select 'batch_stage', aggregate_key, content_version, content_hash, row_seq from recipe.execution_stage_content where batch_id = $1
       union all select 'batch_exception', aggregate_key, content_version, content_hash, row_seq from recipe.execution_exception_content where batch_id = $1
       union all select 'batch_point', aggregate_key, content_version, content_hash, row_seq from recipe.execution_point_content where batch_id = $1) x
     order by row_seq, type, key, version`,
    [batchId],
  );
  return rows.map((r) => ({ type: r.type, key: r.key, version: r.version, hash: r.hash, rowSeq: BigInt(r.row_seq) }));
}

const CONTENT_TABLES: Readonly<Record<AggregateType, string>> = {
  batch_step: 'recipe.execution_step_content',
  batch_stage: 'recipe.execution_stage_content',
  batch_exception: 'recipe.execution_exception_content',
  batch_point: 'recipe.execution_point_content',
};

/** The latest stored content version and hash of one aggregate of a batch (undefined when none is stored). */
export async function loadContentHead(db: Queryable, type: AggregateType, batchId: string, key: string): Promise<{ version: number; hash: string } | undefined> {
  const { rows } = await db.query<{ version: number; hash: string }>(
    `select content_version as version, content_hash as hash from ${CONTENT_TABLES[type]} where aggregate_id = $1 order by content_version desc limit 1`,
    [`${batchId}:${key}`],
  );
  return rows[0];
}

/** A disposition a QA reviewer is about to sign; part of the exception's signed content (sql/0210 propose_disposition). */
export interface DispositionProposal {
  outcome: 'NO_IMPACT' | 'DEVIATION_RAISED';
  justification: string;
  deviationRef: string | null;
}

/** Records the proposed disposition on the exception's current content version (inside the challenge command). */
export async function proposeDisposition(client: Queryable, batchId: string, exceptionId: string, proposal: DispositionProposal): Promise<{ contentVersion: number }> {
  const { rows } = await client.query<{ r: { content_version: number } }>('select recipe.propose_disposition($1, $2, $3::jsonb) as r', [batchId, exceptionId, JSON.stringify(proposal)]);
  return { contentVersion: Number(rows[0]?.r.content_version ?? 0) };
}

/** The latest proposal made on a content version of an exception (null when none). */
export async function loadProposal(db: Queryable, batchId: string, exceptionId: string, contentVersion: number): Promise<DispositionProposal | null> {
  const { rows } = await db.query<{ p: DispositionProposal | null }>('select recipe.current_proposal($1, $2) as p', [`${batchId}:${exceptionId}`, contentVersion]);
  return rows[0]?.p ?? null;
}

/** The invariant query (sql/0210): rows mean a problem. */
export async function executionViolations(db: Queryable): Promise<{ batchId: string | null; problem: string }[]> {
  const { rows } = await db.query<{ batch_id: string | null; problem: string }>('select batch_id, problem from recipe.execution_violations()');
  return rows.map((r) => ({ batchId: r.batch_id, problem: r.problem }));
}

/** Decodes a stored row command. */
export function decodeRowCommand(json: JsonValue): unknown {
  return decode(json);
}

export { encode };
