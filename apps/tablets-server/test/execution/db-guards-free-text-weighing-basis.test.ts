/**
 * Phase 2 exit follow-up F12, round 12: what the manual-weighing gate records with a test run's hand-keyed weighing
 * (tab.manual_weighing_basis) holds no real-format batch or lot number (DI-05, DI-30, INV-18; tablets 0640; ADR 0012).
 *
 * The basis is keyed to the run's row and is part of its record, but it was the one table so keyed that recipe-core
 * 0344's catch-all did not read. Its reasons copy the site gateway's not-ready text, the serial a scale answers with and
 * the one registered for it, the server's detail of an unreachable gateway API and the code of a refused reading's
 * alarm. Over HTTP with no database credentials, the lane's round-12 verification had a fake gateway report both DISP-1
 * scales OFFLINE with the not-ready text 'drum L2409-0017 left on the pan' (P1a), or ONLINE answering with serial
 * L2409-0017 (P1b), for the gate's window; operator1's honest hand-keyed weighing was then recorded with L2409-0017 in the
 * basis. Now (tablets 0640) the basis is read at commit with the kernel's identifier rule, as the rest of the record is:
 * such a weighing is refused (EBMR-EXE-147) and nothing of it is saved, also when the word comes from the server's API
 * detail or from a refused reading's alarm code that the application role recorded itself; the system's own error codes
 * that a function of the installation names (EBMR-DEV-048) and the gate's own reasons are recorded. By default (decision
 * F12.10) an honest instrument serial of letters and digits quoted in a mismatch is refused too: the rule cannot tell
 * SIM-9999 from a lot number.
 *
 * The writer is operator1 through the honest server (HTTP), the fake gateway over HTTP, the gateway API monitor's
 * command and the application role's own call of tab.record_gateway_refusal, as in the gate's tests.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeGateway } from '../devices/support.ts';
import { GATE_WINDOW_MS, handKeyed, newRun, reachPcm, recordContact, report, standFor, startRig, stopRig, type Rig } from '../devices/room-scales-support.ts';
import { outcomeOf, type RunDriver, violations } from './support.ts';

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
}, 180_000);
afterAll(async () => {
  await stopRig(rig);
});
afterEach(async () => {
  // Whatever a failed case left behind: the API reachable again.
  await recordContact(rig, true, 'test: clean-up');
});

const LOT = 'L2409-0017';
const REFUSED = '422:EBMR-EXE-147';
const BESIDE: Readonly<Record<string, 'ONLINE' | 'OFFLINE'>> = { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'ONLINE' };
type Device = { deviceCode: string; state: string; serial: string | null; notReady?: string | null };

/** A dc-mini run at its paracetamol step (a refused weighing leaves it as it was). */
async function pcmRun(): Promise<RunDriver> {
  const d = await newRun(rig);
  await reachPcm(d);
  return d;
}

/** Lets `ms` of database time pass while the gateway reports `devices` every 3 s, then once more (as standFor). */
async function standWith(ms: number, devices: Device[]): Promise<void> {
  const beat = async () => {
    const r = await rig.gw.heartbeat(devices);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  const { rows } = await rig.server.db.admin.query<{ t: string }>('select clock_timestamp()::text as t');
  for (;;) {
    await beat();
    const r = await rig.server.db.admin.query<{ left: number }>("select greatest(0, $2::int - extract(epoch from clock_timestamp() - $1::timestamptz) * 1000)::int as left", [rows[0]?.t ?? '', ms]);
    const left = r.rows[0]?.left ?? 0;
    if (left <= 0) break;
    await new Promise((res) => setTimeout(res, Math.min(3000, left + 50)));
  }
  await beat();
}

/** operator1's hand-keyed weighing of the paracetamol step over HTTP: 'ok' or '<status>:<code>'. */
async function weighByHand(d: RunDriver): Promise<string> {
  return outcomeOf(await d.command('operator1', handKeyed));
}

/** The reasons the gate recorded with the run's hand-keyed weighings, [device code, status, reason] per scale. */
async function basisReasons(runId: string): Promise<string[][][]> {
  const { rows } = await rig.server.db.admin.query<{ scales: Record<string, string>[] }>('select scales from tab.manual_weighing_basis where batch_id = $1 order by row_seq', [runId]);
  return rows.map((r) => r.scales.map((s) => [s['deviceCode'] ?? '', s['status'] ?? '', s['reason'] ?? '']));
}

/** How many basis rows, command rows and audit entries of run `runId` hold `text`. */
async function holding(runId: string, text: string): Promise<Record<string, number>> {
  const like = `%${text}%`;
  const count = async (sql: string) => Number((await rig.server.db.admin.query<{ n: string }>(sql, [runId, like])).rows[0]?.n ?? '0');
  return {
    basis: await count('select count(*)::text as n from tab.manual_weighing_basis where batch_id = $1 and (scales::text like $2 or room_code like $2)'),
    rows: await count('select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2)'),
    audit: await count(`select count(*)::text as n from kernel.audit_event where chain_key = 'batch:' || $1 and payload::text like $2`),
  };
}

const NOTHING = { basis: 0, rows: 0, audit: 0 };
const OFFLINE_REPORTED = 'the site gateway reports it OFFLINE';

describe('F12 round 12: the manual-weighing basis of a test run is read for the identifier rule (tablets 0640; DI-05, DI-30)', () => {
  it('[DI-05][DI-30] round 12 (tablets 0640): the verification\'s P1a and P1b over HTTP, a gateway\'s not-ready text drum L2409-0017 left on the pan and a scale answering with serial L2409-0017, each standing for the gate\'s window, make operator1\'s honest hand-keyed weighing refused (EBMR-EXE-147) with nothing saved and no basis row of the run holding L2409-0017; an honest serial of letters and digits quoted in a mismatch is refused too (decision F12.10); an honest offline report then opens the manual path and the basis records the gate\'s reason', async () => {
    const d = await pcmRun();
    const basisBefore = (await basisReasons(d.runId)).length;

    await standWith(GATE_WINDOW_MS, [
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null, notReady: `drum ${LOT} left on the pan` },
      { deviceCode: 'TEST-BAL-01', state: 'OFFLINE', serial: null, notReady: `drum ${LOT} left on the pan` },
    ]);
    const notReady = await weighByHand(d);
    await standWith(GATE_WINDOW_MS, [
      { deviceCode: 'TEST-BAL-00', state: 'ONLINE', serial: LOT, notReady: null },
      { deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: LOT, notReady: null },
    ]);
    const serial = await weighByHand(d);
    // An honest mismatch: the registered serials are SIM-0000 and SIM-0001, the scale answers SIM-9999.
    await standWith(GATE_WINDOW_MS, [
      { deviceCode: 'TEST-BAL-00', state: 'OFFLINE', serial: null, notReady: null },
      { deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-9999', notReady: null },
    ]);
    const honestSerial = await weighByHand(d);

    expect({ notReady, serial, honestSerial }).toEqual({ notReady: REFUSED, serial: REFUSED, honestSerial: REFUSED });
    expect((await basisReasons(d.runId)).length).toBe(basisBefore);

    // The gate's own reason, standing for the window: recorded in the test run.
    await standFor(rig, GATE_WINDOW_MS, { 'TEST-BAL-00': 'OFFLINE', 'TEST-BAL-01': 'OFFLINE' });
    expect(await weighByHand(d)).toBe('ok');
    expect((await basisReasons(d.runId)).slice(basisBefore)).toEqual([
      [
        ['TEST-BAL-00', 'OFFLINE', OFFLINE_REPORTED],
        ['TEST-BAL-01', 'OFFLINE', OFFLINE_REPORTED],
      ],
    ]);
    expect(await holding(d.runId, LOT)).toEqual(NOTHING);
    expect(await holding(d.runId, 'SIM-9999')).toEqual(NOTHING);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);

  it('[DI-05][DI-30] round 12 (tablets 0640): the server\'s detail of an unreachable gateway API naming L2409-0017, and a refused reading\'s alarm code L2409-0017 or EBMR-LOT-017 (no function names it) that the application role recorded itself, each standing for the gate\'s window, make the hand-keyed weighing refused (EBMR-EXE-147); a refused reading\'s code the installation raises (EBMR-DEV-048) and the gate\'s own reasons are recorded', async () => {
    const d = await pcmRun();
    const basisBefore = (await basisReasons(d.runId)).length;

    await report(rig, BESIDE);
    expect(await recordContact(rig, false, `gateway API answers drum ${LOT} on the pan`)).toBe(true);
    await standFor(rig, GATE_WINDOW_MS, BESIDE);
    const apiDetail = await weighByHand(d);
    expect(await recordContact(rig, true, 'test: the API answers')).toBe(true);

    // A refused reading as the listener records it (the application role's own call, with the live gateway's token).
    const tokenHash = createHash('sha256').update(rig.gw.token, 'utf8').digest('hex');
    const refusal = (code: string) =>
      rig.server.db.app.query('select tab.record_gateway_refusal($1, $2, $3, $4, $5, $6, $7::jsonb)', [tokenHash, 'TEST-GW-01', 'READING_REFUSED', code, null, 'test: a refused reading', '{}']);
    await refusal(LOT);
    await standFor(rig, GATE_WINDOW_MS, BESIDE);
    const alarmCode = await weighByHand(d);
    await refusal('EBMR-LOT-017');
    await standFor(rig, GATE_WINDOW_MS, BESIDE);
    const unnamedCode = await weighByHand(d);
    await refusal('EBMR-DEV-048');
    await standFor(rig, GATE_WINDOW_MS, BESIDE);
    const systemCode = await weighByHand(d);

    expect({ apiDetail, alarmCode, unnamedCode, systemCode }).toEqual({ apiDetail: REFUSED, alarmCode: REFUSED, unnamedCode: REFUSED, systemCode: 'ok' });
    expect((await basisReasons(d.runId)).slice(basisBefore)).toEqual([
      [
        ['TEST-BAL-00', 'OFFLINE', OFFLINE_REPORTED],
        ['TEST-BAL-01', 'OFFLINE', 'the server refused a reading of gateway TEST-GW-01 (EBMR-DEV-048) and has received none since, so no capture can reach it'],
      ],
    ]);
    for (const word of [LOT, 'EBMR-LOT-017']) expect(await holding(d.runId, word), word).toEqual(NOTHING);

    // A reading ingested again ends the hold (the gateway logs in again, as it does after a refusal).
    await rig.gw.close();
    rig.gw = await fakeGateway(rig.server);
    expect(await violations(rig.server)).toEqual([]);
  }, 300_000);
});
