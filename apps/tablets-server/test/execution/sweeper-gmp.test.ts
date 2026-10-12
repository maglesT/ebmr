/**
 * The GMP sweeper (Phase 4 slice 1b, D-P4-9): the GMP installation has its own reserved non-human SERVICE identity on the
 * server terminal SRV-SWEEPER-01, in EXECUTION_SWEEPER only (EXECUTION.SWEEP, no STEP.EXECUTE), so time breaches,
 * overdue in-process checks and interface losses of GMP batches are recorded without waiting for a person's entry.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { openServiceSession, terminalOf } from '@ebmr/test-kit';
import { openSweeperActor, recordInterfaceLosses, recordIpcOverdue, sweepAll, sweeperCredentials, SWEEPER_TERMINALS } from '../../src/features/execution/sweeper.ts';
import type { TestBrowser } from '../support/harness.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { RunDriver } from './support.ts';

type Json = Record<string, unknown>;

let w: GmpBatchWorld;
let issuer: TestBrowser;
let operator: TestBrowser;

beforeAll(async () => {
  // A process window of 1 s over the first step of the GMP master, so a breach is quick to provoke.
  w = await startGmpBatchWorld(
    gmpContent((m: Json) => {
      (m['timeConstraints'] as Json[]).push({
        id: 'TC-SOP-WINDOW', name: 'SOP read window', kind: 'PROCESS_WINDOW', from: { node: 'p-disp-sop', event: 'START' }, to: { node: 'p-disp-sop', event: 'END' },
        max: { value: '1', unit: 's' }, source: { kind: 'VALIDATION_REPORT', ref: 'VR-SOP-01' }, breach: 'EXCEPTION', pauses: 'INCLUDED',
      });
    }),
  );
  [issuer, operator] = await Promise.all([w.gmp.asPersona('issuer'), w.gmp.asPersona('operator1')]);
  vi.useFakeTimers({ toFake: ['performance'] });
}, 600_000);
afterAll(async () => {
  vi.useRealTimers();
  await w?.close();
});

describe('the GMP sweeper identity (D-P4-9)', () => {
  it('[DI-17][INV-20] the GMP sweeper is a SERVICE account on SRV-SWEEPER-01 holding EXECUTION_SWEEPER only: EXECUTION.SWEEP and no step right', async () => {
    const s = w.gmp.seed.services.find((x) => x.key === 'sweeper');
    expect(s).toMatchObject({ terminal: SWEEPER_TERMINALS.GMP, roleCode: 'EXECUTION_SWEEPER' });
    const { rows } = await w.gmp.db.admin.query<{ kind: string; roles: string[]; perms: string[] }>(
      `select a.kind, array_agg(distinct g.role_code order by g.role_code) as roles, array_agg(distinct rp.permission_code order by rp.permission_code) as perms
         from iam.account a join iam.role_grant g on g.account_id = a.id and g.status = 'APPROVED'
         join iam.role_permission rp on rp.role_code = g.role_code and rp.removed_at is null
        where a.id = $1 group by a.kind`,
      [s?.accountId],
    );
    expect(rows).toEqual([{ kind: 'SERVICE', roles: ['EXECUTION_SWEEPER'], perms: ['EXECUTION.SWEEP'] }]);
    // Its credentials come from the GMP server's service-keys file, by its own terminal (not the sandbox's).
    const dir = mkdtempSync(join(tmpdir(), 'ebmr-gmp-keys-'));
    const file = join(dir, 'gmp-service-keys.json');
    const t = terminalOf(w.gmp.seed, SWEEPER_TERMINALS.GMP);
    writeFileSync(file, JSON.stringify({ label: 'DEMO-ONLY service secrets', services: [{ ...s, fingerprint: t.fingerprint, terminalKey: t.key }] }));
    expect(sweeperCredentials(file, 'GMP')).toEqual({ loginName: s?.loginName, serviceKey: s?.serviceKey, fingerprint: t.key?.fingerprint ?? t.fingerprint });
    expect(sweeperCredentials(file, 'SANDBOX')).toBeNull();
    const creds = sweeperCredentials(file, 'GMP');
    if (!creds) throw new Error('no GMP sweeper credentials');
    const actor = await openSweeperActor(w.gmp.built.ctx, creds);
    expect(actor).toMatchObject({ roleCode: 'EXECUTION_SWEEPER', source: 'SYSTEM', personId: s?.personId });
    // No step right: an in-process check (STEP.EXECUTE) in its name is refused.
    await expect(
      withCommand(w.gmp.db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query("select plant.record_ipc_check(gen_random_uuid(), 'PRESS-X', null, 'FAIL', 'x')")),
    ).rejects.toThrow(/EBMR-CNT-020|EBMR-IAM-040/);
  }, 120_000);

  it('[INV-20][DI-14] on GMP the sweeper records the time breach of a running batch as the system\'s, in a SWEEP row of its own identity; the IPC and interface jobs run too', async () => {
    const batchId = await w.issued(issuer);
    const d = new RunDriver(w.gmp, batchId, { issuer, operator1: operator });
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
    await sleep(1_300);
    const sweeper = { ...(await openServiceSession(w.gmp.db, w.gmp.seed, 'sweeper')), correlationId: randomUUID() };
    const r = await sweepAll(w.gmp.built.ctx, sweeper);
    expect(r.failures).toEqual([]);
    expect(r.outcomes[batchId]).toBeGreaterThan(0);
    const breaches = Object.values((await execution.loadState(w.gmp.db.admin, batchId))?.state.exceptions ?? {}).filter((e) => e.type === 'TIME_MAX_BREACH');
    expect(breaches.map((e) => e.raisedBy)).toEqual(['SYSTEM']);
    const { rows } = await w.gmp.db.admin.query<{ actor_role: string; actor_person: string; source: string }>(
      "select actor_role, actor_person, source from recipe.execution_command where batch_id = $1 and kind = 'SWEEP'",
      [batchId],
    );
    expect(rows).toEqual([{ actor_role: 'EXECUTION_SWEEPER', actor_person: w.gmp.seed.services.find((s) => s.key === 'sweeper')?.personId, source: 'SYSTEM' }]);
    // The overdue-check alarm and the interface-loss job run on GMP in the same identity (nothing to record here).
    expect((await recordIpcOverdue(w.gmp.built.ctx, sweeper)).filter((a) => a.batchId === batchId)).toEqual([]);
    expect((await recordInterfaceLosses(w.gmp.built.ctx, sweeper)).filter((a) => a.batchId === batchId)).toEqual([]);
  }, 300_000);
});
