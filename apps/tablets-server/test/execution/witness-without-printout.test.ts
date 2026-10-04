/**
 * A critical value typed by hand without the printout its MBR names is witnessed, not reviewed later (lead TODO T12 of
 * the Phase 2 exit; DI-30, PR-14, DI-35; engine 1.4.0, recipe-core 0325; default T12.1).
 *
 * dc-mini's blend time and blender speed are typed by hand, and the MBR names a printout as their evidence; that is why
 * the validator lets their step's second person review them later (VERIFIED) instead of watching the act (WITNESSED,
 * GMP-WITNESS). In this release no hand entry carries an attachment: the server and the database refuse an attachment
 * hash until an attachment store exists (EBMR-EXE-122). So the values were recorded with nothing behind them and the
 * step was completed by a later review of the values alone. Now the step's check is a witness while it holds such a
 * value, in the engine, on the screen, at the challenge and in the database.
 *
 * The run is dc-mini with the blend time recorded first in the dispensing stage (withEarlyParameter: step p-early-time,
 * check VERIFIED by the production verifier, blend time CRITICAL, MANUAL, evidence PRINTOUT).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { resolveClientIntent, signedCommand, signedMeaning } from '../../src/features/execution/intents.ts';
import { dbNowUs } from '../../src/platform/db/commands.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, interceptSigned, messageOf, unmatched } from './db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, valueOf, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const EARLY = 'p-early-time@';

/** The blend time typed by hand (no printout can be attached) and the step signed performed by the operator. */
async function performed(): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, withEarlyParameter()));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
  return d;
}

async function checks(d: RunDriver): Promise<{ status: string | undefined; checks: string[] }> {
  const st = (await execution.loadState(server.db.admin, d.runId))?.state.steps[EARLY];
  return { status: st?.status, checks: (st?.signatures ?? []).filter((s) => s.role === 'CHECKED').map((s) => s.meaning) };
}

/**
 * A verification of the early step recorded as `recorded` by the application role through the execution store, with
 * the engine's result of the same verification signed WITNESSED (the check the engine asks for), so only the database
 * decides. Returns what the database answered and what the step holds.
 */
async function recordVerifyAs(d: RunDriver, recorded: string): Promise<{ stage: string; ok: boolean; refused: string } & Awaited<ReturnType<typeof checks>>> {
  const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
  if (!handler) throw new Error('ENGINE_COMMAND is not registered');
  const saved = { describe: handler.describe.bind(handler), prepareForChallenge: handler.prepareForChallenge.bind(handler), dryRun: handler.dryRun.bind(handler), apply: handler.apply.bind(handler) };
  const own = <T extends object>(ctx: T): T => ({ ...ctx, meaning: 'WITNESSED' });
  let refused = '';
  Object.assign(handler, {
    describe: (a: Parameters<typeof saved.describe>[0]) => ({ ...saved.describe(a), meaning: '' }),
    prepareForChallenge: (client: Parameters<typeof saved.prepareForChallenge>[0], ctx: Parameters<typeof saved.prepareForChallenge>[1], a: Parameters<typeof saved.prepareForChallenge>[2]) => saved.prepareForChallenge(client, own(ctx), a),
    dryRun: (client: Parameters<typeof saved.dryRun>[0], ctx: Parameters<typeof saved.dryRun>[1], a: Parameters<typeof saved.dryRun>[2]) => saved.dryRun(client, own(ctx), a),
    apply: async (client: Parameters<typeof saved.apply>[0], ctx: Parameters<typeof saved.apply>[1], a: Parameters<typeof saved.apply>[2], sig: Parameters<typeof saved.apply>[3]) => {
      if (a.kind !== 'ENGINE_COMMAND') throw new Error('SETUP: not an engine command');
      const run = await runContext(client, a.runId);
      const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
      const roles = await engineRoles(client);
      const cmd = signedCommand(tx.state, { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, engineActor(ctx.actor.personId, roles), { id: sig.signatureId, meaning: sig.meaning, signer: sig.signer }, `ESIG:${sig.signatureId}`, a.expectedVersion);
      if (cmd.type !== 'VERIFY') throw new Error('SETUP: not a VERIFY');
      try {
        await appendAs(tx, cmd, engineResult(tx, { ...cmd, commandId: randomUUID(), signature: { ...cmd.signature, meaning: 'WITNESSED' } }), roles);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
        throw e;
      }
      return null;
    },
  });
  let r;
  try {
    r = await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, { meaning: recorded });
  } finally {
    Object.assign(handler, saved);
  }
  return { stage: r.stage, ok: r.result.ok, refused, ...(await checks(d)) };
}

describe('a critical value typed by hand without the printout its MBR names is witnessed (lead TODO T12)', () => {
  it('[DI-30][PR-14][DI-35] the screen offers a witness, the server asks for WITNESSED also when the intent names VERIFIED, and the step completes with the witness\'s signature', async () => {
    const d = await performed();
    const view = await d.stepView('verifier1', EARLY);
    expect(view.actions.filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS').map((a) => `${a.action}:${a.meaning}`)).toEqual(['WITNESS:WITNESSED']);
    const run = await runContext(server.db.admin, d.runId);
    const state = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(engine.handEntriesWithoutDeclaredEvidence(run.def, state, state?.steps[EARLY])).toEqual(['blendTime']);
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, await dbNowUs(server.db.admin))).toBe('WITNESSED');
    expect(await checks(d)).toEqual({ status: 'AWAITING_VERIFICATION', checks: [] });
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('WITNESSED');
    expect(await checks(d)).toEqual({ status: 'COMPLETED', checks: ['WITNESSED'] });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-30][DI-35][INV-10] the database refuses a later review recorded as VERIFIED on that step (EBMR-EXE-051), nothing is signed, and asks for WITNESSED as the engine does', async () => {
    const d = await performed();
    const { rows: prior } = await server.db.admin.query<{ state: Record<string, unknown> }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
    const { rows: wanted } = await server.db.admin.query<{ m: string[] }>('select recipe.step_check_meanings($1, $2::jsonb, $3::jsonb) as m', [
      d.runId,
      JSON.stringify(prior[0]?.state ?? {}),
      JSON.stringify({ type: 'VERIFY', step: 'p-early-time', context: [] }),
    ]);
    expect(wanted[0]?.m).toEqual(['WITNESSED']);
    const verified = await recordVerifyAs(d, 'VERIFIED');
    expect(verified.refused).toMatch(/On step p-early-time the engine accepts VERIFY signed WITNESSED, not VERIFIED.*\[EBMR-EXE-051\]/);
    expect({ stage: verified.stage, ok: verified.ok, status: verified.status, checks: verified.checks }).toEqual({ stage: 'sign', ok: false, status: 'AWAITING_VERIFICATION', checks: [] });
    const { rows } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1 and meaning_code = $2', [`${d.runId}:${EARLY}`, 'VERIFIED']);
    expect(rows).toHaveLength(0);
    // The witness, signed as offered, is recorded.
    valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'WITNESSED' })).result);
    expect(await checks(d)).toEqual({ status: 'COMPLETED', checks: ['WITNESSED'] });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

type Json = Record<string, unknown>;

/**
 * withEarlyParameter with the blend-time step beside the booth clearance (a parallel): the operator can start the
 * clearance once the blend time is signed performed, so the run moves on after the act and no witness is possible
 * (the kernel refuses one then, EBMR-ESIG-051), at once and without waiting for the witness window to pass.
 */
const withEarlyBesideClearance = (): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    const early = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [] };
    const [clear, ...rest] = prep as [Json, ...Json[]];
    return [{ kind: 'parallel', id: 'par-early', branches: [{ id: 'br-early', name: 'Blend time', body: early }, { id: 'br-clear', name: 'Clearance', body: clear }] }, ...rest];
  });

const CLEAR = 'p-disp-clear@';

/** The blend time typed by hand and signed performed, then the booth clearance started by the operator: the run moved on. */
async function movedOn(): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, withEarlyBesideClearance()));
  const d = new RunDriver(server, runId, {
    issuer,
    operator1: await server.asPersona('operator1'),
    verifier1: await server.asPersona('verifier1'),
    supervisor1: await server.asPersona('supervisor1'),
    qa1: await server.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: EARLY });
  await d.ok('operator1', { type: 'RECORD_DATA', stepKey: EARLY, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: EARLY });
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  return d;
}

async function lateExceptions(d: RunDriver): Promise<engine.ExceptionRecord[]> {
  return Object.values((await execution.loadState(server.db.admin, d.runId))?.state.exceptions ?? {}).filter((e) => e.type === 'WITNESS_LATE');
}

const lateTitle = (verifier: string): string =>
  `blendTime at p-early-time@ was typed by hand with neither the photo or printout the MBR names nor a witness: the run moved on after the act (another step started or recorded data), so ${verifier} checked the step later (VERIFIED); QA must disposition this exception`;

describe('T12.LATE: once a witness is no longer possible, the step is completed by a later review that records an exception for QA (engine 1.5.0, recipe-core 0333)', () => {
  it('[DI-30][PR-14][DI-35] once the run moved on after the act, a witness is refused and nothing is signed; the screen, the challenge and the signature are the later review (VERIFIED), the step completes and records WITNESS_LATE, which the supervisor cannot disposition and QA does', async () => {
    const d = await movedOn();
    const view = await d.stepView('verifier1', EARLY);
    expect(view.actions.filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS').map((a) => `${a.action}:${a.meaning}`)).toEqual(['VERIFY:VERIFIED']);
    const run = await runContext(server.db.admin, d.runId);
    const state = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: EARLY, meaning: 'WITNESSED' }, await dbNowUs(server.db.admin))).toBe('VERIFIED');
    // The challenge leaves a check due as a witness to the transaction's time (describe() has none).
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }, undefined)).toBeUndefined();
    // A witness asked for now is refused before anything is signed.
    const witness = await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'WITNESSED' });
    expect({ ok: witness.result.ok, ...(await checks(d)) }).toEqual({ ok: false, status: 'AWAITING_VERIFICATION', checks: [] });
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('VERIFIED');
    expect(await checks(d)).toEqual({ status: 'COMPLETED', checks: ['VERIFIED'] });
    const verifier = personaIn(server, 'verifier1').personId;
    const late = await lateExceptions(d);
    expect(late.map((e) => ({ status: e.status, qaOnly: e.qaOnly, stepKey: e.source.stepKey, raisedBy: e.raisedBy, title: e.title, block: e.block ?? null }))).toEqual([
      { status: 'OPEN', qaOnly: true, stepKey: EARLY, raisedBy: verifier, title: lateTitle(verifier), block: null },
    ]);
    const exception = late[0]?.id ?? '';
    const justification = 'The blend time was confirmed from the blender\'s own log.';
    const supervisor = await d.sign('supervisor1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification });
    expect(supervisor.result.ok).toBe(false);
    valueOf((await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification })).result);
    expect((await lateExceptions(d)).map((e) => e.status)).toEqual(['DISPOSITIONED']);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-30][DI-35][PR-14][INV-10] written past the server, the late review recorded without its WITNESS_LATE, with it not QA-only or with another title is refused (EBMR-EXE-141), raised by another person as before (EBMR-EXE-045), and nothing is signed; the honest late review is recorded', async () => {
    const d = await movedOn();
    const operator = personaIn(server, 'operator1').personId;
    /** verifier1's late review through the ceremony, stored through the application role with its state changed by `forge`. */
    const reviewed = async (forge: (state: engine.BatchState, late: engine.ExceptionRecord, events: engine.EngineEvent[]) => void): Promise<string> => {
      const r = await interceptSigned(
        'VERIFY',
        async (tx, command, roles) => {
          const res = engineResult(tx, command);
          const state = structuredClone(res.state);
          const events = structuredClone(res.events);
          const late = Object.values(state.exceptions).find((e) => e.type === 'WITNESS_LATE' && !(e.id in tx.state.exceptions));
          if (!late) throw new Error('SETUP: the engine raised no WITNESS_LATE');
          forge(state, late, events);
          await appendAs(tx, command, { state, events }, roles);
          return res;
        },
        () => d.sign('verifier1', { type: 'VERIFY', stepKey: EARLY, meaning: 'VERIFIED' }),
      );
      return r.error === undefined ? 'ok' : r.error instanceof Error ? r.error.message : JSON.stringify(r.error);
    };
    const outcomes = {
      without: await reviewed((state, late, events) => {
        delete state.exceptions[late.id];
        events.splice(events.findIndex((e) => e.type === 'EXCEPTION_RAISED'), 1);
      }),
      notQaOnly: await reviewed((_s, late) => void (late.qaOnly = false)),
      otherTitle: await reviewed((_s, late) => void (late.title = late.title.replace('the run moved on after the act (another step started or recorded data)', 'the witness window after the act had passed'))),
      otherRaiser: await reviewed((_s, late) => void (late.raisedBy = operator)),
    };
    expect(unmatched(outcomes, {
      without: /^This accepted VERIFY row checks step p-early-time@ by a later review \(VERIFIED\) where a witness was due and is no longer possible, and records no exception for it: .*\[EBMR-EXE-141\]$/,
      notQaOnly: /^This accepted VERIFY row records exception EX-\d+ otherwise than the later review of step p-early-time@ raises it: .*\[EBMR-EXE-141\]$/,
      otherTitle: /^This accepted VERIFY row records exception EX-\d+ otherwise than the later review of step p-early-time@ raises it: .*\[EBMR-EXE-141\]$/,
      otherRaiser: /^Exception EX-\d+ \(WITNESS_LATE\) comes from the act of this COMMAND row, so its raiser is the row's person .*\[EBMR-EXE-045\]$/,
    })).toEqual({});
    expect({ ...(await checks(d)), late: (await lateExceptions(d)).length }).toEqual({ status: 'AWAITING_VERIFICATION', checks: [], late: 0 });
    const { rows } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1 and meaning_code = $2', [`${d.runId}:${EARLY}`, 'VERIFIED']);
    expect(rows).toHaveLength(0);
    expect(await reviewed(() => undefined)).toBe('ok');
    expect({ ...(await checks(d)), late: (await lateExceptions(d)).map((e) => e.title) }).toEqual({ status: 'COMPLETED', checks: ['VERIFIED'], late: [lateTitle(personaIn(server, 'verifier1').personId)] });
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-30][DI-35][PR-14] written past the server, a WITNESS_LATE added by any row but the late review is refused (EBMR-EXE-141): the operator\'s clearance entry raising one at its own step', async () => {
    const d = await movedOn();
    const run = await runContext(server.db.admin, d.runId);
    const who = personaIn(server, 'operator1');
    const entry = { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' })) };
    /** operator1's clearance entry, resolved and run as the server does, stored through the application role; with a WITNESS_LATE at the clearance when `forged`. */
    const recorded = async (forged: boolean): Promise<string> =>
      messageOf(
        withCommand(server.db.app, await actorOf(server, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const resolved = await resolveClientIntent(
            { client: c, app: server.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
            { type: 'RECORD_ENTRY', stepKey: CLEAR, entry } as Parameters<typeof resolveClientIntent>[1],
          );
          const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
          if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
          const state = structuredClone(r.state);
          const events = structuredClone(r.events);
          if (forged) {
            const n = (state.counters['EX'] ?? 0) + 1;
            state.counters['EX'] = n;
            const id = `EX-${n}`;
            const title = `The witness the MBR requires at ${CLEAR} was not given: the run moved on after the act (another step started or recorded data), so ${who.personId} checked the step later (VERIFIED); QA must disposition this exception`;
            state.exceptions[id] = {
              id, type: 'WITNESS_LATE', category: 'DEVIATION_OR_OVERRIDE', title, controls: ['DI-35', 'DI-30'], severity: 'ALERT', source: { stepKey: CLEAR, step: 'p-disp-clear', frames: [] },
              raisedAt: tx.nowUs, raisedSeq: state.seq + 1, raisedBy: who.personId, deviationRequired: false, registrationRelevant: false, qaOnly: true, stageSignOffBlocked: false, releaseBlocking: false, status: 'OPEN',
            };
            state.seq += 1;
            events.push({ type: 'EXCEPTION_RAISED', exception: id, exceptionType: 'WITNESS_LATE', severity: 'ALERT', title, controls: ['DI-35', 'DI-30'], seq: state.seq, at: tx.nowUs });
          }
          return appendAs(tx, resolved.command, { state, events }, roles, engine.encodeCommand(resolved.command), engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
        }),
      );
    expect(await recorded(true)).toMatch(/^This accepted RECORD_ENTRY row adds exception EX-\d+ of type WITNESS_LATE, which only the later review of a step whose witness is no longer possible raises, once: .*\[EBMR-EXE-141\]$/);
    expect(await lateExceptions(d)).toEqual([]);
    expect(await recorded(false)).toBe('ok');
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-35][PR-14][DI-30] the database asks for the witness up to the last microsecond of the witness window after the act and for the later review after it, at the command\'s trusted time; without a time it keeps asking for the witness', async () => {
    const d = await performed();
    const run = await runContext(server.db.admin, d.runId);
    const { rows: st } = await server.db.admin.query<{ state: Json }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
    const prior = st[0]?.state ?? {};
    const ended = BigInt(String((((prior['steps'] as Json)[EARLY] as Json)['endedAt'] as Json)['$u']));
    const window = run.def.policy.witnessWindowUs;
    /** recipe.step_check_meanings for the early step's VERIFY in a transaction whose trusted time (its marker) is `now`. */
    const meaningsAt = async (now: bigint | null): Promise<string[]> => {
      const c = await server.db.admin.connect();
      try {
        await c.query('begin');
        if (now !== null) {
          await c.query('insert into recipe.execution_clock (xact_id, backend_pid, batch_id, now_us) values (pg_current_xact_id(), pg_backend_pid(), $1, $2)', [d.runId, now.toString()]);
        }
        const { rows } = await c.query<{ m: string[] }>('select recipe.step_check_meanings($1, $2::jsonb, $3::jsonb) as m', [d.runId, JSON.stringify(prior), JSON.stringify({ type: 'VERIFY', step: 'p-early-time', context: [] })]);
        return rows[0]?.m ?? [];
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect({ atEnd: await meaningsAt(ended), lastMicrosecond: await meaningsAt(ended + window), after: await meaningsAt(ended + window + 1n), noTime: await meaningsAt(null) }).toEqual({
      atEnd: ['WITNESSED'],
      lastMicrosecond: ['WITNESSED'],
      after: ['VERIFIED'],
      noTime: ['WITNESSED'],
    });
    // The engine agrees at each of these times.
    const stored = (await execution.loadState(server.db.admin, d.runId))?.state;
    const inst = stored?.steps[EARLY];
    expect([ended, ended + window, ended + window + 1n].map((now) => engine.checkMeaning(run.def, inst, 'p-early-time', stored, now))).toEqual(['WITNESSED', 'WITNESSED', 'VERIFIED']);
  }, 240_000);
});
