/**
 * Proposals, signed decisions and the corrections that need an approval, through the store (SQL mutation group
 * "exceptions-and-dispositions": recipe-core 0270, 0295, 0297, 0331, 0344). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in the group's server tests, which drive the server: its own checks refuse most forgeries
 * before the database sees them, and the database's refusals were asserted by their code only. Here every forgery is
 * written past the server with the application role's own credentials (ADR 0012, ebmr_sandbox here), with signatures
 * made through the kernel, and every refusal is asserted by its whole message, with what is stored after it:
 *   - recipe.propose_disposition: an exception of the batch, a proposal of exactly {outcome, justification,
 *     deviationRef}, an offered outcome, a justification of at most 4000 characters, the deviation linked to it, and an
 *     exception with signable content;
 *   - recipe.propose_hold_point_decision: a proposal of exactly {disposition, comment}, a disposition that is a text, a
 *     comment that is a text or null of at most 2000 characters, a hold point of the batch waiting for its decision, a
 *     disposition it offers, and signable content;
 *   - recipe.check_disposition_proposal and recipe.check_hold_point_decision: the proposal a signature covers is the
 *     latest on that record's signed content version (not another record's), prepared by the signer in the command that
 *     asked for the signature, and recorded exactly (each fact on its own);
 *   - recipe.correction_needs_approval: a value the batch's own MBR declares NON_CRITICAL is corrected without an
 *     approval; any other needs one, whatever other parameters or other batches declare;
 *   - recipe.check_exception_changes (recipe-core 0344): the row that decides a loop's exit is judged against the
 *     endpoint's limits although it changes no value, so the exit cannot leave its endpoint waiting and drop the breach
 *     its verdict raises (a defect the mutation run found: before 0344 that row was stored).
 *
 * Controls: PR-08, PR-45, PR-49, DI-07, DI-24, DI-26, DI-37, INV-09, INV-10, INV-19; S25 (decision on corrections).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { defineForSandbox, runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, nextState, prepareSignature } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyParameter, writePackage, type ExecServer } from '../execution/support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
type Client = pg.PoolClient;

const CLEAR = 'p-disp-clear@';
const HOLD = 'H-TEST@';

/** One browser per persona for the whole file: a new session of a person ends their earlier one. */
const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = {};
async function browserOf(persona: string): Promise<Awaited<ReturnType<ExecServer['asPersona']>>> {
  browsers[persona] ??= await sbx.asPersona(persona);
  return browsers[persona];
}

/** A run of `content` issued by the issuer (with `variants`), driven as `personas`. */
async function driver(content: flow.MbrContent, personas: string[], variants: Record<string, string> = {}): Promise<RunDriver> {
  const issuer = await browserOf('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content), undefined, variants);
  const mine: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) mine[p] = await browserOf(p);
  const d = new RunDriver(sbx, runId, mine);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** operator1 raises an exception (no step); its id. */
async function raise(d: RunDriver, severity: 'ALERT' | 'ACTION', description: string): Promise<string> {
  const before = new Set((await d.runView('qa1')).exceptions.map((e) => e.exceptionId));
  await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description, severity });
  const id = (await d.runView('qa1')).exceptions.map((e) => e.exceptionId).find((e) => !before.has(e));
  if (!id) throw new Error('SETUP: no exception raised');
  return id;
}

/** A QA hold point right after the booth clearance with two releasing decisions (one conditional) and a rejection. */
const withConditionalRelease = (): flow.MbrContent =>
  dcMiniVariant(([clear, ...rest]) => [
    clear as Json,
    { kind: 'holdPoint', id: 'H-TEST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'NOT_APPROVED'] },
    ...rest,
  ]);

/** A run whose clearance is performed and verified, so its hold point H-TEST@ is ENABLED for QA. */
async function atHoldPoint(content: flow.MbrContent = withConditionalRelease()): Promise<RunDriver> {
  const d = await driver(content, ['operator1', 'verifier1', 'qa1']);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9996' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  return d;
}

/** `persona` runs `work` in a command of their own, through the application role: 'ok' or the refusal's message. */
async function asApp(persona: string, work: (c: Client) => Promise<unknown>): Promise<string> {
  return messageOf(withCommand(sbx.db.app, await actorOf(sbx, await browserOf(persona), persona), work));
}

const proposeDisposition = (d: RunDriver, exception: string, proposal: unknown): Promise<string> =>
  asApp('qa1', (c) => c.query('select recipe.propose_disposition($1, $2, $3::jsonb)', [d.runId, exception, JSON.stringify(proposal)]));

const proposeDecision = (d: RunDriver, stepKey: string, proposal: unknown): Promise<string> =>
  asApp('qa1', (c) => c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [d.runId, stepKey, JSON.stringify(proposal)]));

async function dispositionProposals(runId: string): Promise<Json[]> {
  const { rows } = await sbx.db.admin.query<{ p: Json }>('select proposal as p from recipe.execution_disposition_proposal where batch_id = $1 order by id', [runId]);
  return rows.map((r) => r.p);
}

async function decisionProposals(runId: string): Promise<Json[]> {
  const { rows } = await sbx.db.admin.query<{ p: Json }>('select proposal as p from recipe.execution_decision_proposal where batch_id = $1 order by id', [runId]);
  return rows.map((r) => r.p);
}

interface Pending {
  contentVersion: string;
  /** esig.sign and seal inside the caller's command. */
  sign(c: Client): Promise<string>;
  /** The actor of that command, attributed by the signature's own authentication. */
  actor(): Promise<ActorContext>;
}

/**
 * qa1 asks for a signature with `meaning` on the record in a command of their own, after `before` ran in that same
 * command (a proposal, as the server's preparation makes it), and authenticates for it on their terminal. Nothing is
 * signed yet.
 */
async function challenge(d: RunDriver, aggregateType: string, aggregateId: string, meaning: string, before?: (c: Client) => Promise<unknown>): Promise<Pending> {
  const persona = 'qa1';
  const who = personaIn(sbx, persona);
  const browser = d.browser(persona);
  const prepared = await withCommand(sbx.db.app, await actorOf(sbx, browser, persona), async (c) => {
    await before?.(c);
    // The record's content as the server's signable handlers read it inside their commands (tablets 0410).
    const { rows } = await c.query<{ r: Json }>('select tab.record_content_for_signing($1, $2) as r', [aggregateType, aggregateId]);
    const content = rows[0]?.r ?? {};
    if (content['exists'] !== true) throw new Error(`SETUP: ${aggregateId} has no signable content`);
    const contentVersion = String(content['content_version']);
    const ch = await esig.createChallenge(c, { aggregateType, aggregateId, contentVersion, meaning, clientContentHash: String(content['content_hash']) });
    return { challengeId: ch.challengeId, contentVersion, state: typeof content['state'] === 'string' ? content['state'] : null };
  });
  const terminal = terminalOf(sbx.seed, browser.terminal);
  const kiosk = terminal.deviceClass === 'SHARED' || terminal.deviceClass === 'GRADE_A_B';
  const ev = await identity.authenticate(sbx.db.authn, {
    ...(kiosk ? { method: 'BADGE_PIN' as const, identifier: who.badgeUid ?? '', secret: who.pin ?? '' } : { method: 'PASSWORD' as const, identifier: who.loginName, secret: who.password }),
    deviceFingerprint: terminal.fingerprint,
    purpose: 'SIGNATURE',
    challengeId: prepared.challengeId,
  });
  const sealKey = sbx.built.ctx.sealKey;
  if (!sealKey) throw new Error('SETUP: the server has no seal key');
  return {
    contentVersion: prepared.contentVersion,
    sign: async (c) => (await esig.sign(c, { challengeId: prepared.challengeId, authEventId: ev.authEventId, expectedState: prepared.state }, sealKey)).signatureId,
    actor: () => actorOf(sbx, browser, persona, { authEventId: ev.authEventId }),
  };
}

/** A command as the store records it, changed by `edit` (the engine's result stays the honest command's). */
type Recorded = (encoded: Record<string, engine.JsonValue>) => engine.JsonValue;

/**
 * qa1 signs and records, through the store, DISPOSITION_HOLD_POINT of H-TEST@ with `decision`, signed with the meaning
 * of its class; `before` runs in the command that asks for the signature. 'ok' or the database's refusal.
 */
async function decideThroughStore(d: RunDriver, decision: { disposition: string; comment?: string }, opts: { before?: (c: Client) => Promise<unknown>; recorded?: Recorded } = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'qa1');
  const meaning = engine.holdPointMeaning(decision.disposition);
  const p = await challenge(d, 'batch_step', `${d.runId}:${HOLD}`, meaning, opts.before);
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_HOLD_POINT', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'H-TEST', context: [], disposition: decision.disposition,
        ...(decision.comment !== undefined ? { comment: decision.comment } : {}), signature: { id, meaning, signer: who.personId },
      };
      const r = engineResult(tx, command);
      return appendAs(tx, command, r, roles, opts.recorded ? opts.recorded({ ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>) }) : undefined);
    }),
  );
}

/** qa1 signs and records, through the store, DISPOSITION_EXCEPTION of `exception`; `before` runs in the command that asks for the signature. */
async function dispositionThroughStore(d: RunDriver, exception: string, disposition: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }, opts: { before?: (c: Client) => Promise<unknown>; recorded?: Recorded } = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'qa1');
  const p = await challenge(d, 'batch_exception', `${d.runId}:${exception}`, 'EXCEPTION_DISPOSITIONED', opts.before);
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'DISPOSITION_EXCEPTION', commandId: randomUUID(), actor: engineActor(who.personId, roles), exception, ...disposition,
        signature: { id, meaning: 'EXCEPTION_DISPOSITIONED', signer: who.personId },
      };
      const r = engineResult(tx, command);
      return appendAs(tx, command, r, roles, opts.recorded ? opts.recorded({ ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>) }) : undefined);
    }),
  );
}

/** The hold point's recorded decision, and the signatures on it. */
async function holdPointRecord(d: RunDriver): Promise<{ decision: { value: string; comment: string | null } | null; signatures: number }> {
  const r = (await execution.loadState(sbx.db.admin, d.runId))?.state.steps[HOLD]?.disposition;
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where aggregate_id = $1', [`${d.runId}:${HOLD}`]);
  return { decision: r ? { value: r.value, comment: r.comment ?? null } : null, signatures: Number(rows[0]?.n) };
}

/** The exception's status and recorded disposition, and the signatures on it. */
async function exceptionRecord(d: RunDriver, exception: string): Promise<{ status: string | undefined; disposition: { outcome: string; justification: string } | null; signatures: number }> {
  const x = (await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[exception];
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where aggregate_id = $1', [`${d.runId}:${exception}`]);
  return { status: x?.status, disposition: x?.disposition ? { outcome: x.disposition.outcome, justification: x.disposition.justification } : null, signatures: Number(rows[0]?.n) };
}

/** As the superuser with the triggers off (a record restored without it): the signable content of a record is gone. */
async function withoutContent(table: 'execution_exception_content' | 'execution_step_content', aggregateId: string): Promise<void> {
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const r = await c.query(`delete from recipe.${table} where aggregate_id = $1`, [aggregateId]);
    if (r.rowCount === 0) throw new Error(`SETUP: ${aggregateId} had no content`);
    await c.query('commit');
  } finally {
    c.release();
  }
}

describe('recipe.propose_disposition: what a proposed disposition is (PR-49, DI-37, DI-26)', () => {
  const SHAPE = 'A proposed disposition is {outcome, justification, deviationRef}: NO_IMPACT or DEVIATION_RAISED, a justification that is not blank, and the deviation linked to the exception (PR-49). [EBMR-EXE-084]';

  it('[PR-49][DI-37][DI-26] a proposal on an exception the batch does not have, with a member of its own, an outcome it does not offer, a deviation that is not the one linked, or a justification over 4000 characters is refused in its own words; what is stored is the honest proposals only', async () => {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    const exception = await raise(d, 'ALERT', 'Label printer jammed once; label reprinted');
    const why = 'Reprint reconciled; no impact on the batch.';
    const longest = `${'x'.repeat(3990)}Reconciled`;
    expect(longest).toHaveLength(4000);
    const outcomes = {
      unknownException: await proposeDisposition(d, 'EX-NONE', { outcome: 'NO_IMPACT', justification: why, deviationRef: null }),
      memberOfItsOwn: await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: why, deviationRef: null, lotNumber: 'L2409-0017' }),
      outcomeNotOffered: await proposeDisposition(d, exception, { outcome: 'NOT_RELEVANT', justification: why, deviationRef: null }),
      deviationNotLinked: await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: why, deviationRef: 'TEST-DEV-0099' }),
      justificationTooLong: await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: `${longest}.`, deviationRef: null }),
      justificationAtTheLimit: await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: longest, deviationRef: null }),
      honest: await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: why, deviationRef: null }),
    };
    expect(outcomes).toEqual({
      unknownException: 'There is no exception EX-NONE in this test batch (DI-26). [EBMR-EXE-084]',
      memberOfItsOwn: SHAPE,
      outcomeNotOffered: SHAPE,
      deviationNotLinked: SHAPE,
      justificationTooLong: SHAPE,
      justificationAtTheLimit: 'ok',
      honest: 'ok',
    });
    expect(await dispositionProposals(d.runId)).toEqual([
      { outcome: 'NO_IMPACT', justification: longest, deviationRef: null },
      { outcome: 'NO_IMPACT', justification: why, deviationRef: null },
    ]);
  }, 300_000);

  it('[DI-37][PR-49] a proposal on an exception whose signable content is missing (a record restored without it) is refused, and nothing is stored', async () => {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    const exception = await raise(d, 'ALERT', 'Label printer jammed once; label reprinted');
    await withoutContent('execution_exception_content', `${d.runId}:${exception}`);
    const outcome = await proposeDisposition(d, exception, { outcome: 'NO_IMPACT', justification: 'Reprint reconciled.', deviationRef: null });
    expect(outcome).toBe(`Exception ${exception} has no signable content (DI-37). [EBMR-EXE-084]`);
    expect(await dispositionProposals(d.runId)).toEqual([]);
  }, 300_000);
});

describe('recipe.propose_hold_point_decision: what a proposed decision is, and on which hold point (PR-45, DI-37)', () => {
  const SHAPE = 'A proposed hold-point decision is {disposition, comment}: a disposition the hold point offers and a comment of at most 2000 characters, or null (PR-45). [EBMR-EXE-084]';

  it('[PR-45][DI-37] a proposal with a member of its own, without its comment, with a blank or non-text disposition, a comment that is not a text or longer than 2000 characters, or a disposition the hold point does not offer is refused in its own words; what is stored is the honest proposals only', async () => {
    const d = await atHoldPoint();
    const longest = 'c'.repeat(2000);
    const outcomes = {
      memberOfItsOwn: await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: null, lotNumber: 'L2409-0017' }),
      noComment: await proposeDecision(d, HOLD, { disposition: 'APPROVED', note: null }),
      blankDisposition: await proposeDecision(d, HOLD, { disposition: '   ', comment: null }),
      numberDisposition: await proposeDecision(d, HOLD, { disposition: 7, comment: null }),
      numberComment: await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: 7 }),
      commentTooLong: await proposeDecision(d, HOLD, { disposition: 'NOT_APPROVED', comment: `${longest}.` }),
      notOffered: await proposeDecision(d, HOLD, { disposition: 'MAYBE_LATER', comment: null }),
      commentAtTheLimit: await proposeDecision(d, HOLD, { disposition: 'NOT_APPROVED', comment: longest }),
      honest: await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: null }),
    };
    expect(outcomes).toEqual({
      memberOfItsOwn: SHAPE,
      noComment: SHAPE,
      blankDisposition: SHAPE,
      numberDisposition: SHAPE,
      numberComment: SHAPE,
      commentTooLong: SHAPE,
      notOffered: 'MAYBE_LATER is not a decision hold point H-TEST@ offers (PR-45). [EBMR-EXE-084]',
      commentAtTheLimit: 'ok',
      honest: 'ok',
    });
    expect(await decisionProposals(d.runId)).toEqual([
      { disposition: 'NOT_APPROVED', comment: longest },
      { disposition: 'APPROVED', comment: null },
    ]);
  }, 300_000);

  it('[PR-45][DI-37] a decision is proposed only on a hold point of the batch waiting for it: a key the batch does not have, a phase, and a hold point its branch left not applicable are refused in their own words', async () => {
    // A QA release in a branch the issue variant does not take: the hold point is in the state, NOT_APPLICABLE.
    const content = dcMiniVariant((prep, c) => {
      (c['header'] as Json)['variants'] = [{ id: 'boothRelease', values: ['QA', 'NONE'] }];
      return [
        {
          kind: 'alternative', id: 'ALT-RELEASE', decision: { mode: 'ISSUE_VARIANT', variant: 'boothRelease' },
          branches: [
            { id: 'B-QA', name: 'QA releases the booth', variantValues: ['QA'], body: { kind: 'holdPoint', id: 'H-ALT', name: 'QA release of the booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] } },
            { id: 'B-NONE', name: 'No release', variantValues: ['NONE'] },
          ],
        },
        ...prep,
      ];
    });
    const d = await driver(content, ['operator1', 'qa1'], { boothRelease: 'NONE' });
    const st = await execution.loadState(sbx.db.admin, d.runId);
    expect(st?.state.steps['H-ALT@']).toMatchObject({ kind: 'HOLD', status: 'NOT_APPLICABLE' });
    expect(st?.state.steps['H-ALT@']).not.toHaveProperty('disposition');
    const decision = { disposition: 'APPROVED', comment: null };
    const outcomes = {
      unknownKey: await proposeDecision(d, 'H-NONE@', decision),
      phase: await proposeDecision(d, CLEAR, decision),
      notApplicable: await proposeDecision(d, 'H-ALT@', decision),
    };
    expect(outcomes).toEqual({
      unknownKey: 'There is no hold point H-NONE@ in this test batch (PR-45). [EBMR-EXE-084]',
      phase: `There is no hold point ${CLEAR} in this test batch (PR-45). [EBMR-EXE-084]`,
      notApplicable: 'Hold point H-ALT@ is not waiting for a decision (PR-45). [EBMR-EXE-084]',
    });
    expect(await decisionProposals(d.runId)).toEqual([]);
  }, 300_000);

  it('[PR-45][DI-37] a hold point whose MBR content offers no list of decisions takes no proposed decision: a package imported and a batch issued past the server, through the application role, with the hold point\'s dispositions left out', async () => {
    // The hold point first, so it waits for its decision from the issue on; the package's content leaves its list out.
    const offered = dcMiniVariant((prep) => [{ kind: 'holdPoint', id: 'H-TEST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'NOT_APPROVED'] }, ...prep]);
    const stored = JSON.parse(JSON.stringify(offered)) as Json;
    const stage = ((((stored['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
    const prep = ((stage['children'] as Json[])[0] as Json)['body'] as Json;
    const hold = (prep['children'] as Json[])[0] as Json;
    expect(hold['id']).toBe('H-TEST');
    delete hold['dispositions'];
    const pkg = writePackage(sbx, stored as unknown as flow.MbrContent);
    expect(await asApp('issuer', (c) => execution.importTestPackage(c, pkg, `${pkg.packageHash}.json`))).toBe('ok');
    // The application issues it with the engine's initial state of the content that offers the decisions.
    const def = defineForSandbox(`${pkg.packageHash}:offered`, offered, []);
    const who = personaIn(sbx, 'issuer');
    const batchId = randomUUID();
    const issued = await asApp('issuer', async (c) => {
      const begun = await execution.beginIssue(c, batchId);
      const request: engine.IssueRequest = {
        batchId, batchNumber: begun.batchNumber, batchSize: offered.header.batchSizes[0]?.id ?? '', marketSet: ['IN'], purpose: 'VALIDATION', variants: {},
        inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'mutation kill test' } }, issuedBy: { id: who.personId, kind: 'PERSON', roles: [] },
      };
      const r = engine.issue(def, request, { nowUs: begun.nowUs });
      const state = { ...r.state, mbrHash: pkg.contentHash };
      const events = r.events.map((e) => (e.type === 'BATCH_ISSUED' ? { ...e, mbrHash: pkg.contentHash } : e));
      await execution.issueExecution(c, {
        batchId, packageHash: pkg.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(def.policy),
        registryFingerprint: def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state, events, contents: engine.changedContents(def, undefined, state),
      });
    });
    expect(issued).toBe('ok');
    expect((await execution.loadState(sbx.db.admin, batchId))?.state.steps[HOLD]).toMatchObject({ kind: 'HOLD', status: 'ENABLED' });
    const d = new RunDriver(sbx, batchId, { qa1: await browserOf('qa1') });
    expect({
      approved: await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: null }),
      notApproved: await proposeDecision(d, HOLD, { disposition: 'NOT_APPROVED', comment: 'Residue behind the grille' }),
    }).toEqual({
      approved: 'APPROVED is not a decision hold point H-TEST@ offers (PR-45). [EBMR-EXE-084]',
      notApproved: 'NOT_APPROVED is not a decision hold point H-TEST@ offers (PR-45). [EBMR-EXE-084]',
    });
    expect(await decisionProposals(batchId)).toEqual([]);
  }, 300_000);

  it('[DI-37][PR-45] a decision proposed on a hold point whose signable content is missing (a record restored without it) is refused, and nothing is stored', async () => {
    const d = await atHoldPoint();
    await withoutContent('execution_step_content', `${d.runId}:${HOLD}`);
    expect(await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: null })).toBe(`Hold point ${HOLD} has no signable content (DI-37). [EBMR-EXE-084]`);
    expect(await decisionProposals(d.runId)).toEqual([]);
  }, 300_000);
});

describe('recipe.check_hold_point_decision: the decision recorded is the one its signature covers (PR-45, DI-37, INV-10)', () => {
  const OTHER_DECISION = (step: string) =>
    `The disposition or comment of the decision on hold point ${step} is not the decision its signature covers; a decision is recorded exactly as signed (PR-45, DI-37). [EBMR-EXE-086]`;
  const propose = (d: RunDriver, decision: { disposition: string; comment: string | null }) => (c: Client) =>
    c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [d.runId, HOLD, JSON.stringify(decision)]);

  it('[PR-45][DI-37][INV-10] a signature that covers no proposed decision, or a decision proposed in another command than the one that asked for the signature, records nothing', async () => {
    const d = await atHoldPoint();
    const none = await decideThroughStore(d, { disposition: 'APPROVED' });
    // qa1 proposes in a command of their own, then asks for the signature in another.
    expect(await proposeDecision(d, HOLD, { disposition: 'APPROVED', comment: null })).toBe('ok');
    const earlier = await decideThroughStore(d, { disposition: 'APPROVED' });
    expect({ none, earlier }).toEqual({
      none: 'The signature on hold point H-TEST covers no proposed decision, so nothing was signed to decide it (PR-45, DI-37). [EBMR-EXE-086]',
      earlier: 'The decision the signature on hold point H-TEST covers was not prepared by the signer when this signature was requested (PR-45, DI-37). [EBMR-EXE-086]',
    });
    expect(await holdPointRecord(d)).toEqual({ decision: null, signatures: 0 });
    // Proposed in the command that asks for the signature, it is recorded.
    expect(await decideThroughStore(d, { disposition: 'APPROVED' }, { before: propose(d, { disposition: 'APPROVED', comment: null }) })).toBe('ok');
    expect(await holdPointRecord(d)).toEqual({ decision: { value: 'APPROVED', comment: null }, signatures: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[PR-45][DI-37][INV-10] a decision recorded with another disposition of the same class, another comment, or a comment of null, than the proposal signed, is refused; nothing is recorded', async () => {
    const d = await atHoldPoint();
    const outcomes = {
      // Signed APPROVED_WITH_CONDITIONS with its conditions, recorded as APPROVED with the same comment.
      otherDisposition: await decideThroughStore(d, { disposition: 'APPROVED', comment: 'Release after the retest' }, { before: propose(d, { disposition: 'APPROVED_WITH_CONDITIONS', comment: 'Release after the retest' }) }),
      // Signed a rejection for one reason, recorded with another.
      otherComment: await decideThroughStore(d, { disposition: 'NOT_APPROVED', comment: 'Paperwork incomplete' }, { before: propose(d, { disposition: 'NOT_APPROVED', comment: 'Residue behind the grille' }) }),
      // Signed without a comment, recorded with a comment that is not a text.
      nullComment: await decideThroughStore(d, { disposition: 'APPROVED' }, { before: propose(d, { disposition: 'APPROVED', comment: null }), recorded: (x) => ({ ...x, comment: null }) }),
    };
    expect(outcomes).toEqual({ otherDisposition: OTHER_DECISION('H-TEST'), otherComment: OTHER_DECISION('H-TEST'), nullComment: OTHER_DECISION('H-TEST') });
    expect(await holdPointRecord(d)).toEqual({ decision: null, signatures: 0 });
  }, 300_000);

  it('[PR-45][DI-37][INV-10][INV-09] the proposal a signature covers is the one on its own hold point: a later proposal on another batch\'s hold point at the same content version is not it', async () => {
    const a = await atHoldPoint();
    const b = await atHoldPoint();
    // In the command that asks for A's signature, qa1 proposes A's decision, then another one on B's hold point.
    let versions: string[] = [];
    const before = async (c: Client) => {
      await propose(a, { disposition: 'APPROVED', comment: null })(c);
      await propose(b, { disposition: 'NOT_APPROVED', comment: 'Residue behind the grille' })(c);
      const { rows } = await c.query<{ v: string }>('select content_version::text as v from recipe.execution_decision_proposal where batch_id = any ($1::uuid[]) order by id', [[a.runId, b.runId]]);
      versions = rows.map((r) => r.v);
    };
    expect(await decideThroughStore(a, { disposition: 'APPROVED' }, { before })).toBe('ok');
    expect(versions).toHaveLength(2);
    expect(versions[0], 'SETUP: both proposals are on the same content version').toBe(versions[1]);
    expect(await holdPointRecord(a)).toEqual({ decision: { value: 'APPROVED', comment: null }, signatures: 1 });
    expect(await holdPointRecord(b)).toEqual({ decision: null, signatures: 0 });
  }, 400_000);
});

describe('recipe.check_disposition_proposal: the disposition recorded is the one its signature covers (PR-49, DI-37, INV-10)', () => {
  const propose = (d: RunDriver, exception: string, proposal: execution.DispositionProposal) => (c: Client) => execution.proposeDisposition(c, d.runId, exception, proposal);

  it('[PR-49][DI-37][INV-10] a signature that covers no proposed disposition, or a disposition recorded with a justification that is not a text, records nothing', async () => {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    const exception = await raise(d, 'ALERT', 'Label printer jammed once; label reprinted');
    const none = await dispositionThroughStore(d, exception, { outcome: 'NO_IMPACT', justification: 'Reprint reconciled.' });
    // The signed proposal's justification is the text "1250"; the command records the number 1250.
    const numberJustification = await dispositionThroughStore(d, exception, { outcome: 'NO_IMPACT', justification: '1250' }, {
      before: propose(d, exception, { outcome: 'NO_IMPACT', justification: '1250', deviationRef: null }),
      recorded: (x) => ({ ...x, justification: 1250 }),
    });
    expect({ none, numberJustification }).toEqual({
      none: `The signature on exception ${exception} covers no proposed disposition, so nothing was signed to disposition it (PR-49, DI-37). [EBMR-EXE-086]`,
      numberJustification: `The outcome, justification or linked deviation of the disposition of exception ${exception} is not the disposition its signature covers; a disposition is recorded exactly as signed (PR-49, DI-37). [EBMR-EXE-086]`,
    });
    expect(await exceptionRecord(d, exception)).toEqual({ status: 'OPEN', disposition: null, signatures: 0 });
  }, 300_000);

  it('[PR-49][DI-37][INV-10][INV-09] the proposal a signature covers is the one on its own exception: a later proposal on another exception at the same content version is not it', async () => {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    const first = await raise(d, 'ALERT', 'Label printer jammed once; label reprinted');
    const second = await raise(d, 'ALERT', 'Booth door left open for two minutes');
    let versions: string[] = [];
    const before = async (c: Client) => {
      await propose(d, first, { outcome: 'NO_IMPACT', justification: 'Reprint reconciled.', deviationRef: null })(c);
      await propose(d, second, { outcome: 'NO_IMPACT', justification: 'Door closed; room pressure held.', deviationRef: null })(c);
      const { rows } = await c.query<{ v: string }>('select content_version::text as v from recipe.execution_disposition_proposal where batch_id = $1 order by id', [d.runId]);
      versions = rows.map((r) => r.v);
    };
    expect(await dispositionThroughStore(d, first, { outcome: 'NO_IMPACT', justification: 'Reprint reconciled.' }, { before })).toBe('ok');
    expect(versions).toHaveLength(2);
    expect(versions[0], 'SETUP: both proposals are on the same content version').toBe(versions[1]);
    expect(await exceptionRecord(d, first)).toEqual({ status: 'DISPOSITIONED', disposition: { outcome: 'NO_IMPACT', justification: 'Reprint reconciled.' }, signatures: 1 });
    expect(await exceptionRecord(d, second)).toEqual({ status: 'OPEN', disposition: null, signatures: 0 });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('recipe.check_exception_changes: a loop\'s exit gives its endpoint the verdict of its limits (PR-08, PR-49, INV-19)', () => {
  /**
   * dc-mini with a drying loop first in the dispensing preparation: one LOD test per iteration, the loop exits once
   * LOD <= 2 %, and LOD has an internal action limit of 0.0-1.0 %, judged at the loop's exit (ADR 0004).
   */
  const withDryingLoop = (): flow.MbrContent =>
    dcMiniVariant((prep, c) => {
      const blendTime = (c['parameters'] as Json[]).find((p) => p['id'] === 'blendTime') as Json;
      const lod: Json = {
        ...blendTime, id: 'lod', name: 'Loss on drying', unit: '%', precision: { kind: 'DECIMALS', digits: 1 }, role: 'PROCESS_ENDPOINT', criticality: 'NON_CRITICAL', riskClass: 'LOW', evidence: 'NONE',
        limits: { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '0.0', inclusive: true }, high: { value: '1.0', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'COMPANY_STANDARD', ref: 'SOP-DRY-001' } }] },
      };
      delete lod['target'];
      (c['parameters'] as Json[]).push(lod);
      const blend = (((((c['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
      const p = (((blend[0] as Json)['body'] as Json)['children'] as Json[]).find((x) => x['id'] === 'p-blend') as Json;
      const test = { ...p, id: 'p-lod', name: 'LOD test', records: ['lod'], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } } };
      return [{ kind: 'loop', id: 'L-DRY', name: 'Drying', maxIterations: 3, exit: { condition: 'lod <= 2 [%]', endpoint: 'lod' }, body: { kind: 'sequence', id: 'L-DRY-seq', children: [test] } }, ...prep];
    });

  it('[PR-08][PR-49][INV-19][DI-26] the row that decides a loop\'s exit and leaves its endpoint waiting, without the breach its verdict raises, is refused although it changes no value; the engine\'s own exit is recorded with that breach', async () => {
    const d = await driver(withDryingLoop(), ['operator1']);
    const key = 'p-lod@L-DRY=1';
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    // 1.5 % ends the loop (<= 2 %) and is outside the internal action limit (0.0-1.0 %).
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: key, item: 'lod', value: { kind: 'DECIMAL', value: '1.5', unit: '%' }, source: { mode: 'MANUAL' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    /** operator1 completes the iteration through the store: the engine's row, or with its verdict left out. */
    const exit = async (leaveWaiting: boolean): Promise<string> =>
      asApp('operator1', async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'COMPLETE_LOOP_ITERATION', commandId: randomUUID(), actor: engineActor(who.personId, roles), construct: 'L-DRY', context: [{ construct: 'L-DRY', index: 1 }] };
        const r = engineResult(tx, command);
        const raised = Object.values(r.state.exceptions).filter((x) => tx.state.exceptions[x.id] === undefined);
        expect(raised.map((x) => [x.type, x.tier, x.severity, x.deviationRequired]), 'SETUP: the engine raises the breach at the exit').toEqual([['LIMIT_BREACH', 'INTERNAL_ACTION', 'ACTION', true]]);
        if (!leaveWaiting) return appendAs(tx, command, r, roles);
        // The exit is decided, the endpoint keeps waiting as before the row, and the breach is left out with its event.
        const state = structuredClone(r.state);
        for (const x of raised) delete state.exceptions[x.id];
        state.points = structuredClone(tx.state.points);
        const events = r.events.filter((e) => e.type !== 'EXCEPTION_RAISED');
        return appendAs(tx, command, { state, events }, roles);
      });
    const forged = await exit(true);
    expect(forged).toMatch(
      /^The limit verdicts of this COMMAND row are not recorded as the engine gives them: the exit of loop L-DRY \(L-DRY@L-DRY=1\) is not recorded with the verdict the engine gives it: it judges the endpoint lod of that iteration against its limits, and the state gives none of its values that verdict\. .*\(PR-08, PR-49, DI-26\)\. \[EBMR-EXE-044\]$/,
    );
    const waiting = await execution.loadState(sbx.db.admin, d.runId);
    expect(Object.keys(waiting?.state.decisions ?? {})).toEqual([]);
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.command_type === 'COMPLETE_LOOP_ITERATION')).toEqual([]);
    // The engine's own exit: the loop ends, the endpoint is judged and its breach raised.
    expect(await exit(false)).toBe('ok');
    const judged = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(Object.values(judged?.decisions ?? {}).map((x) => [x.key, x.outcome])).toEqual([['L-DRY@L-DRY=1', 'EXIT']]);
    const point = Object.values(judged?.points ?? {}).find((x) => x.item === 'lod');
    expect({ failed: point?.failed, waiting: point?.evaluation?.requirement === 'ENDPOINT_IN_PROGRESS', exceptions: point?.exceptions.map((x) => judged?.exceptions[x]?.type) }).toEqual({ failed: true, waiting: false, exceptions: ['LIMIT_BREACH'] });
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('recipe.correction_needs_approval: a correction without an approval only for a value the batch\'s MBR declares non-critical (S25, DI-24, DI-07)', () => {
  const EARLY = 'p-early-time@';
  /** withEarlyParameter with the parameters `nonCritical` declared NON_CRITICAL (blend time is keyed first). */
  const declaring = (...nonCritical: string[]): flow.MbrContent => {
    const content = JSON.parse(JSON.stringify(withEarlyParameter())) as Json;
    for (const p of content['parameters'] as Json[]) if (nonCritical.includes(String(p['id']))) p['criticality'] = 'NON_CRITICAL';
    return content as unknown as flow.MbrContent;
  };

  /** A run of `content` with the blend time keyed by operator1 (15 min); the run and the data point. */
  async function keyed(content: flow.MbrContent): Promise<{ d: RunDriver; point: string }> {
    const d = await driver(content, ['operator1', 'qa1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    const st = await execution.loadState(sbx.db.admin, d.runId);
    const point = Object.values(st?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID')?.id;
    if (!point) throw new Error('SETUP: no blend time recorded');
    return { d, point };
  }

  /** operator1 corrects the blend time to 16 min without an approval, signing CORRECTED in the recording command; the engine's row, or the command recorded as is beside a forged next state when the engine asks for an approval. */
  async function correctWithoutApproval(d: RunDriver, point: string, forged: boolean): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_point', `${d.runId}:${point}`, 'CORRECTED');
    return messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = {
          type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(me.personId, roles), point,
          value: { kind: 'DECIMAL', value: '16', unit: 'min' }, reason: 'Transcription error: the timer read 16 min', signature: { id, meaning: 'CORRECTED', signer: me.personId },
        };
        if (forged) return appendAs(tx, command, nextState(tx), roles);
        const r = await tx.command(command, roles);
        if (!r.accepted) throw new Error(`SETUP: the engine refused the correction: ${JSON.stringify(r.refusal)}`);
        return r;
      }),
    );
  }

  it('[S25][DI-24][DI-07] the blend time declared NON_CRITICAL by the batch\'s own MBR is corrected without an approval; with the blend time critical, another parameter declared NON_CRITICAL waives nothing', async () => {
    // The only batch whose MBR declares the blend time NON_CRITICAL.
    const nonCritical = await keyed(declaring('blendTime'));
    // The blend time critical, the blender speed declared NON_CRITICAL.
    const critical = await keyed(declaring('blenderSpeed'));
    const outcomes = {
      nonCritical: await correctWithoutApproval(nonCritical.d, nonCritical.point, false),
      criticalBesideNonCritical: await correctWithoutApproval(critical.d, critical.point, true),
    };
    expect(outcomes).toEqual({
      nonCritical: 'ok',
      criticalBesideNonCritical: `The correction of ${critical.point} needs the signed approval of a supervisor or QA: the value is not declared non-critical (S25, DI-24). [EBMR-EXE-051]`,
    });
    expect((await rowsOf(sbx, nonCritical.d.runId)).filter((r) => r.command_type === 'CORRECT_ENTRY').map((r) => r.accepted)).toEqual([true]);
    expect((await rowsOf(sbx, critical.d.runId)).filter((r) => r.command_type === 'CORRECT_ENTRY')).toEqual([]);
    const corrected = (await execution.loadState(sbx.db.admin, nonCritical.d.runId))?.state.points;
    expect(Object.values(corrected ?? {}).filter((x) => x.item === 'blendTime').map((x) => [x.status, x.kind === 'VALUE' ? x.value : null])).toEqual([
      ['SUPERSEDED', { kind: 'DECIMAL', value: '15', unit: 'min' }],
      ['VALID', { kind: 'DECIMAL', value: '16', unit: 'min' }],
    ]);
    expect(await violations(sbx)).toEqual([]);
  }, 400_000);
});
