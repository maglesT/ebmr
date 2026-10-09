/**
 * Phase 2 exit review F12, round 9 (self-review after recipe-core 0340; DI-05, DI-30, PR-49, PR-45; recipe-core 0343; ADR
 * 0012): an accepted deviation link names an exception of the record and links it, and an accepted hold release names a
 * hold of the record and releases it.
 *
 * recipe-core 0338 binds what an accepted command names as a place (a step instance, a stage frame, a decision), and a
 * disposition or a correction names its exception or data point under the e-signature that covers it. ATTACH_DEVIATION
 * and RELEASE_HOLD carry no signature, and no guard asked that an accepted one change what it names: through the
 * application role an accepted ATTACH_DEVIATION of exception L2409-0017 and an accepted RELEASE_HOLD of hold L2409-0017,
 * each stored with the state the engine gives (its refusal leaves the state as the time sweep changes it), were recorded
 * 'ok' with no violation. Now each is refused (EBMR-EXE-126), and so is an accepted one naming a real exception or hold
 * that it leaves unchanged.
 *
 * Own file and server: the kiosk's device nonces are rate-limited per terminal and minute.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, unmatched } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const LOT = 'L2409-0017';

/** A dc-mini run whose booth clearance operator1 has started (qa1 and supervisor1 on their terminals). */
async function startedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), qa1: await sbx.asPersona('qa1'), supervisor1: await sbx.asPersona('supervisor1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
  return d;
}

/**
 * `persona`'s command built by `build`, through the application role: honestly through the store and engine
 * (ExecutionTx.command; 'accepted' or 'refused <code>'), or, with `recorded`, stored as accepted with the state the
 * engine gives for `build`'s command and `recorded` in its place ('ok' or the refusal of the database).
 */
async function as(d: RunDriver, persona: string, build: (a: engine.Actor) => engine.Command, recorded?: (c: engine.Command) => engine.Command): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const actor = await actorOf(sbx, d.browser(persona), persona);
  return messageOf(
    withCommand(sbx.db.app, actor, async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command = build(engineActor(personaIn(sbx, persona).personId, roles));
      if (recorded) {
        const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
        const forged = recorded(command);
        return appendAs(tx, forged, { state: r.state, events: r.events }, roles);
      }
      const r = await tx.command(command, roles);
      if (!r.accepted) throw new Error(`refused ${r.refusal?.code ?? ''}`);
    }),
  );
}

const raise = (a: engine.Actor): engine.Command => ({ type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: a, step: 'p-disp-clear', context: [], description: 'The label of the booth door is torn', severity: 'ALERT' });
const attach = (exception: string) => (a: engine.Actor): engine.Command => ({ type: 'ATTACH_DEVIATION', commandId: randomUUID(), actor: a, exception, deviationRef: 'TEST-DEV-2026-001' });
const hold = (a: engine.Actor): engine.Command => ({ type: 'HOLD_BATCH', commandId: randomUUID(), actor: a, holdType: 'SUPERVISOR', reason: 'Booth door label torn' });
const release = (h: string) => (a: engine.Actor): engine.Command => ({ type: 'RELEASE_HOLD', commandId: randomUUID(), actor: a, hold: h, reason: 'Label replaced' });

async function rowsWith(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1 and command::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

describe('F12 round 9: an accepted deviation link or hold release names a record of the state and changes it (DI-05, DI-30, PR-49, PR-45)', () => {
  const ROW = String.raw`\. An accepted command names the exception or hold of the state it acts on and makes the change it records, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;

  it('[DI-05][DI-30][PR-49][PR-45] round 9 (self-review, sql 0343): an accepted ATTACH_DEVIATION of exception L2409-0017 and an accepted RELEASE_HOLD of hold L2409-0017, stored with the state the engine gives, and an accepted link or release naming the real exception or hold but leaving it unchanged, are refused (EBMR-EXE-126) and no row holds L2409-0017; the honest link and release are recorded', async () => {
    const d = await startedRun();
    expect(await as(d, 'operator1', raise)).toBe('ok');
    expect(await as(d, 'supervisor1', hold)).toBe('ok');
    const st = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const ex = Object.keys(st?.exceptions ?? {})[0];
    const held = Object.keys(st?.holds ?? {})[0];
    if (!ex || !held) throw new Error(`SETUP: no exception or hold: ${JSON.stringify({ ex, held })}`);

    const outcomes = {
      // The engine refuses these (ENG-UNKNOWN-EXCEPTION, ENG-HOLD-UNKNOWN) and leaves the state as the sweep changes it.
      attachLot: await as(d, 'qa1', attach(LOT), (c) => c),
      releaseLot: await as(d, 'supervisor1', release(LOT), (c) => c),
      // The real exception and hold named, with that same unchanged state.
      attachUnchanged: await as(d, 'qa1', attach(LOT), (c) => ({ ...c, exception: ex }) as engine.Command),
      releaseUnchanged: await as(d, 'supervisor1', release(LOT), (c) => ({ ...c, hold: held }) as engine.Command),
    };
    expect(
      unmatched(outcomes, {
        attachLot: new RegExp(String.raw`^This accepted ATTACH_DEVIATION row cannot be recorded: command\.exception "L2409-0017" is not an exception of the state before the row, open and without a deviation, that the row links to one` + ROW),
        releaseLot: new RegExp(String.raw`^This accepted RELEASE_HOLD row cannot be recorded: command\.hold "L2409-0017" is not a hold of the state before the row, not yet released, that the row releases` + ROW),
        attachUnchanged: new RegExp(String.raw`^This accepted ATTACH_DEVIATION row cannot be recorded: command\.exception "${ex}" is not an exception of the state before the row` + '.*' + ROW),
        releaseUnchanged: new RegExp(String.raw`^This accepted RELEASE_HOLD row cannot be recorded: command\.hold "${held}" is not a hold of the state before the row` + '.*' + ROW),
      }),
    ).toEqual({});
    expect(await rowsWith(d.runId, LOT)).toBe(0);

    // The honest link and release.
    expect(await as(d, 'qa1', attach(ex))).toBe('ok');
    expect(await as(d, 'supervisor1', release(held))).toBe('ok');
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'ATTACH_DEVIATION' || x.command_type === 'RELEASE_HOLD').map((x) => [x.command_type, x.accepted])).toEqual([
      ['ATTACH_DEVIATION', true],
      ['RELEASE_HOLD', true],
    ]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});
