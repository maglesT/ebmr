/**
 * Where a recorded value came from (review findings P34 and P58; DI-30, DI-32, PR-14, PR-20).
 *
 * The browser may send RECORD_DATA with `source: {mode: 'SCAN', code}`. Before the fix the server copied that claim
 * into the engine command, and the engine applies the hand-entry rules (the MANUAL_FALLBACK flag and exception, and
 * the second person for a critical value keyed by hand) only to a MANUAL source. So a value typed on the kiosk and
 * sent as a "scan" was stored and signed as scanned objective evidence, and one person could complete the step.
 * The same path accepted a photo or printout hash that names no attachment the server stored.
 *
 * The rule now: the server has no way to attest a scan made in the browser, so
 *  - SCAN on a parameter the MBR does not capture by scanning is refused before the engine runs (nothing written);
 *  - SCAN on a scan-captured parameter is recorded as a hand entry, with the hand-entry rules (DI-30);
 *  - a photo or printout hash is refused while no attachment store exists;
 *  - the database refuses any person's RECORD_DATA whose source is not a plain MANUAL one, however it is written;
 *  - the database refuses a state stored beside an accepted RECORD_DATA or SIGN_PERFORMED that the command cannot have
 *    produced: a value of another source or item, a manual fallback without its flag, a critical or fallback value
 *    whose step does not need the second person, a step that needs its check completed by its PERFORMED signature
 *    (round-1 verification, residual a; recipe-core 0300).
 *
 * Round-2 verification (recipe-core 0303): 0300 compared only what a person's row added, and let a SWEEP row through
 * unchecked. With the application's credentials alone, a later row (an exception raised from any terminal, a refused
 * row) could relabel the earlier hand entry as a scan or change its value, and the sweeper's row could complete the
 * step waiting for its second person; the database recorded each with no violation, only the replay disagreed. Now a
 * value, entry, container or computed value once recorded is kept (EBMR-EXE-126), and a sweep changes only its time
 * findings and their bookkeeping (EBMR-EXE-128). Two guards of 0300 that no test held are held here too: the second
 * person, once required, stays required whatever row follows (EBMR-EXE-127), and no source but a hand entry or the
 * block's own computation is attested for a data point a person's row adds (EBMR-EXE-126).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { openServiceSession } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { actorOf, appendAs, codeOf as dbOutcome, engineResult, interceptSigned, messageOf } from './db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, refusalOf, rowsOf, RunDriver, startExecServer, valueOf, violations, withEarlyParameter, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

type Json = Record<string, unknown>;

const KEY = 'p-early-time@';

/**
 * The blend time captured as `capture` in a first G-04 step with a performer only (the G-04 golden-fixture shape of
 * the review reproducers). `oneStep` also drops the system reference and the significance, as P34's set-up did.
 */
const blendTimeCapturedBy = (capture: 'DEVICE' | 'SCAN', oneStep: boolean): flow.MbrContent =>
  dcMiniVariant((prep, content) => {
    const bt = (content['parameters'] as Json[]).find((p) => p['id'] === 'blendTime') as Json;
    bt['capture'] = capture;
    delete bt['evidence'];
    delete bt['accuracyCheck'];
    const blend = (((((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[1] as Json)['body'] as Json)['children'] as Json[];
    const mix = ((blend[0] as Json)['body'] as Json)['children'] as Json[];
    const p = mix.find((x) => x['id'] === 'p-blend') as Json;
    p['records'] = ['blenderSpeed'];
    const early: Json = { ...p, id: 'p-early-time', name: 'Record the blend time', records: ['blendTime'], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } } };
    if (oneStep) Object.assign(early, { significant: false, system: { kind: 'OTHER', ref: 'SYS-BLEND-01' } });
    return [early, ...prep];
  });

async function driver(content: flow.MbrContent): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

async function facts(runId: string) {
  const st = (await execution.loadState(server.db.admin, runId))?.state;
  const points = Object.values(st?.points ?? {}).filter((p) => p.item === 'blendTime');
  return {
    points: points.map((p) => ({ source: p.source, flags: [...p.flags] })),
    exceptions: Object.values(st?.exceptions ?? {})
      .filter((e) => e.source.stepKey === KEY)
      .map((e) => e.type),
    verificationRequired: st?.steps[KEY]?.verificationRequired ?? null,
    status: st?.steps[KEY]?.status ?? null,
  };
}

const record = (source: { mode: 'MANUAL'; evidence?: { kind: 'PHOTO' | 'PRINTOUT'; sha256: string } } | { mode: 'SCAN'; code: string }, value = '15') =>
  ({ type: 'RECORD_DATA', stepKey: KEY, item: 'blendTime', value: { kind: 'DECIMAL', value, unit: 'min' }, source }) as const;

describe('P34: RECORD_DATA with a browser-claimed SCAN source', () => {
  it('[DI-30][PR-14][PR-20] a DEVICE-capture value keyed by hand is a manual fallback (control)', async () => {
    const d = await driver(blendTimeCapturedBy('DEVICE', true));
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    const f = await facts(d.runId);
    expect(f.points).toEqual([{ source: { mode: 'MANUAL' }, flags: ['MANUAL_FALLBACK'] }]);
    expect(f.exceptions).toContain('MANUAL_ENTRY_FALLBACK');
    expect(f.verificationRequired).toBe(true);
  }, 240_000);

  it('[DI-30][DI-32][PR-14][PR-20] the same keyed value claimed as "SCAN" on a DEVICE-capture parameter is refused with nothing written; one person cannot complete the step', async () => {
    const d = await driver(blendTimeCapturedBy('DEVICE', true));
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const r = await d.command('operator1', record({ mode: 'SCAN', code: 'X' }));
    const afterRecord = await facts(d.runId);
    let statusAfterOwnSignature: string | null = null;
    let signedContentClaimsScan = false;
    if (r.ok) {
      // The defect: the same operator signs the step as performed, with no second person.
      const s = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
      signedContentClaimsScan = s.content.ok && /"mode":"SCAN"/.test(s.content.value.canonicalText);
      statusAfterOwnSignature = (await facts(d.runId)).status;
    }
    const observed = { accepted: r.ok, ...afterRecord, signedContentClaimsScan, statusAfterOwnSignature };
    expect(r.ok, `a hand-keyed value for a DEVICE-capture parameter was stored as scanned evidence: ${JSON.stringify(observed)}`).toBe(false);
    expect(refusalOf(r)).toMatchObject({ status: 422, code: 'EBMR-EXE-121' });
    expect(refusalOf(r).why).toMatch(/blendTime.*device/i);
    // Refused before the engine: no point, no exception, no row.
    expect(afterRecord.points).toEqual([]);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('P58: a client-declared SCAN source on a parameter that is not scanned', () => {
  it('[DI-30][DI-32][PR-20] a hand-keyed value declared as SCAN on a DEVICE-capture critical parameter is refused; keyed by hand it still needs the second person', async () => {
    const content = blendTimeCapturedBy('DEVICE', false);
    // Control: keyed by hand (MANUAL), the value is the manual fallback: exception raised, two-person mode.
    const c = await driver(content);
    await c.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const manual = valueOf(await c.command('operator1', record({ mode: 'MANUAL' })));
    expect(manual.step?.exceptions.map((e) => e.type)).toContain('MANUAL_ENTRY_FALLBACK');
    expect(manual.step?.fields.find((f) => f.item === 'blendTime')?.attempts.at(-1)?.echo).toBe('You entered 15 min');
    await c.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect((await c.stepView('operator1', KEY)).step.status).toBe('AWAITING_VERIFICATION');

    // Attack: the same hand-keyed value, declared by the client as a scan of an arbitrary code.
    const d = await driver(content);
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const r = await d.command('operator1', record({ mode: 'SCAN', code: 'x' }));
    expect(r.ok, `the scan claim was accepted: ${JSON.stringify(r.ok ? r.value.step?.fields.find((f) => f.item === 'blendTime')?.attempts.at(-1) : null)}`).toBe(false);
    expect(refusalOf(r)).toMatchObject({ status: 422, code: 'EBMR-EXE-121' });
    expect((await facts(d.runId)).points).toEqual([]);
    expect((await d.stepView('operator1', KEY)).step.status).toBe('IN_PROGRESS');
  }, 240_000);

  it('[DI-30][DI-32][PR-14] dc-mini as released: the MANUAL critical blend time claimed as SCAN is refused; the printout it asks for is not claimed by a bare hash either', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const scan = await d.command('operator1', record({ mode: 'SCAN', code: 'x' }));
    expect(refusalOf(scan)).toMatchObject({ status: 422, code: 'EBMR-EXE-121' });
    expect(refusalOf(scan).why).toMatch(/keyed by hand/);
    // A printout hash that names no attachment the server stored is not evidence (P34): refused, nothing written.
    const printout = await d.command('operator1', record({ mode: 'MANUAL', evidence: { kind: 'PRINTOUT', sha256: 'c'.repeat(64) } }));
    expect(refusalOf(printout)).toMatchObject({ status: 422, code: 'EBMR-EXE-122' });
    expect(refusalOf(printout).why).toMatch(/no stored attachment/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect((await facts(d.runId)).points).toEqual([]);
    // Keyed by hand without a claimed attachment: stored as a hand entry; the critical value needs the second person.
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    const f = await facts(d.runId);
    expect(f.points).toEqual([{ source: { mode: 'MANUAL' }, flags: [] }]);
    expect(f.verificationRequired).toBe(true);
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('a scan the server cannot attest is a hand entry (DI-30)', () => {
  it('[DI-30][DI-32][PR-14] SCAN on a scan-captured parameter is stored as MANUAL with the fallback flag and exception, and the step needs a second person', async () => {
    const d = await driver(blendTimeCapturedBy('SCAN', true));
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const r = valueOf(await d.command('operator1', record({ mode: 'SCAN', code: 'TEST-SCAN-0001' })));
    expect(r.step?.fields.find((f) => f.item === 'blendTime')?.attempts.at(-1)?.source.mode).toBe('MANUAL');
    const f = await facts(d.runId);
    expect(f.points).toEqual([{ source: { mode: 'MANUAL' }, flags: ['MANUAL_FALLBACK'] }]);
    expect(f.exceptions).toContain('MANUAL_ENTRY_FALLBACK');
    expect(f.verificationRequired).toBe(true);
    // The claim is kept with the command row as what the terminal said, never as evidence of the value.
    const { rows } = await server.db.admin.query<{ evidence: Json; command: Json }>(
      "select evidence, command from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_DATA' order by seq desc limit 1",
      [d.runId],
    );
    expect(rows[0]?.command['source']).toEqual({ mode: 'MANUAL' });
    expect(rows[0]?.evidence).toMatchObject({ unattestedScan: { code: 'TEST-SCAN-0001', recordedAs: 'MANUAL' } });
    // One person cannot complete it: after PERFORMED it waits for the second person.
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect((await facts(d.runId)).status).toBe('AWAITING_VERIFICATION');
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('the database is the guard (DI-30, DI-32)', () => {
  it('[DI-30][DI-32] a person\'s RECORD_DATA written past the server with a SCAN source or an attachment hash is refused by the database; a plain MANUAL one is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const run = await runContext(server.db.admin, d.runId);
    const me = personaIn(server, 'operator1');
    const write = async (source: engine.DataSource) =>
      withCommand(server.db.app, await actorOfBrowser(server, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        return tx.command({ type: 'RECORD_DATA', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-early-time', context: [], item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source }, roles);
      });
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? String(e);
      }
    };
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    expect(await codeOf(write({ mode: 'SCAN', code: 'x' }))).toBe('EBMR-EXE-121');
    expect(await codeOf(write({ mode: 'DEVICE', device: 'TEST-BAL-01' }))).toBe('EBMR-EXE-121');
    expect(await codeOf(write({ mode: 'MANUAL', evidence: { kind: 'PRINTOUT', sha256: 'd'.repeat(64) } }))).toBe('EBMR-EXE-122');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect(await codeOf(write({ mode: 'MANUAL' }))).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

/** A step instance of a state (it must exist). */
function stepOf(state: engine.BatchState, key: string): engine.StepInstance {
  const inst = state.steps[key];
  if (!inst) throw new Error(`SETUP: no step instance ${key}`);
  return inst;
}

/**
 * What a writer holding the application role's credentials stores past the server, in a command of `persona`: `forge`
 * returns the engine command to record and the state beside it (the engine's answer to some command, possibly edited),
 * appended as accepted. Returns the database's refusal code, or 'ok'.
 */
async function forged(
  d: RunDriver,
  persona: string,
  forge: (tx: execution.ExecutionTx, me: engine.Actor) => { command: engine.Command; result: Pick<engine.StepResult, 'state' | 'events'> },
): Promise<string> {
  return dbOutcome(forgedRow(d, persona, forge));
}

/** `forged`, rejected with the database's refusal itself (for its message). */
async function forgedRow(
  d: RunDriver,
  persona: string,
  forge: (tx: execution.ExecutionTx, me: engine.Actor) => { command: engine.Command; result: Pick<engine.StepResult, 'state' | 'events'> },
): Promise<void> {
  const run = await runContext(server.db.admin, d.runId);
  await withCommand(server.db.app, await actorOf(server, d.browser(persona), persona), async (c) => {
    const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
    const roles = await engineRoles(c);
    const f = forge(tx, engineActor(personaIn(server, persona).personId, roles));
    await appendAs(tx, f.command, f.result, roles);
  });
}

/** The engine command of `record(...)`: the blend time keyed by hand in the early step. */
const keyed = (me: engine.Actor, value = '15', source: engine.DataSource = { mode: 'MANUAL' }): engine.Command => ({
  type: 'RECORD_DATA',
  commandId: randomUUID(),
  actor: me,
  step: 'p-early-time',
  context: [],
  item: 'blendTime',
  value: { kind: 'DECIMAL', value, unit: 'min' },
  source,
});

describe('P34, P58 (round-1 residual a): the state stored beside the command is the one the command keyed', () => {
  it('[DI-30][DI-32][PR-14] an accepted RECORD_DATA stored with the state of a SCAN source, of another value, or with a critical value that does not need the second person, is refused; the honest state is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const outcomes = {
      // The command says MANUAL; the state is the engine's answer to a SCAN (source SCAN, no second person).
      scanState: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me);
        const result = engineResult(tx, { ...command, source: { mode: 'SCAN', code: 'X' } } as engine.Command);
        return { command, result };
      }),
      otherValue: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me, '15');
        return { command, result: engineResult(tx, { ...command, value: { kind: 'DECIMAL', value: '16', unit: 'min' } } as engine.Command) };
      }),
      // The honest state with the second person dropped: blend time is critical and keyed by hand.
      noSecondPerson: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me);
        const result = engineResult(tx, command);
        stepOf(result.state, KEY).verificationRequired = false;
        return { command, result };
      }),
      control: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me);
        return { command, result: engineResult(tx, command) };
      }),
    };
    expect(outcomes).toEqual({ scanState: 'EBMR-EXE-126', otherValue: 'EBMR-EXE-126', noSecondPerson: 'EBMR-EXE-127', control: 'ok' });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    const f = await facts(d.runId);
    expect(f.points).toEqual([{ source: { mode: 'MANUAL' }, flags: [] }]);
    expect(f.verificationRequired).toBe(true);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-30][PR-14][PR-20] a hand-keyed value of a DEVICE-capture parameter stored without its MANUAL_FALLBACK flag, or without the second person, is refused', async () => {
    const d = await driver(blendTimeCapturedBy('DEVICE', true));
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const outcomes = {
      noFlag: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me);
        const result = engineResult(tx, command);
        for (const p of Object.values(result.state.points)) p.flags = p.flags.filter((x) => x !== 'MANUAL_FALLBACK');
        return { command, result };
      }),
      noSecondPerson: await forged(d, 'operator1', (tx, me) => {
        const command = keyed(me);
        const result = engineResult(tx, command);
        stepOf(result.state, KEY).verificationRequired = false;
        return { command, result };
      }),
    };
    expect(outcomes).toEqual({ noFlag: 'EBMR-EXE-126', noSecondPerson: 'EBMR-EXE-127' });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect((await facts(d.runId)).points).toEqual([]);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-30][PR-14][INV-03] a PERFORMED signature stored as completing a step that needs the second person is refused, nothing is signed; signed honestly the step awaits verification', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    const signaturesBefore = (await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1', [`${d.runId}:${KEY}`])).rows.length;
    const r = await interceptSigned(
      'SIGN_PERFORMED',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        const inst = stepOf(res.state, KEY);
        if (inst.status !== 'AWAITING_VERIFICATION') throw new Error(`SETUP: the engine left ${KEY} ${inst.status}`);
        // One person completes the critical step: the state says COMPLETED, with no verification.
        inst.status = 'COMPLETED';
        inst.completedAt = tx.nowUs;
        await appendAs(tx, command, res, roles);
        return res;
      },
      () => d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY }),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/its PERFORMED signature leaves it awaiting verification, not completed .*\[EBMR-EXE-127\]/);
    expect(r.out.result.ok).toBe(false);
    expect((await facts(d.runId)).status).toBe('IN_PROGRESS');
    expect((await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1', [`${d.runId}:${KEY}`])).rows.length).toBe(signaturesBefore);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect((await facts(d.runId)).status).toBe('AWAITING_VERIFICATION');
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

/** The blend-time data points of a state. */
const blendPoints = (s: engine.BatchState): engine.DataPoint[] => Object.values(s.points).filter((p) => p.item === 'blendTime');

/** An exception raised by `me`, about nothing in particular (a row any terminal may record). */
const raised = (me: engine.Actor): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: me, description: 'Label printer jammed once', severity: 'ALERT' });

/**
 * A refused row of `persona` written past the server: the engine refuses `command` (built on the transaction), and
 * `edit` changes the state stored beside the refusal. The database's refusal code, or 'ok'.
 */
async function refusedRow(d: RunDriver, persona: string, command: (tx: execution.ExecutionTx, me: engine.Actor) => engine.Command, edit: (s: engine.BatchState) => void = () => undefined): Promise<string> {
  const run = await runContext(server.db.admin, d.runId);
  return dbOutcome(
    withCommand(server.db.app, await actorOf(server, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const cmd = command(tx, engineActor(personaIn(server, persona).personId, roles));
      const r = engine.step(tx.def, tx.state, cmd, { nowUs: tx.nowUs });
      if (r.accepted || !r.refusal) throw new Error(`SETUP: the engine accepted ${cmd.type}`);
      const state = structuredClone(r.state);
      edit(state);
      await execution.appendExecution(c, {
        batchId: d.runId,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: engine.encodeCommand(cmd),
        commandId: cmd.commandId,
        nowUs: tx.nowUs,
        accepted: false,
        refusal: r.refusal,
        state,
        events: r.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, state),
      });
    }),
  );
}

/** Replay of the stored rows with the engine (ADR 0010): identical, or the first difference. */
async function replayed(runId: string): Promise<{ identical: boolean; firstDifference: unknown }> {
  const run = await runContext(server.db.admin, runId);
  const r = await execution.replayExecution(server.db.admin, run.def, runId);
  return { identical: r.identical, firstDifference: r.firstDifference };
}

describe('P34, P58 (round-2 verification): what the state recorded is kept by every later row and by the sweeper (recipe-core 0303)', () => {
  it('[DI-30][DI-32][DI-24][INV-41] a later exception, or a refused entry, whose state relabels the earlier hand entry as a scan, gives it another value or removes it is refused; the honest rows are recorded and the replay agrees', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const exception = (edit: (s: engine.BatchState) => void) =>
      forged(d, 'operator1', (tx, me) => {
        const command = raised(me);
        const result = engineResult(tx, command);
        edit(result.state);
        return { command, result };
      });
    const outcomes = {
      // The verifier's reproducer: an accepted RAISE_EXCEPTION stores the earlier hand entry as a scan of the same value...
      scanSource: await exception((s) => blendPoints(s).forEach((p) => (p.source = { mode: 'SCAN', code: 'FORGED' }))),
      // ... or as 16 min instead of 15, with no correction, no new version and no signature.
      otherValue: await exception((s) => blendPoints(s).forEach((p) => (p.value = { kind: 'DECIMAL', value: '16', unit: 'min' }))),
      removed: await exception((s) => blendPoints(s).forEach((p) => delete s.points[p.id])),
      // A refused row changes nothing: the engine refuses a stale entry, and the state beside it relabels the value.
      refusedScan: await refusedRow(
        d,
        'operator1',
        (tx, me) => ({ ...keyed(me, '17'), expectedVersion: tx.state.version - 1 }),
        (s) => blendPoints(s).forEach((p) => (p.source = { mode: 'SCAN', code: 'FORGED' })),
      ),
    };
    expect(outcomes).toEqual({ scanSource: 'EBMR-EXE-126', otherValue: 'EBMR-EXE-126', removed: 'EBMR-EXE-126', refusedScan: 'EBMR-EXE-126' });
    const why = await messageOf(
      forgedRow(d, 'operator1', (tx, me) => {
        const command = raised(me);
        const result = engineResult(tx, command);
        blendPoints(result.state).forEach((p) => (p.source = { mode: 'SCAN', code: 'FORGED' }));
        return { command, result };
      }),
    );
    expect(why).toMatch(/This accepted RAISE_EXCEPTION row changes the source of data point DP-\d+ \(blendTime of step p-early-time@\): .*kept as recorded.*\[EBMR-EXE-126\]/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    // Controls: the same exception and the same refused entry with the engine's own state are recorded.
    expect(await forged(d, 'operator1', (tx, me) => {
      const command = raised(me);
      return { command, result: engineResult(tx, command) };
    })).toBe('ok');
    expect(await refusedRow(d, 'operator1', (tx, me) => ({ ...keyed(me, '17'), expectedVersion: tx.state.version - 1 }))).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 2);
    const st = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(blendPoints(st as engine.BatchState).map((p) => ({ source: p.source, value: p.value, flags: p.flags }))).toEqual([
      { source: { mode: 'MANUAL' }, value: { kind: 'DECIMAL', value: '15', unit: 'min' }, flags: [] },
    ]);
    expect(await violations(server)).toEqual([]);
    expect(await replayed(d.runId)).toEqual({ identical: true, firstDifference: null });
  }, 240_000);

  it('[DI-27][INV-20][DI-30][PR-14] a SWEEP row whose state relabels the hand entry, changes its value, or completes the step awaiting its second person is refused; the honest sweep is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect(await facts(d.runId)).toMatchObject({ status: 'AWAITING_VERIFICATION', verificationRequired: true });
    const run = await runContext(server.db.admin, d.runId);
    // The in-process sweeper's own identity (its service key is the server's): the engine's sweep, edited.
    const sweeper = await openServiceSession(server.db, server.seed, 'sweeper');
    const sweep = (edit: (s: engine.BatchState, nowUs: bigint) => void = () => undefined) =>
      withCommand(server.db.app, { ...sweeper, correlationId: randomUUID() }, async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const r = engine.sweep(run.def, tx.state, { nowUs: tx.nowUs });
        const state = structuredClone(r.state);
        edit(state, tx.nowUs);
        return execution.appendExecution(c, { batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'SWEEP', command: { type: 'SWEEP' }, commandId: `SWEEP:${randomUUID()}`, nowUs: tx.nowUs, accepted: true, state, events: r.events, roles: [], contents: engine.changedContents(run.def, tx.state, state) });
      });
    let why: string;
    let outcomes: Record<string, string>;
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    try {
      outcomes = {
        relabelScan: await dbOutcome(sweep((s) => blendPoints(s).forEach((p) => (p.source = { mode: 'SCAN', code: 'FORGED' })))),
        otherValue: await dbOutcome(sweep((s) => blendPoints(s).forEach((p) => (p.value = { kind: 'DECIMAL', value: '16', unit: 'min' })))),
        completeWithoutCheck: await dbOutcome(
          sweep((s, now) => {
            const inst = stepOf(s, KEY);
            inst.status = 'COMPLETED';
            inst.verificationRequired = false;
            inst.completedAt = now;
          }),
        ),
        clearCheckOnly: await dbOutcome(sweep((s) => void (stepOf(s, KEY).verificationRequired = false))),
        versionMoved: await dbOutcome(sweep((s) => void (s.version += 1))),
      };
      why = await messageOf(sweep((s) => void (stepOf(s, KEY).status = 'COMPLETED')));
      outcomes['control'] = await dbOutcome(sweep());
    } finally {
      await identity.endSession(server.db.app, sweeper.sessionId);
    }
    expect(outcomes).toEqual({ relabelScan: 'EBMR-EXE-128', otherValue: 'EBMR-EXE-128', completeWithoutCheck: 'EBMR-EXE-128', clearCheckOnly: 'EBMR-EXE-128', versionMoved: 'EBMR-EXE-128', control: 'ok' });
    expect(why).toMatch(/Row \d+ is a time sweep, and the state it stores changes its steps: .*\[EBMR-EXE-128\]/);
    expect((await rowsOf(server, d.runId)).filter((r) => r.kind === 'SWEEP')).toHaveLength(1);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    const f = await facts(d.runId);
    expect(f).toMatchObject({ status: 'AWAITING_VERIFICATION', verificationRequired: true, points: [{ source: { mode: 'MANUAL' }, flags: [] }] });
    expect(await violations(server)).toEqual([]);
    expect(await replayed(d.runId)).toEqual({ identical: true, firstDifference: null });
  }, 240_000);

  it('[DI-30][PR-14] a later row of the step itself whose state clears the need of the second person, its PERFORMED signature or a refused entry, is refused: nothing clears it; signed honestly the step still needs the check', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    expect((await facts(d.runId)).verificationRequired).toBe(true);
    // A refused entry of the step itself: the engine refuses it as stale; the state beside it clears the need.
    const refusedClears = await refusedRow(
      d,
      'operator1',
      (tx, me) => ({ ...keyed(me, '17'), expectedVersion: tx.state.version - 1 }),
      (s) => void (stepOf(s, KEY).verificationRequired = false),
    );
    expect(refusedClears).toBe('EBMR-EXE-127');
    // The PERFORMED signature itself, with the real e-signature: the state leaves the step awaiting verification (as
    // the engine does) but no longer needing the second person, so a correction's re-opening could later complete it
    // with one person.
    const r = await interceptSigned(
      'SIGN_PERFORMED',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        const inst = stepOf(res.state, KEY);
        if (inst.status !== 'AWAITING_VERIFICATION' || !inst.verificationRequired) throw new Error(`SETUP: the engine left ${KEY} ${inst.status}`);
        inst.verificationRequired = false;
        await appendAs(tx, command, res, roles);
        return res;
      },
      () => d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY }),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/Step p-early-time@ needs a second person's check, and this SIGN_PERFORMED row clears that requirement; nothing clears it .*\[EBMR-EXE-127\]/);
    expect(r.out.result.ok).toBe(false);
    expect(await facts(d.runId)).toMatchObject({ status: 'IN_PROGRESS', verificationRequired: true });
    // Controls: the refused entry as the engine refused it, and the signature as the engine applies it.
    expect(await refusedRow(d, 'operator1', (tx, me) => ({ ...keyed(me, '17'), expectedVersion: tx.state.version - 1 }))).toBe('ok');
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: KEY });
    expect(await facts(d.runId)).toMatchObject({ status: 'AWAITING_VERIFICATION', verificationRequired: true });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-30][DI-32] an exception whose state adds a data point captured by scan, device, automation or LIMS is refused: no such source is attested for a person\'s row; the honest exception is recorded', async () => {
    const d = await driver(withEarlyParameter());
    await d.ok('operator1', { type: 'START_STEP', stepKey: KEY });
    valueOf(await d.command('operator1', record({ mode: 'MANUAL' })));
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    /** The exception's state with a second blend time of `source`, as the engine would store a value of that source. */
    const withPoint = (source: engine.DataSource) =>
      forged(d, 'operator1', (tx, me) => {
        const command = raised(me);
        const result = engineResult(tx, command);
        const [first] = blendPoints(result.state);
        if (!first) throw new Error('SETUP: no blend time recorded');
        const n = (result.state.counters['DP'] ?? 0) + 1;
        result.state.counters['DP'] = n;
        result.state.points[`DP-${n}`] = { ...structuredClone(first), id: `DP-${n}`, attempt: 2, source, flags: ['REPEAT'], value: { kind: 'DECIMAL', value: '16', unit: 'min' } };
        return { command, result };
      });
    const outcomes = {
      scan: await withPoint({ mode: 'SCAN', code: 'FORGED' }),
      device: await withPoint({ mode: 'DEVICE', device: 'TEST-BAL-01' }),
    };
    expect(outcomes).toEqual({ scan: 'EBMR-EXE-126', device: 'EBMR-EXE-126' });
    const why = await messageOf(
      forgedRow(d, 'operator1', (tx, me) => {
        const command = raised(me);
        const result = engineResult(tx, command);
        const [first] = blendPoints(result.state);
        if (first) result.state.points['DP-99'] = { ...structuredClone(first), id: 'DP-99', source: { mode: 'SCAN', code: 'FORGED' } };
        return { command, result };
      }),
    );
    expect(why).toMatch(/Data point DP-99 is recorded with a SCAN source, which no device, scan or system attests for a person's row.*\[EBMR-EXE-126\]/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect(await forged(d, 'operator1', (tx, me) => {
      const command = raised(me);
      return { command, result: engineResult(tx, command) };
    })).toBe('ok');
    expect((await facts(d.runId)).points).toEqual([{ source: { mode: 'MANUAL' }, flags: [] }]);
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});
