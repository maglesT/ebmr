/**
 * Who was involved in the step that raised an exception, read from the stored rows of the batch itself, and what the
 * invariant query reports over those rows (SQL mutation group "involvement-and-independence": recipe-core 0306, 0310,
 * 0315, 0327). These tests close the gaps the SQL mutation run (tools/sql-mutation) left in the group's tests:
 *   - recipe.recorded_involvement (0310): the persons of the accepted rows on a step instance are those of its own
 *     starts, data, entries and PERFORMED signatures and of the corrections of its data points (by whoever made them),
 *     only before the row asked about, and never of another step (INV-03, PR-13, PR-49);
 *   - recipe.exception_raising_steps (0327): the steps an exception was raised at are read from the EXCEPTION_RAISED
 *     events of that exception, in that batch: neither another exception's raising row nor another batch's exception of
 *     the same id counts (INV-03, PR-13, PR-49);
 *   - recipe.execution_disposition_involvement_check (0315): the disposition trigger reads the stored state of the
 *     disposition's own batch, where a correction's data point says which step it corrected (EBMR-EXE-087);
 *   - recipe.execution_rule_violations (0327): involvement after the disposition is no violation, the disposition row
 *     itself is not "before" it, and the step-order (DI-34, PR-13) and minimum-duration (INV-20, PR-30) arms read the
 *     stored steps and node events;
 *   - recipe.execution_violations (0306): each fact of the projection, a gap in the row numbers, a batch without rows and
 *     a content version that no longer matches its hash is reported on its own (DI-34, DI-37).
 *
 * The private functions are called as the database superuser on rows the store wrote through the application role
 * (ebmr_sandbox here; ADR 0012), as db-guards-disposition-involvement.test.ts does; what "lands behind the triggers'
 * back" is written by the superuser with session_replication_role = replica (a restore or a hand edit).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, identity, toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, type engine, type flow } from '@ebmr/recipe-core';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, prepareSignature } from '../execution/db-guards-support.ts';
import { asPersonaInRole, dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from '../execution/support.ts';

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
const EARLY = 'p-early-time@';
const JUSTIFICATION = 'Door closed, booth re-checked; no impact.';

/**
 * dc-mini with the blend time keyed by hand in a first step (p-early-time). The blend time is NON_CRITICAL here, so a
 * correction of it needs no approval.
 */
const withEarlyTime = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    for (const x of content['parameters'] as Json[]) if (x['id'] === 'blendTime') x['criticality'] = 'NON_CRITICAL';
    return [{ ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [] }, ...prep];
  });

/** dc-mini with a 1 h minimum (and an 8 h maximum) from the clearance's START to its END. */
const withClearanceMinimum = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    (content['timeConstraints'] as Json[]).push({
      id: 'TC-CLEAR-MIN', name: 'Booth clearance settling time', kind: 'PROCESS_WINDOW',
      from: { node: 'p-disp-clear', event: 'START' }, to: { node: 'p-disp-clear', event: 'END' },
      min: { value: '1', unit: 'h' }, max: { value: '8', unit: 'h' },
      source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED',
    });
    return prep;
  });

const granted = new Map<ExecServer, Promise<void>>();
/** operator1 also holds QA_SHOP_FLOOR in `server`'s database (requested by the administrator, approved by the owner; once). */
function operatorAlsoQa(server: ExecServer): Promise<void> {
  let p = granted.get(server);
  if (!p) {
    p = (async () => {
      const who = personaIn(server, 'operator1');
      const reason = { reasonCode: 'TEST_SETUP', reasonText: 'INV-03: operator1 also holds QA_SHOP_FLOOR' };
      const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, { ...reason, correlationId: randomUUID() });
      const grantId = await withCommand(server.db.app, admin, (c) => identity.requestRoleGrant(c, { accountId: who.accountId, roleCode: 'QA_SHOP_FLOOR', scope: {}, reason: reason.reasonText }));
      const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint, { ...reason, correlationId: randomUUID() });
      await withCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, grantId, true, 'INV-03 set-up'));
    })();
    granted.set(server, p);
  }
  return p;
}

/** A new run of `content` in `server`, driven by the personas named (operator2 on the dispensing kiosk). */
async function newRun(server: ExecServer, content: flow.MbrContent, personas: readonly string[]): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await server.asPersona(p, p === 'operator2' ? 'TEST-KIOSK-DISP-1' : undefined);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** Runs `sql` as the superuser with the row triggers off (a restore or a hand edit). */
async function landByHand(server: ExecServer, sql: string, params: unknown[]): Promise<void> {
  const admin = await server.db.admin.connect();
  try {
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(sql, params);
    await admin.query('commit');
  } catch (e) {
    await admin.query('rollback');
    throw e;
  } finally {
    admin.release();
  }
}

/** recipe.recorded_involvement of a run's step instance `key` over its stored points, before row `before` (every row when null). */
async function recordedInvolvement(runId: string, key: string, before: string | null): Promise<string[]> {
  const { rows } = await sbx.db.admin.query<{ r: string[] }>(
    'select recipe.recorded_involvement($1::uuid, s.state -> \'points\', $2, $3::bigint) as r from recipe.execution_state s where s.batch_id = $1::uuid',
    [runId, key, before],
  );
  return rows[0]?.r ?? [];
}

/** recipe.exception_raising_steps of exception `exception` of a run, over its stored state. */
async function raisingSteps(runId: string, exception: string): Promise<string[]> {
  const { rows } = await sbx.db.admin.query<{ s: string[] }>(
    'select recipe.exception_raising_steps($1::uuid, s.state, $2) as s from recipe.execution_state s where s.batch_id = $1::uuid',
    [runId, exception],
  );
  return rows[0]?.s ?? [];
}

/** The persons the signed content of an exception names as having entered it (the kernel excludes them, EBMR-ESIG-044). */
async function enteredBy(runId: string, exception: string, server: ExecServer = sbx): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ c: { entered_by: string[] } }>('select recipe.batch_exception_content($1) as c', [`${runId}:${exception}`]);
  return [...(rows[0]?.c.entered_by ?? [])].sort();
}

/** The seq of the accepted rows of a run with command type `type`, in order. */
async function seqsOf(server: ExecServer, runId: string, type: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ seq: string }>("select seq::text as seq from recipe.execution_command where batch_id = $1 and command_type = $2 and kind = 'COMMAND' and accepted order by seq", [runId, type]);
  return rows.map((r) => r.seq);
}

/** The exceptions of a run's stored state, newest last. */
async function exceptionsOf(server: ExecServer, runId: string): Promise<engine.BatchState['exceptions'][string][]> {
  return Object.values((await execution.loadState(server.db.admin, runId))?.state.exceptions ?? {}).sort((a, b) => a.raisedSeq - b.raisedSeq);
}

/** The id of the valid blend-time data point of a run. */
async function blendTimePoint(server: ExecServer, runId: string): Promise<string> {
  const p = Object.values((await execution.loadState(server.db.admin, runId))?.state.points ?? {}).find((x) => x.item === 'blendTime' && x.status === 'VALID');
  if (!p) throw new Error('SETUP: no blend time recorded');
  return p.id;
}

/** `persona` corrects the blend time of run `d` to `value` min through the store, with the engine's own result. */
async function correctBlendTime(server: ExecServer, d: RunDriver, persona: string, value: string): Promise<void> {
  const point = await blendTimePoint(server, d.runId);
  const who = personaIn(server, persona);
  const run = await runContext(server.db.admin, d.runId);
  const p = await prepareSignature(server, d.browser(persona), persona, 'batch_point', `${d.runId}:${point}`, 'CORRECTED');
  await withCommand(server.db.app, await p.actor(), async (c) => {
    const id = await p.sign(c);
    const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
    const roles = await engineRoles(c);
    const command: engine.Command = {
      type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(who.personId, roles), point,
      value: { kind: 'DECIMAL', value, unit: 'min' }, reason: `Transcription error: the timer read ${value} min`, signature: { id, meaning: 'CORRECTED', signer: who.personId },
    };
    const r = await tx.command(command, roles);
    if (!r.accepted) throw new Error(`SETUP: the engine refused the correction: ${JSON.stringify(r.refusal)}`);
  });
}

describe('recipe.recorded_involvement: the accepted rows of a step instance (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49][DI-17] a step instance\'s recorded involvement is the persons of its own starts, data and PERFORMED signatures and of the corrections of its data points, only before the row asked about; another step\'s rows and corrections never count', async () => {
    const d = await newRun(sbx, withEarlyTime(), ['operator1', 'operator2', 'supervisor1', 'verifier1']);
    const operator1 = personaIn(sbx, 'operator1').personId;
    const operator2 = personaIn(sbx, 'operator2').personId;
    const supervisor1 = personaIn(sbx, 'supervisor1').personId;
    // operator2 keys the blend time and signs the step performed, verifier1 verifies it; supervisor1 raises an exception
    // at the clearance before anyone works in it; then operator1 corrects the blend time (operator1's only act).
    await d.ok('operator2', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator2', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.signed('operator2', { type: 'SIGN_PERFORMED', stepKey: EARLY });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' });
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    await correctBlendTime(sbx, d, 'operator1', '17');
    const [correction] = await seqsOf(sbx, d.runId, 'CORRECT_ENTRY');
    if (!correction) throw new Error('SETUP: no correction row');
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.steps[EARLY]?.correctors, 'SETUP: operator1 corrected the blend time').toEqual([operator1]);
    expect(stored?.state.steps[EARLY]?.performers, 'SETUP: operator1 did nothing else in the step').toEqual([operator2]);

    expect({
      early: await recordedInvolvement(d.runId, EARLY, null),
      earlyBeforeTheCorrection: await recordedInvolvement(d.runId, EARLY, correction),
      earlyAfterTheCorrection: await recordedInvolvement(d.runId, EARLY, String(BigInt(correction) + 1n)),
      clearance: await recordedInvolvement(d.runId, CLEAR, null),
    }).toEqual({
      early: [operator1, operator2].sort(),
      earlyBeforeTheCorrection: [operator2],
      earlyAfterTheCorrection: [operator1, operator2].sort(),
      clearance: [],
    });
    // The signed content of the exception raised at the clearance names its raiser alone: neither the blend time's
    // performer nor its corrector worked in the clearance.
    const exception = (await exceptionsOf(sbx, d.runId)).find((x) => x.source.stepKey === CLEAR)?.id ?? '';
    expect(await enteredBy(d.runId, exception)).toEqual([supervisor1]);
  }, 300_000);
});

describe('recipe.exception_raising_steps: the rows that raised this exception, in this batch (INV-03, PR-13, PR-49)', () => {
  it('[INV-03][PR-13][PR-49] an exception raised at no step has no raising step and its signed content names its raiser alone, although another exception of the same batch, and an exception of the same id in another batch, were raised at the clearance someone worked in', async () => {
    const operator1 = personaIn(sbx, 'operator1').personId;
    const supervisor1 = personaIn(sbx, 'supervisor1').personId;
    // Batch X: operator1 starts the clearance; supervisor1 raises EX-1 at it and EX-2 at no step.
    const x = await newRun(sbx, dcMini(), ['operator1', 'supervisor1']);
    await x.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await x.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar during clearance', severity: 'ALERT' });
    await x.ok('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    // Batch Y: operator1 starts the clearance; supervisor1 raises EX-1 at no step.
    const y = await newRun(sbx, dcMini(), ['operator1', 'supervisor1']);
    await y.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await y.ok('supervisor1', { type: 'RAISE_EXCEPTION', description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const ids = async (d: RunDriver) => (await exceptionsOf(sbx, d.runId)).map((e) => [e.id, e.source.stepKey ?? null]);
    expect(await ids(x), 'SETUP').toEqual([['EX-1', CLEAR], ['EX-2', null]]);
    expect(await ids(y), 'SETUP').toEqual([['EX-1', null]]);

    expect({
      xAtTheClearance: await raisingSteps(x.runId, 'EX-1'),
      xAtNoStep: await raisingSteps(x.runId, 'EX-2'),
      yAtNoStep: await raisingSteps(y.runId, 'EX-1'),
    }).toEqual({ xAtTheClearance: [CLEAR], xAtNoStep: [], yAtNoStep: [] });
    expect({
      xAtTheClearance: await enteredBy(x.runId, 'EX-1'),
      xAtNoStep: await enteredBy(x.runId, 'EX-2'),
      yAtNoStep: await enteredBy(y.runId, 'EX-1'),
    }).toEqual({ xAtTheClearance: [operator1, supervisor1].sort(), xAtNoStep: [supervisor1], yAtNoStep: [supervisor1] });
  }, 300_000);
});

describe('the disposition trigger reads its own batch\'s stored state (INV-03, PR-13, PR-49; EBMR-EXE-087)', () => {
  // A database of its own: the run under test and one other test batch, issued and untouched, so the stored state the
  // trigger must not read is known.
  let own: ExecServer;
  beforeAll(async () => {
    own = await startExecServer();
  }, 180_000);
  afterAll(async () => {
    await own?.close();
  });

  it('[INV-03][PR-13][PR-49][DI-17] a disposition signed before its signer corrected a value of the raising step, then stored after that correction in the same transaction with the corrector left out of the step\'s lists and events, is refused by the store: the stored state of that batch says which step the corrected point belongs to', async () => {
    await operatorAlsoQa(own);
    const issuer = await own.asPersona('issuer');
    const pkg = writePackage(own, withEarlyTime());
    const other = await importAndIssue(own, issuer, pkg);
    const runId = await importAndIssue(own, issuer, pkg);
    const d = new RunDriver(own, runId, { issuer, operator1: await own.asPersona('operator1'), operator2: await own.asPersona('operator2', 'TEST-KIOSK-DISP-1'), supervisor1: await own.asPersona('supervisor1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    const who = personaIn(own, 'operator1').personId;
    await d.ok('operator2', { type: 'START_STEP', stepKey: EARLY });
    await d.ok('operator2', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '16', unit: 'min' }, source: { mode: 'MANUAL' } });
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: EARLY, description: 'Timer display flickered while the blend time was keyed', severity: 'ALERT' });
    const [exception] = (await exceptionsOf(own, runId)).map((x) => x.id);
    if (!exception) throw new Error('SETUP: no exception');
    const point = await blendTimePoint(own, runId);
    const { rows: batches } = await own.db.admin.query<{ id: string }>('select batch_id::text as id from recipe.execution_state order by 1');
    expect(batches.map((r) => r.id), 'SETUP: two test batches, the other untouched').toEqual([other, runId].sort());

    // operator1, holding QA_SHOP_FLOOR, proposes NO_IMPACT and prepares the disposition's signature; as an operator it
    // prepares a CORRECTED signature on the blend time.
    const agg = `${runId}:${exception}`;
    const asQa = async (extra: Partial<ActorContext> = {}): Promise<ActorContext> => ({ ...(await actorOf(own, d.browser('operator1'), 'operator1')), roleCode: 'QA_SHOP_FLOOR', ...extra });
    await withCommand(own.db.app, await asQa(), (c) => execution.proposeDisposition(c, runId, exception, { outcome: 'NO_IMPACT', justification: JUSTIFICATION, deviationRef: null }));
    const content = await esig.contentForSigning(own.db.admin, 'batch_exception', agg);
    expect(await enteredBy(runId, exception, own), 'SETUP: operator1 is not involved yet').toEqual([personaIn(own, 'operator2').personId, personaIn(own, 'supervisor1').personId].sort());
    const challenge = await withCommand(own.db.app, await asQa(), (c) =>
      esig.createChallenge(c, { aggregateType: 'batch_exception', aggregateId: agg, contentVersion: content.contentVersion ?? '', meaning: 'EXCEPTION_DISPOSITIONED', clientContentHash: content.contentHash ?? '' }),
    );
    const persona = personaIn(own, 'operator1');
    const ev = await identity.authenticate(own.db.authn, {
      method: 'BADGE_PIN', identifier: persona.badgeUid ?? '', secret: persona.pin ?? '', deviceFingerprint: terminalOf(own.seed, d.browser('operator1').terminal).fingerprint,
      purpose: 'SIGNATURE', challengeId: challenge.challengeId,
    });
    const sealKey = own.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: no seal key');
    const qa = await asQa({ authEventId: ev.authEventId });
    const corrected = await prepareSignature(own, d.browser('operator1'), 'operator1', 'batch_point', `${runId}:${point}`, 'CORRECTED');
    const operator = await corrected.actor();
    const install = (c: pg.PoolClient, ctx: ActorContext) => c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
    const run = await runContext(own.db.admin, runId);

    const outcome = await messageOf(
      withCommand(own.db.app, qa, async (c) => {
        // Signed while operator1 is not involved: the kernel lets it through.
        const signatureId = (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId;
        // operator1 then corrects the blend time as an operator, the correction stored without operator1 in the step's
        // lists and without its INVOLVEMENT event.
        await install(c, operator);
        const id = await corrected.sign(c);
        const corr = await execution.ExecutionTx.open(c, run.def, runId);
        const roles = await engineRoles(c);
        const correction: engine.Command = {
          type: 'CORRECT_ENTRY', commandId: randomUUID(), actor: engineActor(who, roles), point,
          value: { kind: 'DECIMAL', value: '17', unit: 'min' }, reason: 'Transcription error: the timer read 17 min', signature: { id, meaning: 'CORRECTED', signer: who },
        };
        const r = engineResult(corr, correction);
        const state = structuredClone(r.state);
        const inst = state.steps[EARLY];
        if (!inst) throw new Error('SETUP: no blend-time step');
        for (const list of ['performers', 'dataEnterers', 'correctors', 'performedSigners'] as const) inst[list] = inst[list].filter((p) => p !== who);
        await appendAs(corr, correction, { state, events: r.events.filter((e) => e.type !== 'INVOLVEMENT') }, roles);
        // Back as QA: the signed disposition, with the engine's own result on the stored state (which no longer
        // names operator1 in the step).
        await install(c, qa);
        const tx = await execution.ExecutionTx.open(c, run.def, runId);
        const qaRoles = await engineRoles(c);
        const disposition: engine.Command = {
          type: 'DISPOSITION_EXCEPTION', commandId: randomUUID(), actor: engineActor(who, qaRoles), exception, outcome: 'NO_IMPACT', justification: JUSTIFICATION,
          signature: { id: signatureId, meaning: 'EXCEPTION_DISPOSITIONED', signer: who },
        };
        return appendAs(tx, disposition, engineResult(tx, disposition), qaRoles);
      }),
    );
    expect(outcome).toBe(
      `${who} started, entered data in, corrected or signed performed step ${EARLY}, which raised exception ${exception}, as the accepted commands recorded on that step show, so the disposition is refused: an exception is decided by a person outside the work that raised it (INV-03, PR-13, PR-49). [EBMR-EXE-087]`,
    );
    // The whole transaction was rolled back: the exception is open, the blend time uncorrected, nothing signed.
    const after = await execution.loadState(own.db.admin, runId);
    expect(after?.state.exceptions[exception]?.status).toBe('OPEN');
    expect(Object.values(after?.state.points ?? {}).map((p) => [p.id, p.status])).toEqual([[point, 'VALID']]);
    const { rows: sigs } = await own.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [agg]);
    expect(sigs[0]?.n).toBe('0');
  }, 300_000);
});

describe('recipe.execution_rule_violations: what the invariant query reports over the stored rows', () => {
  it('[INV-03][PR-13][PR-49] involvement in the raising step after the disposition is no violation, nor an INVOLVEMENT the disposition row itself records (only rows before it count); that tampered row is reported as such (DI-34)', async () => {
    await operatorAlsoQa(sbx);
    const d = await newRun(sbx, dcMini(), ['supervisor1']);
    const operator1 = personaIn(sbx, 'operator1').personId;
    // The exception is raised at the clearance while nobody has worked in it; operator1, acting as QA, dispositions it
    // through the server's ceremony, then starts the clearance and records an entry in it as an operator.
    await d.ok('supervisor1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found ajar before clearance', severity: 'ALERT' });
    const [exception] = (await exceptionsOf(sbx, d.runId)).map((x) => x.id);
    if (!exception) throw new Error('SETUP: no exception');
    const qa = new RunDriver(sbx, d.runId, { operator1: await asPersonaInRole(sbx, 'operator1', 'QA_SHOP_FLOOR') });
    qa.beforeTap = d.beforeTap;
    const r = await qa.sign('operator1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: JUSTIFICATION });
    expect(outcomeOf(r.result), r.result.ok ? '' : JSON.stringify(r.result.error)).toBe('ok');
    const op = new RunDriver(sbx, d.runId, { operator1: await sbx.asPersona('operator1') });
    op.beforeTap = d.beforeTap;
    await op.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await op.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'NONE', batchNumber: 'TEST-B26-0001' } });
    const stored = await execution.loadState(sbx.db.admin, d.runId);
    expect(stored?.state.exceptions[exception]?.disposition?.by, 'SETUP').toBe(operator1);
    expect(stored?.state.steps[CLEAR]?.performers, 'SETUP').toEqual([operator1]);
    const ofRun = async () => (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(await ofRun()).toEqual([]);

    // A hand edit puts an INVOLVEMENT of operator1 in the clearance into the disposition row itself.
    const [disposition] = await seqsOf(sbx, d.runId, 'DISPOSITION_EXCEPTION');
    if (!disposition) throw new Error('SETUP: no disposition row');
    await landByHand(
      sbx,
      `insert into recipe.execution_event (batch_id, row_seq, idx, event_type, event)
       select $1, $2::bigint, coalesce(max(idx), -1) + 1, 'INVOLVEMENT', jsonb_build_object('type', 'INVOLVEMENT', 'stepKey', $3::text, 'person', $4::text, 'involvement', 'STARTED')
         from recipe.execution_event where batch_id = $1 and row_seq = $2::bigint`,
      [d.runId, disposition, CLEAR, operator1],
    );
    expect(await ofRun()).toEqual([`row ${disposition}: the stored events do not match the events hash (DI-34)`]);
  }, 300_000);

  it('[DI-34][PR-13] a step instance that came before the steps before it, landed behind the triggers\' back, is reported by the step-order arm, with the stored state that is no longer its last row\'s', async () => {
    const d = await newRun(sbx, dcMini(), ['operator1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    await landByHand(
      sbx,
      `update recipe.execution_state
          set state = jsonb_set(state, '{steps,p-disp-pcm@}', jsonb_build_object(
                'key', 'p-disp-pcm@', 'step', 'p-disp-pcm', 'kind', 'PHASE', 'frames', '[]'::jsonb, 'status', 'ENABLED',
                'performers', '[]'::jsonb, 'dataEnterers', '[]'::jsonb, 'correctors', '[]'::jsonb, 'performedSigners', '[]'::jsonb,
                'signatures', '[]'::jsonb, 'verificationRequired', false, 'reverification', false, 'targets', '{}'::jsonb,
                'blockComputed', '{}'::jsonb, 'enabledSeq', (state ->> 'seq')::int))
        where batch_id = $1`,
      [d.runId],
    );
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem)).toEqual([
      'the stored state is not the state of the last row (DI-34)',
      'step instance p-disp-pcm@: O-DISP-PREP comes before it and has not been left: step p-disp-clear@ is in progress (DI-34, PR-13)',
    ]);
  }, 300_000);

  it('[INV-20][PR-30] an end before its minimum, landed behind the triggers\' back, is reported by the minimum-duration arm: the end is a node event the earlier ones do not hold', async () => {
    const d = await newRun(sbx, withClearanceMinimum(), ['operator1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId)).toEqual([]);
    await landByHand(
      sbx,
      `update recipe.execution_state
          set state = jsonb_set(state, '{nodeEvents,p-disp-clear|END|}', jsonb_build_object(
                'node', 'p-disp-clear', 'event', 'END', 'frames', '[]'::jsonb,
                'at', jsonb_build_object('$u', ((state -> 'nodeEvents' -> 'p-disp-clear|START|' -> 'at' ->> '$u')::bigint + 1000000)::text)))
        where batch_id = $1`,
      [d.runId],
    );
    expect((await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem)).toEqual([
      'the stored state is not the state of the last row (DI-34)',
      'the end of p-disp-clear@ comes 1 s after the start of p-disp-clear, before the minimum of 1 h of Booth clearance settling time (INV-20, PR-30)',
    ]);
  }, 300_000);
});

describe('recipe.execution_violations: each fact of the stored rows on its own (DI-34, DI-37)', () => {
  it('[DI-34][DI-37] a projection whose version or last row hash alone differs from its last row, a content version that alone no longer matches its hash, a gap in the row numbers and a batch without rows are each reported', async () => {
    const d = await newRun(sbx, dcMini(), ['operator1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    const ofRun = async () => (await violations(sbx)).filter((v) => v.batchId === d.runId).map((v) => v.problem);
    expect(await ofRun()).toEqual([]);
    const { rows: last } = await sbx.db.admin.query<{ v: number; h: string; n: string }>(
      'select state_version as v, last_row_hash as h, last_seq::text as n from recipe.execution_state where batch_id = $1',
      [d.runId],
    );
    const projection = last[0];
    if (!projection) throw new Error('SETUP: no state');
    const PROJECTION = 'the stored state is not the state of the last row (DI-34)';

    // The projection's version alone.
    await landByHand(sbx, 'update recipe.execution_state set state_version = state_version + 1 where batch_id = $1', [d.runId]);
    const version = await ofRun();
    await landByHand(sbx, 'update recipe.execution_state set state_version = $2 where batch_id = $1', [d.runId, projection.v]);
    // The projection's last row hash alone.
    await landByHand(sbx, 'update recipe.execution_state set last_row_hash = $2 where batch_id = $1', [d.runId, '0'.repeat(64)]);
    const rowHash = await ofRun();
    await landByHand(sbx, 'update recipe.execution_state set last_row_hash = $2 where batch_id = $1', [d.runId, projection.h]);
    // A content version of the clearance changed after it was written (its hash kept).
    const agg = `${d.runId}:${CLEAR}`;
    await landByHand(sbx, `update recipe.execution_step_content set content = content || '{"tampered": true}' where aggregate_id = $1 and content_version = 1`, [agg]);
    const content = await ofRun();
    await landByHand(sbx, `update recipe.execution_step_content set content = content - 'tampered' where aggregate_id = $1 and content_version = 1`, [agg]);
    expect(await ofRun(), 'every hand edit was undone').toEqual([]);
    expect({ version, rowHash, content }).toEqual({
      version: [PROJECTION],
      rowHash: [PROJECTION],
      content: [`signable content of ${agg} is not versioned 1..n or does not match its hash (DI-37)`],
    });

    // A row taken out of the middle of the chain, then every row.
    await landByHand(sbx, 'delete from recipe.execution_command where batch_id = $1 and seq = 2', [d.runId]);
    expect(await ofRun()).toContain(`rows are not numbered 1..n without gaps (${BigInt(projection.n) - 1n} rows, 1..${projection.n}) (DI-34)`);
    await landByHand(sbx, 'delete from recipe.execution_command where batch_id = $1', [d.runId]);
    expect(await ofRun()).toContain('rows are not numbered 1..n without gaps (0 rows, ..) (DI-34)');
  }, 300_000);
});
