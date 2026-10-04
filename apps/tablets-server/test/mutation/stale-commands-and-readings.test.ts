/**
 * Stale commands and the scale readings they name, rule by rule (SQL mutation group "stale-commands-and-readings":
 * recipe-core 0326, tablets 0500, 0510, 0520 and 0590). These tests close the gaps the SQL mutation run
 * (tools/sql-mutation) found in the group's server tests (test/execution/db-guards-stale-row, db-guards-stale-row-commit
 * and db-guards-used-readings), which drive a stale command and its readings end to end and with a few forgeries:
 *   - recipe.stale_command_problem (0326, EBMR-EXE-140): the version a screen showed is a whole number of the range of a
 *     run's version, both ends included (0 and 2147483647 are, -1 and 2147483648 are not); the refusal of a row says what
 *     the row records (as accepted, or with which refusal); and an accepted row's refusal is never read as its verdict,
 *     so an accepted command from an older screen with an ENG-STALE refusal beside it is the version check's refusal,
 *     and one from the current screen is left to the refusal-shape rule (0336, EBMR-EXE-126);
 *   - recipe.execution_stale_refusal_check (0326, EBMR-EXE-140): only the refusal ENG-STALE is held to the time sweep;
 *     a command refused for another reason keeps what the engine's finalisation established before the refusal, as the
 *     engine records it (StepResult; recipe-core 0303); and a preparation recorded as refused ENG-STALE never reaches
 *     the projection (the version check, or the row's shape, refuses it first);
 *   - tab.stale_row_claims_check and tab.reading_use_stale_row_check (0520, EBMR-EXE-124): the mark of a correlation id
 *     keeps what each side wrote, so a second stale row under a correlation id leaves its mark of a stale refusal, and a
 *     claim of one reading alone leaves its mark of a claim; the later write is refused at commit either way.
 * Everything goes through the store as the server writes (recipe.append_execution through ExecutionTx or
 * execution.appendExecution, tab.claim_readings) with the application role and the actors the server builds (ADR 0012:
 * the application role is the attacker); the database's own tables are read as the superuser.
 *
 * Own file and server: the kiosk's device nonces are rate-limited per terminal and minute (as the stale-row files).
 *
 * Controls: DI-32, DI-34, PR-19.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { startRig, stopRig, type Rig } from '../devices/room-scales-support.ts';
import { staleRowHelpers, weighing, type Json } from '../execution/db-guards-stale-support.ts';
import { actorOf, codeOf, messageOf } from '../execution/db-guards-support.ts';
import { outcomeOf, personaIn, rowsOf, violations, type RunDriver } from '../execution/support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const { readings, usesOf, claimAlone, markOf, staleException, preparedRun } = staleRowHelpers(() => rig);

const STALE: engine.Refusal = { code: 'ENG-STALE', message: 'The batch changed since this screen was loaded (ENG-STALE; DI-34)', controls: ['DI-34'] };
const NOT_ENABLED: engine.Refusal = { code: 'ENG-NOT-ENABLED', message: 'Step p-disp-pcm is not enabled', controls: ['DI-34'] };

/** The run's version and state as the projection stores them (superuser read). */
async function projectionOf(d: RunDriver): Promise<{ version: number; state: Json }> {
  const { rows } = await rig.server.db.admin.query<{ version: number; state: Json }>('select state_version as version, state from recipe.execution_state where batch_id = $1', [d.runId]);
  const p = rows[0];
  if (!p) throw new Error(`SETUP: run ${d.runId} has no projection`);
  return p;
}

/** What a forged row records beside the command: its verdict and refusal. */
interface Verdict {
  accepted: boolean;
  refusal?: engine.Refusal;
}

/**
 * operator1 raises an exception about the paracetamol step from a screen that showed `seen(version)`, written past the
 * server through the store. Without `verdict`, the engine's own result is appended (ExecutionTx). With it, the row
 * records that verdict and refusal, with the engine's state and events for it: those of the command from the current
 * screen when the row says accepted, those of the command as sent when it says refused. The database's message, or 'ok'.
 */
async function raisePast(d: RunDriver, seen: (version: number) => number, verdict?: Verdict): Promise<string> {
  const run = await runContext(rig.server.db.admin, d.runId);
  const who = personaIn(rig.server, 'operator1');
  return messageOf(
    withCommand(rig.server.db.app, await actorOf(rig.server, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = {
        type: 'RAISE_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(who.personId, roles),
        expectedVersion: seen(tx.state.version),
        step: 'p-disp-pcm',
        context: [],
        description: 'Label of the drum torn',
        severity: 'ALERT',
      };
      if (!verdict) return tx.command(command, roles);
      const r = engine.step(tx.def, tx.state, verdict.accepted ? { ...command, expectedVersion: tx.state.version } : command, { nowUs: tx.nowUs });
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: engine.encodeCommand(command),
        commandId: command.commandId,
        nowUs: tx.nowUs,
        accepted: verdict.accepted,
        ...(verdict.refusal ? { refusal: verdict.refusal } : {}),
        state: r.state,
        events: r.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, r.state),
      });
    }),
  );
}

describe('recipe-core 0326: a stale command is recorded only as the engine\'s refusal ENG-STALE, and that refusal changes nothing but the sweep\'s findings (DI-34)', () => {
  it('[DI-34] the version a screen showed is a whole number of the range of a run\'s version, both ends included: the engine\'s stale refusal of a command naming 0 or 2147483647 is recorded, one naming -1 or 2147483648 is refused EBMR-EXE-140 as no version of a run; the refusal says what the row records (as accepted, or with its refusal), and an accepted row\'s refusal is never its verdict', async () => {
    const d = await preparedRun();
    const { version } = await projectionOf(d);
    const rowsBefore = await rowsOf(rig.server, d.runId);
    const stale = (n: number) => `This refused RAISE_EXCEPTION row names ${n} as the version its screen showed, which is not a version of a run (DI-34). [EBMR-EXE-140]`;
    const recorded = (what: string) =>
      `was sent from a screen that showed version ${version - 1} while the run is at version ${version}, and is recorded ${what}; a command from a screen that shows another version is recorded only as the engine's refusal ENG-STALE (DI-34). [EBMR-EXE-140]`;

    const refused = {
      // Below the range of a run's version (state_version >= 0) and just above it (integer).
      belowRange: await raisePast(d, () => -1),
      aboveRange: await raisePast(d, () => 2147483648),
      // An accepted command from an older screen, and a refusal for another reason from it: the refusal says which.
      acceptedFromOlderScreen: await raisePast(d, (v) => v - 1, { accepted: true }),
      otherRefusalFromOlderScreen: await raisePast(d, (v) => v - 1, { accepted: false, refusal: NOT_ENABLED }),
      // An accepted command with the refusal ENG-STALE beside it: from an older screen, the version check refuses it as
      // accepted (the refusal is not its verdict); from the current screen, the version check has nothing to say and
      // the refusal-shape rule refuses it (0336).
      acceptedStaleWithRefusal: await raisePast(d, (v) => v - 1, { accepted: true, refusal: STALE }),
      acceptedCurrentWithStaleRefusal: await raisePast(d, (v) => v, { accepted: true, refusal: STALE }),
    };
    const { acceptedCurrentWithStaleRefusal, ...byVersionCheck } = refused;
    expect(byVersionCheck).toEqual({
      belowRange: stale(-1),
      aboveRange: stale(2147483648),
      acceptedFromOlderScreen: `This accepted RAISE_EXCEPTION row ${recorded('as accepted')}`,
      otherRefusalFromOlderScreen: `This refused RAISE_EXCEPTION row ${recorded('with the refusal ENG-NOT-ENABLED')}`,
      acceptedStaleWithRefusal: `This accepted RAISE_EXCEPTION row ${recorded('as accepted')}`,
    });
    expect(acceptedCurrentWithStaleRefusal).toMatch(/^This accepted RAISE_EXCEPTION row cannot be recorded: an accepted row records no refusal\. .*\[EBMR-EXE-126\]$/);
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);

    // Both ends of the range are versions a screen may have shown: the engine's stale refusals are recorded with them,
    // and the run stays at its version.
    expect([await raisePast(d, () => 0), await raisePast(d, () => 2147483647)]).toEqual(['ok', 'ok']);
    const { rows } = await rig.server.db.admin.query<{ accepted: boolean; code: string; seen: string; version: number }>(
      "select accepted, refusal ->> 'code' as code, command ->> 'expectedVersion' as seen, state_version as version from recipe.execution_command where batch_id = $1 and seq > $2 order by seq",
      [d.runId, rowsBefore.length],
    );
    expect(rows).toEqual([
      { accepted: false, code: 'ENG-STALE', seen: '0', version },
      { accepted: false, code: 'ENG-STALE', seen: '2147483647', version },
    ]);
    expect((await projectionOf(d)).version).toBe(version);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-34] only the refusal ENG-STALE is held to the time sweep: written past the server, a PERFORMED signing refused for its meaning records what the engine\'s finalisation of the step established before the refusal, and is recorded as the engine left it (recipe-core 0303)', async () => {
    const d = await preparedRun();
    const before = await projectionOf(d);
    const pcmOf = (state: Json) => (state['steps'] as Record<string, Json>)['p-disp-pcm@'] ?? {};
    // The fingerprint of the entries the finalisation evaluated (steps.ts finalisePerform, key U+0000 perform), stored
    // under the codec's escaped key.
    const performFingerprint = (state: Json) => (pcmOf(state)['blockComputed'] as Record<string, string>)['~%00perform'];
    expect(pcmOf(before.state)['status']).toBe('IN_PROGRESS');
    expect(performFingerprint(before.state)).toBeUndefined();
    const rowsBefore = await rowsOf(rig.server, d.runId);
    const run = await runContext(rig.server.db.admin, d.runId);
    const who = personaIn(rig.server, 'operator1');

    // The refusal ENG-STALE is a refused command's: operator1's preparation for the PERFORMED signature of the step,
    // with the engine's facts for it, recorded as refused ENG-STALE is refused before the projection is written: by the
    // version check when its command names no version (EBMR-EXE-140), by the row's shape when it names one (a
    // preparation declares none; EBMR-EXE-126).
    const preparation = async (seen?: (version: number) => number) =>
      messageOf(
        withCommand(rig.server.db.app, await actorOf(rig.server, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const target: engine.SignatureTarget = { type: 'SIGN_PERFORMED', step: 'p-disp-pcm', context: [] };
          const actor = engineActor(who.personId, roles);
          const p = engine.prepareForSignature(tx.def, tx.state, target, actor, { nowUs: tx.nowUs });
          const command = { type: 'PREPARE', target, actor, meaning: 'PERFORMED', ...(seen ? { expectedVersion: seen(tx.state.version) } : {}) };
          return execution.appendExecution(tx.client, {
            batchId: tx.locked.batch.id,
            expectedSeq: tx.lastSeq,
            kind: 'PREPARE',
            command: engine.encodeCommand(command as unknown as engine.Command),
            commandId: `PREPARE:${randomUUID()}`,
            nowUs: tx.nowUs,
            accepted: false,
            refusal: STALE,
            state: p.state,
            events: p.events,
            roles,
            contents: engine.changedContents(tx.def, tx.state, p.state),
          });
        }),
      );
    const prepared = { withoutVersion: await preparation(), fromOlderScreen: await preparation((v) => v - 1) };
    expect(prepared.withoutVersion).toMatch(/^This refused \S+ row is recorded as the refusal ENG-STALE, but its command names no version its screen showed; .*\[EBMR-EXE-140\]$/);
    expect(prepared.fromOlderScreen).toMatch(/^This preparation \S+ row cannot be recorded: command\.expectedVersion is a member a preparation for a signature does not declare\. .*\[EBMR-EXE-126\]$/);
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await projectionOf(d)).toEqual(before);

    // operator1 signs the paracetamol weighing as performed with a signature of another meaning, from the current
    // screen and with no preparation row before it: the engine finalises the step (finalisePhase), then refuses the
    // signature (ENG-SIGNATURE-MEANING) and keeps the finalisation in the state it returns.
    let refusal: string | undefined;
    const outcome = await messageOf(
      withCommand(rig.server.db.app, await actorOf(rig.server, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const r = await tx.command(
          {
            type: 'SIGN_PERFORMED',
            commandId: randomUUID(),
            actor: engineActor(who.personId, roles),
            expectedVersion: tx.state.version,
            step: 'p-disp-pcm',
            context: [],
            signature: { id: randomUUID(), meaning: 'VERIFIED', signer: who.personId },
          },
          roles,
        );
        refusal = r.refusal?.code;
      }),
    );
    expect({ outcome, refusal }).toEqual({ outcome: 'ok', refusal: 'ENG-SIGNATURE-MEANING' });

    const after = await rowsOf(rig.server, d.runId);
    expect(after.slice(0, rowsBefore.length)).toEqual(rowsBefore);
    expect(after.slice(rowsBefore.length)).toMatchObject([{ kind: 'COMMAND', command_type: 'SIGN_PERFORMED', accepted: false, refusal: { code: 'ENG-SIGNATURE-MEANING' } }]);
    const now = await projectionOf(d);
    expect(now.version).toBe(before.version);
    expect(pcmOf(now.state)['status']).toBe('IN_PROGRESS');
    expect(performFingerprint(now.state)).toEqual(expect.any(String));
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});

describe('tablets 0520: the marks of a correlation id keep what each side wrote, so a stale refusal and a claim of a scale reading under one correlation id never both commit (DI-32, DI-34)', () => {
  it('[DI-32][DI-34][PR-19] written past the server: one reading claimed alone under a correlation id marks it as claimed, and a stale row under it later is refused at commit (EBMR-EXE-124); a second stale row under a correlation id keeps its mark of a stale refusal, and a claim under it later is refused at commit; the readings refused there stay unused for the next accepted weighing', async () => {
    const d = await preparedRun();
    const operator = (correlationId: string) => actorOf(rig.server, d.browser('operator1'), 'operator1', { correlationId });
    const staleRowUnder = async (correlationId: string) => codeOf(withCommand(rig.server.db.app, await operator(correlationId), (c) => staleException(c, d, 'operator1')));

    // One reading claimed alone (a tare, in a command that writes no row; the residual of decision F58.2), then a stale
    // row under the same correlation id in a later transaction.
    const one = await readings();
    const w = randomUUID();
    const claimedAlone = await codeOf(
      withCommand(rig.server.db.app, await operator(w), (c) => c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'TARE')", [one.tare])),
    );
    expect(claimedAlone).toBe('ok');
    expect(await markOf(w)).toEqual({ claimed: true, stale_refusal: false });
    const rowsBefore = await rowsOf(rig.server, d.runId);
    expect(await staleRowUnder(w)).toBe('EBMR-EXE-124');
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await markOf(w)).toEqual({ claimed: true, stale_refusal: false });
    expect(await usesOf([one.tare, one.gross])).toBe(1);

    // Two stale rows under one correlation id, each committed in a transaction of its own; then its readings claimed
    // under it in a later transaction.
    const z = randomUUID();
    expect(await staleRowUnder(z)).toBe('ok');
    expect(await markOf(z)).toEqual({ claimed: false, stale_refusal: true });
    expect(await staleRowUnder(z)).toBe('ok');
    expect(await markOf(z)).toEqual({ claimed: false, stale_refusal: true });
    expect((await rowsOf(rig.server, d.runId)).slice(rowsBefore.length)).toMatchObject([
      { kind: 'COMMAND', command_type: 'RAISE_EXCEPTION', accepted: false, refusal: { code: 'ENG-STALE' } },
      { kind: 'COMMAND', command_type: 'RAISE_EXCEPTION', accepted: false, refusal: { code: 'ENG-STALE' } },
    ]);
    const pair = await readings();
    expect(await claimAlone(d, pair, z)).toBe('EBMR-EXE-124');
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);
    expect(await markOf(z)).toEqual({ claimed: false, stale_refusal: true });

    // The readings the refused claim named were never used: the weighing from the current screen uses them.
    expect(outcomeOf(await d.command('operator1', weighing(pair.tare, pair.gross)))).toBe('ok');
    expect(await usesOf([pair.tare, pair.gross])).toBe(2);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
