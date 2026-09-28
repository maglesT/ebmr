/**
 * The time sweeper (module C3; INV-20): the SYSTEM identity TEST-sweeper evaluates the time limits of every
 * running test batch; a maximum breach is raised exactly once, whether the sweeper or a command notices it
 * first; a SWEEP row is written only when the sweep produced events; a batch another command holds is skipped.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execution } from '@ebmr/recipe-core';
import { openServiceSession, terminalOf } from '@ebmr/test-kit';
import { sweepAll, sweeperCredentials } from '../../src/features/execution/sweeper.ts';
import { importAndIssue, rowsOf, RunDriver, startExecServer, violations, withShortWindow, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

describe('time sweeper', () => {
  it('[INV-20] raises exactly one maximum-breach exception, records SWEEP rows only with events, and skips a batch that is held', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, withShortWindow()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    await sleep(1_300);
    const sweeper = { ...(await openServiceSession(server.db, server.seed, 'sweeper')), correlationId: randomUUID() };
    const breaches = async () => Object.values((await execution.loadState(server.db.admin, runId))?.state.exceptions ?? {}).filter((e) => e.type === 'TIME_MAX_BREACH');

    // Another command holds the batch: the sweeper skips it (FOR UPDATE SKIP LOCKED) and writes nothing.
    const holder = await server.db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from recipe.batch_execution where id = $1 for update', [runId]);
      const skipped = await sweepAll(server.built.ctx, sweeper);
      expect(skipped.skipped).toBeGreaterThanOrEqual(1);
      expect(skipped.failures).toEqual([]);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await breaches()).toHaveLength(0);

    const first = await sweepAll(server.built.ctx, sweeper);
    expect(first.failures).toEqual([]);
    expect(first.events).toBeGreaterThan(0);
    expect(await breaches()).toHaveLength(1);
    const sweeps = (await rowsOf(server, runId)).filter((r) => r.kind === 'SWEEP');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ accepted: true, device_class: 'SERVER', auth_event_id: null });
    const { rows } = await server.db.admin.query<{ source: string; actor_person: string }>("select source, actor_person from recipe.execution_command where batch_id = $1 and kind = 'SWEEP'", [runId]);
    expect(rows[0]).toMatchObject({ source: 'SYSTEM', actor_person: server.seed.services.find((s) => s.key === 'sweeper')?.personId });

    // A second sweep finds nothing new: no row, no second exception; a command sweeps too and adds none.
    const second = await sweepAll(server.built.ctx, sweeper);
    expect(second.failures).toEqual([]);
    expect((await rowsOf(server, runId)).filter((r) => r.kind === 'SWEEP')).toHaveLength(1);
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-7' } });
    expect(await breaches()).toHaveLength(1);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[INV-20] the sweeper identity is the TEST-SRV-SWEEPER entry of the service-keys file (its terminal key fingerprint)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-c3-keys-'));
    const file = join(dir, 'sandbox-service-keys.json');
    const t = terminalOf(server.seed, 'TEST-SRV-SWEEPER');
    const s = server.seed.services.find((x) => x.key === 'sweeper');
    writeFileSync(file, JSON.stringify({ label: 'DEMO-ONLY service secrets', services: [{ ...s, fingerprint: t.fingerprint, terminalKey: t.key }] }));
    expect(sweeperCredentials(file)).toEqual({ loginName: s?.loginName, serviceKey: s?.serviceKey, fingerprint: t.key?.fingerprint ?? t.fingerprint });
    expect(sweeperCredentials(null)).toBeNull();
  });
});
