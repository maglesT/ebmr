/**
 * Thin, typed callers of the MBR life-cycle functions in the recipe schema (sql/0100-0180). Every
 * writer runs inside a command the caller started (kernel withCommand), so it commits together with
 * whatever else the command does; the database decides and refuses with a code (EBMR-RCP-NNN, or
 * the kernel's EBMR-PLAT / EBMR-IAM / EBMR-ESIG codes), raised here as KernelError.
 *
 * State changes of a version go through the kernel state engine (state.transition) on machine
 * mbr_version; the return to DRAFT and retirement go through their recipe functions, which record
 * what the transition needs (a new draft cycle; the end of open market authorisations).
 */
import type pg from 'pg';
import { commands, esig, state } from '@ebmr/kernel';
import { mbrContentHash } from '../flow/canonical.ts';
import type { MbrContent } from '../flow/model.ts';
import { parseMbr } from '../flow/parse.ts';
import type { WarningJustification } from '../validator/types.ts';
import { MBR_VERSION_AGGREGATE, MBR_VERSION_MACHINE, type MbrVersionEvent } from './machine.ts';
import { testVectorEvidence, validatorEvidence, type FullVerification, type VerificationPort } from './verification.ts';
import type {
  ActivationResult,
  ChangeRecordDefinition,
  ControlRecipeCheck,
  DraftAttributes,
  EvidenceKind,
  EvidenceResult,
  EvidenceStatus,
  FamilyDefinition,
  InFlightDisposition,
  InvariantViolation,
  IssueResult,
  IssueScope,
  MarketAuthorisationDefinition,
  MarketCode,
  OverdueReview,
  ReviewOutcome,
  RiskAssessmentDefinition,
  SelectionResult,
  StubBatchDefinition,
  VersionRef,
} from './types.ts';

type Db = pg.Pool | pg.PoolClient;

/** Content that fails the flow model's parser is refused before it reaches the database. */
export class MbrContentError extends Error {
  constructor(readonly problems: { path: string; message: string }[]) {
    super(`The MBR content does not parse: ${problems.map((p) => `${p.path}: ${p.message}`).join('; ')} (EBMR-RCP-029)`);
    this.name = 'MbrContentError';
  }
}

async function one<T>(db: Db, sql: string, params: unknown[]): Promise<T> {
  try {
    const { rows } = await db.query<{ r: T }>(sql, params);
    if (rows.length === 0) throw new Error(`no result from ${sql}`);
    return (rows[0] as { r: T }).r;
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

async function exec(db: Db, sql: string, params: unknown[]): Promise<void> {
  try {
    await db.query(sql, params);
  } catch (error) {
    throw commands.asKernelError(error);
  }
}

function checkedContent(content: unknown): { content: MbrContent; hash: string } {
  const parsed = parseMbr(content);
  if (!parsed.ok) throw new MbrContentError(parsed.problems);
  return { content: parsed.mbr, hash: mbrContentHash(parsed.mbr) };
}

const toVersionRef = (r: { version_id: string; version_number: number; content_hash: string; state: string; state_version: number | string }): VersionRef => ({
  versionId: r.version_id,
  versionNumber: r.version_number,
  contentHash: r.content_hash,
  state: r.state,
  stateVersion: Number(r.state_version),
});

// ---------------------------------------------------------------------------------------------
// Families and versions
// ---------------------------------------------------------------------------------------------

/** The family a content header describes (product, strength, batch sizes, form, edition). */
export function familyOf(content: MbrContent, title = content.header.title): FamilyDefinition {
  const h = content.header;
  return {
    code: h.family,
    title,
    edition: h.edition,
    recordKind: h.recordKind,
    product: { code: h.product.code, name: h.product.name, strength: h.product.strength, dosageForm: h.product.dosageForm },
    batchSizes: h.batchSizes.map((b) => ({ id: b.id, quantity: { value: b.quantity.value, unit: b.quantity.unit } })),
    ...(h.recordKind === 'PACKAGING' ? { packType: h.packType ?? 'STANDARD' } : {}),
  };
}

export function defineFamily(c: pg.PoolClient, def: FamilyDefinition): Promise<string> {
  return one<string>(c, 'select recipe.define_family($1::jsonb) as r', [JSON.stringify(def)]);
}

/**
 * D-3 (recipe-core 1878): the family of `def`'s code when it has `def`'s identity and every version of it was discarded
 * (WITHDRAWN, never approved), else null; a new draft then starts in it instead of a twin family.
 */
export async function reopenFamily(c: pg.PoolClient, def: FamilyDefinition): Promise<string | null> {
  return (await c.query<{ r: string | null }>('select recipe.reopen_family($1::jsonb) as r', [JSON.stringify(def)])).rows[0]?.r ?? null;
}

/** The family of `def`: the discarded one of its code and identity (reopenFamily), else a new one (defineFamily). */
export async function familyForNewDraft(c: pg.PoolClient, def: FamilyDefinition): Promise<string> {
  return (await reopenFamily(c, def)) ?? defineFamily(c, def);
}

export async function createVersion(c: pg.PoolClient, familyId: string, content: unknown, reason?: string): Promise<VersionRef> {
  const { content: mbr, hash } = checkedContent(content);
  return toVersionRef(await one(c, 'select recipe.create_version($1, $2::jsonb, $3, $4) as r', [familyId, JSON.stringify(mbr), hash, reason ?? null]));
}

export async function deriveVersion(c: pg.PoolClient, fromVersionId: string, reason: string): Promise<VersionRef> {
  return toVersionRef(await one(c, 'select recipe.derive_version($1, $2) as r', [fromVersionId, reason]));
}

export async function saveContent(c: pg.PoolClient, versionId: string, content: unknown, reason?: string): Promise<{ revision: number; contentHash: string }> {
  const { content: mbr, hash } = checkedContent(content);
  const r = await one<{ revision: number; content_hash: string }>(c, 'select recipe.save_content($1, $2::jsonb, $3, $4) as r', [
    versionId,
    JSON.stringify(mbr),
    hash,
    reason ?? null,
  ]);
  return { revision: r.revision, contentHash: r.content_hash };
}

/** DRAFT only. The command carries the author's own reason, code and text, or the update is refused (EBMR-AUDIT-002). */
export function setDraftAttributes(c: pg.PoolClient, versionId: string, attrs: DraftAttributes): Promise<void> {
  return exec(c, 'select recipe.set_draft_attributes($1, $2::jsonb)', [versionId, JSON.stringify(attrs)]);
}

export function linkRiskAssessment(c: pg.PoolClient, versionId: string, riskAssessmentId: string, subjects: readonly string[] = []): Promise<void> {
  return exec(c, 'select recipe.link_risk_assessment($1, $2, $3::text[])', [versionId, riskAssessmentId, subjects]);
}

export function unlinkRiskAssessment(c: pg.PoolClient, versionId: string, riskAssessmentId: string): Promise<void> {
  return exec(c, 'select recipe.unlink_risk_assessment($1, $2)', [versionId, riskAssessmentId]);
}

/** The current content of a version (latest revision). */
export async function loadContent(db: Db, versionId: string): Promise<{ content: MbrContent; contentHash: string; revision: number }> {
  const r = await one<{ content: MbrContent; content_hash: string; revision: number } | null>(
    db,
    "select (select jsonb_build_object('content', c.content, 'content_hash', c.content_hash, 'revision', c.revision) from recipe.mbr_content c where c.version_id = $1 order by c.revision desc limit 1) as r",
    [versionId],
  );
  if (!r) throw new commands.KernelError('EBMR-RCP-020', `Unknown MBR version ${versionId} (EBMR-RCP-020)`);
  return { content: r.content, contentHash: r.content_hash, revision: r.revision };
}

// ---------------------------------------------------------------------------------------------
// QMS stand-ins
// ---------------------------------------------------------------------------------------------

export function recordChangeRecord(c: pg.PoolClient, def: ChangeRecordDefinition): Promise<string> {
  return one<string>(c, 'select recipe.record_change_record($1::jsonb) as r', [JSON.stringify(def)]);
}

export function addChangeValidation(c: pg.PoolClient, changeRecordId: string, validationRef: string, description?: string): Promise<string> {
  return one<string>(c, 'select recipe.add_change_validation($1, $2, $3) as r', [changeRecordId, validationRef, description ?? null]);
}

export function addChangeRegulatory(c: pg.PoolClient, changeRecordId: string, market: MarketCode, reportingCategory: string, reference?: string): Promise<string> {
  return one<string>(c, 'select recipe.add_change_regulatory($1, $2, $3, $4) as r', [changeRecordId, market, reportingCategory, reference ?? null]);
}

export function recordRiskAssessment(c: pg.PoolClient, def: RiskAssessmentDefinition): Promise<string> {
  return one<string>(c, 'select recipe.record_risk_assessment($1::jsonb) as r', [JSON.stringify(def)]);
}

// ---------------------------------------------------------------------------------------------
// Verification evidence (DI-04)
// ---------------------------------------------------------------------------------------------

export async function recordEvidence(c: pg.PoolClient, versionId: string, kind: EvidenceKind, report: unknown): Promise<EvidenceResult> {
  const r = await one<{ evidence_id: string; kind: EvidenceKind; mode: 'FULL' | 'DELTA' | null; result: 'PASS' | 'FAIL'; content_hash: string; report_hash: string; problems: string[] }>(
    c,
    'select recipe.record_evidence($1, $2, $3::jsonb) as r',
    [versionId, kind, JSON.stringify(report)],
  );
  return { evidenceId: r.evidence_id, kind: r.kind, mode: r.mode, result: r.result, contentHash: r.content_hash, reportHash: r.report_hash, problems: r.problems };
}

/**
 * DRAFT -> IN_VERIFICATION through the verification port (outline 5.2.1): the static validator runs
 * on the version's current content (read in this command), its report is stored with the content
 * hash, and only when the database finds it passing is the transition made, all in one command. The
 * warning justifications are the author's.
 */
export async function validateAndStartVerification(
  c: pg.PoolClient,
  versionId: string,
  expectedVersion: number,
  port: VerificationPort,
  justifications: readonly WarningJustification[] = [],
): Promise<{ evidence: EvidenceResult; transition?: state.TransitionResult }> {
  const { content } = await loadContent(c, versionId);
  const evidence = await recordEvidence(c, versionId, 'VALIDATOR', validatorEvidence(port.validate(content), justifications));
  if (evidence.result !== 'PASS') return { evidence };
  return { evidence, transition: await startVerification(c, versionId, expectedVersion) };
}

/**
 * Stores a full verification made through the port (validator, simulation with coverage, and the
 * generated test vectors the author confirms) for the version's current content. The sandbox run is
 * recorded separately (recordEvidence SANDBOX_RUN) when it has run on the same content.
 */
export async function recordVerification(
  c: pg.PoolClient,
  versionId: string,
  verification: FullVerification,
  justifications: readonly WarningJustification[],
  confirmedBy: string,
): Promise<EvidenceResult[]> {
  return [
    await recordEvidence(c, versionId, 'VALIDATOR', validatorEvidence(verification.report, justifications)),
    await recordEvidence(c, versionId, 'VERIFICATION', verification.evidence),
    await recordEvidence(c, versionId, 'TEST_VECTORS', testVectorEvidence(verification.simulation, confirmedBy)),
  ];
}

export async function evidenceStatus(db: Db, versionId: string): Promise<EvidenceStatus> {
  const r = await one<{ version_id: string; content_hash: string; complete: boolean; missing: string[]; delta: boolean; items: EvidenceStatus['items'] }>(
    db,
    'select recipe.evidence_status($1) as r',
    [versionId],
  );
  return { versionId: r.version_id, contentHash: r.content_hash, complete: r.complete, missing: r.missing, delta: r.delta, items: r.items };
}

// ---------------------------------------------------------------------------------------------
// The version machine
// ---------------------------------------------------------------------------------------------

export function versionState(db: Db, versionId: string): Promise<state.AggregateState | undefined> {
  return state.getAggregateState(db, { aggregateType: MBR_VERSION_AGGREGATE, aggregateId: versionId });
}

/**
 * Any event through the kernel engine (the guards hold every condition). RETIRE needs the QA person's own reason, code
 * and text, in the command context, as `retireVersion` does (guard mbr_version.no_open_authorisation, migration 0290).
 */
export function transitionVersion(c: pg.PoolClient, versionId: string, event: MbrVersionEvent, expectedVersion: number, signatureId?: string): Promise<state.TransitionResult> {
  return state.transition(c, {
    machine: MBR_VERSION_MACHINE,
    aggregateType: MBR_VERSION_AGGREGATE,
    aggregateId: versionId,
    event,
    expectedVersion,
    payload: signatureId ? { signature_id: signatureId } : {},
  });
}

/** DRAFT -> IN_VERIFICATION: needs a stored passing validator result for the exact content. */
export const startVerification = (c: pg.PoolClient, versionId: string, expectedVersion: number) => transitionVersion(c, versionId, 'START_VERIFICATION', expectedVersion);
/** IN_VERIFICATION -> SUBMITTED with the author's PREPARED signature. */
export const submitVersion = (c: pg.PoolClient, versionId: string, expectedVersion: number, preparedSignatureId: string) =>
  transitionVersion(c, versionId, 'SUBMIT', expectedVersion, preparedSignatureId);
/** SUBMITTED -> CHECKED with an independent checker's CHECKED signature (INV-04). */
export const checkVersion = (c: pg.PoolClient, versionId: string, expectedVersion: number, checkedSignatureId: string) =>
  transitionVersion(c, versionId, 'CHECK', expectedVersion, checkedSignatureId);
/** CHECKED -> APPROVED with QA's APPROVED signature (INV-04, PR-02, PR-04, PR-06, L-24). */
export const approveVersion = (c: pg.PoolClient, versionId: string, expectedVersion: number, approvedSignatureId: string) =>
  transitionVersion(c, versionId, 'APPROVE', expectedVersion, approvedSignatureId);
/** Any state before RETIRED -> WITHDRAWN (the command carries a reason). */
export const withdrawVersion = (c: pg.PoolClient, versionId: string, expectedVersion: number) => transitionVersion(c, versionId, 'WITHDRAW', expectedVersion);

/** IN_VERIFICATION / SUBMITTED / CHECKED -> DRAFT with a reason; supersedes every signature (DI-37). */
export async function returnToDraft(c: pg.PoolClient, versionId: string, expectedVersion: number): Promise<{ to: string; newVersion: number }> {
  const r = await one<{ to: string; new_version: number }>(c, 'select recipe.return_to_draft($1, $2) as r', [versionId, expectedVersion]);
  return { to: r.to, newVersion: Number(r.new_version) };
}

/**
 * APPROVED -> RETIRED by QA: ends every open market authorisation of the version (PR-05). The command carries the QA
 * person's own reason, code and text, whether or not a cell is open, or it is refused before anything changes
 * (EBMR-AUDIT-002; migration 0290); each ended cell's audit entry records that reason exactly.
 */
export async function retireVersion(c: pg.PoolClient, versionId: string, expectedVersion: number): Promise<{ to: string; newVersion: number }> {
  const r = await one<{ to: string; new_version: number }>(c, 'select recipe.retire_version($1, $2) as r', [versionId, expectedVersion]);
  return { to: r.to, newVersion: Number(r.new_version) };
}

/** The canonical content a signer of the version sees and signs (esig content provider). */
export function versionSigningContent(db: Db, versionId: string): Promise<esig.ContentForSigning> {
  return esig.contentForSigning(db, MBR_VERSION_AGGREGATE, versionId);
}

// ---------------------------------------------------------------------------------------------
// Market authorisation (ADR 0014)
// ---------------------------------------------------------------------------------------------

export const MARKET_AUTHORISATION_AGGREGATE = 'mbr_market_authorisation';

export function proposeMarketAuthorisation(c: pg.PoolClient, def: MarketAuthorisationDefinition): Promise<string> {
  return one<string>(c, 'select recipe.propose_market_authorisation($1::jsonb) as r', [JSON.stringify(def)]);
}

/**
 * Activates a proposed record with its QA and regulatory signatures; for CURRENT, supersedes the predecessor's cell
 * per scope cell. The command carries the QA person's own reason, code and text, for a first activation as for a
 * successor's, or it is refused before anything changes (EBMR-AUDIT-002; migration 0290). The superseded cell's
 * audit entry records that reason exactly; the system writes no part of it.
 */
export async function activateMarketAuthorisation(c: pg.PoolClient, authorisationId: string, qaSignatureId: string, regulatorySignatureId: string): Promise<ActivationResult> {
  const r = await one<{ authorisation_id: string; version_id: string; market: string; kind: 'CURRENT' | 'BRIDGING'; effective_from: string; cells: ActivationResult['cells'] }>(
    c,
    'select recipe.activate_market_authorisation($1, $2, $3) as r',
    [authorisationId, qaSignatureId, regulatorySignatureId],
  );
  return { authorisationId: r.authorisation_id, versionId: r.version_id, market: r.market, kind: r.kind, effectiveFrom: r.effective_from, cells: r.cells };
}

/**
 * Withdraws a record: its open cells end (WITHDRAWN). `reason` is the withdrawal's stated reason, kept on the
 * withdrawal record (EBMR-RCP-084). The command also carries the QA person's own reason, code and text, or it is
 * refused before anything changes (EBMR-AUDIT-002; migration 0290); each ended cell's audit entry records it exactly.
 */
export async function withdrawMarketAuthorisation(c: pg.PoolClient, authorisationId: string, reason: string): Promise<{ cellsEnded: number }> {
  const r = await one<{ cells_ended: number }>(c, 'select recipe.withdraw_market_authorisation($1, $2) as r', [authorisationId, reason]);
  return { cellsEnded: r.cells_ended };
}

// ---------------------------------------------------------------------------------------------
// Selection at issue, pin and control recipe (INV-01, INV-02)
// ---------------------------------------------------------------------------------------------

export interface SelectionRequest {
  familyId: string;
  markets: readonly MarketCode[];
  scope: IssueScope;
  /** ISO instant; the database clock when absent. */
  at?: string;
}

export function selectVersionForIssue(db: Db, req: SelectionRequest): Promise<SelectionResult> {
  return one<SelectionResult>(db, 'select recipe.select_version_for_issue($1, $2::text[], $3::jsonb, $4::timestamptz) as r', [
    req.familyId,
    req.markets,
    JSON.stringify(req.scope),
    req.at ?? null,
  ]);
}

export function createStubBatch(c: pg.PoolClient, def: StubBatchDefinition): Promise<string> {
  return one<string>(c, 'select recipe.create_stub_batch($1::jsonb) as r', [JSON.stringify(def)]);
}

/**
 * PLANNED -> ISSUED: selection at the database clock, pin, control recipe (INV-01, INV-02). The command
 * carries the issuer's own reason, code and text, or the issue is refused (EBMR-AUDIT-002).
 */
export async function issueStubBatch(c: pg.PoolClient, batchId: string, versionId?: string): Promise<IssueResult> {
  const r = await one<{
    batch_id: string;
    pin_id: string;
    version_id: string;
    version_number: number;
    content_hash: string;
    rule: string;
    basis: IssueResult['basis'];
    control_recipe_id: string;
    snapshot_hash: string;
  }>(c, 'select recipe.issue_stub_batch($1, $2) as r', [batchId, versionId ?? null]);
  return {
    batchId: r.batch_id,
    pinId: r.pin_id,
    versionId: r.version_id,
    versionNumber: r.version_number,
    contentHash: r.content_hash,
    rule: r.rule,
    basis: r.basis,
    controlRecipeId: r.control_recipe_id,
    snapshotHash: r.snapshot_hash,
  };
}

/** The command carries the user's own reason, code and text, or the status change is refused (EBMR-AUDIT-002). */
export function setStubBatchStatus(c: pg.PoolClient, batchId: string, status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'): Promise<void> {
  return exec(c, 'select recipe.set_stub_batch_status($1, $2)', [batchId, status]);
}

/** INV-02: the database check plus the same hash recomputed here over the stored snapshot. */
export async function verifyControlRecipe(db: Db, batchId: string): Promise<ControlRecipeCheck> {
  const r = await one<{ batch_id: string; ok: boolean; stored_hash?: string; computed_hash?: string; pinned_content_hash?: string; problems: string[] }>(
    db,
    'select recipe.verify_control_recipe($1) as r',
    [batchId],
  );
  const out: ControlRecipeCheck = { batchId: r.batch_id, ok: r.ok, problems: r.problems };
  if (r.stored_hash !== undefined) out.storedHash = r.stored_hash;
  if (r.computed_hash !== undefined) out.computedHash = r.computed_hash;
  if (r.pinned_content_hash !== undefined) out.pinnedContentHash = r.pinned_content_hash;
  const snap = await db.query<{ snapshot: unknown }>('select snapshot from recipe.control_recipe where batch_id = $1', [batchId]);
  const snapshot = snap.rows[0]?.snapshot;
  if (snapshot !== undefined) {
    out.tsComputedHash = esig.sha256Hex(esig.canonicalJson(snapshot));
    if (out.tsComputedHash !== out.storedHash) {
      out.ok = false;
      if (!out.problems.includes('the snapshot does not hash to its stored hash (the issued control recipe changed)')) {
        out.problems = [...out.problems, 'the snapshot does not hash to its stored hash (recomputed outside the database)'];
      }
    }
  }
  return out;
}

export function recordInFlightDisposition(c: pg.PoolClient, successorVersionId: string, batchId: string, disposition: InFlightDisposition, reason: string): Promise<string> {
  return one<string>(c, 'select recipe.record_in_flight_disposition($1, $2, $3, $4) as r', [successorVersionId, batchId, disposition, reason]);
}

export async function inFlightBatches(db: Db, versionId: string): Promise<{ batchId: string; batchNumber: string; status: string; pinnedVersionNumber: number; disposition: InFlightDisposition | null }[]> {
  const { rows } = await db.query<{ batch_id: string; batch_number: string; status: string; pinned_version_number: number; disposition: InFlightDisposition | null }>(
    'select * from recipe.in_flight_batches($1)',
    [versionId],
  );
  return rows.map((r) => ({ batchId: r.batch_id, batchNumber: r.batch_number, status: r.status, pinnedVersionNumber: r.pinned_version_number, disposition: r.disposition }));
}

export async function whereUsed(db: Db, versionId: string): Promise<{ batchId: string; batchNumber: string; status: string; markets: string[] }[]> {
  const { rows } = await db.query<{ batch_id: string; batch_number: string; status: string; markets: string[] }>('select * from recipe.where_used($1)', [versionId]);
  return rows.map((r) => ({ batchId: r.batch_id, batchNumber: r.batch_number, status: r.status, markets: r.markets }));
}

// ---------------------------------------------------------------------------------------------
// Periodic review (PR-05)
// ---------------------------------------------------------------------------------------------

export function recordPeriodicReview(c: pg.PoolClient, versionId: string, outcome: ReviewOutcome, summary: string, nextDue: string): Promise<string> {
  return one<string>(c, 'select recipe.record_periodic_review($1, $2, $3, $4::date) as r', [versionId, outcome, summary, nextDue]);
}

/** The dashboard's overdue list (as of the site date, or the date given as YYYY-MM-DD). */
export async function overdueReviews(db: Db, asOf?: string): Promise<OverdueReview[]> {
  const { rows } = await db.query<{
    version_id: string;
    family_code: string;
    version_number: number;
    document_id: string;
    review_due: string;
    days_overdue: number;
    last_review_at: string | null;
    in_use: boolean;
  }>(
    "select version_id, family_code, version_number, document_id, to_char(review_due, 'YYYY-MM-DD') as review_due, days_overdue, recipe.utc_text(last_review_at) as last_review_at, in_use from recipe.overdue_reviews($1::date)",
    [asOf ?? null],
  );
  return rows.map((r) => ({
    versionId: r.version_id,
    familyCode: r.family_code,
    versionNumber: r.version_number,
    documentId: r.document_id,
    reviewDue: r.review_due,
    daysOverdue: r.days_overdue,
    lastReviewAt: r.last_review_at,
    inUse: r.in_use,
  }));
}

// ---------------------------------------------------------------------------------------------
// Invariant queries (zero rows expected)
// ---------------------------------------------------------------------------------------------

export async function invariantViolations(db: Db): Promise<InvariantViolation[]> {
  const { rows } = await db.query<{ invariant: string; subject: string; detail: string }>('select invariant, subject::text as subject, detail from recipe.invariant_violations()');
  return rows;
}
