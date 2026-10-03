/**
 * The time sweeper (module C3; INV-20): the SYSTEM identity TEST-sweeper evaluates the time limits of every
 * running test batch; a maximum breach is raised exactly once, and by SYSTEM, whether the sweeper or a command
 * notices it first (review P35); a SWEEP row is written only when the sweep produced events; a batch another
 * command holds is skipped.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { openServiceSession, passwordActor, terminalOf } from '@ebmr/test-kit';
import { openSweeperActor, sweepAll, sweeperCredentials } from '../../src/features/execution/sweeper.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
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
      expect(skipped.outcomes[runId]).toBe('SKIPPED');
      expect(skipped.failures).toEqual([]);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await breaches()).toHaveLength(0);

    const first = await sweepAll(server.built.ctx, sweeper);
    expect(first.failures).toEqual([]);
    expect(first.outcomes[runId]).toBeGreaterThan(0);
    expect(await breaches()).toHaveLength(1);
    const sweeps = (await rowsOf(server, runId)).filter((r) => r.kind === 'SWEEP');
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({ accepted: true, device_class: 'SERVER', auth_event_id: null });
    const { rows } = await server.db.admin.query<{ source: string; actor_person: string }>("select source, actor_person from recipe.execution_command where batch_id = $1 and kind = 'SWEEP'", [runId]);
    expect(rows[0]).toMatchObject({ source: 'SYSTEM', actor_person: server.seed.services.find((s) => s.key === 'sweeper')?.personId });

    // A second sweep evaluates the batch and finds nothing new: no row, no second exception; a command sweeps too and
    // adds none. (Review F24: a batch the sweep skipped or never listed would also leave no row.)
    const rows0 = await rowsOf(server, runId);
    const second = await sweepAll(server.built.ctx, sweeper);
    expect(second.failures).toEqual([]);
    expect(second.outcomes[runId]).toBe(0);
    expect(second.skipped).toBe(0);
    expect(await rowsOf(server, runId)).toEqual(rows0);
    expect((await rowsOf(server, runId)).filter((r) => r.kind === 'SWEEP')).toHaveLength(1);
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-7' } });
    expect(await breaches()).toHaveLength(1);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[INV-20][DI-14] a command that notices the breach first records it as the system\'s, exactly once; the sweeper then finds nothing new and writes no row', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, withShortWindow()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    await sleep(1_300);
    const breaches = async () => Object.values((await execution.loadState(server.db.admin, runId))?.state.exceptions ?? {}).filter((e) => e.type === 'TIME_MAX_BREACH');

    // operator1's command evaluates the time first (review P35): the breach is SYSTEM's, not operator1's, and the
    // command itself is operator1's own, accepted, row.
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-clear@', entry: { kind: 'PREVIOUS_BATCH', product: 'X', batchNumber: 'TEST-B26-7' } });
    expect((await breaches()).map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    const operator1 = server.seed.personas.find((p) => p.key === 'operator1')?.personId;
    const { rows } = await server.db.admin.query<{ kind: string; command_type: string; actor_person: string; accepted: boolean }>(
      "select kind, command_type, actor_person::text as actor_person, accepted from recipe.execution_command where batch_id = $1 and kind <> 'ISSUE' order by seq",
      [runId],
    );
    expect(rows.slice(-1)).toEqual([{ kind: 'COMMAND', command_type: 'RECORD_ENTRY', actor_person: operator1, accepted: true }]);

    // The sweeper evaluates the batch and finds the breach already recorded: no event, no second exception, no SWEEP
    // row. (Review F24: a batch the sweep skipped or never listed would also leave no row.)
    const rows0 = await rowsOf(server, runId);
    const sweeper = { ...(await openServiceSession(server.db, server.seed, 'sweeper')), correlationId: randomUUID() };
    try {
      const swept = await sweepAll(server.built.ctx, sweeper);
      expect(swept.failures).toEqual([]);
      expect(swept.outcomes[runId]).toBe(0);
      expect(swept.skipped).toBe(0);
      expect(Object.keys(swept.outcomes)).toHaveLength(swept.runs);
    } finally {
      await identity.endSession(server.db.app, sweeper.sessionId);
    }
    expect((await rowsOf(server, runId)).filter((r) => r.kind === 'SWEEP')).toEqual([]);
    expect(await rowsOf(server, runId)).toEqual(rows0);
    expect((await breaches()).map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    expect(await violations(server)).toEqual([]);
  }, 180_000);

  it('[DI-17][INV-20] only the sweeper identity records a time sweep: the gateway (SITE_GATEWAY) is refused even as source SYSTEM, and nothing is written', async () => {
    const issuer = await server.asPersona('issuer');
    const runId = await importAndIssue(server, issuer, writePackage(server, withShortWindow()));
    const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1') });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-clear@' });
    await sleep(1_300);
    const breaches = async () => Object.values((await execution.loadState(server.db.admin, runId))?.state.exceptions ?? {}).filter((e) => e.type === 'TIME_MAX_BREACH');
    const sweepRows = async () =>
      (await server.db.admin.query<{ actor_role: string; actor_person: string }>("select actor_role, actor_person from recipe.execution_command where batch_id = $1 and kind = 'SWEEP'", [runId])).rows;

    // The gateway holds its own role SITE_GATEWAY (tablets 0290: INTERFACE.WRITE only); neither it nor the kernel's
    // SERVICE_ACCOUNT carries EXECUTION.SWEEP (recipe-core 0260). An INTEGRATION account may declare source SYSTEM
    // (kernel 0190), so the permission check itself refuses it.
    const gateway = await openServiceSession(server.db, server.seed, 'gateway');
    expect(gateway.roleCode).toBe('SITE_GATEWAY');
    const refused = await sweepAll(server.built.ctx, { ...gateway, source: 'SYSTEM', correlationId: randomUUID() });
    expect(refused.failures.find((f) => f.runId === runId)?.error).toMatch(/EBMR-IAM-040 .* acting as SITE_GATEWAY lacks permission EXECUTION\.SWEEP/);
    expect(await sweepRows()).toEqual([]);
    expect(await breaches()).toHaveLength(0);

    // The sweeper, in its own role (EXECUTION.SWEEP and nothing else), records the breach.
    const sweeper = await openServiceSession(server.db, server.seed, 'sweeper');
    expect(sweeper.roleCode).toBe('EXECUTION_SWEEPER');
    const swept = await sweepAll(server.built.ctx, { ...sweeper, correlationId: randomUUID() });
    expect(swept.failures).toEqual([]);
    expect(await breaches()).toHaveLength(1);
    expect(await sweepRows()).toEqual([{ actor_role: 'EXECUTION_SWEEPER', actor_person: server.seed.services.find((s) => s.key === 'sweeper')?.personId }]);
    for (const s of [gateway, sweeper]) await identity.endSession(server.db.app, s.sessionId);
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

  it('[DI-14] the sweeper context names the legal name its person holds now, not the name of the demo seed (EBMR-IAM-117)', async () => {
    const s = server.seed.services.find((x) => x.key === 'sweeper');
    if (!s) throw new Error('no sweeper identity in the seed');
    const creds = { loginName: s.loginName, serviceKey: s.serviceKey, fingerprint: terminalOf(server.seed, s.terminal).fingerprint };
    const rename = async (legalName: string): Promise<void> => {
      const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, {
        reasonCode: 'NAME_CHANGE',
        reasonText: `DI-14 test: the sweeper identity is recorded as ${legalName}`,
        correlationId: randomUUID(),
      });
      try {
        await withCommand(server.db.app, admin, (c) => identity.renamePerson(c, s.personId, legalName));
      } finally {
        await identity.endSession(server.db.app, admin.sessionId);
      }
    };
    const renamed = 'TEST-SWEEPER-02';
    expect(renamed).not.toBe(s.legalName);
    await rename(renamed);
    try {
      const sweeper = await openSweeperActor(server.built.ctx, creds);
      try {
        expect(sweeper.legalName).toBe(renamed);
        // The kernel accepts the context the server builds, and a sweep runs under it ...
        await withActorCommand(server.db.app, { ...sweeper, correlationId: randomUUID() }, () => Promise.resolve());
        expect((await sweepAll(server.built.ctx, sweeper)).failures).toEqual([]);
        // ... while a context still carrying the seed's name is refused: the name is not the person's any more.
        await expect(withActorCommand(server.db.app, { ...sweeper, legalName: s.legalName, correlationId: randomUUID() }, () => Promise.resolve())).rejects.toThrow(/EBMR-IAM-117/);
      } finally {
        await identity.endSession(server.db.app, sweeper.sessionId);
      }
    } finally {
      await rename(s.legalName);
    }
    expect(await violations(server)).toEqual([]);
  }, 120_000);
});
