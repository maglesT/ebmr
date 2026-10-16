/**
 * The ENGINE_COMMAND signable action (module C3; Phase 2 apps plan section 6): SIGN_PERFORMED, VERIFY
 * (verified or witnessed), DISPOSITION_HOLD_POINT, SIGN_OFF_STAGE and DISPOSITION_EXCEPTION on a sandbox test
 * run, through C1's ceremony.
 *
 *  - describe(): the aggregate (batch_step, batch_stage or batch_exception `<run>:<key>`), the meaning the
 *    engine requires (from the run cache; unknown runs leave it to the checks below) and the state the engine
 *    requires the record in (esig.sign binds the signature to it).
 *  - previewContent(): a pure preview at the database time: the record as it will be after the sweep and,
 *    for PERFORMED, the finalisation, with the exact canonical text the kernel hashes, the next content version
 *    and a rendering (batch_step, batch_stage, batch_exception). The rendering shows as the record to be signed
 *    only what the canonical content holds; what is shown beside it for information (the status, deviation and
 *    handling of exceptions, the exceptions raised by acts about a step, a stage's exceptions, targets, live
 *    loop-endpoint verdicts, the times of system computations) is in `notSigned`, which the dialog shows apart
 *    and labelled as not part of the signature (review finding CN1; DI-37, DI-36). A stage's signed text holds its
 *    summary (statement, step counts, exception ids, deviations, yields), which the STAGE_SIGNED_OFF meaning confirms
 *    and the dialog shows as signed (Phase 2 exit review F01).
 *  - prepareForChallenge(): refuses a step's PERFORMED or VERIFY signature from a terminal outside the step's room
 *    before the challenge, so before the PIN (EBMR-EXE-123, DI-20; the database refuses the signed row too), locks
 *    the run and appends a PREPARE row when the system facts changed the record,
 *    and records what is being decided as part of the signed content: an exception's proposed disposition
 *    (recipe.propose_disposition) or a hold point's proposed decision, its disposition and comment
 *    (recipe.propose_hold_point_decision, recipe-core 0295; review findings P26, P38).
 *  - dryRun(): locks the run, checks that the decision of the sign request is the one its challenge recorded
 *    (EBMR-EXE-086, before anything is written), prepares again, and runs the command with a placeholder
 *    signature. A refusal by the engine is recorded as a refused COMMAND row and answered; nothing is signed.
 *    Accepted: the content hash and version the signature would bind (C1 compares them with the challenge).
 *  - apply(): runs the command with the real signature; any refusal or content change after the seal throws,
 *    so the whole command (signature, seal, row) rolls back (INV-10).
 * The binding of a decision lives in the database, not in this process: the proposal is part of the content the
 * challenge and the signature hash, and recipe.check_signatures refuses a decision other than the one the
 * signature covers, made by the signer when this signature was requested (0295). The meaning of the challenge
 * must be the one the engine requires at the transaction's time (EBMR-EXE-080; a verifier signs the step's own check,
 * P37, which the database checks too). A check due as a witness is a witness only while one is possible: once the
 * witness window after the act has passed or the run moved on (the kernel refuses a witness then, EBMR-ESIG-051/052),
 * it is the step's later review, which raises WITNESS_LATE for QA (engine 1.5.0, recipe-core 0333; T12.LATE), so a
 * witness asked for then is a meaning mismatch and the screen, reloaded, offers the review.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { engine, execution, flow } from '@ebmr/recipe-core';
import { unstorableTextIssues, type ExceptionView, type FieldView, type Refusal, type SignableAction, type SignableContentView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { DryRunOutcome, SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import type { EsigSignableContext } from '../esig/content.ts';
import { meaningInfo } from '../esig/views.ts';
import { engineRefusal } from './guidance.ts';
import { correctionApproval, signedCommand, signedMeaning, signedSubject, stepRoomRefusal, stepTarget, wireOf } from './intents.ts';
import { peopleText } from './people-text.ts';
import { displayPermissions, displayRoles, engineActor, engineRoles } from './roles.ts';
import { loadRowFacts, notFound, runCache, runContext, type Db, type RunContext } from './runs.ts';
import { entriesOf, exceptionsOfStep, exceptionView, fieldsOf, limitViews, specOf, stageRef, stepScreen, stepSummary, type ViewContext, type ViewerInfo } from './views.ts';

type Json = Record<string, unknown>;
type Limit = FieldView['limits'][number];

type EngineAction = Extract<SignableAction, { kind: 'ENGINE_COMMAND' }>;

const HANDLED: readonly engine.AggregateType[] = ['batch_step', 'batch_stage', 'batch_exception'];
const UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$/i;

const meaningOf = (ctx: SignableContext): string => (ctx as Partial<EsigSignableContext>).meaning ?? '';

function mismatch(expected: string | undefined, given: string): Refusal {
  return {
    code: 'EBMR-EXE-080',
    kind: 'INVALID_INPUT',
    whatHappened: 'The signature meaning does not match this action. Nothing was signed.',
    why: `This action is signed ${expected ?? '(unknown)'}; the signing was started for ${given || '(none)'}.`,
    controls: ['DI-35', 'DI-37'],
    whatYouCanDo: ['Reload the screen and start the signing again.'],
    whoCanHelp: [],
  };
}

function stale(state: engine.BatchState, expected: number): Error {
  return refusal(409, {
    code: 'ENG-STALE',
    kind: 'STALE',
    whatHappened: 'The test run changed since this screen was loaded. Nothing was signed.',
    why: `The run is at version ${state.version}; the screen showed version ${expected}.`,
    controls: ['DI-34'],
    whatYouCanDo: ['Reload the screen and start the signing again.'],
  }, true);
}

/** The session facts of a signing context, for the views a signing returns. */
function viewerOf(ctx: SignableContext): ViewerInfo {
  return { personId: ctx.actor.personId, legalName: ctx.actor.legalName ?? ctx.actor.personId, loginName: null, roleCode: ctx.actor.roleCode, deviceClass: ctx.deviceClass, roomCode: ctx.room };
}

async function viewContext(app: AppContext, db: Db, run: RunContext, state: engine.BatchState, nowUs: bigint, viewer: ViewerInfo): Promise<ViewContext> {
  return {
    app,
    db,
    run,
    state,
    nowUs,
    rows: await loadRowFacts(db, run.batch.id),
    session: viewer,
    viewer: { id: viewer.personId, kind: 'PERSON', roles: await displayRoles(app, db, viewer.roleCode) },
    permissions: await displayPermissions(app, db, viewer.roleCode),
  };
}

/** A hold-point decision being signed: the disposition and the reviewer's comment (null when none). */
export interface HoldPointDecision {
  disposition: string;
  comment: string | null;
}

/** The decision of a DISPOSITION_HOLD_POINT intent, as the signed content holds it. */
export const decisionOf = (intent: { disposition: string; comment?: string | undefined }): HoldPointDecision => ({ disposition: intent.disposition, comment: intent.comment ?? null });

const sameDecision = (a: HoldPointDecision, b: HoldPointDecision): boolean => a.disposition === b.disposition && a.comment === b.comment;

function badIntent(expected: string): Error {
  return refusal(400, { code: 'SCHEMA', kind: 'INVALID_INPUT', whatHappened: 'The decision to sign in the request is not in the expected form.', why: `Expected ${expected}.`, controls: ['DI-37'], whatYouCanDo: ['Reload the screen and start the signing again.'] });
}

/**
 * The `intent` of a content preview: the meaning code, and for a decision the decision being signed, which is part
 * of the signed content (so the signer's preview must show and hash it):
 *  - an exception disposition: `EXCEPTION_DISPOSITIONED|<base64url of the JSON {outcome, justification}>`;
 *  - a hold-point decision: `HOLD_POINT_RELEASED|<base64url of the JSON {disposition, comment}>` (or
 *    HOLD_POINT_NOT_RELEASED), the comment a text or null (review findings P26, P38).
 * The decision travels encoded, so the contract's check of the query cannot see its text: bytes that are not UTF-8 are
 * refused, never read as U+FFFD, and so is text no record can hold (U+0000, a lone surrogate), naming the member, before
 * anything is hashed or stored (review F31, F33).
 */
export function parseIntent(intent: string): {
  meaning: string;
  proposal: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string } | null;
  decision: HoldPointDecision | null;
} {
  const bar = intent.indexOf('|');
  if (bar < 0) return { meaning: intent, proposal: null, decision: null };
  const meaning = intent.slice(0, bar);
  let p: unknown;
  try {
    p = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(intent.slice(bar + 1), 'base64url')));
  } catch {
    p = null;
  }
  const r = (p !== null && typeof p === 'object' && !Array.isArray(p) ? p : {}) as Record<string, unknown>;
  const unstorable = unstorableTextIssues(r);
  if (unstorable.length > 0) {
    throw refusal(400, {
      code: 'SCHEMA',
      kind: 'INVALID_INPUT',
      whatHappened: 'The decision to sign in the request holds text no record can hold. Nothing was signed.',
      why: unstorable.map((i) => `The ${i.path.length > 0 ? i.path.join('.') : 'decision'} ${i.message}.`).join(' '),
      controls: ['DI-37'],
      whatYouCanDo: ['Enter the text again, then start the signing again.'],
    });
  }
  if (meaning === engine.MEANINGS.HOLD_RELEASED || meaning === engine.MEANINGS.HOLD_NOT_RELEASED) {
    const comment = r['comment'] ?? null;
    const known = Object.keys(r).every((k) => k === 'disposition' || k === 'comment');
    if (!known || typeof r['disposition'] !== 'string' || r['disposition'] === '' || (comment !== null && (typeof comment !== 'string' || comment.length > 2000))) {
      throw badIntent('<meaning>|<base64url JSON {disposition, comment}>');
    }
    // The decision's class is the meaning: a release is never previewed as a refusal, nor the other way round.
    if (engine.holdPointMeaning(r['disposition']) !== meaning) throw badIntent(`a decision signed ${meaning}`);
    return { meaning, proposal: null, decision: { disposition: r['disposition'], comment } };
  }
  if ((r['outcome'] !== 'NO_IMPACT' && r['outcome'] !== 'DEVIATION_RAISED') || typeof r['justification'] !== 'string' || r['justification'].trim() === '') {
    throw refusal(400, { code: 'SCHEMA', kind: 'INVALID_INPUT', whatHappened: 'The proposed disposition in the request is not in the expected form.', why: 'Expected <meaning>|<base64url JSON {outcome, justification}>.', controls: ['DI-37'], whatYouCanDo: ['Reload the screen and start the signing again.'] });
  }
  return { meaning, proposal: { outcome: r['outcome'], justification: r['justification'] }, decision: null };
}

const sameProposal = (a: execution.DispositionProposal | null, b: execution.DispositionProposal | null): boolean =>
  a !== null && b !== null && a.outcome === b.outcome && a.justification === b.justification && a.deviationRef === b.deviationRef;

function proposalOf(state: engine.BatchState, exceptionId: string, p: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }): execution.DispositionProposal {
  return { outcome: p.outcome, justification: p.justification, deviationRef: state.exceptions[exceptionId]?.deviation?.ref ?? null };
}

function proposalChanged(exceptionId: string): Refusal {
  return {
    code: 'EBMR-EXE-086',
    kind: 'CONTENT_CHANGED',
    whatHappened: 'The disposition to sign is not the one reviewed at the start of the signing. Nothing was signed.',
    why: `The outcome, justification or linked deviation of exception ${exceptionId} differs from the disposition prepared for the signature.`,
    controls: ['DI-37', 'PR-49'],
    whatYouCanDo: ['Review the disposition again, then sign again.'],
    whoCanHelp: [],
  };
}

/** A stored proposal of a hold-point decision: the latest one made on a content version of the hold point. */
interface StoredDecision extends HoldPointDecision {
  proposedBy: string;
  correlationId: string;
}

/** The latest decision proposed on content version `version` of hold point `key` (recipe.execution_decision_proposal, 0295). */
async function loadDecision(db: Db, runId: string, key: string, version: number): Promise<StoredDecision | null> {
  const { rows } = await db.query<{ proposal: { disposition: string; comment: string | null }; proposed_by_person: string; correlation_id: string }>(
    `select p.proposal, p.proposed_by_person::text as proposed_by_person, p.correlation_id::text as correlation_id
       from recipe.execution_decision_proposal p where p.aggregate_id = $1 and p.content_version = $2 order by p.id desc limit 1`,
    [`${runId}:${key}`, version],
  );
  const r = rows[0];
  return r ? { disposition: r.proposal.disposition, comment: r.proposal.comment ?? null, proposedBy: r.proposed_by_person, correlationId: r.correlation_id } : null;
}

/** Whether `c` is the content of a hold point (whose signed content carries the decision). */
const isHoldPoint = (c: engine.AggregateContent): boolean => c.type === 'batch_step' && (c.content['step'] as Record<string, unknown> | undefined)?.['kind'] === 'HOLD';

/**
 * The canonical envelope hash and version a signature on `c` would bind, given the stored head. What is being
 * decided is part of the signed content: an exception's proposed disposition (`proposal`) and a hold point's
 * proposed decision (`decision`); when undefined, the one stored on the head (as the content provider adds it). A
 * stage's content also holds its summary (`summary`: engine.stageSummaryMember of the same state; F01).
 */
async function bindingOf(
  db: Db,
  runId: string,
  c: engine.AggregateContent,
  summary: engine.StageSummaryContent | undefined,
  proposal?: execution.DispositionProposal | null,
  decision?: HoldPointDecision | null,
): Promise<{ version: number; text: string; hash: string }> {
  const head = await execution.loadContentHead(db, c.type, runId, c.key);
  const version = head && head.hash === c.contentHash ? head.version : (head?.version ?? 0) + 1;
  let content = c.content;
  if (c.type === 'batch_exception') {
    const p = proposal !== undefined ? proposal : head && version === head.version ? await execution.loadProposal(db, runId, c.key, version) : null;
    content = { ...content, proposedDisposition: p ? { outcome: p.outcome, justification: p.justification, deviationRef: p.deviationRef } : null };
  }
  if (c.type === 'batch_stage' && summary !== undefined) {
    // The stage's derived summary, which the STAGE_SIGNED_OFF meaning confirms, is part of the signed text (F01), as
    // the database's provider adds it (recipe-core 0319).
    content = { ...content, summary };
  }
  if (isHoldPoint(c)) {
    const d = decision !== undefined ? decision : head && version === head.version ? await loadDecision(db, runId, c.key, version) : null;
    // As the provider gives it (recipe-core 0302): the member only once a decision is proposed, so a hold point
    // without one keeps the content signed before 0295.
    if (d) content = { ...content, proposedDecision: { disposition: d.disposition, comment: d.comment } };
  }
  const env = engine.signingEnvelope(c.type, `${runId}:${c.key}`, version, content);
  return { version, text: env.text, hash: env.hash };
}

/** The signature target of an aggregate being previewed for a meaning (the challenge names the aggregate and the meaning only). */
function previewTarget(def: engine.BatchDefinition, state: engine.BatchState, type: engine.AggregateType, key: string, meaning: string): engine.SignatureTarget {
  if (type === 'batch_stage') return { type: 'SIGN_OFF_STAGE' };
  if (type === 'batch_exception') return { type: 'DISPOSITION_EXCEPTION' };
  const inst = state.steps[key];
  if (inst?.kind === 'HOLD') return { type: 'DISPOSITION_HOLD_POINT' };
  const t = stepTarget(state, key);
  return meaning === engine.performMeaning(def, t.step) ? { type: 'SIGN_PERFORMED', step: t.step, context: t.context } : { type: 'VERIFY' };
}

// ---------------------------------------------------------------------------------------------
// What the dialog shows as signed, and what it shows beside it (review finding CN1; DI-37, DI-36)

/** The note of the `notSigned` part of a rendering. */
export const NOT_SIGNED_NOTE =
  'Shown for information only. These facts are not part of the signed content: this signature does not cover them, and they may change after signing without affecting it.';

/** The members of an exception view that a step's content signs (the exception as raised; not its time, which the preparation may set). */
const STEP_EXCEPTION_SIGNED = ['exceptionId', 'type', 'title', 'category', 'severity', 'tier', 'expected', 'actual', 'raisedBy', 'controls'] as const;
/** An exception's own content (batch_exception) also signs when it was raised and the deviation linked to it. */
const EXCEPTION_SIGNED = [...STEP_EXCEPTION_SIGNED, 'raisedAt', 'deviationRef'] as const;

function pick(v: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((k) => k in v).map((k) => [k, v[k]]));
}

function omit(v: Json, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
}

const idsOf = (list: unknown): Map<string, Json> =>
  new Map(
    (Array.isArray(list) ? (list as unknown[]) : [])
      .filter((x): x is Json => x !== null && typeof x === 'object' && typeof (x as Json)['id'] === 'string')
      .map((x) => [x['id'] as string, x]),
  );

/** A field of a step as displayed, with the tolerance band derived from its target (not signed) apart from its MBR limits. */
export interface FieldForSigning extends FieldView {
  band: Limit[];
}

/** Why an exception shown with a step is not part of the step's signed content (it is signed in its own exception record). */
export const NOT_SIGNED_WHY = {
  OTHER_INSTANCE: 'Raised about this step, not by the data of this step instance (it names the step but no instance of it): it is signed in its own exception record.',
  OPERATOR_RAISED: 'Reported by a person about the step, not raised by its data: it is signed in its own exception record.',
  WITNESS_LATE: 'Raised by a witness signature given after the witness window, an act about the step: it is signed in its own exception record.',
  HOLD_POINT_NOT_APPROVED: 'Raised by the decision not to release the hold point, an act about the step: it is signed in its own exception record.',
  STEP_SKIPPED: 'Raised by the approved skip of the step, an act about the step: it is signed in its own exception record.',
  EXECUTED_TARGET_CHANGED: 'Raised when a target this step used was changed after it was executed, a later act: it is signed in its own exception record.',
  CALCULATION_WITHDRAWN: 'Raised when a derived value of the step was withdrawn after the fact because its inputs were invalidated elsewhere, a later act: it is signed in its own exception record.',
  LOOP_EXIT_VERDICT: 'The verdict on a loop endpoint, judged when the loop exits, after this step was signed (the step signs the value as "judged at the loop exit"): it is signed in its own exception record.',
  OTHER: 'Not part of this step\'s signed content: it is signed in its own exception record.',
} as const;

/** The reason an exception shown with step instance `stepKey` is outside its signed content (the branches of engine.isStepDataException). */
export function notSignedWhy(def: engine.BatchDefinition, state: engine.BatchState, e: engine.ExceptionRecord, stepKey: string): string {
  if (e.source.stepKey !== stepKey) return NOT_SIGNED_WHY.OTHER_INSTANCE;
  if (engine.ACT_EXCEPTION_TYPES.has(e.type)) return NOT_SIGNED_WHY[e.type as keyof typeof NOT_SIGNED_WHY] ?? NOT_SIGNED_WHY.OTHER;
  if (e.type === 'CALCULATION_FAILED' && e.source.derived !== undefined) return NOT_SIGNED_WHY.CALCULATION_WITHDRAWN;
  const p = e.source.point !== undefined ? state.points[e.source.point] : undefined;
  if (e.type === 'LIMIT_BREACH' && p !== undefined && engine.judgedAtLoopExit(def, p)) return NOT_SIGNED_WHY.LOOP_EXIT_VERDICT;
  return NOT_SIGNED_WHY.OTHER;
}

/**
 * The parts of a step's rendering, split by what the canonical content `content` (ebmr.batch-step-content) holds:
 *  - exceptions: those in content.exceptions, as raised (no status, deviation, handling or time);
 *  - fields: without the target and the tolerance band derived from it; each attempt as recorded in
 *    content.points or content.derived, with the verdict the content signs (a loop endpoint is judged at the loop
 *    exit), without its status now (valid, superseded, invalidated: a point's status is never signed) and without
 *    the time of a system computation (a block-computed value, a derived value);
 *  - notSigned: everything else that is shown, with the note; each exception outside the content with the reason
 *    (`why`, from `whyNotSigned` by exception id; a general reason when none is given).
 * Pure: the same content and parts give the same rendering.
 */
export function stepForSigning(
  content: Json,
  parts: { fields: readonly FieldForSigning[]; exceptions: readonly ExceptionView[]; whyNotSigned?: ReadonlyMap<string, string> },
): { fields: Json[]; exceptions: Json[]; notSigned: Json } {
  const signedExceptions = idsOf(content['exceptions']);
  const points = idsOf(content['points']);
  const derived = idsOf(content['derived']);
  const targets: Json[] = [];
  const verdicts: Json[] = [];
  const times: Json[] = [];
  const statuses: Json[] = [];
  const unrecorded: Json[] = [];
  const fields = parts.fields.map((f) => {
    if (f.target !== null || f.band.length > 0) targets.push({ item: f.item, name: f.name, target: f.target, limits: f.band });
    const attempts: Json[] = [];
    for (const a of f.attempts) {
      const at = { item: f.item, pointId: a.pointId, attempt: a.attempt, version: a.version };
      const p = points.get(a.pointId);
      const d = derived.get(a.pointId);
      if (p || d) statuses.push({ ...at, status: a.status });
      if (p) {
        const evaluation = (p['evaluation'] ?? null) as Json | null;
        let shown: Json = omit(a, ['status']);
        if (evaluation !== null && evaluation['requirement'] === 'ENDPOINT_IN_PROGRESS') {
          // The content signs "judged at the loop exit"; the verdict given at the exit is a later fact.
          shown = { ...shown, verdict: { tier: null, failed: false, text: 'Judged when the loop ends' } };
          if (a.verdict !== null && a.verdict.text !== 'Judged when the loop ends') verdicts.push({ ...at, verdict: a.verdict });
        }
        if (p['recordedAt'] === null) {
          shown = omit(shown, ['at']);
          times.push({ ...at, at: a.at, what: 'the time the system computed this value when the step was prepared for signing' });
        }
        attempts.push(shown);
      } else if (d) {
        attempts.push(omit(a, ['at', 'by', 'status']));
        times.push({ ...at, at: a.at, by: a.by, what: 'the time and the command of the computation' });
      } else {
        unrecorded.push({ ...at, attemptShown: a });
      }
    }
    return { ...omit(f as unknown as Json, ['target', 'band', 'attempts']), attempts };
  });
  const exceptions = parts.exceptions.filter((e) => signedExceptions.has(e.exceptionId)).map((e) => pick(e as unknown as Json, STEP_EXCEPTION_SIGNED));
  const context = parts.exceptions.map((e) =>
    signedExceptions.has(e.exceptionId)
      ? { exceptionId: e.exceptionId, title: e.title, inSignedContent: true, ...omit(e as unknown as Json, [...STEP_EXCEPTION_SIGNED, 'title']) }
      : { ...(e as unknown as Json), inSignedContent: false, why: parts.whyNotSigned?.get(e.exceptionId) ?? NOT_SIGNED_WHY.OTHER },
  );
  return {
    fields,
    exceptions,
    notSigned: {
      note: NOT_SIGNED_NOTE,
      exceptions: context,
      ...(targets.length > 0 ? { targets } : {}),
      ...(verdicts.length > 0 ? { verdicts } : {}),
      ...(times.length > 0 ? { times } : {}),
      ...(statuses.length > 0 ? { statuses } : {}),
      ...(unrecorded.length > 0 ? { unrecorded } : {}),
    },
  };
}

/** Why the master record's version label is shown apart from the record to be signed (F03). */
export const MBR_VERSION_NOTE =
  "The version number and revision come from the test package's own metadata; the signature binds the master record content by its hash, not this label.";

/** The same note for a GMP batch (its control recipe names the version; Phase 3 slice 2b). */
export const MBR_VERSION_NOTE_GMP =
  "The version number and revision are those of the effective MBR version the batch's control recipe was made from; the signature binds the master record content by its hash, not this label.";

/** The note of a hold point previewed without the decision being signed (it cannot be signed as shown). */
export const NO_DECISION_NOTE = 'The decision is part of the signed content: preview it with the intent <meaning>|<base64url JSON {disposition, comment}>.';

function rendering(
  vc: ViewContext,
  type: engine.AggregateType,
  key: string,
  meaning: { code: string; text: string },
  decided: { proposal: execution.DispositionProposal | null; decision: HoldPointDecision | null },
  c: engine.AggregateContent,
): { title: string; data: Record<string, unknown> & { kind: string } } {
  const proposal = decided.proposal;
  const run = vc.run;
  // The header shown as part of the record to be signed comes from the MBR content the signature binds (content.batch:
  // family, product code and the MBR hash, which binds the content's header product name and strength), never from the
  // test package's own metadata. The package's version label is shown apart, as not signed (Phase 2 exit review F03).
  const h = run.def.mbr.header;
  const common = {
    runId: run.batch.id,
    batchNumber: vc.state.header.batchNumber,
    product: { code: h.product.code, name: h.product.name, strength: h.product.strength },
    mbr: { familyCode: h.family, contentHash: run.def.contentHash },
    meaning: meaning.code,
    meaningText: meaning.text,
  };
  const pkgFacts = { mbrVersion: { number: run.mbr.versionNumber, revision: run.mbr.revision, note: run.pkg ? MBR_VERSION_NOTE : MBR_VERSION_NOTE_GMP } };
  if (type === 'batch_step') {
    const inst = vc.state.steps[key];
    if (!inst) throw notFound('step');
    const stepDef = run.def.steps.get(inst.step);
    if (!stepDef) throw notFound('step');
    const summary = stepSummary(vc, inst, inst.step, key);
    const shown = exceptionsOfStep(vc, inst, key, inst.step);
    const sopId = stepDef.node.kind === 'phase' && typeof stepDef.node.config['sop'] === 'string' ? stepDef.node.config['sop'] : undefined;
    const sop = sopId ? run.def.mbr.references.find((r) => r.id === sopId) : undefined;
    const signedParts = stepForSigning(c.content, {
      fields: fieldsForSigning(vc, stepDef, inst, key),
      exceptions: shown.map((e) => exceptionView(vc, e)),
      whyNotSigned: new Map(shown.map((e) => [e.id, notSignedWhy(run.def, vc.state, e, key)])),
    });
    return {
      title: `${summary.number} ${summary.title}`,
      data: {
        kind: 'batch_step',
        ...common,
        step: { stepKey: key, stepId: inst.step, number: summary.number, title: summary.title, kind: inst.kind, block: summary.block, blockTitle: stepDef.block?.title ?? null, stage: stageRef(vc, stepDef.stage) },
        instruction: { text: stepDef.node.kind === 'phase' && typeof stepDef.node.config['text'] === 'string' ? stepDef.node.config['text'] : null, sop: sop ? { code: sop.code, title: sop.title, version: sop.version, hash: sop.hash ?? null } : null },
        // A hold point's decision (disposition and comment) is part of the signed content (proposedDecision), bound
        // when the signing challenge is prepared; a preview without it cannot be signed as shown (P26, P38).
        ...(inst.kind === 'HOLD' ? { decision: decided.decision ? { proposed: { disposition: decided.decision.disposition, comment: decided.decision.comment } } : { proposed: null, note: NO_DECISION_NOTE } } : {}),
        entries: entriesOf(vc, key),
        ...signedParts,
        notSigned: { ...signedParts.notSigned, ...pkgFacts },
      },
    };
  }
  if (type === 'batch_stage') {
    const frame = vc.state.stages[key];
    if (!frame) throw notFound('stage');
    const ref = stageRef(vc, frame.stage);
    const steps = engine.stageSteps(run.def, vc.state, frame).map((i) => stepSummary(vc, i, i.step, i.key));
    // The stage's content signs its steps (number, status, content hash) and its summary (F01): the statement, the
    // step counts, the ids of its exceptions, the deviations and the yields, as the sign-off records them. The
    // exceptions themselves (each signed in its own record), their status and how many are open are shown apart.
    // The same member bindingOf adds to the signed text (the same state).
    const summary = engine.stageSummaryMember(run.def, vc.state, key);
    const exceptions = engine.deriveStageSummary(run.def, vc.state, frame).exceptions;
    return {
      title: `Stage ${ref?.number ?? ''} ${ref?.name ?? frame.stage}`.trim(),
      data: {
        kind: 'batch_stage',
        ...common,
        stage: { stageKey: key, stageId: frame.stage, number: ref?.number ?? '', name: ref?.name ?? frame.stage, startedAt: vc.app.formatInstant(frame.startedAt) },
        steps: steps.map((x) => omit(x as unknown as Json, ['openExceptions'])),
        summary: summary ? summaryForSigning(run.def, summary) : null,
        notSigned: {
          note: NOT_SIGNED_NOTE,
          ...pkgFacts,
          openExceptions: steps.filter((x) => x.openExceptions > 0).map((x) => ({ stepKey: x.stepKey, number: x.number, openExceptions: x.openExceptions })),
          // The exceptions the summary counts (as the sign-off derives them: also a time-limit breach that names a step
          // of the stage by step and frames), with their status and handling.
          exceptions: [...exceptions].sort((a, b) => a.raisedSeq - b.raisedSeq).map((e) => exceptionView(vc, e)),
        },
      },
    };
  }
  const e = vc.state.exceptions[key];
  if (!e) throw notFound('exception');
  const raisedAt = exceptionStep(vc, e);
  const point = e.source.point !== undefined ? vc.state.points[e.source.point] : undefined;
  const derived = e.source.derived !== undefined ? vc.state.derived[e.source.derived] : undefined;
  const item = point?.item ?? derived?.calculation;
  const param = item ? run.def.mbr.parameters.find((p) => p.id === item) : undefined;
  const calc = item ? run.def.mbr.calculations.find((c) => c.id === item) : undefined;
  const value = point?.value ?? derived?.value;
  const view = exceptionView(vc, e);
  return {
    title: `Exception ${e.id}: ${e.title}`,
    data: {
      kind: 'batch_exception',
      ...common,
      // The step the signed source names (source.stepKey, or source.step in source.frames, as a time-limit breach the
      // system raises names it), null only when the signed source names no step (Phase 2 exit review F02).
      step: raisedAt,
      // The exception's content signs it as raised and its deviation link, never its status or handling.
      exception: pick(view, EXCEPTION_SIGNED),
      // What else the signed source names: the time constraint and the construct (loop, replicate, alternative).
      source: { constraint: constraintRef(run.def, e.source.constraint), construct: constructRef(run.def, e.source.construct) },
      recorded: item
        ? {
            item,
            name: param?.name ?? calc?.name ?? item,
            value: value ? wireOf(value) : null,
            text: value ? engine.showValue(value) : null,
            limits: limitViews(run.def, specOf(run.def, item)),
          }
        : null,
      deviation: e.deviation ? { ref: e.deviation.ref, linkedBy: vc.rows.person(e.deviation.linkedBy), at: vc.app.formatInstant(e.deviation.at) } : null,
      // The disposition being signed is part of the signed content (proposedDisposition), bound when the
      // signing challenge is prepared; a preview without it cannot be signed as shown.
      disposition: proposal ? { proposed: proposal } : { proposed: null, note: 'The proposed disposition is part of the signed content: preview it with the intent EXCEPTION_DISPOSITIONED|<base64url JSON {outcome, justification}>.' },
      notSigned: { note: NOT_SIGNED_NOTE, ...pkgFacts, exception: { exceptionId: view.exceptionId, ...omit(view, EXCEPTION_SIGNED) } },
    },
  };
}

/**
 * The step an exception's signed source names (signing-content.ts exceptionFacts: source.stepKey, source.step and
 * source.frames): the instance under source.stepKey, else the instance of source.step in source.frames (a time-limit
 * breach the system raises names the step its constraint ends at, never an instance key: engine timing.ts), else that
 * step from the definition with the number of those frames, when no instance of it exists (yet). Null only when the
 * source names no step (F02; DI-37).
 */
export function exceptionStep(vc: ViewContext, e: engine.ExceptionRecord): { stepKey: string; number: string; title: string } | null {
  const def = vc.run.def;
  const key = e.source.stepKey ?? (e.source.step !== undefined ? engine.stepKey(e.source.step, e.source.frames) : undefined);
  if (key === undefined) return null;
  const inst = vc.state.steps[key];
  if (inst) {
    const sum = stepSummary(vc, inst, inst.step, inst.key);
    return { stepKey: sum.stepKey, number: sum.number, title: sum.title };
  }
  const stepId = e.source.step ?? key.slice(0, key.indexOf('@'));
  const node = def.steps.get(stepId)?.node;
  const numbered = def.steps.has(stepId) ? flow.instanceNumber(engine.numberingOf(def), stepId, e.source.frames).text : '';
  return { stepKey: key, number: numbered, title: node?.name ?? stepId };
}

/** A time constraint a signed source names, with its name in the MBR (null when the source names none). */
function constraintRef(def: engine.BatchDefinition, id: string | undefined): { id: string; name: string } | null {
  if (id === undefined) return null;
  return { id, name: def.constraints.find((c) => c.tc.id === id)?.tc.name ?? id };
}

/** A loop, replicate section or alternative a signed source names, with its name in the MBR (null when none). */
function constructRef(def: engine.BatchDefinition, id: string | undefined): { id: string; name: string } | null {
  if (id === undefined) return null;
  // An alternative has no name of its own in the MBR: its id is shown.
  return { id, name: def.loops.get(id)?.name ?? def.replicates.get(id)?.name ?? id };
}

/** The texts of a stage's statement (G-02). */
export const STAGE_STATEMENT_TEXT: Readonly<Record<engine.StageSummary['statement'], string>> = {
  COMPLETED_PER_MBR: 'Completed per MBR: no exception was dispositioned as a deviation or is still open, and no step was skipped',
  COMPLETED_WITH_DEVIATIONS: 'Completed with deviations: an exception is still open, linked to a deviation or dispositioned as a deviation, or a step was skipped',
};

/** A stage's summary as signed (its `summary` member), with the statement in words and each yield's MBR name. */
export function summaryForSigning(def: engine.BatchDefinition, sum: engine.StageSummaryContent): Json {
  return {
    statement: sum.statement,
    statementText: STAGE_STATEMENT_TEXT[sum.statement],
    steps: { ...sum.steps },
    exceptions: [...sum.exceptions],
    deviations: [...sum.deviations],
    yields: sum.yields.map((y) => ({ ...y, name: def.mbr.calculations.find((c) => c.id === y.calculation)?.name ?? y.calculation })),
  };
}

/** The step's fields as the step screen shows them, with the tolerance band (derived from the target) apart from the MBR limits. */
function fieldsForSigning(vc: ViewContext, stepDef: engine.StepDef, inst: engine.StepInstance, key: string): FieldForSigning[] {
  return fieldsOf(vc, stepDef, inst, key).map((f) => {
    const mbr = limitViews(vc.run.def, specOf(vc.run.def, f.item)).length;
    return { ...f, limits: f.limits.slice(0, mbr), band: f.limits.slice(mbr) };
  });
}

/** The proposal stored on the exception's current content version is the action's (outcome, justification, deviation). */
async function proposalHolds(db: Db, runId: string, state: engine.BatchState, intent: { exception: string; outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }): Promise<boolean> {
  const head = await execution.loadContentHead(db, 'batch_exception', runId, intent.exception);
  if (!head) return false;
  return sameProposal(await execution.loadProposal(db, runId, intent.exception, head.version), proposalOf(state, intent.exception, intent));
}

// ---------------------------------------------------------------------------------------------
// The hold-point decision a signature covers (review findings P26, P38; DI-37, PR-45)

/**
 * A challenge (esig.challenge) names the aggregate, the content version and hash and the meaning, and nothing else
 * of the action; two decisions of the same class (APPROVED and APPROVED_WITH_CONDITIONS, both HOLD_POINT_RELEASED;
 * two rejections with different reasons) share the meaning. So the decision is part of the signed content: the
 * preparation of the challenge records it (recipe.propose_hold_point_decision) and the hold point's content carries
 * the latest one as `proposedDecision`, which the challenge and the signature hash. The member appears once a
 * decision is proposed, so a hold point without one keeps the content signed before 0295 (recipe-core 0302). A sign
 * request whose decision is not the one recorded for its challenge is refused here (EBMR-EXE-086) and, whatever the
 * server does, by the database (recipe.check_hold_point_decision, 0295): the binding does not depend on this
 * process's memory.
 */
function decisionChanged(stepKey: string, asked: HoldPointDecision, prepared: StoredDecision | null): Refusal {
  const what = prepared === null ? [] : [asked.disposition !== prepared.disposition ? 'disposition' : null, asked.comment !== prepared.comment ? 'comment' : null].filter((x) => x !== null);
  return {
    code: 'EBMR-EXE-086',
    kind: 'CONTENT_CHANGED',
    whatHappened: 'The hold-point decision to sign is not the one reviewed at the start of the signing. Nothing was signed.',
    why:
      prepared === null
        ? `No decision on hold point ${stepKey} was prepared for this signature.`
        : what.length > 0
          ? `The ${what.join(' and ')} of the decision on hold point ${stepKey} differs from the decision the signing was prepared for (${prepared.disposition}, ${prepared.comment === null ? 'without a comment' : 'with a comment'}).`
          : `The decision on hold point ${stepKey} was prepared by another person or for another signing than this one.`,
    controls: ['DI-37', 'PR-45'],
    whatYouCanDo: ['Review the decision again, then start the signing again.'],
    whoCanHelp: [],
  };
}

/**
 * The correlation id of the challenge command the signing's authentication was made for, in this session and for this
 * signer. The challenge is read through the session-checked tab.session_challenge (tablets 0610: the application role
 * selects no row of esig.challenge), for the session whose token the request presented.
 */
async function challengeCorrelation(db: Db, ctx: SignableContext): Promise<string | null> {
  if (!ctx.actor.authEventId) return null;
  const { rows } = await db.query<{ correlation_id: string | null }>(
    `select c.correlation_id::text as correlation_id
       from iam.auth_event e
       cross join lateral tab.session_challenge($4, e.challenge_id) c
      where e.id = $1 and e.purpose = 'SIGNATURE' and e.person_id = c.signer_person and c.session_id = $2 and c.signer_person = $3`,
    [ctx.actor.authEventId, ctx.actor.sessionId, ctx.actor.personId, (ctx as Partial<EsigSignableContext>).tokenHash ?? ''],
  );
  return rows[0]?.correlation_id ?? null;
}

/**
 * Null when the decision of `intent` is exactly the one recorded on the hold point's current content version, by
 * this signer, for the challenge this signing authenticated (the rule recipe.check_hold_point_decision enforces).
 */
async function decisionProblem(db: Db, ctx: SignableContext, runId: string, intent: { stepKey: string; disposition: string; comment?: string | undefined }): Promise<Refusal | null> {
  const head = await execution.loadContentHead(db, 'batch_step', runId, intent.stepKey);
  const stored = head ? await loadDecision(db, runId, intent.stepKey, head.version) : null;
  const asked = decisionOf(intent);
  if (stored === null || !sameDecision(stored, asked)) return decisionChanged(intent.stepKey, asked, stored);
  if (stored.proposedBy !== ctx.actor.personId || stored.correlationId !== (await challengeCorrelation(db, ctx))) return decisionChanged(intent.stepKey, asked, stored);
  return null;
}

/** Null when what the sign request decides (an exception disposition, a hold-point decision) is what its challenge recorded. */
async function decidedProblem(db: Db, ctx: SignableContext, a: EngineAction, state: engine.BatchState): Promise<Refusal | null> {
  if (a.intent.type === 'DISPOSITION_EXCEPTION') return (await proposalHolds(db, a.runId, state, a.intent)) ? null : proposalChanged(a.intent.exception);
  if (a.intent.type === 'DISPOSITION_HOLD_POINT') return decisionProblem(db, ctx, a.runId, a.intent);
  return null;
}

/**
 * The hash of what the signature binds of an aggregate, apart from a decision's proposal: the content and, for a stage,
 * its summary member (F01). A signed command never changes it (EBMR-EXE-083).
 */
function signedHash(def: engine.BatchDefinition, state: engine.BatchState, type: engine.AggregateType, key: string): string | undefined {
  const c = engine.aggregateContent(def, state, type, key);
  if (!c) return undefined;
  if (type !== 'batch_stage') return c.contentHash;
  return sha256Hex(canonicalJson({ content: c.content, summary: engine.stageSummaryMember(def, state, key) ?? null }));
}

export function engineCommandHandler(app: AppContext): SignableActionHandler<EngineAction> {
  const cache = runCache(app);

  /** Locks the run and checks what does not depend on the command's own result (meaning, witness, version). */
  async function open(client: pg.PoolClient, ctx: SignableContext, a: EngineAction): Promise<{ run: RunContext; tx: execution.ExecutionTx; subject: ReturnType<typeof signedSubject>; meaning: string; problem: Refusal | null }> {
    const run = await runContext(client, a.runId);
    const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
    const subject = signedSubject(tx.state, a.intent);
    // At the transaction's trusted time: a check due as a witness is the step's later review once no witness is possible.
    const meaning = signedMeaning(run.def, tx.state, a.intent, tx.nowUs) ?? '';
    const problem: Refusal | null = meaning !== meaningOf(ctx) ? mismatch(meaning, meaningOf(ctx)) : null;
    return { run, tx, subject, meaning, problem };
  }

  return {
    kind: 'ENGINE_COMMAND',
    aggregateTypes: HANDLED,

    describe(a) {
      const cached = cache.get(a.runId);
      const subject = signedSubject(cached?.state, a.intent);
      // No time here: a check due as a witness is left to the transaction (signedMeaning answers undefined).
      return { aggregateType: subject.aggregateType, aggregateId: `${a.runId}:${subject.key}`, meaning: signedMeaning(cached?.def, cached?.state, a.intent, undefined) ?? '', expectedState: subject.expectedState };
    },

    async previewContent(ctx, query): Promise<SignableContentView> {
      const m = UUID_PREFIX.exec(query.aggregateId);
      const type = query.aggregateType as engine.AggregateType;
      if (!m || !HANDLED.includes(type)) throw notFound('record to be signed');
      const runId = (m[1] ?? '').toLowerCase();
      const key = m[2] ?? '';
      const db = app.pools.app;
      const run = await runContext(db, runId);
      const stored = await execution.loadState(db, runId);
      if (!stored) throw notFound('test run');
      const nowUs = await dbNowUs(db);
      const parsed = parseIntent(query.intent);
      const meaning = await meaningInfo(db, parsed.meaning);
      const viewer = viewerOf(ctx);
      const actor: engine.Actor = { id: viewer.personId, kind: 'PERSON', roles: await displayRoles(app, db, viewer.roleCode) };
      const exists = type === 'batch_step' ? stored.state.steps[key] : type === 'batch_stage' ? stored.state.stages[key] : stored.state.exceptions[key];
      if (!exists) throw notFound('record to be signed');
      if (parsed.decision !== null && (type !== 'batch_step' || stored.state.steps[key]?.kind !== 'HOLD')) throw badIntent('a hold-point decision only for a hold point');
      const prepared = engine.prepareForSignature(run.def, stored.state, previewTarget(run.def, stored.state, type, key, meaning.code), actor, { nowUs });
      const c = engine.aggregateContent(run.def, prepared.state, type, key);
      if (!c) throw notFound('record to be signed');
      const proposal = type === 'batch_exception' ? (parsed.proposal ? proposalOf(prepared.state, key, parsed.proposal) : null) : undefined;
      const decision = isHoldPoint(c) ? parsed.decision : undefined;
      const binding = await bindingOf(db, runId, c, engine.stageSummaryMember(run.def, prepared.state, key), proposal, decision);
      const vc = await viewContext(app, db, run, prepared.state, nowUs, viewer);
      const r = rendering(vc, type, key, meaning, { proposal: proposal ?? null, decision: decision ?? null }, c);
      return {
        aggregateType: type,
        aggregateId: `${runId}:${key}`,
        contentVersion: String(binding.version),
        canonicalText: binding.text,
        contentHash: binding.hash,
        meaning: meaning.code,
        meaningText: meaning.text,
        title: `${meaning.title}: ${r.title}`,
        preview: true,
        rendering: r.data,
      };
    },

    async prepareForChallenge(client, ctx, a) {
      const o = await open(client, ctx, a);
      if (o.problem) throw new HttpRefusal(422, o.problem);
      // A PERFORMED signature is prepared only for a step instance of the run (recipe-core 0338 refuses a preparation that
      // names another; F12 round 8, DI-05): a step key the run does not have is not found, before anything is written.
      if (o.subject.target.type === 'SIGN_PERFORMED' && !o.tx.state.steps[o.subject.key]) throw notFound('record to be signed');
      // A step is signed as performed or verified only from a terminal of its room (DI-20; the database refuses the
      // signed row from anywhere else, recipe-core 0285 and 0300): said here, before the challenge and the PIN.
      const room = a.intent.type === 'SIGN_PERFORMED' || a.intent.type === 'VERIFY' ? stepRoomRefusal(o.run.def, stepTarget(o.tx.state, a.intent.stepKey).step, ctx.room) : null;
      if (room) throw new HttpRefusal(422, room);
      if (o.tx.state.version !== a.expectedVersion) throw stale(o.tx.state, a.expectedVersion);
      const roles = await engineRoles(client, a.runId);
      const changed = await o.tx.prepare(o.subject.target, engineActor(ctx.actor.personId, roles), roles, o.meaning);
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const c = engine.aggregateContent(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key);
      if (!c) throw notFound('record to be signed');
      // What is being decided becomes part of the signed content (never a change of the record's data).
      if (a.intent.type === 'DISPOSITION_EXCEPTION') await execution.proposeDisposition(client, a.runId, a.intent.exception, proposalOf(o.tx.state, a.intent.exception, a.intent));
      if (a.intent.type === 'DISPOSITION_HOLD_POINT') await client.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [a.runId, a.intent.stepKey, JSON.stringify(decisionOf(a.intent))]);
      const binding = await bindingOf(client, a.runId, c, engine.stageSummaryMember(o.run.def, o.tx.state, o.subject.key));
      return { contentVersion: String(binding.version), contentHash: binding.hash, changed };
    },

    async dryRun(client, ctx, a): Promise<DryRunOutcome> {
      const o = await open(client, ctx, a);
      if (o.problem) return { accepted: false, status: 422, refusal: o.problem };
      // Not the decision its challenge recorded: refused before anything is written (it is logged as a signing failure).
      const decided = await decidedProblem(client, ctx, a, o.tx.state);
      if (decided) return { accepted: false, status: 409, refusal: decided };
      const roles = await engineRoles(client, a.runId);
      const actor = engineActor(ctx.actor.personId, roles);
      await o.tx.prepare(o.subject.target, actor, roles, o.meaning);
      const placeholder: engine.SignatureRef = { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: o.meaning, signer: actor.id };
      const approval = a.intent.type === 'CORRECT_ENTRY' && a.intent.approvalSignatureId ? await correctionApproval(client, a.runId, a.intent.point, a.intent.approvalSignatureId) : undefined;
      const command = signedCommand(o.tx.state, a.intent, actor, placeholder, `ESIG-DRY:${randomUUID()}`, a.expectedVersion, approval);
      const dry = o.tx.dryRun(command);
      if (!dry.accepted) {
        // The refusal is part of the record: a refused COMMAND row with the placeholder (never a signature).
        const r = await o.tx.command(command, roles, { signing: 'refused before signing', meaning: o.meaning });
        cache.set(a.runId, { def: o.run.def, state: o.tx.state });
        const mapped = engineRefusal(app.guidance, r.refusal ?? { code: 'ENG-REFUSED', message: 'Refused', controls: ['DI-34'] });
        // The engine's reason as people read it (T4); the refused row keeps the engine's own text.
        return { accepted: false, status: mapped.status, refusal: { ...mapped.refusal, whatHappened: `${mapped.refusal.whatHappened} Nothing was signed.`, why: peopleText({ def: o.run.def }, mapped.refusal.why) } };
      }
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const c = engine.aggregateContent(o.run.def, dry.state, o.subject.aggregateType, o.subject.key);
      if (!c) return { accepted: false, status: 404, refusal: { code: 'EXE_NOT_FOUND', kind: 'STALE', whatHappened: 'The record to be signed was not found. Nothing was signed.', why: '', controls: ['DI-37'], whatYouCanDo: ['Reload the screen.'], whoCanHelp: [] } };
      // After the dry run the stage is signed off: its summary member is the one the sign-off recorded, which must be
      // the one the challenge previewed (the hash comparison of the sign route).
      const binding = await bindingOf(client, a.runId, c, engine.stageSummaryMember(o.run.def, dry.state, o.subject.key));
      return { accepted: true, contentHash: binding.hash, contentVersion: String(binding.version) };
    },

    async apply(client, ctx, a, signature) {
      const o = await open(client, ctx, a);
      if (o.problem) throw new Error(`${o.problem.code} ${o.problem.why}`);
      if (signature.meaning !== o.meaning || signature.signer !== ctx.actor.personId) throw new Error(`EBMR-EXE-080 the signature (${signature.meaning}, ${signature.signer}) is not the one this action needs`);
      const decided = await decidedProblem(client, ctx, a, o.tx.state);
      if (decided) throw new Error(`${decided.code} ${decided.why}`);
      const roles = await engineRoles(client, a.runId);
      const actor = engineActor(ctx.actor.personId, roles);
      const before = signedHash(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key);
      const approval = a.intent.type === 'CORRECT_ENTRY' && a.intent.approvalSignatureId ? await correctionApproval(client, a.runId, a.intent.point, a.intent.approvalSignatureId) : undefined;
      const command = signedCommand(o.tx.state, a.intent, actor, { id: signature.signatureId, meaning: signature.meaning, signer: signature.signer }, `ESIG:${signature.signatureId}`, a.expectedVersion, approval);
      const r = await o.tx.command(command, roles, { signatureId: signature.signatureId });
      if (!r.accepted) throw new Error(`EBMR-EXE-082 the signed command was refused after its dry run was accepted (${r.refusal?.code ?? '?'}: ${r.refusal?.message ?? ''}); nothing is kept`);
      const after = signedHash(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key);
      if (after !== before) throw new Error('EBMR-EXE-083 the signed content changed while the signature was applied; nothing is kept (DI-37)');
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const raised = o.subject.aggregateType === 'batch_exception' ? o.tx.state.exceptions[o.subject.key] : undefined;
      const stepKey = o.subject.aggregateType === 'batch_step' ? o.subject.key : raised ? (raised.source.stepKey ?? (raised.source.step !== undefined ? engine.stepKey(raised.source.step, raised.source.frames) : undefined)) : undefined;
      if (stepKey === undefined || !o.tx.state.steps[stepKey]) return null;
      const vc = await viewContext(app, client, o.run, o.tx.state, o.tx.nowUs, viewerOf(ctx));
      return await stepScreen(vc, stepKey);
    },
  };
}
