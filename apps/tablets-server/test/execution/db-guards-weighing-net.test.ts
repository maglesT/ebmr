/**
 * Lead TODO T2 of the Phase 2 exit (INV-25, PR-19, DI-30; recipe-core sql 0321): the net weight a weighing entry records
 * is gross minus tare, exactly, at the resolution of the weighings. Engine 1.2.0 writes it so ("50.000" for 51.250 -
 * 1.250); the database checks it for every weighing entry a row brings in (EBMR-EXE-136), so a row written with the
 * application's own role cannot record another net, nor the net without its resolution, beside honest weighings.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const PCM = 'p-disp-pcm@';

/** dc-mini at the paracetamol weighing, started by operator1 (the steps before it done as the server does them). */
async function atWeighing(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  const step = async (key: string, entries: Parameters<RunDriver['ok']>[1][], verify: boolean) => {
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    for (const e of entries) await d.ok('operator1', e);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
    if (verify) await d.signed('verifier1', { type: 'VERIFY', stepKey: key, meaning: 'VERIFIED' });
  };
  await step('p-disp-clear@', [
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'CLEARANCE_CHECK', answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
    { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
  ], true);
  await step('p-disp-bal@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } }], false);
  await step('p-disp-sop@', [{ type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } }], false);
  await step('p-disp-calc@', [], false);
  await d.ok('operator1', { type: 'START_STEP', stepKey: PCM });
  return d;
}

/**
 * operator1's hand-keyed weighing of the paracetamol (51.250 - 1.250), resolved and run through the engine as the server
 * does, then stored through the application's role with `net` written in the new entry and its container instead of the
 * engine's.
 */
async function weighingWithNet(d: RunDriver, net: string | null): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        { type: 'RECORD_ENTRY', stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } },
      );
      const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the weighing: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      const entry = Object.values(state.entries).find((e) => !(e.id in tx.state.entries));
      if (!entry) throw new Error('SETUP: no new entry');
      if (entry.data['net'] !== '50.000') throw new Error(`SETUP: the engine wrote net ${String(entry.data['net'])}`);
      if (net !== null) {
        entry.data = { ...entry.data, net };
        const container = state.containers[String(entry.data['container'])];
        if (container?.net) container.net = { ...container.net, value: net };
      }
      return appendAs(tx, resolved.command, { state, events: r.events }, roles, engine.encodeCommand(resolved.command), engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
    }),
  );
}

describe('T2: a recorded net weight keeps the resolution of the weighings (INV-25, PR-19; sql 0321)', () => {
  it('[INV-25][PR-19][DI-30] a weighing row recording its net without the trailing zeros of the weighings, or another net, is refused; the engine\'s own net is recorded', async () => {
    const d = await atWeighing();
    const rowsBefore = (await sbx.db.admin.query('select 1 from recipe.execution_command where batch_id = $1', [d.runId])).rows.length;
    const outcomes = {
      withoutResolution: await weighingWithNet(d, '50'),
      anotherNet: await weighingWithNet(d, '49.000'),
      honest: await weighingWithNet(d, null),
    };
    expect(outcomes.withoutResolution).toMatch(/^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) with net "50", where gross 51\.250 minus tare 1\.250 is 50\.000 at the resolution of the weighings: .*\[EBMR-EXE-136\]$/);
    expect(outcomes.anotherNet).toMatch(/with net "49\.000", where gross 51\.250 minus tare 1\.250 is 50\.000 .*\[EBMR-EXE-136\]$/);
    expect(outcomes.honest).toBe('ok');
    expect((await sbx.db.admin.query('select 1 from recipe.execution_command where batch_id = $1', [d.runId])).rows.length).toBe(rowsBefore + 1);
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(Object.values(state?.entries ?? {}).filter((e) => e.kind === 'CONTAINER_WEIGHING').map((e) => e.data['net'])).toEqual(['50.000']);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19] the database\'s reading: gross minus tare at the finer resolution, for both weighing kinds; other entries pass', async () => {
    const problem = async (entry: unknown): Promise<string | null> => {
      const { rows } = await sbx.db.admin.query<{ p: string | null }>('select recipe.weighing_net_problem($1::jsonb) as p', [JSON.stringify(entry)]);
      return rows[0]?.p ?? null;
    };
    const w = (kind: string, gross: unknown, tare: unknown, net: unknown) => ({ kind, data: { gross, tare, net, unit: 'kg' } });
    expect({
      honest: await problem(w('CONTAINER_WEIGHING', '51.250', '1.250', '50.000')),
      mixed: await problem(w('OUTPUT_CONTAINER', '26.10', '1.05', '25.05')),
      finer: await problem(w('OUTPUT_CONTAINER', '5.50', '1.125', '4.375')),
      whole: await problem(w('CONTAINER_WEIGHING', '7', '2', '5')),
      dropped: await problem(w('CONTAINER_WEIGHING', '51.250', '1.250', '50')),
      padded: await problem(w('CONTAINER_WEIGHING', '7', '2', '5.0')),
      wrong: await problem(w('OUTPUT_CONTAINER', '26.10', '1.05', '25.06')),
      numberNet: await problem(w('CONTAINER_WEIGHING', '7', '2', 5)),
      noNet: await problem({ kind: 'CONTAINER_WEIGHING', data: { gross: '7', tare: '2' } }),
      notDecimal: await problem(w('CONTAINER_WEIGHING', '1e3', '2', '998')),
      other: await problem({ kind: 'CLEARANCE_CHECK', data: { net: 'anything' } }),
    }).toEqual({
      honest: null,
      mixed: null,
      finer: null,
      whole: null,
      dropped: '(CONTAINER_WEIGHING) with net "50", where gross 51.250 minus tare 1.250 is 50.000 at the resolution of the weighings',
      padded: '(CONTAINER_WEIGHING) with net "5.0", where gross 7 minus tare 2 is 5 at the resolution of the weighings',
      wrong: '(OUTPUT_CONTAINER) with net "25.06", where gross 26.10 minus tare 1.05 is 25.05 at the resolution of the weighings',
      numberNet: '(CONTAINER_WEIGHING) with net 5, where gross 7 minus tare 2 is 5 at the resolution of the weighings',
      noNet: '(CONTAINER_WEIGHING) with net null, where gross 7 minus tare 2 is 5 at the resolution of the weighings',
      notDecimal: '(CONTAINER_WEIGHING) with no gross and tare as decimal text',
      other: null,
    });
  }, 300_000);
});
