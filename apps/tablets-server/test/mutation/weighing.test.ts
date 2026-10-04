/**
 * Kill tests of the SQL mutation group weighing (tools/sql-mutation/src/targets.ts) at database level: rows written past
 * the server through the store with the application role (ADR 0012: the application role is the attacker, with the
 * same database rights as the server), as the group's own tests write them (test/execution/db-guards-weighing-net.test.ts
 * and db-guards-weighing-record.test.ts).
 *
 * Mutation batch 2 (e236af3) left these behaviours of the row triggers untested:
 *  - recipe-core 0323 (zm_execution_weighing_item, EBMR-EXE-139): the first weighing a batch records is read like any
 *    later one; the round-3 tests forged a second container beside an honest one;
 *  - recipe-core 0322 (zm_execution_weighing_record, EBMR-EXE-138): a row that brings in a block value counted from
 *    weighings without ending its step is read: the preparation for the PERFORMED signature, whose finalisation
 *    computes the step's quantity, at the batch's first step (no block value and no ended step before it), and a
 *    refused SIGN_PERFORMED recorded with that finalisation (the refusal names its row in its own words); and the first
 *    step a batch ends is read for the total of its weighings although no step was ended before it.
 * The pure checks of the group are in packages/recipe-core/test/mutation/weighing.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, messageOf, prepareSignature, unmatched } from '../execution/db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, RunDriver, startExecServer, violations, writePackage, type ExecServer } from '../execution/support.ts';

type Json = Record<string, unknown>;

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
const EXC = 'p-disp-exc@';
const OUT = 'p-early-out@';

const weighing = (stepKey: string, item: string, bomLine: string, lotCode: string, gross: string, tare: string) =>
  ({ type: 'RECORD_ENTRY', stepKey, entry: { kind: 'CONTAINER_WEIGHING', item, bomLine, lotCode, manual: { gross, tare, unit: 'kg' } } }) as const;

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

const container = { kind: 'OUTPUT_CONTAINER' as const, intermediate: 'I-EARLY', manual: { gross: '26.100', tare: '1.050', unit: 'kg' } };

/** dc-mini with an output step first in the dispensing booth, started by operator1: it records earlyNet (kg) and produces I-EARLY. */
async function atEarlyOutput(): Promise<RunDriver> {
  const content = dcMiniVariant((prep, c) => {
    (c['intermediates'] as Json[]).push({ id: 'I-EARLY', name: 'Early output', holdTime: { max: { value: '30', unit: 'd' }, source: { kind: 'HOLD_STUDY', ref: 'HS-PCM-01' }, storage: 'Closed, labelled containers' } });
    (c['parameters'] as Json[]).push({ id: 'earlyNet', name: 'Early output (net)', valueType: 'DECIMAL', unit: 'kg', precision: { kind: 'DECIMALS', digits: 3 }, role: 'QUANTITY', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'DEVICE' });
    const out = { kind: 'phase', id: 'p-early-out', name: 'Discharge the early output', block: { type: 'G-22', version: '1' }, config: {}, records: ['earlyNet'], computes: [], reads: [], consumes: [], produces: ['I-EARLY'], uses: [], equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } }, significant: true, riskClass: 'HIGH' };
    return [out, ...prep];
  });
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: OUT });
  return d;
}

/**
 * operator1's RECORD_ENTRY of `entry` at `stepKey` in DISP-1, resolved and run through the engine as the server does, then
 * stored through the application's role with the new entry's data and the recorded command changed by `forge`. 'ok', or
 * the refusal's message.
 */
async function entryForged(d: RunDriver, stepKey: string, entry: Json, forge: (data: Json, command: Json) => void): Promise<string> {
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
      const recorded = structuredClone(engine.encodeCommand(resolved.command)) as Json;
      forge(added.data, recorded);
      return appendAs(tx, resolved.command, { state, events: r.events }, roles, recorded as engine.JsonValue, engine.changedContents(tx.def, tx.state, state), resolved.evidence as engine.JsonValue);
    }),
  );
}

/** The block values the row adds to `state` after `before` (source BLOCK): exactly one, or the set-up is wrong. */
function addedBlockValue(before: engine.BatchState, state: engine.BatchState): engine.DataPoint {
  const added = Object.values(state.points).filter((x) => !(x.id in before.points) && x.source.mode === 'BLOCK');
  if (added.length !== 1 || !added[0]) throw new Error(`SETUP: the engine computed ${JSON.stringify(added.map((x) => x.value))}`);
  return added[0];
}

/**
 * operator1's preparation for the PERFORMED signature of `stepKey` (no frames), its finalisation run by the engine as
 * ExecutionTx.prepare runs it, stored through the application's role as the PREPARE row with the state changed by
 * `forge` (the block value it adds). 'ok', or the refusal's message.
 */
async function preparedWith(d: RunDriver, stepKey: string, forge: (point: engine.DataPoint) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(who.personId, roles);
      const target: engine.SignatureTarget = { type: 'SIGN_PERFORMED', step: stepKey.replace(/@$/, ''), context: [] };
      const p = engine.prepareForSignature(tx.def, tx.state, target, actor, { nowUs: tx.nowUs });
      const state = structuredClone(p.state);
      forge(addedBlockValue(tx.state, state));
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id,
        expectedSeq: tx.lastSeq,
        kind: 'PREPARE',
        command: engine.encode({ type: 'PREPARE', target, actor, meaning: 'PERFORMED' }),
        commandId: `PREPARE:${randomUUID()}`,
        nowUs: tx.nowUs,
        accepted: true,
        state,
        events: p.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, state),
      });
    }),
  );
}

/**
 * operator1's signed SIGN_PERFORMED of `stepKey` (no frames), run through the engine and stored through the
 * application's role with the state changed by `forge` (the state and the block value the row adds). 'ok', or the
 * refusal's message.
 */
async function performedWith(d: RunDriver, stepKey: string, forge?: (state: engine.BatchState, point: engine.DataPoint) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', `${d.runId}:${stepKey}`, 'PERFORMED');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: stepKey.replace(/@$/, ''), context: [], signature: { id, meaning: 'PERFORMED', signer: who.personId } };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      if (!r.accepted) throw new Error(`SETUP: the engine refused the signing: ${JSON.stringify(r.refusal)}`);
      const state = structuredClone(r.state);
      forge?.(state, addedBlockValue(tx.state, state));
      return appendAs(tx, command, { state, events: r.events }, roles);
    }),
  );
}

/**
 * operator1's SIGN_PERFORMED of `stepKey` (no frames) with the dry run's placeholder signature, refused by the engine,
 * stored through the application's role as the refused COMMAND row the server records for a refused signing (its
 * evidence 'refused before signing'), with the finalisation the engine keeps in it (the block value it adds) changed by
 * `forge`. 'ok', or the refusal's message; `refusal` receives the engine's refusal.
 */
async function refusedPerformedWith(d: RunDriver, stepKey: string, refusal: { code?: string }, forge?: (point: engine.DataPoint) => void): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(who.personId, roles);
      const command: engine.Command = {
        type: 'SIGN_PERFORMED', commandId: `ESIG-DRY:${randomUUID()}`, actor, expectedVersion: tx.state.version, step: stepKey.replace(/@$/, ''), context: [],
        signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'PERFORMED', signer: who.personId },
      };
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      if (r.accepted || !r.refusal) throw new Error('SETUP: the engine accepted the signing');
      refusal.code = r.refusal.code;
      const state = structuredClone(r.state);
      forge?.(addedBlockValue(tx.state, state));
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: engine.encodeCommand(command),
        commandId: command.commandId,
        nowUs: tx.nowUs,
        accepted: false,
        refusal: r.refusal,
        state,
        events: r.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, state),
        evidence: { signing: 'refused before signing', meaning: 'PERFORMED' },
      });
    }),
  );
}

async function entryIds(d: RunDriver, kind: string): Promise<string[]> {
  const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  return Object.values(state?.entries ?? {}).filter((e) => e.kind === kind).map((e) => e.id);
}

/** The block values of `item` the stored state holds: value, status and the entries they are computed from. */
async function totalsOf(d: RunDriver, item: string): Promise<unknown[]> {
  const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
  return Object.values(state?.points ?? {}).filter((x) => x.item === item && x.source.mode === 'BLOCK').map((x) => ({ value: x.value, status: x.status, entries: (x.source as unknown as { entries: string[] }).entries }));
}

async function rowCount(d: RunDriver): Promise<number> {
  return (await sbx.db.admin.query('select 1 from recipe.execution_command where batch_id = $1', [d.runId])).rows.length;
}

const ITEM_RULE = String.raw`a weighing counts into the quantity its phase records in the MBR, decided by the database, never by the entry \(INV-25, PR-19\)\. \[EBMR-EXE-139\]$`;
const TOTAL_RULE = String.raw`a quantity counted from weighings is the sum of their nets, every one, at the resolution they were weighed at \(INV-25, PR-19\)\. \[EBMR-EXE-138\]$`;

describe('recipe.execution_weighing_item_check (sql 0323): every weighing a row brings in counts into its phase\'s quantity, the batch\'s first one too (INV-25, PR-19)', () => {
  it('[INV-25][PR-19][DI-30] the first dispensed container of a batch stored without item, or counting into another quantity, is refused (EBMR-EXE-139) and nothing is written; the honest weighing is then recorded', async () => {
    const d = await atWeighing();
    expect(await entryIds(d, 'CONTAINER_WEIGHING')).toEqual([]);
    const rows = await rowCount(d);
    const first: Json = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } };
    const outcomes = {
      noItem: await entryForged(d, PCM, first, (data) => {
        delete data['item'];
      }),
      otherQuantity: await entryForged(d, PCM, first, (data, command) => {
        data['item'] = 'excDispensed';
        (command['entry'] as Json)['item'] = 'excDispensed';
      }),
    };
    expect(unmatched(outcomes, {
      noItem: new RegExp(String.raw`^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) at p-disp-pcm@ counted into \(no item\), where its phase p-disp-pcm records the mass quantities \["pcmDispensed"\]: ` + ITEM_RULE),
      otherQuantity: new RegExp(String.raw`^This accepted RECORD_ENTRY row stores entry EN-\d+ \(CONTAINER_WEIGHING\) at p-disp-pcm@ counted into "excDispensed", where its phase p-disp-pcm records the mass quantities \["pcmDispensed"\]: ` + ITEM_RULE),
    })).toEqual({});
    expect({ weighings: await entryIds(d, 'CONTAINER_WEIGHING'), rows: await rowCount(d) }).toEqual({ weighings: [], rows });
    await d.ok('operator1', weighing(PCM, 'pcmDispensed', 'BOM-PCM', 'TEST-L26-0101', '51.250', '1.250'));
    expect(await entryIds(d, 'CONTAINER_WEIGHING')).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] the first output container of a batch stored into no quantity, where its phase records one, is refused (EBMR-EXE-139) and nothing is written; the honest container is then recorded', async () => {
    const d = await atEarlyOutput();
    const rows = await rowCount(d);
    const outcomes = {
      nullItem: await entryForged(d, OUT, container, (data) => {
        data['item'] = null;
      }),
    };
    expect(unmatched(outcomes, {
      nullItem: new RegExp(String.raw`^This accepted RECORD_ENTRY row stores entry EN-\d+ \(OUTPUT_CONTAINER\) at p-early-out@ counted into null, where its phase p-early-out counts it into "earlyNet": ` + ITEM_RULE),
    })).toEqual({});
    expect({ outputs: await entryIds(d, 'OUTPUT_CONTAINER'), rows: await rowCount(d) }).toEqual({ outputs: [], rows });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: OUT, entry: container });
    expect(await entryIds(d, 'OUTPUT_CONTAINER')).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);
});

describe('recipe.execution_weighing_record_check (sql 0322): every row that brings in a total of weighings, or ends a step that has them, is read (INV-25, PR-19)', () => {
  it('[INV-25][PR-19][DI-30] at the batch\'s first step, before any block value, a preparation for the PERFORMED signature whose finalisation records the produced quantity at another resolution or as another figure is refused (EBMR-EXE-138) and nothing is written; the honest signing records 25.050 kg', async () => {
    const d = await atEarlyOutput();
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: OUT, entry: container });
    const [output] = await entryIds(d, 'OUTPUT_CONTAINER');
    expect(await totalsOf(d, 'earlyNet')).toEqual([]);
    const rows = await rowCount(d);
    const setValue = (value: string) => (x: engine.DataPoint) => {
      x.value = { kind: 'DECIMAL', value, unit: 'kg' };
    };
    const outcomes = { coarser: await preparedWith(d, OUT, setValue('25.05')), other: await preparedWith(d, OUT, setValue('26.050')) };
    const refused = (value: string) =>
      new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row records block value DP-\d+ of earlyNet at p-early-out@ as \{"kind": "DECIMAL", "unit": "kg", "value": "${value.replace('.', '\\.')}"\}, where the nets of its weighings \["${String(output)}"\] come to 25\.050 kg at the resolution they were weighed at: ` + TOTAL_RULE);
    expect(unmatched(outcomes, { coarser: refused('25.05'), other: refused('26.050') })).toEqual({});
    expect({ totals: await totalsOf(d, 'earlyNet'), rows: await rowCount(d) }).toEqual({ totals: [], rows });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: OUT });
    expect(await totalsOf(d, 'earlyNet')).toEqual([{ value: { kind: 'DECIMAL', value: '25.050', unit: 'kg' }, status: 'VALID', entries: [output] }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] the batch\'s first step signed performed without the total of its weighings is refused (EBMR-EXE-138), though no step was ended before it, and nothing is written; the honest signing ends it with 25.050 kg', async () => {
    const d = await atEarlyOutput();
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: OUT, entry: container });
    const [output] = await entryIds(d, 'OUTPUT_CONTAINER');
    const before = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    expect(Object.values(before?.steps ?? {}).filter((s) => s.status === 'AWAITING_VERIFICATION' || s.status === 'COMPLETED')).toEqual([]);
    const rows = await rowCount(d);
    const noTotal = await performedWith(d, OUT, (s, x) => {
      delete s.points[x.id];
    });
    expect(noTotal).toMatch(new RegExp(String.raw`^This accepted SIGN_PERFORMED row records step p-early-out@ as AWAITING_VERIFICATION with 0 valid block values of earlyNet, where its weighings count into exactly one: ` + TOTAL_RULE));
    expect({ status: (await execution.loadState(sbx.db.admin, d.runId))?.state.steps[OUT]?.status, rows: await rowCount(d) }).toEqual({ status: 'IN_PROGRESS', rows });
    expect(await performedWith(d, OUT)).toBe('ok');
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.steps[OUT]?.status).toBe('AWAITING_VERIFICATION');
    expect(await totalsOf(d, 'earlyNet')).toEqual([{ value: { kind: 'DECIMAL', value: '25.050', unit: 'kg' }, status: 'VALID', entries: [output] }]);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[INV-25][PR-19][DI-30] a refused signing recorded with its finalisation is read too: the refused SIGN_PERFORMED of a step with a BOM line not yet dispensed, whose dispensed quantity is not its weighings\' total, is refused in its own words (EBMR-EXE-138) and nothing is written; the engine\'s own refusal is recorded with 9.400 kg', async () => {
    const d = await atWeighing();
    await d.ok('operator1', weighing(PCM, 'pcmDispensed', 'BOM-PCM', 'TEST-L26-0101', '51.250', '1.250'));
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: PCM });
    await d.signed('verifier1', { type: 'VERIFY', stepKey: PCM, meaning: 'VERIFIED' });
    await d.ok('operator1', { type: 'START_STEP', stepKey: EXC });
    // The microcrystalline cellulose weighed, the magnesium stearate not yet: the step cannot be signed performed.
    await d.ok('operator1', weighing(EXC, 'excDispensed', 'BOM-MCC', 'TEST-L26-0102', '10.400', '1.000'));
    const [, mcc] = await entryIds(d, 'CONTAINER_WEIGHING');
    expect(await totalsOf(d, 'excDispensed')).toEqual([]);
    const rows = await rowCount(d);
    const refusal: { code?: string } = {};
    const forged = await refusedPerformedWith(d, EXC, refusal, (x) => {
      x.value = { kind: 'DECIMAL', value: '9.4', unit: 'kg' };
    });
    expect(refusal.code).toBe('G07-BOM-INCOMPLETE');
    expect(forged).toMatch(new RegExp(String.raw`^This refused SIGN_PERFORMED row records block value DP-\d+ of excDispensed at p-disp-exc@ as \{"kind": "DECIMAL", "unit": "kg", "value": "9\.4"\}, where the nets of its weighings \["${String(mcc)}"\] come to 9\.400 kg at the resolution they were weighed at: ` + TOTAL_RULE));
    expect({ totals: await totalsOf(d, 'excDispensed'), rows: await rowCount(d) }).toEqual({ totals: [], rows });
    expect(await refusedPerformedWith(d, EXC, refusal)).toBe('ok');
    const { rows: last } = await sbx.db.admin.query<{ accepted: boolean; code: string }>(
      `select accepted, refusal ->> 'code' as code from recipe.execution_command where batch_id = $1 order by seq desc limit 1`,
      [d.runId],
    );
    expect({ last: last[0], totals: await totalsOf(d, 'excDispensed'), status: (await execution.loadState(sbx.db.admin, d.runId))?.state.steps[EXC]?.status }).toEqual({
      last: { accepted: false, code: 'G07-BOM-INCOMPLETE' },
      totals: [{ value: { kind: 'DECIMAL', value: '9.400', unit: 'kg' }, status: 'VALID', entries: [mcc] }],
      status: 'IN_PROGRESS',
    });
    expect(await violations(sbx)).toEqual([]);
  }, 600_000);
});
