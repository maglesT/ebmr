/**
 * Phase 2 exit review F38 (executed attacks; DI-28, DI-32, DI-31; ADR 0012): the oldest a scale reading may be when an
 * entry uses it is the database's policy, not the caller's word.
 *
 * Before tablets 0360, tab.claim_readings compared a reading's proven age only with the maximum the caller named (up to
 * 1 hour); the 120 s policy (M6-C5) lived only in the server. On the server's own connection (the application role) a
 * port passing 3600 s recorded a weighing as captured from the scale on readings 10 minutes old. Now the database
 * applies the lesser of the caller's maximum and the platform setting device.reading_max_age_s (default 120 s, allowed
 * 5-120 s), so such a claim is refused (EBMR-DEV-104) and nothing is recorded; a site that tightens the setting gets the
 * tighter maximum whatever the server asks.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { withChangeRecord } from '../../../../packages/kernel/test/support/change-record.ts';
import type { DeviceReadingPort } from '../../src/platform/ports.ts';
import { outcomeOf } from '../execution/support.ts';
import { newRun, PCM, reachPcm, report, startRig, stopRig, type Rig } from './room-scales-support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});

const weighing = (tare: string, gross: string) => ({ type: 'RECORD_ENTRY' as const, stepKey: PCM, entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId: tare, grossReadingId: gross } });

/** A tare and gross reading of TEST-BAL-01, uploaded with a proven wait of `waitUs` each. */
async function readings(waitUs: string): Promise<{ tare: string; gross: string }> {
  const tare = rig.gw.next({ value: '2.000', purpose: 'TARE' });
  const gross = rig.gw.next({ value: '52.000', purpose: 'GROSS' });
  const up = await rig.gw.uplink([{ reading: tare, delayUs: waitUs }, { reading: gross, delayUs: waitUs }]);
  expect(up.body.refused, JSON.stringify(up.body)).toBeNull();
  return { tare: tare.readingId, gross: gross.readingId };
}

/** Runs `work` with the server's reading port passing `maxAgeUs` to tab.claim_readings; the role it ran as. */
async function withPortMaxAge<T>(maxAgeUs: bigint, work: () => Promise<T>): Promise<{ result: T; role: { current_user: string; rolsuper: boolean } | undefined }> {
  const port: DeviceReadingPort = rig.server.built.ctx.deviceReadings;
  const original = port.claim.bind(port);
  let role: { current_user: string; rolsuper: boolean } | undefined;
  port.claim = async (client, claim) => {
    const q = await client.query<{ current_user: string; rolsuper: boolean }>('select current_user, (select rolsuper from pg_roles where rolname = current_user) as rolsuper');
    role = q.rows[0];
    return original(client, { ...claim, maxAgeUs });
  };
  try {
    return { result: await work(), role };
  } finally {
    port.claim = original;
  }
}

async function weighingsOf(runId: string): Promise<number> {
  const { rows } = await rig.server.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_command where batch_id = $1 and command_type = 'RECORD_ENTRY' and accepted and command -> 'entry' ->> 'kind' = 'CONTAINER_WEIGHING'", [runId]);
  return Number(rows[0]?.n ?? '0');
}

/** platform.set_setting by the installation's process owner, with a reason. */
async function setMaxAge(seconds: string): Promise<void> {
  const owner = await passwordActor(rig.server.db, rig.server.seed.bootstrap.owner, rig.server.seed.bootstrap.owner.fingerprint, { reasonCode: 'CHANGE_CONTROL', reasonText: `F38: reading age ${seconds} s`, correlationId: randomUUID() });
  await withCommand(rig.server.db.app, await withChangeRecord(rig.server.db, owner), (c) => c.query("select platform.set_setting('device.reading_max_age_s', $1)", [seconds]));
}

describe('F38: the maximum age of a scale reading is the database\'s policy (DI-28)', () => {
  it('[DI-28][DI-32] a 10-minute-old reading pair is refused at 120 s, and still refused when the application role asks for 3600 s; nothing is recorded', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    const r = await readings('600000000');
    expect(outcomeOf(await d.command('operator1', weighing(r.tare, r.gross)))).toMatch(/EBMR-DEV-104/);
    const forged = await withPortMaxAge(3_600_000_000n, () => d.command('operator1', weighing(r.tare, r.gross)));
    expect(forged.role).toEqual({ current_user: 'ebmr_sandbox', rolsuper: false });
    expect(outcomeOf(forged.result)).toMatch(/EBMR-DEV-104/);
    expect(await weighingsOf(d.runId)).toBe(0);
    // The policy and its bounds: default 120 s, allowed 5-120 s (only ever tightened).
    const { rows } = await rig.server.db.admin.query<{ d: string; lo: string; hi: string }>("select default_value as d, min_value::text as lo, max_value::text as hi from platform.setting_definition where key = 'device.reading_max_age_s'");
    expect(rows[0]).toEqual({ d: '120', lo: '5', hi: '120' });
    await expect(setMaxAge('121')).rejects.toThrow(/EBMR-PLAT-021/);
    await expect(setMaxAge('4')).rejects.toThrow(/EBMR-PLAT-021/);
    // Fresh readings are used at once.
    const fresh = await readings('1000000');
    expect(outcomeOf(await d.command('operator1', weighing(fresh.tare, fresh.gross)))).toBe('ok');
    expect(await weighingsOf(d.runId)).toBe(1);
  }, 300_000);

  it('[DI-28][DI-32] a site that tightens the policy gets the tighter maximum, whatever the server asks', async () => {
    const d = await newRun(rig);
    await reachPcm(d);
    await report(rig, { 'TEST-BAL-01': 'ONLINE' });
    await setMaxAge('60');
    try {
      // 90 s: within the server's 120 s, beyond the site's 60 s.
      const r = await readings('90000000');
      const out = outcomeOf(await d.command('operator1', weighing(r.tare, r.gross)));
      expect(out).toMatch(/EBMR-DEV-104/);
      expect(await weighingsOf(d.runId)).toBe(0);
    } finally {
      await setMaxAge('120');
    }
  }, 300_000);
});
