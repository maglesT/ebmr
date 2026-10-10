/**
 * What an e-signature on a batch record signs (Phase 2 apps plan section 6, "Signing content rules";
 * module C3; DI-37, INV-09).
 *
 * The kernel's e-signature module binds a signature to the canonical content of one record version
 * (esig content providers). For a batch these are four aggregates, computed here from the engine state
 * only (pure; the same function runs in the server, in replay and in the tests):
 *
 *  - `batch_step` (a phase or hold-point instance): batch number and MBR hash; the step's key, number,
 *    title, stage, block and frames; the instruction (node hash and SOP reference); every data-point
 *    attempt and version with value, unit, source, device, raw string, recorded and occurred time and
 *    limit evaluation; derived values with their evaluation-record hash; block entries; and the
 *    exceptions the step's own data and finalisation raised.
 *    EXCLUDED, because signing or deciding changes them: the step status, signatures, performers and
 *    signers, end and completion times, node END events, exception status, dispositions and deviation
 *    links, the targets shown (an upstream correction updates them without re-opening the step), and the
 *    exceptions raised by acts about the step rather than by its data (a late witness, an operator's
 *    exception, a refused hold point, a skip, a moved target, an input withdrawn after the fact): those
 *    live in their own `batch_exception` aggregate.
 *    Also excluded: the times of facts the system computes when the step is prepared for signing (the
 *    recorded time of block-computed values, the computation time of derived values, the time an exception
 *    on the step was raised). Their values, inputs, evaluations and the exceptions themselves are signed;
 *    their times stay in the record (events, rows, state hash). Otherwise the signer's preview, computed a
 *    moment earlier, could never equal the content the challenge prepares (DI-37).
 *  - `batch_stage` (a stage frame): the stage and, for each of its step instances, the number, status and
 *    the hash of the step's content. The text a STAGE_SIGNED_OFF signature binds also holds the stage's derived
 *    summary (`summary`, stage-summary.ts stageSummaryMember: the summary the sign-off would record now and, once
 *    signed, the one it recorded), which the meaning confirms (Phase 2 exit review F01). It is added to the stored
 *    content when the content is signed, as a decision's proposal is (the server's bindingOf; the database's provider,
 *    recipe-core sql 0319): an exception raised, dispositioned or linked to a deviation changes the summary, and so
 *    the signed text, without a new content version. The sign-off itself and its end time are excluded.
 *  - `batch_exception`: the exception as raised (type, class, severity, tier, what was recorded and
 *    against which limit, who raised it and when) and the linked deviation; never its status or
 *    disposition, so a disposition signature stays valid.
 *  - `batch_point`: one data point as recorded (the subject of a CORRECTED signature); never its status or
 *    what superseded it.
 *
 * Consequences, proven by tests: an accepted SIGN_PERFORMED, VERIFY, hold-point disposition, stage
 * sign-off or exception disposition never changes the content it was signed on; any data, finalisation or
 * exception change of the step does (so the kernel supersedes the signatures, exactly when the engine
 * invalidates them).
 *
 * Instants are UTC epoch microseconds written as decimal strings; decimals are strings; there are no
 * floating-point numbers, so the database hashes the same text (esig.canonical_json).
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { flowNodeHash } from '../flow/canonical.ts';
import { instanceNumber, numberMbr, type MbrNumbering } from '../flow/numbering.ts';
import type { Frame } from '../flow/tokens.ts';
import type { BatchDefinition } from './definition.ts';
import { encodeCommand, hashJson, type JsonValue } from './codec.ts';
import { replicateCompatible } from './exceptions.ts';
import { stepKey as stepKeyOf } from './tx.ts';
import type { BatchState, Command, DataPoint, DataSource, DataValue, DerivedValue, EntryRecord, ExceptionRecord, SignatureRef, SignatureTarget, StageFrameState, StepInstance, StoredEvaluation } from './types.ts';

export type AggregateType = 'batch_step' | 'batch_stage' | 'batch_exception' | 'batch_point';
export const AGGREGATE_TYPES: readonly AggregateType[] = ['batch_step', 'batch_stage', 'batch_exception', 'batch_point'];

export type ContentJson = null | boolean | number | string | ContentJson[] | { [key: string]: ContentJson };

export interface AggregateContent {
  type: AggregateType;
  /** Key inside the run: step key, stage key, exception id or data-point id. */
  key: string;
  /** The canonical content (JSON; decimals and instants as strings). */
  content: { [key: string]: ContentJson };
  /** SHA-256 of the canonical JSON of `content`. */
  contentHash: string;
  /** Persons who performed, entered data in or corrected it (for the kernel's INV-03 check). */
  enteredBy: string[];
  /** The record's state for the signing check (step status, stage phase, exception status). */
  state: string;
}

/** Exception types raised by acts about a step (signing, deciding, a person's report), not by its data. */
export const ACT_EXCEPTION_TYPES: ReadonlySet<string> = new Set(['WITNESS_LATE', 'OPERATOR_RAISED', 'HOLD_POINT_NOT_APPROVED', 'STEP_SKIPPED', 'EXECUTED_TARGET_CHANGED', 'STEP_HANDED_OVER']);

/**
 * True when a data point is the endpoint of a repeat-until loop recorded inside that loop: its limits are
 * judged only when the loop exits (ADR 0004), a system fact after the step was signed, so the signed
 * content shows it as "judged at the loop exit" and the verdict lives in the loop decision and exceptions.
 */
export function judgedAtLoopExit(def: BatchDefinition, p: DataPoint): boolean {
  const constructs = def.steps.get(p.step)?.constructs ?? [];
  return (def.loopEndpoints.get(p.item) ?? []).some((l) => constructs.includes(l));
}

/** True when an exception belongs to the signed content of the step that raised it. */
export function isStepDataException(def: BatchDefinition, s: BatchState, e: ExceptionRecord, stepKey: string): boolean {
  if (e.source.stepKey !== stepKey) return false;
  if (ACT_EXCEPTION_TYPES.has(e.type)) return false;
  // A derived value withdrawn after the fact (its inputs were invalidated elsewhere) is a later act too.
  if (e.type === 'CALCULATION_FAILED' && e.source.derived !== undefined) return false;
  // The verdict on a loop endpoint, judged when the loop exits.
  const p = e.source.point !== undefined ? s.points[e.source.point] : undefined;
  if (e.type === 'LIMIT_BREACH' && p !== undefined && judgedAtLoopExit(def, p)) return false;
  return true;
}

const frames = (f: readonly Frame[]): ContentJson => f.map((x) => ({ construct: x.construct, index: x.index }));

export function valueContent(v: DataValue | undefined): ContentJson {
  if (!v) return null;
  switch (v.kind) {
    case 'DECIMAL':
      return { kind: v.kind, value: v.value, unit: v.unit };
    case 'COUNT':
      return { kind: v.kind, value: v.value };
    case 'BOOLEAN':
      return { kind: v.kind, value: v.value };
    case 'CATEGORY':
    case 'TEXT':
      return { kind: v.kind, value: v.value };
    case 'INSTANT':
      return { kind: v.kind, us: v.us.toString() };
    case 'SERIES':
      return { kind: v.kind, values: [...v.values], unit: v.unit };
  }
}

function sourceContent(s: DataSource): ContentJson {
  switch (s.mode) {
    case 'MANUAL':
      return { mode: s.mode, evidence: s.evidence ? { kind: s.evidence.kind, sha256: s.evidence.sha256 } : null };
    case 'DEVICE':
      return { mode: s.mode, device: s.device, raw: s.raw ?? null };
    case 'SCAN':
      return { mode: s.mode, code: s.code };
    case 'AUTOMATION':
      return { mode: s.mode, system: s.system, tag: s.tag ?? null };
    case 'LIMS':
      return { mode: s.mode, resultRef: s.resultRef };
    case 'BLOCK':
      return { mode: s.mode, entries: [...s.entries] };
  }
}

function evaluationContent(e: StoredEvaluation | undefined): ContentJson {
  if (!e) return null;
  return { breached: e.breached ?? null, requirement: e.requirement, detail: [...e.detail], languageVersion: e.languageVersion };
}

/** A JSON-safe copy of block data (bigints as strings, undefined dropped). */
function plain(v: unknown): ContentJson {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isSafeInteger(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'object':
      if (Array.isArray(v)) return v.map(plain);
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]));
    default:
      // Functions and symbols never occur in stored state (it is JSON); they carry no content.
      return null;
  }
}

const AT_LOOP_EXIT: ContentJson = { requirement: 'ENDPOINT_IN_PROGRESS', judged: 'at the loop exit' };

/** The recorded facts of a data point (no status, no successor, no exception list). */
export function pointFacts(p: DataPoint, loopEndpoint = false): { [key: string]: ContentJson } {
  return {
    id: p.id,
    item: p.item,
    stepKey: p.stepKey,
    attempt: p.attempt,
    version: p.version,
    kind: p.kind,
    value: valueContent(p.value),
    source: sourceContent(p.source),
    enteredBy: p.enteredBy,
    // A block-computed value is materialised when the step is prepared for signing: its time is not signed.
    recordedAt: p.source.mode === 'BLOCK' ? null : p.recordedAt.toString(),
    occurredAt: p.occurredAt ? { us: p.occurredAt.us.toString(), trust: p.occurredAt.trust } : null,
    timeBasis: p.timeBasis,
    supersedes: p.supersedes ?? null,
    correction: p.correction ? { reason: p.correction.reason, signature: p.correction.signature, evidence: p.correction.evidence ?? null, approvedBy: p.correction.approvedBy ?? null } : null,
    voidReason: p.voidReason ?? null,
    evaluation: loopEndpoint ? AT_LOOP_EXIT : evaluationContent(p.evaluation),
    failed: loopEndpoint ? null : p.failed,
    flags: [...p.flags],
  };
}

function derivedFacts(d: DerivedValue): ContentJson {
  return {
    id: d.id,
    calculation: d.calculation,
    version: d.version,
    value: valueContent(d.value),
    recordHash: d.record.contentHash,
    inputs: d.inputs.map((i) => ({ item: i.item, points: [...i.points], derived: [...i.derived] })),
    supersedes: d.supersedes ?? null,
    reason: d.reason ?? null,
    evaluation: evaluationContent(d.evaluation),
    failed: d.failed,
  };
}

function entryFacts(e: EntryRecord): ContentJson {
  return { id: e.id, kind: e.kind, data: plain(e.data), enteredBy: e.enteredBy, recordedAt: e.recordedAt.toString() };
}

/**
 * The exception as raised (never its status, disposition or deviation link). `withTime` false for the
 * exceptions of a step's content, which the preparation for signing may raise (their time is not signed).
 */
export function exceptionFacts(e: ExceptionRecord, withTime = true): { [key: string]: ContentJson } {
  return {
    id: e.id,
    type: e.type,
    category: e.category,
    title: e.title,
    controls: [...e.controls],
    severity: e.severity,
    tier: e.tier ?? null,
    requirement: e.requirement ?? null,
    source: {
      stepKey: e.source.stepKey ?? null,
      step: e.source.step ?? null,
      frames: frames(e.source.frames),
      item: e.source.item ?? null,
      point: e.source.point ?? null,
      derived: e.source.derived ?? null,
      constraint: e.source.constraint ?? null,
      construct: e.source.construct ?? null,
    },
    raisedAt: withTime ? e.raisedAt.toString() : null,
    raisedBy: e.raisedBy,
    blocks: e.block ? { steps: [...e.block.steps], downstream: e.block.downstream ? { node: e.block.downstream.node, frames: frames(e.block.downstream.frames) } : null, until: e.block.until } : null,
    deviationRequired: e.deviationRequired,
    registrationRelevant: e.registrationRelevant,
    qaOnly: e.qaOnly,
    stageSignOffBlocked: e.stageSignOffBlocked,
    releaseBlocking: e.releaseBlocking,
  };
}

const numberingCache = new WeakMap<BatchDefinition, MbrNumbering>();

/** The document numbering of the definition's MBR (cached per definition). */
export function numberingOf(def: BatchDefinition): MbrNumbering {
  let n = numberingCache.get(def);
  if (!n) {
    n = numberMbr(def.mbr);
    numberingCache.set(def, n);
  }
  return n;
}

function hashContent(content: { [key: string]: ContentJson }): string {
  return sha256Hex(canonicalJson(content));
}

function header(def: BatchDefinition, s: BatchState): { [key: string]: ContentJson } {
  return { batchNumber: s.header.batchNumber, batchId: s.header.batchId, mbrHash: s.mbrHash, family: def.mbr.header.family, product: def.mbr.header.product.code };
}

function stepEnteredBy(inst: StepInstance): string[] {
  return [...new Set([...inst.performers, ...inst.dataEnterers, ...inst.correctors, ...inst.performedSigners])].sort();
}

/** The signing content of one step instance (`batch_step`). */
export function stepSigningContent(def: BatchDefinition, s: BatchState, key: string): AggregateContent {
  const inst = s.steps[key];
  if (!inst) throw new Error(`step instance ${key} does not exist`);
  const step = def.steps.get(inst.step);
  if (!step) throw new Error(`step ${inst.step} is not in the definition`);
  const node = step.node;
  const numbering = numberingOf(def);
  const sopId = node.kind === 'phase' && typeof node.config['sop'] === 'string' ? node.config['sop'] : undefined;
  const sop = sopId === undefined ? undefined : def.mbr.references.find((r) => r.id === sopId);
  const points = Object.values(s.points)
    .filter((p) => p.stepKey === key)
    .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : a.attempt - b.attempt || a.version - b.version || a.recordedSeq - b.recordedSeq));
  const derived = Object.values(s.derived)
    .filter((d) => d.stepKey === key)
    .sort((a, b) => a.computedSeq - b.computedSeq);
  const entries = Object.values(s.entries)
    .filter((e) => e.stepKey === key)
    .sort((a, b) => a.recordedSeq - b.recordedSeq);
  const exceptions = Object.values(s.exceptions)
    .filter((e) => isStepDataException(def, s, e, key))
    .sort((a, b) => a.raisedSeq - b.raisedSeq);
  const content: { [k: string]: ContentJson } = {
    schema: 'ebmr.batch-step-content',
    batch: header(def, s),
    step: {
      key,
      id: inst.step,
      kind: inst.kind,
      number: instanceNumber(numbering, inst.step, inst.frames).text,
      title: node.name,
      stage: step.stage ?? null,
      block: node.kind === 'phase' ? `${node.block.type}@${node.block.version}` : null,
      frames: frames(inst.frames),
    },
    instruction: {
      nodeHash: flowNodeHash(node),
      text: node.kind === 'phase' && typeof node.config['text'] === 'string' ? node.config['text'] : null,
      sop: sop ? { code: sop.code, version: sop.version, hash: sop.hash ?? null } : null,
    },
    points: points.map((p) => pointFacts(p, judgedAtLoopExit(def, p))),
    derived: derived.map(derivedFacts),
    entries: entries.map(entryFacts),
    exceptions: exceptions.map((e) => exceptionFacts(e, false)),
  };
  return { type: 'batch_step', key, content, contentHash: hashContent(content), enteredBy: stepEnteredBy(inst), state: inst.status };
}

/** Step instances that belong to a stage frame (same stage; frames compatible with the frame's). */
export function stageSteps(def: BatchDefinition, s: BatchState, frame: StageFrameState): StepInstance[] {
  return Object.values(s.steps)
    .filter((i) => def.steps.get(i.step)?.stage === frame.stage && frame.frames.every((x) => i.frames.some((y) => y.construct === x.construct && y.index === x.index)) && replicateCompatible(def, frame.frames, i.frames))
    .sort((a, b) => (a.enabledSeq ?? 0) - (b.enabledSeq ?? 0) || (a.key < b.key ? -1 : 1));
}

export function stageState(frame: StageFrameState): string {
  if (frame.signOff?.valid === true) return 'SIGNED_OFF';
  if (frame.awaitingSignOff || frame.endedAt !== undefined) return 'AWAITING_SIGN_OFF';
  return 'IN_PROGRESS';
}

/** The signing content of one stage frame (`batch_stage`). */
export function stageSigningContent(def: BatchDefinition, s: BatchState, key: string): AggregateContent {
  const frame = s.stages[key];
  if (!frame) throw new Error(`stage frame ${key} does not exist`);
  const node = def.stages.get(frame.stage);
  const numbering = numberingOf(def);
  const steps = stageSteps(def, s, frame);
  const enteredBy = new Set<string>();
  for (const i of steps) for (const p of stepEnteredBy(i)) enteredBy.add(p);
  const content: { [k: string]: ContentJson } = {
    schema: 'ebmr.batch-stage-content',
    batch: header(def, s),
    stage: { key, id: frame.stage, name: node?.name ?? frame.stage, number: numbering.byId.get(frame.stage)?.number ?? null, frames: frames(frame.frames), startedAt: frame.startedAt.toString() },
    steps: steps.map((i) => ({ key: i.key, number: instanceNumber(numbering, i.step, i.frames).text, status: i.status, contentHash: stepSigningContent(def, s, i.key).contentHash })),
  };
  return { type: 'batch_stage', key, content, contentHash: hashContent(content), enteredBy: [...enteredBy].sort(), state: stageState(frame) };
}

/** The signing content of one exception (`batch_exception`). */
export function exceptionSigningContent(def: BatchDefinition, s: BatchState, id: string): AggregateContent {
  const e = s.exceptions[id];
  if (!e) throw new Error(`exception ${id} does not exist`);
  const point = e.source.point !== undefined ? s.points[e.source.point] : undefined;
  const derived = e.source.derived !== undefined ? s.derived[e.source.derived] : undefined;
  const content: { [k: string]: ContentJson } = {
    schema: 'ebmr.batch-exception-content',
    batch: header(def, s),
    exception: exceptionFacts(e),
    recorded: point ? { point: point.id, item: point.item, value: valueContent(point.value), evaluation: judgedAtLoopExit(def, point) ? AT_LOOP_EXIT : evaluationContent(point.evaluation) } : derived ? { derived: derived.id, item: derived.calculation, value: valueContent(derived.value), evaluation: evaluationContent(derived.evaluation) } : null,
    deviation: e.deviation ? { ref: e.deviation.ref, linkedBy: e.deviation.linkedBy, at: e.deviation.at.toString() } : null,
  };
  // The raiser, the person who linked the deviation and everyone involved in the step the exception was raised at:
  // none of them dispositions it (batch.ts dispositionException; recipe-core sql 0306, Phase 2 exit review F11).
  const source = e.source.stepKey !== undefined ? s.steps[e.source.stepKey] : undefined;
  const enteredBy = [e.raisedBy, ...(e.deviation ? [e.deviation.linkedBy] : []), ...(source ? stepEnteredBy(source) : [])].filter((p) => p !== 'SYSTEM');
  return { type: 'batch_exception', key: id, content, contentHash: hashContent(content), enteredBy: [...new Set(enteredBy)].sort(), state: e.status };
}

/** The signing content of one data point (`batch_point`, the subject of a CORRECTED signature). */
export function pointSigningContent(def: BatchDefinition, s: BatchState, id: string): AggregateContent {
  const p = s.points[id];
  if (!p) throw new Error(`data point ${id} does not exist`);
  const content: { [k: string]: ContentJson } = { schema: 'ebmr.batch-point-content', batch: header(def, s), point: pointFacts(p, judgedAtLoopExit(def, p)) };
  return { type: 'batch_point', key: id, content, contentHash: hashContent(content), enteredBy: [p.enteredBy], state: p.status };
}

/** Every signable aggregate of a state, keyed `${type}:${key}`. */
export function signingContents(def: BatchDefinition, s: BatchState): Map<string, AggregateContent> {
  const out = new Map<string, AggregateContent>();
  const add = (c: AggregateContent): void => void out.set(`${c.type}:${c.key}`, c);
  for (const key of Object.keys(s.steps).sort()) add(stepSigningContent(def, s, key));
  for (const key of Object.keys(s.stages).sort()) add(stageSigningContent(def, s, key));
  for (const id of Object.keys(s.exceptions).sort()) add(exceptionSigningContent(def, s, id));
  for (const id of Object.keys(s.points).sort()) add(pointSigningContent(def, s, id));
  return out;
}

/** The content of one aggregate, or undefined when the state has no such record. */
export function aggregateContent(def: BatchDefinition, s: BatchState, type: AggregateType, key: string): AggregateContent | undefined {
  switch (type) {
    case 'batch_step':
      return s.steps[key] ? stepSigningContent(def, s, key) : undefined;
    case 'batch_stage':
      return s.stages[key] ? stageSigningContent(def, s, key) : undefined;
    case 'batch_exception':
      return s.exceptions[key] ? exceptionSigningContent(def, s, key) : undefined;
    case 'batch_point':
      return s.points[key] ? pointSigningContent(def, s, key) : undefined;
  }
}

/**
 * The envelope the kernel hashes (esig.canonical_envelope): aggregate type and id, content version and
 * content. Its SHA-256 is the content hash a signature binds.
 */
export function signingEnvelope(aggregateType: AggregateType, aggregateId: string, contentVersion: number, content: { [key: string]: ContentJson }): { text: string; hash: string } {
  const text = canonicalJson({ aggregate_type: aggregateType, aggregate_id: aggregateId, content_version: contentVersion, content });
  return { text, hash: sha256Hex(text) };
}

/**
 * Whether a new aggregate's first content version is stored as soon as it appears. A phase instance is not:
 * it appears when the command that ends the step before it enables it, and the e-signature module counts the
 * person whose command stores a content version as having changed that record (esig content_change), which
 * would exclude, say, the verifier of the previous step from verifying this one (a false INV-03 refusal).
 * Its first version is stored when it first changes, or when a person first works on it (touchedAggregates):
 * START_STEP by its performer at the latest, so every phase that can be signed has stored content. Hold
 * points, stage frames, exceptions and data points are stored when they appear.
 */
export function storedOnCreation(c: AggregateContent, s: BatchState): boolean {
  return !(c.type === 'batch_step' && s.steps[c.key]?.kind === 'PHASE');
}

/** Aggregates whose content must be stored after a move from `before` to `after` (changed, or new and stored on creation), in key order. */
export function changedContents(def: BatchDefinition, before: BatchState | undefined, after: BatchState): AggregateContent[] {
  const prev = before ? signingContents(def, before) : new Map<string, AggregateContent>();
  const next = signingContents(def, after);
  return [...next.entries()]
    .filter(([k, c]) => {
      const p = prev.get(k);
      return p === undefined ? storedOnCreation(c, after) : p.contentHash !== c.contentHash;
    })
    .map(([, c]) => c);
}

/**
 * The aggregates a person works on with an accepted command (or a PREPARE for SIGN_PERFORMED): their content
 * is stored if it is not yet (see storedOnCreation).
 */
export function touchedAggregates(command: { type: string; step?: unknown; context?: unknown; target?: unknown }): { type: AggregateType; key: string }[] {
  const t = command.type === 'PREPARE' && typeof command.target === 'object' && command.target !== null ? (command.target as { type?: unknown; step?: unknown; context?: unknown }) : command;
  if (typeof t.step !== 'string') return [];
  const frames = Array.isArray(t.context) ? (t.context as Frame[]) : [];
  return [{ type: 'batch_step', key: stepKeyOf(t.step, frames) }];
}

/**
 * Whether the run moved on after the act of a step instance, so the act can no longer be witnessed: another
 * step instance started, or data or a block entry was recorded in another instance, at or after the act's
 * end (a tie counts as started). The same derivation as the database's recipe.next_step_started, which the
 * batch_step content provider reports to the e-signature module as `act.next_step_started`.
 */
export function nextStepStarted(s: BatchState, key: string): boolean {
  const ended = s.steps[key]?.endedAt;
  if (ended === undefined) return false;
  if (Object.values(s.steps).some((i) => i.key !== key && i.startedAt !== undefined && i.startedAt >= ended)) return true;
  if (Object.values(s.entries).some((e) => e.stepKey !== key && e.recordedAt >= ended)) return true;
  return Object.values(s.points).some((p) => p.stepKey !== key && p.recordedAt >= ended);
}

// ---------------------------------------------------------------------------------------------
// Which aggregate each signature is about (the engine's side of "esig valid set = engine valid set")

/** The batch record as a whole (recipe-core sql 0450): signed by the approvals of an abort and by a cancellation. */
export const BATCH_RECORD_AGGREGATE = 'batch_record';
/** The key of the batch record as it stands in state `s` (one record per state version, recipe-core sql 0450). */
export const batchRecordKey = (s: Pick<BatchState, 'version'>): string => `record@${s.version}`;

/**
 * The act a person asks another to approve, as its approver signs it (recipe-core sql 0470, `batch_act`): the command as
 * recorded without its id, actor, signatures and expected version, with its requester. The approval of a skip, a void,
 * an invalidation, an abort and a hand-over signs this act at the state version it is given in, so it approves this
 * act only: another step, item, point, reason, investigation, cause, checklist, performer or requester is another act.
 */
export const BATCH_ACT_AGGREGATE = 'batch_act';
const NOT_IN_ACT = new Set(['commandId', 'actor', 'approval', 'approvals', 'signature', 'expectedVersion']);

export function approvedAct(cmd: Command): { [key: string]: JsonValue } {
  const encoded = encodeCommand(cmd) as { [key: string]: JsonValue };
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(encoded)) if (!NOT_IN_ACT.has(k)) out[k] = v;
  out['requestedBy'] = cmd.actor.id;
  return out;
}

/** The key of the act `cmd` asks to approve, in state `s` (`act@<state version>:<hash of the act>`, recipe-core sql 0470). */
export const approvedActKey = (s: Pick<BatchState, 'version'>, cmd: Command): string => `act@${s.version}:${hashJson(approvedAct(cmd))}`;

export interface SignatureSubject {
  signatureId: string;
  meaning: string;
  signer: string;
  type: AggregateType | typeof BATCH_RECORD_AGGREGATE | typeof BATCH_ACT_AGGREGATE;
  key: string;
}

/**
 * The aggregates the e-signatures of a command sign: the step for PERFORMED, VERIFIED, WITNESSED and
 * hold-point signatures; the stage frame for a sign-off; the exception for its disposition; the data point for a
 * correction and its approval; the batch record (`batch_record`, `<batch id>:record@<state version>`, whose content the
 * database provides: recipe-core sql 0450) for the signature of a cancellation; the approved act (`batch_act`,
 * `<batch id>:act@<state version>:<hash>`, recipe-core sql 0470) for the approval of a skip, a void, an invalidation and
 * an abort and the two signatures of a hand-over, so an approval binds the very act it approves. Each subject's content
 * is one its own command leaves unchanged and one that exists before the act.
 */
export function signatureSubjects(s: BatchState, cmd: Command): SignatureSubject[] {
  const sub = (sig: SignatureRef, type: SignatureSubject['type'], key: string): SignatureSubject => ({ signatureId: sig.id, meaning: sig.meaning, signer: sig.signer, type, key });
  switch (cmd.type) {
    case 'SIGN_PERFORMED':
      return cmd.signature ? [sub(cmd.signature, 'batch_step', stepKeyOf(cmd.step, cmd.context ?? []))] : [];
    case 'VERIFY':
    case 'DISPOSITION_HOLD_POINT':
      return [sub(cmd.signature, 'batch_step', stepKeyOf(cmd.step, cmd.context ?? []))];
    case 'SIGN_OFF_STAGE':
      return [sub(cmd.signature, 'batch_stage', stepKeyOf(cmd.stage, cmd.context ?? []))];
    case 'DISPOSITION_EXCEPTION':
      return [sub(cmd.signature, 'batch_exception', cmd.exception)];
    case 'CORRECT_ENTRY':
      return s.points[cmd.point] ? [sub(cmd.signature, 'batch_point', cmd.point), ...(cmd.approval ? [sub(cmd.approval.signature, 'batch_point', cmd.point)] : [])] : [];
    case 'REQUEST_SKIP':
      return [sub(cmd.approval.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd))];
    case 'VOID_ATTEMPT':
      return cmd.approval ? [sub(cmd.approval.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd))] : [];
    case 'INVALIDATE_RESULT':
      return [sub(cmd.approval.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd))];
    case 'ABORT_BATCH':
      return cmd.approvals.map((a) => sub(a.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd)));
    case 'CANCEL_BATCH':
      return [sub(cmd.signature, BATCH_RECORD_AGGREGATE, batchRecordKey(s))];
    case 'HAND_OVER_STEP':
      return [sub(cmd.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd)), sub(cmd.approval.signature, BATCH_ACT_AGGREGATE, approvedActKey(s, cmd))];
    default:
      return [];
  }
}

/** The signature target for `prepareForSignature` of a signed command. */
export function signatureTargetOf(cmd: Command): SignatureTarget {
  return cmd.type === 'SIGN_PERFORMED' ? { type: cmd.type, step: cmd.step, context: cmd.context ?? [] } : { type: cmd.type };
}

/**
 * Signatures the engine holds, with the aggregate each binds and whether the engine still treats it as
 * valid: step signatures (PERFORMED, CHECKED, hold point), stage sign-offs, exception dispositions (never
 * invalidated) and corrections (bound to the corrected point, never invalidated).
 */
export function engineSignatures(s: BatchState): Map<string, { type: AggregateType; key: string; valid: boolean }> {
  const out = new Map<string, { type: AggregateType; key: string; valid: boolean }>();
  for (const inst of Object.values(s.steps)) {
    for (const g of inst.signatures) if (g.role !== 'SKIP_APPROVAL') out.set(g.id, { type: 'batch_step', key: inst.key, valid: g.valid });
  }
  for (const f of Object.values(s.stages)) if (f.signOff) out.set(f.signOff.signature, { type: 'batch_stage', key: f.key, valid: f.signOff.valid });
  for (const e of Object.values(s.exceptions)) if (e.disposition) out.set(e.disposition.signature, { type: 'batch_exception', key: e.id, valid: true });
  for (const p of Object.values(s.points)) {
    if (p.correction && p.supersedes !== undefined && p.correction.signature !== 'SYSTEM') out.set(p.correction.signature, { type: 'batch_point', key: p.supersedes, valid: true });
  }
  return out;
}
