/**
 * Kill tests of the SQL mutation group execution-steps-and-order (tools/sql-mutation; build outline 9.1), through the
 * store: the row triggers on recipe.execution_state that read the row's kind, verdict and act (recipe-core sql 0307
 * zd_execution_step_order, 0308 ze_execution_step_acts, 0312 zg_execution_own_node_events, 0320
 * zk_execution_stage_summary; Phase 2 exit review F66, F67, F01; DI-34, PR-13, INV-20, PR-30, PR-08, PR-45, IN-37,
 * DI-27, DI-37, IN-15, PR-16).
 *
 * The application role (ebmr_sandbox here; ADR 0012) is the writer: the honest rows go through the server as the
 * personas of the seed record them, and each forged row is appended through the store's own functions
 * (recipe.issue_execution, recipe.append_execution) with an engine result the engine itself would refuse, the
 * signatures made through the kernel. Each refusal is checked with its code and reason, and that nothing was written.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, identity, withCommand } from '@ebmr/kernel';
import { engine, execution, flow } from '@ebmr/recipe-core';
import { terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, prepareSignature, signOffStageThroughStore, unmatched } from '../execution/db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, RunDriver, rowsOf, startExecServer, violations, withEarlyHoldPoint, withEarlyParameter, writePackage, type ExecServer } from '../execution/support.ts';

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

const CLEAR = 'p-disp-clear@';
const HOLD = 'H-TEST@';
const CHECKLIST = { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) };
const PREVIOUS = { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' };

/** A run of `content` issued by the issuer, with a browser per persona (a persona name, or [persona, terminal]). */
async function newRun(content: flow.MbrContent, people: readonly (string | [string, string])[], variants: Record<string, string> = {}): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content), undefined, variants);
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of people) {
    const [key, terminal] = typeof p === 'string' ? [p, undefined] : p;
    browsers[key] = await sbx.asPersona(key, terminal);
  }
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** The line clearance started, its two entries recorded, signed performed by operator1 and verified by verifier1. */
async function clearance(d: RunDriver, afterStart: () => Promise<void> = () => Promise.resolve()): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  await afterStart();
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: CHECKLIST });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: PREVIOUS });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
}

/** operator1's ACTION exception on `stepKey` (it blocks the steps after it until a deviation is linked); its id. */
async function actionException(d: RunDriver, stepKey: string, description: string): Promise<string> {
  await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey, description, severity: 'ACTION' });
  const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  const x = Object.values(state?.exceptions ?? {}).find((e) => e.type === 'OPERATOR_RAISED' && e.status === 'OPEN' && e.title.endsWith(description));
  if (!x) throw new Error(`SETUP: no open exception "${description}"`);
  return x.id;
}

/**
 * qa1's HOLD_POINT_RELEASED signature on hold point H-TEST of run `d`, made through the kernel as the server makes it:
 * the decision proposed in the command that requests the signature (its correlation id; recipe-core 0295), the content
 * the kernel's provider gives with it, qa1's badge and PIN on the kiosk. `sign` signs inside the caller's command.
 */
async function releaseSignature(d: RunDriver): Promise<{ sign: (c: Parameters<Parameters<typeof withCommand>[2]>[0]) => Promise<string>; actor: () => ReturnType<typeof actorOf> }> {
  const aggregateId = `${d.runId}:${HOLD}`;
  const browser = d.browser('qa1');
  const who = personaIn(sbx, 'qa1');
  const propose = (c: { query: (q: string, v: unknown[]) => Promise<unknown> }) =>
    c.query('select recipe.propose_hold_point_decision($1, $2, $3::jsonb)', [d.runId, HOLD, JSON.stringify({ disposition: 'APPROVED', comment: null })]);
  // The content with the decision proposed (the provider's, read as the server previews it), then the same decision
  // proposed again in the command that requests the signature.
  await withCommand(sbx.db.app, await actorOf(sbx, browser, 'qa1'), propose);
  const content = await esig.contentForSigning(sbx.db.admin, 'batch_step', aggregateId);
  if (!content.exists || content.contentVersion === undefined || content.contentHash === undefined) throw new Error(`SETUP: no signable content: ${JSON.stringify(content)}`);
  const prepared = await withCommand(sbx.db.app, await actorOf(sbx, browser, 'qa1'), async (c) => {
    await propose(c);
    const challenge = await esig.createChallenge(c, { aggregateType: 'batch_step', aggregateId, contentVersion: content.contentVersion ?? '', meaning: 'HOLD_POINT_RELEASED', clientContentHash: content.contentHash ?? '' });
    return { challengeId: challenge.challengeId, state: content.state ?? null };
  });
  const terminal = terminalOf(sbx.seed, browser.terminal);
  const ev = await identity.authenticate(sbx.db.authn, { method: 'BADGE_PIN', identifier: who.badgeUid ?? '', secret: who.pin ?? '', deviceFingerprint: terminal.fingerprint, purpose: 'SIGNATURE', challengeId: prepared.challengeId });
  const sealKey = sbx.built.ctx.sealKey;
  if (!sealKey) throw new Error('SETUP: the server has no seal key');
  return {
    sign: async (c) => (await esig.sign(c, { challengeId: prepared.challengeId, authEventId: ev.authEventId, expectedState: prepared.state }, sealKey)).signatureId,
    actor: () => actorOf(sbx, browser, 'qa1', { authEventId: ev.authEventId }),
  };
}

const stateOf = async (d: RunDriver): Promise<engine.BatchState> => {
  const s = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  if (!s) throw new Error('SETUP: no state');
  return s;
};

/** dc-mini whose dispensing stage holds the line clearance only (its sign-off follows the clearance), with `constraints`. */
function clearanceStage(constraints: Json[] = []): flow.MbrContent {
  const content = JSON.parse(JSON.stringify(dcMini())) as Json;
  const stage = ((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json)['body'] as Json;
  const prep = (stage['children'] as Json[])[0] as Json;
  const body = prep['body'] as Json;
  body['children'] = (body['children'] as Json[]).slice(0, 1);
  stage['children'] = [prep];
  content['timeConstraints'] = constraints;
  const parsed = flow.parseMbr(content);
  if (!parsed.ok) throw new Error(`SETUP: the variant does not parse: ${JSON.stringify(parsed.problems.slice(0, 3))}`);
  return parsed.mbr;
}

describe('F66: the issue brings in only the steps the token reaches, with the starts it records (0307, 0312; DI-34, PR-13, DI-27)', () => {
  it('[DI-34][PR-13][INV-18][DI-27][INV-20] an ISSUE row whose initial state also enables the second step, or leaves out the start of the first stage, is refused, and no batch is issued; the honest issue is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const firstRun = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const run = await runContext(sbx.db.admin, firstRun);
    const who = personaIn(sbx, 'issuer');
    /** Issues a batch of the same package as the issuer, with the engine's initial state changed by `edit`. */
    const issueWith = async (edit?: (s: engine.BatchState, events: engine.EngineEvent[]) => void): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, issuer, 'issuer'), async (c) => {
          const batchId = randomUUID();
          const begun = await execution.beginIssue(c, batchId);
          const request: engine.IssueRequest = {
            batchId, batchNumber: begun.batchNumber, batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {},
            inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'mutation kill test' } },
            issuedBy: { id: who.personId, kind: 'PERSON', roles: [] },
          };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          edit?.(r.state, r.events);
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: engine.encode(request), policy: execution.pinnedPolicy(run.def.policy),
            registryFingerprint: run.def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events: r.events,
            contents: engine.changedContents(run.def, undefined, r.state),
          });
        }),
      );
    const batches = async (): Promise<string> => (await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution')).rows[0]?.n ?? '';
    const issued = await batches();
    // The balance check enabled at the issue beside the clearance, told as the token advance tells an arrival.
    const early = await issueWith((s, events) => {
      const clear = s.steps[CLEAR];
      if (!clear) throw new Error('SETUP: the clearance is not enabled at the issue');
      s.seq += 1;
      s.steps['p-disp-bal@'] = { ...structuredClone(clear), key: 'p-disp-bal@', step: 'p-disp-bal', enabledSeq: s.seq };
      events.push({ type: 'STEP_STATUS_CHANGED', seq: s.seq, at: s.header.issuedAt, stepKey: 'p-disp-bal@', step: 'p-disp-bal', from: 'PENDING', to: 'ENABLED', by: 'SYSTEM', reason: 'token arrived' });
    });
    expect(early).toBe(
      'Step instance p-disp-bal@ is new in the state, but the token cannot have reached it: p-disp-clear comes before it and has not been left: step p-disp-clear@ is enabled. A step comes only after the steps before it (DI-34, PR-13). [EBMR-EXE-129]',
    );
    // The start of the dispensing stage left out of the issued state.
    const noStart = await issueWith((s) => {
      expect(s.nodeEvents['S-DISP|START|'], 'SETUP: the issue records the start of the stage').toBeDefined();
      delete s.nodeEvents['S-DISP|START|'];
    });
    expect(noStart).toMatch(/^This issue ISSUE row brings in step p-disp-clear@, which lies in stage S-DISP, but records no START event of that stage \(S-DISP\|START\|\): .*\(DI-27, INV-20, DI-34\)\. \[EBMR-EXE-133\]$/);
    expect(await batches(), 'nothing was issued').toBe(issued);
    expect(await issueWith()).toBe('ok');
    expect(await batches()).toBe(String(Number(issued) + 1));
  }, 300_000);
});

describe('F67: a hold point is released only with no open exception (0308 recipe.execution_step_acts_check; PR-45, IN-37, PR-08)', () => {
  it('[PR-45][IN-37][PR-08] the honest release of a hold point with no exception open is recorded', async () => {
    const d = await newRun(withEarlyHoldPoint(), ['operator1', 'verifier1', 'qa1']);
    await clearance(d);
    expect((await stateOf(d)).steps[HOLD]?.status).toBe('ENABLED');
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: HOLD, disposition: 'APPROVED' });
    const s = await stateOf(d);
    expect(s.steps[HOLD]?.status).toBe('COMPLETED');
    expect(s.steps['p-disp-bal@']?.status).toBe('ENABLED');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[PR-45][IN-37][PR-08][PR-13] while an operator\'s ACTION exception is open: the clearance\'s own entries are recorded, a release stored with the engine result computed as if it were closed is refused, and QA\'s decision not to release is recorded', async () => {
    const d = await newRun(withEarlyHoldPoint(), ['operator1', 'verifier1', 'qa1']);
    let ex = '';
    // The exception raised on the clearance while it is in progress; its own entries, signature and check follow.
    await clearance(d, async () => void (ex = await actionException(d, CLEAR, 'Booth door found open during the clearance')));
    let s = await stateOf(d);
    expect(s.steps[HOLD]?.status, 'SETUP: the hold point is reached').toBe('ENABLED');
    expect(s.exceptions[ex]?.status).toBe('OPEN');
    // qa1's release, signed through the kernel on the decision it proposed, stored with the engine result of a state in
    // which the exception were an alert (the engine refuses the release: ENG-HOLD-OPEN-EXCEPTIONS).
    const run = await runContext(sbx.db.admin, d.runId);
    const qa = personaIn(sbx, 'qa1');
    const p = await releaseSignature(d);
    let verdict = '';
    const forged = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'DISPOSITION_HOLD_POINT', commandId: randomUUID(), actor: engineActor(qa.personId, roles), step: 'H-TEST', context: [], disposition: 'APPROVED', signature: { id, meaning: 'HOLD_POINT_RELEASED', signer: qa.personId } };
        const honest = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        verdict = honest.accepted ? 'accepted' : (honest.refusal?.code ?? 'refused');
        const doctored = structuredClone(tx.state);
        const x = doctored.exceptions[ex];
        if (x) x.severity = 'ALERT';
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored release: ${JSON.stringify(r.refusal)}`);
        r.state.exceptions[ex] = structuredClone(tx.state.exceptions[ex] as engine.ExceptionRecord);
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(verdict).toBe('ENG-HOLD-OPEN-EXCEPTIONS');
    expect(forged).toMatch(new RegExp(`^This DISPOSITION_HOLD_POINT row is refused: hold point H-TEST@ cannot be released while required results are failing or open exceptions have no QA decision: ${ex} .*Booth door found open during the clearance \\(PR-45, IN-37, PR-08\\)\\. \\[EBMR-EXE-131\\]$`));
    s = await stateOf(d);
    expect(s.steps[HOLD]?.status, 'nothing was released').toBe('ENABLED');
    expect(s.steps[HOLD]?.disposition).toBeUndefined();
    // QA's decision not to release, while the exception is open: recorded (it releases nothing).
    await d.signed('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: HOLD, disposition: 'NOT_APPROVED', comment: 'Booth not released until the open door is investigated' });
    s = await stateOf(d);
    expect(s.steps[HOLD]?.disposition?.value).toBe('NOT_APPROVED');
    expect(s.steps[HOLD]?.status).toBe('ENABLED');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);
});

describe('F67: blocks hold at completion and are not asked of a step that does not complete (0308; PR-08, PR-13, INV-20)', () => {
  it('[PR-08][PR-13][PR-14] two persons\' entries on a blocked step: the first PERFORMED signature, which leaves it in progress, is recorded; a VERIFY stored as if the step were not blocked is refused; the verification the engine refuses as blocked is recorded as that refusal', async () => {
    // The blend time is recorded first (in range), then the clearance: operator1 and operator2 (on the dispensing
    // kiosk) each record an entry.
    const d = await newRun(withEarlyParameter(), ['operator1', ['operator2', 'TEST-KIOSK-DISP-1'], 'verifier1', 'supervisor1']);
    const EARLY = 'p-early-time@';
    await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: CHECKLIST });
    await d.ok('operator2', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: PREVIOUS });
    // An ACTION exception on the finished blend-time step blocks the clearance, which comes after it.
    const first = await actionException(d, EARLY, 'Blend timer found reset after the step');
    // operator1's PERFORMED signature: operator2 has not signed for their entry, so the step stays in progress and
    // completes nothing (the engine checks the block only when the step completes).
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    let s = await stateOf(d);
    expect(s.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    expect(s.steps[CLEAR]?.performedSigners).toEqual([personaIn(sbx, 'operator1').personId]);
    // The deviation linked, operator2 signs: the clearance awaits its check. A second exception blocks it again.
    await d.ok('supervisor1', { type: 'ATTACH_DEVIATION', exception: first, deviationRef: 'TEST-DEV-0201' });
    await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    expect((await stateOf(d)).steps[CLEAR]?.status).toBe('AWAITING_VERIFICATION');
    const second = await actionException(d, EARLY, 'Blend timer reset again');
    // verifier1's check, stored with the engine result of a state without the block (the engine refuses: ENG-BLOCKED).
    const run = await runContext(sbx.db.admin, d.runId);
    const ver = personaIn(sbx, 'verifier1');
    const meaning = (await d.signing('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).meaning;
    expect(meaning, 'SETUP: the meaning of the clearance\'s check').not.toBe('');
    const p = await prepareSignature(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', `${d.runId}:${CLEAR}`, meaning);
    let verdict = '';
    const forged = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(ver.personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning, signer: ver.personId } };
        const honest = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        verdict = honest.accepted ? 'accepted' : (honest.refusal?.code ?? 'refused');
        const doctored = structuredClone(tx.state);
        const x = doctored.exceptions[second];
        if (x) delete (x as { block?: unknown }).block;
        const r = engine.step(tx.def, doctored, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the engine refused the doctored check: ${JSON.stringify(r.refusal)}`);
        r.state.exceptions[second] = structuredClone(tx.state.exceptions[second] as engine.ExceptionRecord);
        expect(r.state.nodeEvents, 'SETUP: the check records no start or end').toEqual(tx.state.nodeEvents);
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(verdict).toBe('ENG-BLOCKED');
    expect(forged).toMatch(new RegExp(`^This VERIFY row is refused: step p-disp-clear@ cannot complete while these exceptions are unresolved: ${second} .*Blend timer reset again \\(needs a linked deviation\\); a blocked step waits for its deviation or QA decision \\(PR-08, PR-13, INV-20\\)\\. \\[EBMR-EXE-131\\]$`));
    expect((await stateOf(d)).steps[CLEAR]?.status, 'nothing was verified').toBe('AWAITING_VERIFICATION');
    // The honest check: the engine refuses it as blocked, and the refusal is recorded as such (a refused row is not
    // judged as an act).
    const before = (await rowsOf(sbx, d.runId)).length;
    expect(outcomeOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result)).toMatch(/ENG-BLOCKED/);
    const rows = await rowsOf(sbx, d.runId);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ kind: 'COMMAND', command_type: 'VERIFY', accepted: false, refusal: { code: 'ENG-BLOCKED' } });
    s = await stateOf(d);
    expect(s.steps[CLEAR]?.status).toBe('AWAITING_VERIFICATION');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);
});

describe('F67 and F01: a stage sign-off keeps its minimum and records the summary its signature covers (0308, 0320; INV-20, PR-30, DI-37, IN-15, PR-16)', () => {
  it('[INV-20][PR-30][IN-15] a stage signed off before a minimum ending at its end is refused by the database, not only by the engine', async () => {
    const TC = 'TC-DISP-SETTLE';
    const d = await newRun(
      clearanceStage([{ id: TC, name: 'Dispensing booth settling', kind: 'PROCESS_WINDOW', from: { node: 'p-disp-clear', event: 'START' }, to: { node: 'S-DISP', event: 'END' }, min: { value: '8', unit: 'h' }, source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED' }]),
      ['operator1', 'verifier1', 'supervisor1'],
    );
    await clearance(d);
    expect((await stateOf(d)).stages['S-DISP@']?.awaitingSignOff, 'SETUP: the stage awaits its sign-off').toBe(true);
    expect(outcomeOf((await d.sign('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' })).result)).toMatch(/ENG-MIN-DURATION/);
    // supervisor1's sign-off through the store, with the engine result of the definition without the minimum.
    const run = await runContext(sbx.db.admin, d.runId);
    const sup = personaIn(sbx, 'supervisor1');
    const p = await prepareSignature(sbx, d.browser('supervisor1'), 'supervisor1', 'batch_stage', `${d.runId}:S-DISP@`, 'STAGE_SIGNED_OFF');
    const forged = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'SIGN_OFF_STAGE', commandId: randomUUID(), actor: engineActor(sup.personId, roles), stage: 'S-DISP', context: [], signature: { id, meaning: 'STAGE_SIGNED_OFF', signer: sup.personId } };
        const lax: engine.BatchDefinition = {
          ...tx.def,
          constraints: tx.def.constraints.map((rc) => {
            if (rc.tc.id !== TC) return rc;
            const tc = { ...rc.tc };
            delete tc.min;
            return { ...rc, tc };
          }),
        };
        const r = engine.step(lax, tx.state, command, { nowUs: tx.nowUs });
        if (!r.accepted) throw new Error(`SETUP: the definition without the minimum refused the sign-off: ${JSON.stringify(r.refusal)}`);
        return appendAs(tx, command, r, roles);
      }),
    );
    expect(forged).toMatch(/^The end of S-DISP@ comes \d+(\.\d+)? (s|min) after the start of p-disp-clear, before the minimum of 8 h of Dispensing booth settling: no step starts or completes before its minimum duration \(INV-20, PR-30\)\. \[EBMR-EXE-130\]$/);
    const s = await stateOf(d);
    expect(s.stages['S-DISP@']?.signOff).toBeUndefined();
    expect(s.nodeEvents['S-DISP|END|']).toBeUndefined();
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);

  it('[DI-37][IN-15][PR-16] a refused sign-off is recorded as the refusal it is; a sign-off recording another statement, stage or start than the summary its signature covers is refused (EBMR-EXE-135); the engine\'s own is accepted', async () => {
    const d = await newRun(clearanceStage(), ['operator1', 'verifier1', 'supervisor1']);
    // While the clearance is in progress: the engine refuses supervisor1's sign-off, and the store records the refusal
    // (as the server does for a refused signing, with the placeholder signature).
    const run = await runContext(sbx.db.admin, d.runId);
    const sup = personaIn(sbx, 'supervisor1');
    await clearance(d, async () => {
      let refusal = '';
      const refused = await messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('supervisor1'), 'supervisor1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'SIGN_OFF_STAGE', commandId: randomUUID(), actor: engineActor(sup.personId, roles), stage: 'S-DISP', context: [], signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'STAGE_SIGNED_OFF', signer: sup.personId } };
          refusal = (await tx.command(command, roles)).refusal?.code ?? 'accepted';
        }),
      );
      expect({ refused, refusal }).toEqual({ refused: 'ok', refusal: 'ENG-STAGE-NOT-READY' });
      expect((await rowsOf(sbx, d.runId)).at(-1)).toMatchObject({ kind: 'COMMAND', command_type: 'SIGN_OFF_STAGE', accepted: false, refusal: { code: 'ENG-STAGE-NOT-READY' } });
    });
    const s0 = await stateOf(d);
    expect(s0.stages['S-DISP@']?.awaitingSignOff, 'SETUP: the stage awaits its sign-off').toBe(true);
    const outcomes: Record<string, string> = {
      statement: await signOffStageThroughStore(sbx, d, 'S-DISP', (s) => void (s.statement = s.statement === 'COMPLETED_PER_MBR' ? 'COMPLETED_WITH_DEVIATIONS' : 'COMPLETED_PER_MBR')),
      stage: await signOffStageThroughStore(sbx, d, 'S-DISP', (s) => void (s.stage = 'S-BLEND')),
      startedAt: await signOffStageThroughStore(sbx, d, 'S-DISP', (s) => void (s.startedAt = s.startedAt + 1n)),
    };
    const summary = /^The sign-off of stage S-DISP@ records the summary .*, but the summary of the stage as signed is .*\(DI-37, IN-15, PR-16\)\. \[EBMR-EXE-135\]$/;
    expect(unmatched(outcomes, { statement: summary, stage: summary, startedAt: summary })).toEqual({});
    expect((await stateOf(d)).stages['S-DISP@']?.signOff, 'nothing was signed off').toBeUndefined();
    expect(await signOffStageThroughStore(sbx, d, 'S-DISP')).toBe('ok');
    expect((await stateOf(d)).stages['S-DISP@']?.signOff?.summary.stage).toBe('S-DISP');
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
  }, 300_000);
});
