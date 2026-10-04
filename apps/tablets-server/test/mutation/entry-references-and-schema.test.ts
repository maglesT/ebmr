/**
 * The trigger of recipe-core 0330 (zzd_execution_entry_block, recipe.execution_entry_block_check) through the
 * application role, the attacker of ADR 0012 (SQL mutation group "entry-references-and-schema"; the rules its function
 * applies are tested in packages/recipe-core/test/mutation/entry-references-and-schema.test.ts). These tests close the
 * gaps the SQL mutation run (tools/sql-mutation, batch 2) found in apps/tablets-server/test/execution
 * db-guards-entry-identifiers.test.ts: the trigger reads every row that adds an entry, the first entry of a batch
 * included, and holds it to the MBR of the batch's own test package (not to another batch's or another package's).
 *
 * Controls: DI-05 (no identifier in the record that its MBR does not give it), DI-10 and DI-30 (an entry holds exactly
 * what its block builds from what was entered and the batch's MBR).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from '../execution/db-guards-support.ts';
import { dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from '../execution/support.ts';

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

/** The step this file adds first to the dispensing preparation: an acknowledgement of the clearance SOP. */
const ACK = 'p-early-ack';
/** The SOP references of dc-mini (its references list): the one the new step names, and the dispensing SOP's. */
const CLEAN_SOP = { sop: 'SOP-CLEAN-003', sopVersion: '1', sopHash: 'ec88ec86896ccb82445f5cdd6b762cb1830e67b164120a200c4a306e60c49a41' };
const DISP_SOP = { sop: 'SOP-DISP-001', sopVersion: '1', sopHash: 'a10392006925d1f24c34701fcb7c0b1c5ce2793bd979c2fcececb826d4b41f8a' };

/**
 * A test batch of dc-mini with an acknowledgement of SOP-CLEAN-003 first in the dispensing preparation (dc-mini's own
 * acknowledgement step, p-disp-sop, names SOP-DISP-001), its package imported once, issued and that step started: the
 * batch has no entry yet.
 */
async function earlyAcknowledgementRun(): Promise<RunDriver> {
  const content = dcMiniVariant((prep) => {
    const sop = prep.find((x) => x['id'] === 'p-disp-sop');
    if (!sop) throw new Error('SETUP: no SOP step');
    return [{ ...sop, id: ACK, name: 'Read the room and line clearance SOP', config: { sop: CLEAN_SOP.sop, acknowledgement: 'READ' } }, ...prep];
  });
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: `${ACK}@` });
  return d;
}

/**
 * operator1's entry `entry` at step `stepKey`, resolved and run through the engine as the server does, then stored
 * through the application role after `forge` changed the new entry's data: what a writer that stores another entry than
 * the block builds stores. 'ok' or the refusal.
 */
async function forgedEntry(d: RunDriver, stepKey: string, entry: Json, forge: (data: Json) => void = () => undefined): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        { type: 'RECORD_ENTRY', stepKey, entry } as Parameters<typeof resolveClientIntent>[1],
      );
      const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the entry: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const added = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
      if (!added) throw new Error('SETUP: no new entry');
      forge(added.data);
      return appendAs(tx, resolved.command, { state, events: r.events }, roles, engine.encodeCommand(resolved.command), engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
    }),
  );
}

async function entriesOf(runId: string): Promise<Json[]> {
  return Object.values((await execution.loadState(sbx.db.admin, runId))?.state.entries ?? {}).map((e) => ({ id: e.id, kind: e.kind, data: e.data }));
}

describe('recipe-core 0330 through the application role: every entry a row adds is held to what its block builds from the batch\'s own MBR (DI-05, DI-10, DI-30)', () => {
  it('[DI-30][DI-10][DI-05] the first entry of a batch is read like any other, against the MBR of the batch\'s own package: an acknowledgement naming the SOP another step of the MBR names is refused (EBMR-EXE-126) and nothing holds it; the acknowledgement of the SOP its own step names is recorded', async () => {
    const d = await earlyAcknowledgementRun();
    expect(await entriesOf(d.runId)).toEqual([]);
    const ack = { kind: 'ACKNOWLEDGE', mode: 'READ' };
    // The engine's own result, its data naming the dispensing SOP (the one dc-mini's p-disp-sop names, in every other dc-mini package).
    expect(await forgedEntry(d, `${ACK}@`, ack, (data) => Object.assign(data, DISP_SOP))).toBe(
      `This accepted RECORD_ENTRY row stores entry EN-1 (ACKNOWLEDGE) of step ${ACK}@ with sop "${DISP_SOP.sop}", where its block writes "${CLEAN_SOP.sop}": an entry holds exactly what its block builds from what was entered, the batch's MBR, the batch, its step, its person and the time, and only what the block accepts (DI-05, DI-10, DI-30, PR-14, PR-18, PR-23, PR-29, PR-34, PR-40, PR-47). [EBMR-EXE-126]`,
    );
    expect(await entriesOf(d.runId)).toEqual([]);
    // The honest acknowledgement: what the block builds from this batch's MBR.
    expect(await forgedEntry(d, `${ACK}@`, ack)).toBe('ok');
    expect(await entriesOf(d.runId)).toEqual([{ id: 'EN-1', kind: 'ACKNOWLEDGE', data: { mode: 'READ', acknowledgedBy: personaIn(sbx, 'operator1').personId, ...CLEAN_SOP } }]);
  }, 300_000);
});
