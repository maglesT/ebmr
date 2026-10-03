/**
 * Phase 2 exit review F58.1 (DI-34, DI-32, PR-19): a command from a screen that showed another version of the run is
 * recorded as the engine's refusal ENG-STALE, changes nothing and uses none of the scale readings it names; the
 * database holds every such row to that (recipe-core 0326, tablets 0500; ADR 0012: the application role is the attacker,
 * with the same database rights as the server).
 *
 * F58 answered a stale run command before anything was written, so its scale readings were not spent, but the attempt
 * was then no row of the run (DI-34 records a refused engine call with its refusal). The server records it again and
 * names the readings without using them. Written past the server, through the store as the server writes:
 *  - recipe-core 0326, EBMR-EXE-140: a command whose screen showed another version than the run's is recorded only as
 *    the refusal ENG-STALE, and that refusal only for such a command; a stale refusal stores the state before it,
 *    changed only by the time sweep;
 *  - tablets 0500, EBMR-EXE-124: a stale refusal used no reading in its command and lists none as used; the readings of
 *    a stale weighing are the stored readings it states, one named for each purpose, and (tablets 0510) a tare and a
 *    gross the claims of its command would accept now, together (otherwise the claim's own refusal, EBMR-DEV-1xx; one
 *    reading named as both is refused as the gross claim refuses it, EBMR-DEV-105), so the next accepted weighing uses
 *    them.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { newRun, PCM, reachPcm, report, startRig, stopRig, type Rig } from '../devices/room-scales-support.ts';
import { actorOf, appendAs, codeOf, unmatched } from './db-guards-support.ts';
import { outcomeOf, personaIn, rowsOf, violations, type RunDriver } from './support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

type Json = Record<string, unknown>;

const weighing = (tareReadingId: string, grossReadingId: string, lotCode = 'TEST-L26-0101') => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: PCM,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode, tareReadingId, grossReadingId },
});

/** A stable tare and gross of TEST-BAL-01 (the DISP-1 balance), ingested as the gateway sends them (`delayUs`: the wait it signed). */
async function readings(tare = '1.250', gross = '26.250', delayUs = '1000'): Promise<{ tare: string; gross: string }> {
  const t = rig.gw.next({ value: tare, purpose: 'TARE' });
  const g = rig.gw.next({ value: gross, purpose: 'GROSS' });
  const res = await rig.gw.uplink([
    { reading: t, delayUs },
    { reading: g, delayUs },
  ]);
  expect(res.body.refused, JSON.stringify(res.body.refused)).toBeNull();
  return { tare: t.readingId, gross: g.readingId };
}

async function usesOf(ids: readonly string[]): Promise<number> {
  return (await rig.server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids])).rows.length;
}

interface PastOptions {
  /** The version the screen showed (default: one before the run's). */
  seen?: (version: number) => number;
  /** Whether the resolution uses (claims) the readings, as for a fresh screen (default false, as for a stale one). */
  useReadings?: boolean;
  lotCode?: string;
  /** Changes the resolved command and evidence before the engine runs and the row is written. */
  edit?: (command: Json & { entry: Json }, evidence: Json) => void;
}

/**
 * operator1's weighing of `ids` written past the server, on DISP-1's kiosk, through the store: the intent resolved as
 * the server resolves it (readings named, not used, unless `useReadings`), the engine's result appended. The
 * database's refusal code, or 'ok'.
 */
async function weighingPast(d: RunDriver, ids: { tare: string; gross: string }, opts: PastOptions = {}): Promise<string> {
  const run = await runContext(rig.server.db.admin, d.runId);
  const who = personaIn(rig.server, 'operator1');
  return codeOf(
    withCommand(rig.server.db.app, await actorOf(rig.server, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        {
          client: c,
          app: rig.server.built.ctx,
          def: run.def,
          state: tx.state,
          room: 'DISP-1',
          actor: engineActor(who.personId, roles),
          commandId: randomUUID(),
          expectedVersion: (opts.seen ?? ((v) => v - 1))(tx.state.version),
          useReadings: opts.useReadings ?? false,
        },
        weighing(ids.tare, ids.gross, opts.lotCode),
      );
      const command = structuredClone(resolved.command) as unknown as Json & { entry: Json };
      const evidence = structuredClone(resolved.evidence);
      opts.edit?.(command, evidence);
      return tx.command(command as unknown as engine.Command, roles, evidence as engine.JsonValue);
    }),
  );
}

/** The readings a resolved stale weighing names (its evidence.namedReadings). */
const named = (evidence: Json): Json[] => evidence['namedReadings'] as Json[];

/** Replaces the reading a stale weighing names for `purpose` by `readingId` (its value is the same). */
const naming = (purpose: 'TARE' | 'GROSS', readingId: string) => (_: Json, evidence: Json) => {
  for (const r of named(evidence)) if (r['purpose'] === purpose) r['readingId'] = readingId;
};

/** What a forged row records: the command (encoded as the store encodes it, then `json` applied), the verdict, the state. */
type Forge = (
  r: engine.StepResult,
  command: engine.Command,
  version: number,
) => { recorded: engine.Command; json?: (encoded: Json) => void; accepted: boolean; refusal?: engine.Refusal; state?: engine.BatchState };

/**
 * operator1 raises an exception about the paracetamol step (any terminal may) from a screen that showed `seen`, written
 * past the server: the engine's result for it, then `forge` decides what the row records (command, verdict, state). The
 * database's refusal code, or 'ok'.
 */
async function exceptionPast(d: RunDriver, seen: (version: number) => number, forge?: Forge): Promise<string> {
  const run = await runContext(rig.server.db.admin, d.runId);
  const who = personaIn(rig.server, 'operator1');
  return codeOf(
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
      if (!forge) return tx.command(command, roles);
      const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
      const f = forge(r, command, tx.state.version);
      const state = f.state ?? r.state;
      const recorded = engine.encodeCommand(f.recorded) as Json;
      f.json?.(recorded);
      if (f.accepted) return appendAs(tx, command, { state, events: r.events }, roles, recorded as engine.JsonValue);
      return execution.appendExecution(tx.client, {
        batchId: tx.locked.batch.id,
        expectedSeq: tx.lastSeq,
        kind: 'COMMAND',
        command: recorded as engine.JsonValue,
        commandId: command.commandId,
        nowUs: tx.nowUs,
        accepted: false,
        refusal: f.refusal ?? r.refusal,
        state,
        events: r.events,
        roles,
        contents: engine.changedContents(tx.def, tx.state, state),
      });
    }),
  );
}

const STALE: engine.Refusal = { code: 'ENG-STALE', message: 'The batch changed since this screen was loaded (ENG-STALE; DI-34)', controls: ['DI-34'] };

async function preparedRun(): Promise<RunDriver> {
  const d = await newRun(rig);
  await reachPcm(d);
  await report(rig, { 'TEST-BAL-01': 'ONLINE' });
  return d;
}

describe('F58.1: a stale command is the engine\'s refusal, changes nothing and uses no scale reading (DI-34, DI-32)', () => {
  it('[DI-34] a command from a screen that showed another version is recorded only as the refusal ENG-STALE, and that refusal only for such a command: written past the server, an ENG-STALE refusal at the run\'s own version, without a version or with one that is no version, an accepted command and another refusal from an older screen are refused; the engine\'s own stale refusal is recorded', async () => {
    const d = await preparedRun();
    const rowsBefore = (await rowsOf(rig.server, d.runId)).length;
    const older = (v: number) => v - 1;
    const outcomes = {
      atOwnVersion: await exceptionPast(d, older, (_, cmd, v) => ({ recorded: { ...cmd, expectedVersion: v }, accepted: false })),
      withoutVersion: await exceptionPast(d, older, (_, cmd) => ({ recorded: cmd, json: (c) => delete c['expectedVersion'], accepted: false })),
      versionNoNumber: await exceptionPast(d, older, (_, cmd, v) => ({ recorded: { ...cmd, expectedVersion: String(v - 1) as unknown as number }, accepted: false })),
      // The store's codec carries no fraction; a writer of its own JSON may.
      versionNotWhole: await exceptionPast(d, older, (_, cmd, v) => ({ recorded: cmd, json: (c) => (c['expectedVersion'] = v - 0.5), accepted: false })),
      acceptedFromOlderScreen: await exceptionPast(d, (v) => v, (_, cmd, v) => ({ recorded: { ...cmd, expectedVersion: v - 1 }, accepted: true })),
      otherRefusalFromOlderScreen: await exceptionPast(d, older, (_, cmd) => ({ recorded: cmd, accepted: false, refusal: { code: 'ENG-NOT-ENABLED', message: 'Step p-disp-pcm is not enabled', controls: ['DI-34'] } })),
      newerScreenAccepted: await exceptionPast(d, (v) => v, (_, cmd, v) => ({ recorded: { ...cmd, expectedVersion: v + 1 }, accepted: true })),
    };
    expect(unmatched(outcomes, {
      atOwnVersion: 'EBMR-EXE-140',
      withoutVersion: 'EBMR-EXE-140',
      versionNoNumber: 'EBMR-EXE-140',
      versionNotWhole: 'EBMR-EXE-140',
      acceptedFromOlderScreen: 'EBMR-EXE-140',
      otherRefusalFromOlderScreen: 'EBMR-EXE-140',
      newerScreenAccepted: 'EBMR-EXE-140',
    })).toEqual({});
    expect((await rowsOf(rig.server, d.runId)).length).toBe(rowsBefore);

    // The engine's own verdicts are recorded: its stale refusal (the version the screen showed kept with the command),
    // and the same command from the current screen.
    expect(await exceptionPast(d, older)).toBe('ok');
    expect(await exceptionPast(d, (v) => v)).toBe('ok');
    const { rows } = await rig.server.db.admin.query<{ accepted: boolean; refusal: { code: string } | null; seen: number; version: number }>(
      "select accepted, refusal, (command ->> 'expectedVersion')::int as seen, state_version as version from recipe.execution_command where batch_id = $1 order by seq desc limit 2",
      [d.runId],
    );
    const [accepted, stale] = rows;
    const version = stale?.version ?? -1;
    expect(stale).toMatchObject({ accepted: false, refusal: { code: 'ENG-STALE' }, seen: version - 1 });
    expect(accepted).toEqual({ accepted: true, refusal: null, seen: version, version: version + 1 });
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-34] a stale refusal stores the state before it: written past the server, one that moves the version on or counts its command as applied is refused', async () => {
    const d = await preparedRun();
    const rowsBefore = (await rowsOf(rig.server, d.runId)).length;
    const older = (v: number) => v - 1;
    const outcomes = {
      versionMoved: await exceptionPast(d, older, (r, cmd) => ({ recorded: cmd, accepted: false, refusal: STALE, state: { ...r.state, version: r.state.version + 1 } })),
      countedAsApplied: await exceptionPast(d, older, (r, cmd) => ({ recorded: cmd, accepted: false, refusal: STALE, state: { ...r.state, appliedCommands: [...r.state.appliedCommands, cmd.commandId] } })),
      asTheEngineLeftIt: await exceptionPast(d, older, (_, cmd) => ({ recorded: cmd, accepted: false })),
    };
    expect(unmatched(outcomes, { versionMoved: 'EBMR-EXE-140', countedAsApplied: 'EBMR-EXE-140', asTheEngineLeftIt: 'ok' })).toEqual({});
    expect((await rowsOf(rig.server, d.runId)).length).toBe(rowsBefore + 1);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-32][DI-34][PR-19] written past the server, a stale weighing names its scale readings without using them: recorded when they are the stored readings it states and a claim would accept them now, and the next accepted weighing uses them; refused when its weights are not the readings\', a reading is not named once, already used or too old, or its command claimed or lists readings as used; a refusal that is not stale still stands on readings claimed for it', async () => {
    const d = await preparedRun();
    const pair = await readings();
    const used = await readings('1.250', '26.250');
    expect(outcomeOf(await d.command('operator1', weighing(used.tare, used.gross)))).toBe('ok');
    const old = await readings('1.250', '26.250', '200000000');
    const rowsBefore = (await rowsOf(rig.server, d.runId)).length;

    const outcomes = {
      weightsNotTheReadings: await weighingPast(d, pair, { edit: (cmd) => (cmd.entry['gross'] = '26.251') }),
      grossNotNamed: await weighingPast(d, pair, { edit: (_, ev) => (ev['namedReadings'] = named(ev).filter((r) => r['purpose'] !== 'GROSS')) }),
      grossNamedTwice: await weighingPast(d, pair, { edit: (_, ev) => (ev['namedReadings'] = [...named(ev), ...named(ev).filter((r) => r['purpose'] === 'GROSS')]) }),
      grossAlreadyUsed: await weighingPast(d, pair, { edit: naming('GROSS', used.gross) }),
      grossTooOld: await weighingPast(d, pair, { edit: naming('GROSS', old.gross) }),
      // The row F58 left: the readings claimed while the intent was resolved, then the stale refusal recorded with them.
      claimedThenStale: await weighingPast(d, pair, { useReadings: true }),
      listedAsUsed: await weighingPast(d, pair, {
        edit: (_, ev) => {
          ev['readings'] = ev['namedReadings'];
          delete ev['namedReadings'];
        },
      }),
      // A refusal for another reason (a quarantined lot, G07-LOT-STATUS) from the current screen is no stale refusal.
      notStaleUnclaimed: await weighingPast(d, pair, { seen: (v) => v, lotCode: 'TEST-L26-0199' }),
    };
    expect(unmatched(outcomes, {
      weightsNotTheReadings: 'EBMR-EXE-124',
      grossNotNamed: 'EBMR-EXE-124',
      grossNamedTwice: 'EBMR-EXE-124',
      grossAlreadyUsed: 'EBMR-DEV-105',
      grossTooOld: 'EBMR-DEV-104',
      claimedThenStale: 'EBMR-EXE-124',
      listedAsUsed: 'EBMR-EXE-124',
      notStaleUnclaimed: 'EBMR-EXE-124',
    })).toEqual({});
    expect((await rowsOf(rig.server, d.runId)).length).toBe(rowsBefore);
    expect(await usesOf([pair.tare, pair.gross, old.tare, old.gross])).toBe(0);

    // The honest stale weighing is recorded, naming the readings; they stay unused, and the weighing from the reloaded
    // screen uses them.
    expect(await weighingPast(d, pair)).toBe('ok');
    const { rows } = await rig.server.db.admin.query<{ accepted: boolean; refusal: { code: string } | null; evidence: Json }>(
      'select accepted, refusal, evidence from recipe.execution_command where batch_id = $1 order by seq desc limit 1',
      [d.runId],
    );
    expect(rows[0]).toMatchObject({ accepted: false, refusal: { code: 'ENG-STALE' }, evidence: { namedReadings: [{ purpose: 'TARE', readingId: pair.tare }, { purpose: 'GROSS', readingId: pair.gross }] } });
    expect(rows[0]?.evidence['readings']).toBeUndefined();
    expect(await usesOf([pair.tare, pair.gross])).toBe(0);
    expect(outcomeOf(await d.command('operator1', weighing(pair.tare, pair.gross)))).toBe('ok');
    expect(await usesOf([pair.tare, pair.gross])).toBe(2);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-32][DI-34][PR-19] written past the server, a stale weighing that names one reading taken for no stated purpose as both its tare and its gross is refused as the claims of its command would refuse it (EBMR-DEV-105): no row, and the reading stays unused for the next accepted weighing (F58.1)', async () => {
    const d = await preparedRun();
    // Two stable readings the gateway took for no stated purpose (a reading may carry none), so either may be claimed
    // as a tare or as a gross; the second is only there for the server to resolve the weighing before the forgery.
    const one = rig.gw.next({ value: '5.000', purpose: null });
    const other = rig.gw.next({ value: '30.000', purpose: null });
    expect((await rig.gw.uplink([{ reading: one }, { reading: other }])).body.refused).toBeNull();
    const rowsBefore = await rowsOf(rig.server, d.runId);

    // The weighing as an older screen sends it, then rewritten to name the first reading as its gross too (the weights
    // the readings state, the reading named once for each purpose): each reading alone is one a claim accepts now, the
    // pair is not, since the claim of the gross finds the reading used by the tare's.
    const sameForBoth = await weighingPast(d, { tare: one.readingId, gross: other.readingId }, {
      edit: (cmd, ev) => {
        cmd.entry['gross'] = '5.000';
        for (const r of named(ev)) if (r['purpose'] === 'GROSS') Object.assign(r, { readingId: one.readingId, value: '5.000' });
      },
    });
    expect(sameForBoth).toBe('EBMR-DEV-105');
    expect(await rowsOf(rig.server, d.runId)).toEqual(rowsBefore);
    expect(await usesOf([one.readingId, other.readingId])).toBe(0);

    // Nothing of it was used: the weighing from the current screen claims the reading as its tare.
    expect(outcomeOf(await d.command('operator1', weighing(one.readingId, other.readingId)))).toBe('ok');
    expect(await usesOf([one.readingId, other.readingId])).toBe(2);
    expect(await violations(rig.server)).toEqual([]);

    // The pair is checked by one definer function, executable by its owner and the application role only (not PUBLIC;
    // on this sandbox installation the sandbox's application role holds the grant too); the per-purpose check of 0500,
    // which let the pair through, is gone.
    const { rows: fn } = await rig.server.db.admin.query<{ acl: string[]; definer: boolean; config: string[] }>(
      "select p.proacl::text[] as acl, p.prosecdef as definer, p.proconfig as config from pg_catalog.pg_proc p where p.oid = 'tab.peek_weighing_readings(uuid,uuid,text,bigint)'::regprocedure",
    );
    expect(fn).toEqual([{ acl: ['ebmr_owner=X/ebmr_owner', 'ebmr_app=X/ebmr_owner', 'ebmr_sandbox=X/ebmr_owner'], definer: true, config: ['search_path=pg_catalog, tab, pg_temp'] }]);
    const { rows: gone } = await rig.server.db.admin.query<{ f: string | null }>("select to_regprocedure('tab.peek_readings(uuid[],text,bigint,text)')::text as f");
    expect(gone).toEqual([{ f: null }]);
  }, 300_000);
});
