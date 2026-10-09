/**
 * Shared set-up of the stale-row database-guard tests (Phase 2 exit review F58.1; DI-32, DI-34, PR-19): a dc-mini run
 * at its paracetamol weighing in DISP-1, scale readings of TEST-BAL-01 as the gateway sends them, and operator1's
 * weighing written past the server through the store, the intent resolved as the server resolves it (the readings of a
 * stale screen named, not used), with the transaction open to statements of the test's own before and after the row.
 * The application role is the attacker (ADR 0012). Each test file has its own server: the kiosk's device nonces are
 * rate-limited per terminal and minute, so one file holds only a few runs.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, type engine } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { newRun, PCM, reachPcm, report, type Rig } from '../devices/room-scales-support.ts';
import { actorOf, codeOf } from './db-guards-support.ts';
import { personaIn, type RunDriver } from './support.ts';

export type Json = Record<string, unknown>;

export interface ReadingPair {
  tare: string;
  gross: string;
}

/** operator1's container weighing of the paracetamol step on the readings `tareReadingId` and `grossReadingId`. */
export const weighing = (tareReadingId: string, grossReadingId: string, lotCode = 'TEST-L26-0101') => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: PCM,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode, tareReadingId, grossReadingId },
});

/** The readings a resolved stale weighing names (its evidence.namedReadings). */
export const named = (evidence: Json): Json[] => evidence['namedReadings'] as Json[];

/** Claims `ids` as the run command claims them (tare, then gross, for DISP-1) in the transaction of `c`. */
export async function claim(c: pg.PoolClient, ids: ReadingPair): Promise<void> {
  await c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'TARE')", [ids.tare]);
  await c.query("select tab.claim_readings(array[$1]::uuid[], 'DISP-1', 120000000, 'GROSS')", [ids.gross]);
}

export interface PastOptions {
  /** The version the screen showed (default: one before the run's). */
  seen?: (version: number) => number;
  /** Whether the resolution uses (claims) the readings, as for a fresh screen (default false, as for a stale one). */
  useReadings?: boolean;
  lotCode?: string;
  /** Changes the resolved command and evidence before the engine runs and the row is written. */
  edit?: (command: Json & { entry: Json }, evidence: Json) => void;
  /** The correlation id of the command (default: a new one, as the server gives every request). */
  correlationId?: string;
  /** Runs in the command's transaction before the run is opened. */
  before?: (c: pg.PoolClient) => Promise<unknown>;
  /** Runs in the command's transaction once the row is written, before the commit. */
  after?: (c: pg.PoolClient) => Promise<unknown>;
}

/** A command transaction left open after its work; its commit gives the refusal code, or 'ok'. */
export interface OpenCommand {
  commit(): Promise<string>;
}

/** The helpers of the stale-row tests, on the rig `rigOf` gives (set up by the test file's beforeAll). */
export function staleRowHelpers(rigOf: () => Rig) {
  /** A stable tare and gross of TEST-BAL-01 (the DISP-1 balance), ingested as the gateway sends them (`delayUs`: the wait it signed). */
  async function readings(tare = '1.250', gross = '26.250', delayUs = '1000'): Promise<ReadingPair> {
    const rig = rigOf();
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
    return (await rigOf().server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [ids])).rows.length;
  }

  /**
   * operator1's weighing of `ids` written past the server, on DISP-1's kiosk, through the store: the intent resolved as
   * the server resolves it (readings named, not used, unless `useReadings`), the engine's result appended. The
   * database's refusal code, or 'ok'.
   */
  async function weighingPast(d: RunDriver, ids: ReadingPair, opts: PastOptions = {}): Promise<string> {
    const rig = rigOf();
    const run = await runContext(rig.server.db.admin, d.runId);
    const who = personaIn(rig.server, 'operator1');
    const actor = await actorOf(rig.server, d.browser('operator1'), 'operator1', opts.correlationId ? { correlationId: opts.correlationId } : {});
    return codeOf(
      withCommand(rig.server.db.app, actor, async (c) => {
        await opts.before?.(c);
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
        const r = await tx.command(command as unknown as engine.Command, roles, evidence as engine.JsonValue);
        await opts.after?.(c);
        return r;
      }),
    );
  }

  /** operator1 claims `ids` in a command of its own, under `correlationId`, and writes no row. The database's refusal code, or 'ok'. */
  async function claimAlone(d: RunDriver, ids: ReadingPair, correlationId: string): Promise<string> {
    const rig = rigOf();
    return codeOf(withCommand(rig.server.db.app, await actorOf(rig.server, d.browser('operator1'), 'operator1', { correlationId }), (c) => claim(c, ids)));
  }

  /** The marks the database keeps of a correlation id (tablets 0520), or null. */
  async function markOf(correlationId: string): Promise<{ claimed: boolean; stale_refusal: boolean } | null> {
    const { rows } = await rigOf().server.db.admin.query<{ claimed: boolean; stale_refusal: boolean }>(
      'select claimed, stale_refusal from tab.reading_claim_mark where correlation_id = $1',
      [correlationId],
    );
    return rows[0] ?? null;
  }

  /** `actor`'s command at `isolation` (its snapshot taken by begin_command), with `work` done in it, left open. */
  async function openCommand(actor: ActorContext, isolation: 'read committed' | 'repeatable read', work: (c: pg.PoolClient) => Promise<unknown>): Promise<OpenCommand> {
    const c = await rigOf().server.db.app.connect();
    try {
      await c.query(`begin isolation level ${isolation}`);
      // A blocked statement fails the case instead of hanging it.
      await c.query("set local statement_timeout = '30s'");
      await c.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(actor))]);
      await work(c);
    } catch (error) {
      await c.query('rollback');
      c.release();
      throw error;
    }
    return {
      commit: () =>
        codeOf(
          (async () => {
            try {
              await c.query('commit');
            } catch (error) {
              await c.query('rollback');
              throw error;
            } finally {
              c.release();
            }
          })(),
        ),
    };
  }

  /**
   * `persona` raises an exception about the paracetamol step from a screen that showed the version before the run's, in
   * the transaction of `c`: the engine refuses it ENG-STALE and the row is appended.
   */
  async function staleException(c: pg.PoolClient, d: RunDriver, persona: string): Promise<void> {
    const rig = rigOf();
    const run = await runContext(rig.server.db.admin, d.runId);
    const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
    const roles = await engineRoles(c);
    const r = await tx.command(
      {
        type: 'RAISE_EXCEPTION',
        commandId: randomUUID(),
        actor: engineActor(personaIn(rig.server, persona).personId, roles),
        expectedVersion: tx.state.version - 1,
        step: 'p-disp-pcm',
        context: [],
        description: 'Label of the drum torn',
        severity: 'ALERT',
      },
      roles,
    );
    expect(r.refusal?.code).toBe('ENG-STALE');
  }

  /** A run at its paracetamol weighing, with TEST-BAL-01 reported ONLINE. */
  async function preparedRun(): Promise<RunDriver> {
    const rig = rigOf();
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    return d;
  }

  return { readings, usesOf, weighingPast, claimAlone, markOf, openCommand, staleException, preparedRun };
}
