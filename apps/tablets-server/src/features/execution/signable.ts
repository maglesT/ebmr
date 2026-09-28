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
 *    and a rendering (batch_step, batch_stage, batch_exception).
 *  - prepareForChallenge(): locks the run and appends a PREPARE row when the system facts changed the record.
 *  - dryRun(): locks the run, prepares again, and runs the command with a placeholder signature. A refusal
 *    by the engine is recorded as a refused COMMAND row and answered; nothing is signed. Accepted: the
 *    content hash and version the signature would bind (C1 compares them with the challenge).
 *  - apply(): runs the command with the real signature; any refusal or content change after the seal throws,
 *    so the whole command (signature, seal, row) rolls back (INV-10).
 * The meaning of the challenge must be the one the engine requires (EBMR-EXE-080), and a witness after the
 * run moved on is refused (EBMR-EXE-081; the kernel's act.next_step_started check says the same).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { engine, execution } from '@ebmr/recipe-core';
import type { Refusal, SignableAction, SignableContentView } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { dbNowUs } from '../../platform/db/commands.ts';
import { HttpRefusal, refusal } from '../../platform/http/refusal.ts';
import type { DryRunOutcome, SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import type { EsigSignableContext } from '../esig/content.ts';
import { meaningInfo } from '../esig/views.ts';
import { engineRefusal } from './guidance.ts';
import { signedCommand, signedMeaning, signedSubject, stepTarget, wireOf } from './intents.ts';
import { displayRoles, engineActor, engineRoles } from './roles.ts';
import { loadRowFacts, notFound, runCache, runContext, type Db, type RunContext } from './runs.ts';
import { entriesOf, exceptionsOfStep, exceptionView, fieldsOf, limitViews, specOf, stageRef, stepScreen, stepSummary, type ViewContext, type ViewerInfo } from './views.ts';

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

function lateWitness(key: string): Refusal {
  return {
    code: 'EBMR-EXE-081',
    kind: 'NOT_ALLOWED',
    whatHappened: 'The next step has started, so this act can no longer be witnessed. Nothing was signed.',
    why: `The run moved on after the act of ${key}: another step started or recorded data after it ended; a witness must watch the act itself.`,
    controls: ['DI-35', 'PR-14'],
    whatYouCanDo: ['Raise an exception for the missed witness; a supervisor decides how to proceed.'],
    whoCanHelp: ['The shift supervisor', 'QA (shop floor)'],
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
  };
}

/**
 * The `intent` of a content preview: the meaning code, and for an exception disposition the proposal being
 * signed, `EXCEPTION_DISPOSITIONED|<base64url of the JSON {outcome, justification}>` (the proposal is part of the
 * signed content, so the signer's preview must show and hash it).
 */
export function parseIntent(intent: string): { meaning: string; proposal: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string } | null } {
  const bar = intent.indexOf('|');
  if (bar < 0) return { meaning: intent, proposal: null };
  const meaning = intent.slice(0, bar);
  let p: unknown;
  try {
    p = JSON.parse(Buffer.from(intent.slice(bar + 1), 'base64url').toString('utf8'));
  } catch {
    p = null;
  }
  const r = (p ?? {}) as Record<string, unknown>;
  if ((r['outcome'] !== 'NO_IMPACT' && r['outcome'] !== 'DEVIATION_RAISED') || typeof r['justification'] !== 'string' || r['justification'].trim() === '') {
    throw refusal(400, { code: 'SCHEMA', kind: 'INVALID_INPUT', whatHappened: 'The proposed disposition in the request is not in the expected form.', why: 'Expected <meaning>|<base64url JSON {outcome, justification}>.', controls: ['DI-37'], whatYouCanDo: ['Reload the screen and start the signing again.'] });
  }
  return { meaning, proposal: { outcome: r['outcome'], justification: r['justification'] } };
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

/**
 * The canonical envelope hash and version a signature on `c` would bind, given the stored head. An exception's
 * signed content also carries its proposed disposition (`proposal`; when undefined, the one stored on the head).
 */
async function bindingOf(db: Db, runId: string, c: engine.AggregateContent, proposal?: execution.DispositionProposal | null): Promise<{ version: number; text: string; hash: string }> {
  const head = await execution.loadContentHead(db, c.type, runId, c.key);
  const version = head && head.hash === c.contentHash ? head.version : (head?.version ?? 0) + 1;
  let content = c.content;
  if (c.type === 'batch_exception') {
    const p = proposal !== undefined ? proposal : head && version === head.version ? await execution.loadProposal(db, runId, c.key, version) : null;
    content = { ...content, proposedDisposition: p ? { outcome: p.outcome, justification: p.justification, deviationRef: p.deviationRef } : null };
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

function rendering(vc: ViewContext, type: engine.AggregateType, key: string, meaning: { code: string; text: string }, proposal: execution.DispositionProposal | null): { title: string; data: Record<string, unknown> & { kind: string } } {
  const run = vc.run;
  const common = {
    runId: run.batch.id,
    batchNumber: vc.state.header.batchNumber,
    product: { code: run.def.mbr.header.product.code, name: run.pkg.product.name || run.def.mbr.header.product.name, strength: run.def.mbr.header.product.strength },
    mbr: { familyCode: run.pkg.familyCode, versionNumber: run.pkg.versionNumber, revision: run.pkg.revision, contentHash: run.def.contentHash },
    meaning: meaning.code,
    meaningText: meaning.text,
  };
  if (type === 'batch_step') {
    const inst = vc.state.steps[key];
    if (!inst) throw notFound('step');
    const stepDef = run.def.steps.get(inst.step);
    if (!stepDef) throw notFound('step');
    const summary = stepSummary(vc, inst, inst.step, key);
    const sopId = stepDef.node.kind === 'phase' && typeof stepDef.node.config['sop'] === 'string' ? stepDef.node.config['sop'] : undefined;
    const sop = sopId ? run.def.mbr.references.find((r) => r.id === sopId) : undefined;
    return {
      title: `${summary.number} ${summary.title}`,
      data: {
        kind: 'batch_step',
        ...common,
        step: { stepKey: key, stepId: inst.step, number: summary.number, title: summary.title, kind: inst.kind, block: summary.block, blockTitle: stepDef.block?.title ?? null, stage: stageRef(vc, stepDef.stage) },
        instruction: { text: stepDef.node.kind === 'phase' && typeof stepDef.node.config['text'] === 'string' ? stepDef.node.config['text'] : null, sop: sop ? { code: sop.code, title: sop.title, version: sop.version, hash: sop.hash ?? null } : null },
        fields: fieldsOf(vc, stepDef, inst, key),
        entries: entriesOf(vc, key),
        exceptions: exceptionsOfStep(vc, inst, key, inst.step).map((e) => exceptionView(vc, e)),
      },
    };
  }
  if (type === 'batch_stage') {
    const frame = vc.state.stages[key];
    if (!frame) throw notFound('stage');
    const ref = stageRef(vc, frame.stage);
    const steps = engine.stageSteps(run.def, vc.state, frame).map((i) => stepSummary(vc, i, i.step, i.key));
    const keys = new Set(steps.map((s) => s.stepKey));
    return {
      title: `Stage ${ref?.number ?? ''} ${ref?.name ?? frame.stage}`.trim(),
      data: {
        kind: 'batch_stage',
        ...common,
        stage: { stageKey: key, stageId: frame.stage, number: ref?.number ?? '', name: ref?.name ?? frame.stage, startedAt: vc.app.formatInstant(frame.startedAt) },
        steps,
        exceptions: Object.values(vc.state.exceptions)
          .filter((e) => e.source.stepKey !== undefined && keys.has(e.source.stepKey))
          .sort((a, b) => a.raisedSeq - b.raisedSeq)
          .map((e) => exceptionView(vc, e)),
      },
    };
  }
  const e = vc.state.exceptions[key];
  if (!e) throw notFound('exception');
  const inst = e.source.stepKey !== undefined ? vc.state.steps[e.source.stepKey] : undefined;
  const summary = inst ? stepSummary(vc, inst, inst.step, inst.key) : undefined;
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
      step: summary ? { stepKey: summary.stepKey, number: summary.number, title: summary.title } : null,
      exception: view,
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
    },
  };
}

/** The proposal stored on the exception's current content version is the action's (outcome, justification, deviation). */
async function proposalHolds(db: Db, runId: string, state: engine.BatchState, intent: { exception: string; outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }): Promise<boolean> {
  const head = await execution.loadContentHead(db, 'batch_exception', runId, intent.exception);
  if (!head) return false;
  return sameProposal(await execution.loadProposal(db, runId, intent.exception, head.version), proposalOf(state, intent.exception, intent));
}

export function engineCommandHandler(app: AppContext): SignableActionHandler<EngineAction> {
  const cache = runCache(app);

  /** Locks the run and checks what does not depend on the command's own result (meaning, witness, version). */
  async function open(client: pg.PoolClient, ctx: SignableContext, a: EngineAction): Promise<{ run: RunContext; tx: execution.ExecutionTx; subject: ReturnType<typeof signedSubject>; meaning: string; problem: Refusal | null }> {
    const run = await runContext(client, a.runId);
    const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
    const subject = signedSubject(tx.state, a.intent);
    const meaning = signedMeaning(run.def, tx.state, a.intent) ?? '';
    let problem: Refusal | null = null;
    if (meaning !== meaningOf(ctx)) problem = mismatch(meaning, meaningOf(ctx));
    else if (a.intent.type === 'VERIFY' && meaning === engine.MEANINGS.WITNESSED && engine.nextStepStarted(tx.state, subject.key)) problem = lateWitness(subject.key);
    return { run, tx, subject, meaning, problem };
  }

  return {
    kind: 'ENGINE_COMMAND',
    aggregateTypes: HANDLED,

    describe(a) {
      const cached = cache.get(a.runId);
      const subject = signedSubject(cached?.state, a.intent);
      return { aggregateType: subject.aggregateType, aggregateId: `${a.runId}:${subject.key}`, meaning: signedMeaning(cached?.def, cached?.state, a.intent) ?? '', expectedState: subject.expectedState };
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
      const prepared = engine.prepareForSignature(run.def, stored.state, previewTarget(run.def, stored.state, type, key, meaning.code), actor, { nowUs });
      const c = engine.aggregateContent(run.def, prepared.state, type, key);
      if (!c) throw notFound('record to be signed');
      const proposal = type === 'batch_exception' ? (parsed.proposal ? proposalOf(prepared.state, key, parsed.proposal) : null) : undefined;
      const binding = await bindingOf(db, runId, c, proposal);
      const vc = await viewContext(app, db, run, prepared.state, nowUs, viewer);
      const r = rendering(vc, type, key, meaning, proposal ?? null);
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
      if (o.tx.state.version !== a.expectedVersion) throw stale(o.tx.state, a.expectedVersion);
      const roles = await engineRoles(client);
      const changed = await o.tx.prepare(o.subject.target, engineActor(ctx.actor.personId, roles), roles, o.meaning);
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const c = engine.aggregateContent(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key);
      if (!c) throw notFound('record to be signed');
      // The disposition being signed becomes part of the exception's signed content (never a change of its data).
      if (a.intent.type === 'DISPOSITION_EXCEPTION') await execution.proposeDisposition(client, a.runId, a.intent.exception, proposalOf(o.tx.state, a.intent.exception, a.intent));
      const binding = await bindingOf(client, a.runId, c);
      return { contentVersion: String(binding.version), contentHash: binding.hash, changed };
    },

    async dryRun(client, ctx, a): Promise<DryRunOutcome> {
      const o = await open(client, ctx, a);
      if (o.problem) return { accepted: false, status: 422, refusal: o.problem };
      const roles = await engineRoles(client);
      const actor = engineActor(ctx.actor.personId, roles);
      await o.tx.prepare(o.subject.target, actor, roles, o.meaning);
      if (a.intent.type === 'DISPOSITION_EXCEPTION' && !(await proposalHolds(client, a.runId, o.tx.state, a.intent))) {
        cache.set(a.runId, { def: o.run.def, state: o.tx.state });
        return { accepted: false, status: 409, refusal: proposalChanged(a.intent.exception) };
      }
      const placeholder: engine.SignatureRef = { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: o.meaning, signer: actor.id };
      const command = signedCommand(o.tx.state, a.intent, actor, placeholder, `ESIG-DRY:${randomUUID()}`, a.expectedVersion);
      const dry = o.tx.dryRun(command);
      if (!dry.accepted) {
        // The refusal is part of the record: a refused COMMAND row with the placeholder (never a signature).
        const r = await o.tx.command(command, roles, { signing: 'refused before signing', meaning: o.meaning });
        cache.set(a.runId, { def: o.run.def, state: o.tx.state });
        const mapped = engineRefusal(app.guidance, r.refusal ?? { code: 'ENG-REFUSED', message: 'Refused', controls: ['DI-34'] });
        return { accepted: false, status: mapped.status, refusal: { ...mapped.refusal, whatHappened: `${mapped.refusal.whatHappened} Nothing was signed.` } };
      }
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const c = engine.aggregateContent(o.run.def, dry.state, o.subject.aggregateType, o.subject.key);
      if (!c) return { accepted: false, status: 404, refusal: { code: 'EXE_NOT_FOUND', kind: 'STALE', whatHappened: 'The record to be signed was not found. Nothing was signed.', why: '', controls: ['DI-37'], whatYouCanDo: ['Reload the screen.'], whoCanHelp: [] } };
      const binding = await bindingOf(client, a.runId, c);
      return { accepted: true, contentHash: binding.hash, contentVersion: String(binding.version) };
    },

    async apply(client, ctx, a, signature) {
      const o = await open(client, ctx, a);
      if (o.problem) throw new Error(`${o.problem.code} ${o.problem.why}`);
      if (signature.meaning !== o.meaning || signature.signer !== ctx.actor.personId) throw new Error(`EBMR-EXE-080 the signature (${signature.meaning}, ${signature.signer}) is not the one this action needs`);
      if (a.intent.type === 'DISPOSITION_EXCEPTION' && !(await proposalHolds(client, a.runId, o.tx.state, a.intent))) throw new Error(`EBMR-EXE-086 ${proposalChanged(a.intent.exception).why}`);
      const roles = await engineRoles(client);
      const actor = engineActor(ctx.actor.personId, roles);
      const before = engine.aggregateContent(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key)?.contentHash;
      const command = signedCommand(o.tx.state, a.intent, actor, { id: signature.signatureId, meaning: signature.meaning, signer: signature.signer }, `ESIG:${signature.signatureId}`, a.expectedVersion);
      const r = await o.tx.command(command, roles, { signatureId: signature.signatureId });
      if (!r.accepted) throw new Error(`EBMR-EXE-082 the signed command was refused after its dry run was accepted (${r.refusal?.code ?? '?'}: ${r.refusal?.message ?? ''}); nothing is kept`);
      const after = engine.aggregateContent(o.run.def, o.tx.state, o.subject.aggregateType, o.subject.key)?.contentHash;
      if (after !== before) throw new Error('EBMR-EXE-083 the signed content changed while the signature was applied; nothing is kept (DI-37)');
      cache.set(a.runId, { def: o.run.def, state: o.tx.state });
      const stepKey = o.subject.aggregateType === 'batch_step' ? o.subject.key : o.subject.aggregateType === 'batch_exception' ? o.tx.state.exceptions[o.subject.key]?.source.stepKey : undefined;
      if (stepKey === undefined || !o.tx.state.steps[stepKey]) return null;
      const vc = await viewContext(app, client, o.run, o.tx.state, o.tx.nowUs, viewerOf(ctx));
      return await stepScreen(vc, stepKey);
    },
  };
}
