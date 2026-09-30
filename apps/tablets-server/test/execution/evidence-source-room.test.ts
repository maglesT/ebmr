/**
 * Step commands and scale readings are bound to the room of the step's stage (review finding P36; DI-20, DI-32,
 * PR-20, PR-23).
 *
 * Before the fix the command handler passed the session terminal's room to the intent resolution, and the scale
 * readings were claimed for THAT room. Nothing compared the stage binding (S-DISP -> DISP-1 in dc-mini) with the
 * terminal's room: a DISP-1 weighing could be recorded from the BLEND-1 kiosk on the BLEND-1 balance (stored as
 * DEVICE, no hand-entry flag, no second person), and the DISP-1 clearance could be recorded from another room or an
 * office PC. DI-20 accepts data of a step whose MBR declares a binding only from a device assigned to the step's
 * location; the plan's "kiosk's room" is weaker, and the stricter rule wins.
 *
 * The rule now: START_STEP, RECORD_DATA and RECORD_ENTRY of a step whose stage names rooms are refused (nothing
 * written) unless the terminal is registered to one of those rooms, and readings are claimed for that room only;
 * the database refuses the same rows, and the step's PERFORMED and VERIFY signatures, from any other terminal, and
 * a device entry whose balance is not an active instrument of the terminal's own room or whose weights are not the
 * readings claimed for it in the same command.
 *
 * Round-1 verification (recipe-core 0300, tablets 0300): the database checked the command row only, so
 *  - a state that changes another step than the one the row acts on (a room-free exception completing the DISP-1
 *    clearance, a start that brings in the next step already started) passed the room check;
 *  - an accepted step row naming no step, or no step of the MBR, passed from any terminal (fail open);
 *  - a device weighing on a BLOCKED balance, or with invented weights and no claimed reading, was recorded;
 *  - a refused row from another room (a signing dry run refused by the engine) was itself refused, so the engine's
 *    refusal was neither recorded nor shown.
 *
 * Round-2 verification (recipe-core 0303): 0300 confined a row to the step it acts on only for what the row ADDED. An
 * exception raised from the BLEND-1 kiosk (any room may raise one) could rewrite the DISP-1 weighing already recorded
 * (its weights, its source) or take its container out of quarantine, and the database recorded it. What the state has
 * recorded is now kept by every later row (EBMR-EXE-126); only the engine's own changes pass (a charge consumes a
 * container in the step that charges it).
 *
 * Round-1 verification (execution-refusal-guidance-and-room-ux): a PERFORMED or VERIFY signature from a terminal outside
 * the step's room was refused only when it was applied, after the PIN. The server now refuses it when the signing is
 * requested (EBMR-EXE-123, with the room to go to), so over HTTP no dry run from another room is left; the database's
 * own refusal of the signed row, and its keeping of a refused dry-run row, are shown on rows written past the server.
 *
 * Round-2 verification (guards no test held): five guards of recipe-core 0300 and tablets 0300 could each be removed
 * with every test still passing. Each now has a forgery that it alone refuses, beside the honest row: a new step
 * instance brought in IN_PROGRESS but otherwise as the token enables one (EBMR-EXE-128); an entry whose state appends a
 * signature the row does not carry, or adds its person as a PERFORMED signer (EBMR-EXE-128); a device weighing stored
 * with another gross than its command sent (EBMR-EXE-126); and one standing on readings claimed and committed in an
 * earlier command under the same correlation id, which the application chooses (EBMR-EXE-124).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import type { SignedIntent } from '@ebmr/api-contract';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../src/features/devices/enrol.ts';
import { containerId, READING_MAX_AGE_US } from '../../src/features/execution/intents.ts';
import { lotForEngine, resolveLot } from '../../src/features/execution/lots.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { adminActor, fakeGateway, gatewayKey, type FakeGateway } from '../devices/support.ts';
import { actorOfBrowser } from '../esig/support.ts';
import { actorOf, appendAs, engineResult, messageOf, nextState, prepareSignature } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, refusalOf, rowsOf, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
let gw: FakeGateway;

beforeAll(async () => {
  server = await startExecServer();
  // The site gateway serves both balances of the demo site: TEST-BAL-01 (DISP-1) and TEST-BAL-02 (BLEND-1).
  await enrolGateway(server.db.app, await adminActor(server), {
    ...DEMO_GATEWAY,
    spki: gatewayKey(server).publicKeySpki,
    instruments: [...DEMO_INSTRUMENTS, { deviceCode: 'TEST-BAL-02', serial: 'SIM-0002', unit: 'kg', resolution: '0.001' }],
  });
  gw = await fakeGateway(server);
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await gw?.close();
  await server?.close();
});

/** A stable reading of `deviceCode` taken for `purpose`, ingested as the gateway would; returns its id. */
async function reading(deviceCode: string, serial: string, purpose: 'TARE' | 'GROSS', value: string): Promise<string> {
  const r = gw.next({ deviceCode, serial, purpose, value });
  const res = await gw.uplink([{ reading: r, delayUs: '1000' }]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.refused, JSON.stringify(res.body.refused)).toBeNull();
  return r.readingId;
}

const CLEAR = 'p-disp-clear@';
const PCM = 'p-disp-pcm@';

const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'X', batchNumber: 'TEST-B26-9' } },
];

const weigh = (tareReadingId: string, grossReadingId: string) => ({
  type: 'RECORD_ENTRY' as const,
  stepKey: PCM,
  entry: { kind: 'CONTAINER_WEIGHING' as const, item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', tareReadingId, grossReadingId },
});

async function newRun(extra: Record<string, [persona: string, terminal?: string]> = {}): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, dcMini()));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = {
    issuer,
    operator1: await server.asPersona('operator1'), // TEST-KIOSK-DISP-1 (room DISP-1)
    verifier1: await server.asPersona('verifier1'), // TEST-KIOSK-DISP-1
  };
  for (const [name, [persona, terminal]] of Object.entries(extra)) browsers[name] = await server.asPersona(persona, terminal);
  const d = new RunDriver(server, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** Clearance, balance status, SOP and quantities of the dispensing stage on the DISP-1 kiosk, then start the paracetamol step. */
async function prepareDispensing(d: RunDriver): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok('operator1', c);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-1', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-sop@' });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-sop@', entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-sop@' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-calc@' });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-calc@' });
  await d.ok('operator1', { type: 'START_STEP', stepKey: PCM });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

describe('P36: scale readings and commands are bound to the step\'s room (DI-20)', () => {
  it('[DI-20][DI-32][PR-20] a DISP-1 weighing sent from the BLEND-1 kiosk with readings of the BLEND-1 balance is refused, nothing written', async () => {
    const d = await newRun({ operator2: ['operator2'] }); // operator2 on TEST-KIOSK-BLEND-1 (room BLEND-1)
    expect(d.browser('operator2').terminal).toBe('TEST-KIOSK-BLEND-1');
    await prepareDispensing(d);

    // Control: the DISP-1 balance from the DISP-1 kiosk is accepted as a device weighing (the set-up is sound).
    const control = valueOf(await d.command('operator1', weigh(await reading('TEST-BAL-01', 'SIM-0001', 'TARE', '1.250'), await reading('TEST-BAL-01', 'SIM-0001', 'GROSS', '11.250'))));
    expect(control.step?.entries.at(-1)?.data).toMatchObject({ source: 'DEVICE', balance: 'TEST-BAL-01' });

    // The same step (stage S-DISP, bound to room DISP-1) from the BLEND-1 kiosk, weighed on the BLEND-1 balance.
    const tare = await reading('TEST-BAL-02', 'SIM-0002', 'TARE', '1.100');
    const gross = await reading('TEST-BAL-02', 'SIM-0002', 'GROSS', '21.100');
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const wrongRoom = await d.command('operator2', weigh(tare, gross));

    const st = await execution.loadState(server.db.admin, d.runId);
    const fromBlendBalance = Object.values(st?.state.entries ?? {}).filter((e) => e.stepKey === PCM && e.data['balance'] === 'TEST-BAL-02');
    expect(
      { outcome: outcomeOf(wrongRoom), fromBlendBalance: fromBlendBalance.map((e) => ({ balance: e.data['balance'], source: e.data['source'], enteredBy: e.enteredBy })) },
      'a weighing of the DISP-1 step must not be accepted from the BLEND-1 kiosk with readings of the BLEND-1 balance (DI-20: data only from a device assigned to the step\'s location)',
    ).toEqual({ outcome: '422:EBMR-EXE-123', fromBlendBalance: [] });
    expect(refusalOf(wrongRoom)).toMatchObject({ status: 422, code: 'EBMR-EXE-123', kind: 'NOT_ALLOWED' });
    expect(refusalOf(wrongRoom).why).toMatch(/BLEND-1.*DISP-1/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    // Refused before the claim: the BLEND-1 readings were not used up by the refused command.
    const { rows: used } = await server.db.admin.query('select 1 from tab.reading_use where reading_id = any($1::uuid[])', [[tare, gross]]);
    expect(used).toEqual([]);

    // The step's own kiosk cannot use the BLEND-1 balance either: its readings are claimed for DISP-1 only.
    const fromOtherBalance = await d.command('operator1', weigh(await reading('TEST-BAL-02', 'SIM-0002', 'TARE', '1.100'), await reading('TEST-BAL-02', 'SIM-0002', 'GROSS', '21.100')));
    expect(outcomeOf(fromOtherBalance)).toMatch(/^4\d\d:EBMR-DEV-103$/);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][PR-23] the DISP-1 clearance cannot be started or recorded from the BLEND-1 kiosk or an office PC; the terminal of the room is accepted', async () => {
    const d = await newRun({ operator2: ['operator2'], office: ['operator1', 'TEST-PC-01'] });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const fromBlend = await d.command('operator2', { type: 'START_STEP', stepKey: CLEAR });
    expect(refusalOf(fromBlend)).toMatchObject({ status: 422, code: 'EBMR-EXE-123', kind: 'NOT_ALLOWED' });
    expect(refusalOf(fromBlend).why).toMatch(/BLEND-1.*DISP-1/);
    const fromOffice = await d.command('office', { type: 'START_STEP', stepKey: CLEAR });
    expect(refusalOf(fromOffice)).toMatchObject({ status: 422, code: 'EBMR-EXE-123' });
    expect(refusalOf(fromOffice).why).toMatch(/no room/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);

    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const who of ['operator2', 'office']) {
      for (const c of clearance) expect(outcomeOf(await d.command(who, c))).toBe('422:EBMR-EXE-123');
    }
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    // Raising an exception about the step is never blocked by the room (it only adds a record).
    await d.ok('operator2', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Seen from the blending room: booth door open', severity: 'ALERT' });
    for (const c of clearance) await d.ok('operator1', c);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-35][PR-23] the step\'s PERFORMED and VERIFY signatures from a terminal outside the step\'s room are refused before the PIN, with the room to go to; the database refuses the signed rows written past the server; nothing is signed', async () => {
    const d = await newRun({ verifier2: ['verifier2'] });
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    const run = await runContext(server.db.admin, d.runId);
    const challenges = async () => (await server.db.admin.query('select 1 from esig.challenge where aggregate_id = $1', [`${d.runId}:${CLEAR}`])).rows.length;
    const signedRow = (who: string, browser: ReturnType<RunDriver['browser']>, type: 'SIGN_PERFORMED' | 'VERIFY', meaning: string) =>
      codeOf(
        (async () => {
          // Written past the server: a real e-signature of the signer made through the kernel in this terminal's session.
          const p = await prepareSignature(server, browser, who, 'batch_step', `${d.runId}:${CLEAR}`, meaning);
          return withCommand(server.db.app, await p.actor(), async (c) => {
            const id = await p.sign(c);
            const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
            const roles = await engineRoles(c);
            const command: engine.Command = { type, commandId: randomUUID(), actor: engineActor(personaIn(server, who).personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning, signer: personaIn(server, who).personId } };
            return appendAs(tx, command, engineResult(tx, command), roles);
          });
        })(),
      );
    // The performer walks to the blending kiosk (a new shop-floor session ends the one on DISP-1) and signs there.
    const atBlend = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1', 'TEST-KIOSK-BLEND-1') });
    atBlend.beforeTap = d.beforeTap;
    const challengesBefore = await challenges();
    const performedElsewhere = await atBlend.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    // Refused when the signing is requested, before any challenge or PIN, with the declared controls and the room to go to.
    expect(performedElsewhere.stage).toBe('challenge');
    expect(refusalOf(performedElsewhere.result)).toMatchObject({ status: 422, code: 'EBMR-EXE-123', kind: 'NOT_ALLOWED', controls: ['DI-20', 'PR-23'], whatYouCanDo: ['Go to the terminal in DISP-1 and do the step there.'] });
    expect(await challenges()).toBe(challengesBefore);
    expect((await atBlend.stepView('operator1', CLEAR)).step.status).toBe('IN_PROGRESS');
    // Written past the server from that kiosk, with the performer's real signature: the database refuses the row.
    expect(await signedRow('operator1', atBlend.browser('operator1'), 'SIGN_PERFORMED', 'LINE_CLEARANCE_PERFORMED')).toBe('EBMR-EXE-123');
    // Back on the DISP-1 kiosk the same signature is accepted.
    const back = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1'), verifier1: d.browser('verifier1'), verifier2: d.browser('verifier2') });
    back.beforeTap = d.beforeTap;
    await back.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    const verifiedElsewhere = await back.sign('verifier2', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    expect(verifiedElsewhere.stage).toBe('challenge');
    expect(refusalOf(verifiedElsewhere.result)).toMatchObject({ status: 422, code: 'EBMR-EXE-123', controls: ['DI-20', 'PR-23'], whatYouCanDo: ['Go to the terminal in DISP-1 and do the step there.'] });
    expect(await signedRow('verifier2', back.browser('verifier2'), 'VERIFY', 'LINE_CLEARANCE_VERIFIED')).toBe('EBMR-EXE-123');
    expect((await back.stepView('operator1', CLEAR)).step.status).toBe('AWAITING_VERIFICATION');
    const { rows } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1', [`${d.runId}:${CLEAR}`]);
    expect(rows).toHaveLength(1);
    await back.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    expect((await back.stepView('operator1', CLEAR)).step.status).toBe('COMPLETED');
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-30][DI-31][DI-32] the database refuses a device weighing that does not stand on readings claimed for it, in its own command, from an active instrument of the terminal\'s room, or that is stored with other weights than its command sent, even from the step\'s own kiosk', async () => {
    const d = await newRun();
    await prepareDispensing(d);
    const run = await runContext(server.db.admin, d.runId);
    const lot = await resolveLot(server.db.admin, 'TEST-L26-0101');
    if (!lot) throw new Error('SETUP: demo lot missing');
    const bal01 = (await server.db.admin.query<{ id: string }>("select id from iam.device where code = 'TEST-BAL-01'")).rows[0]?.id ?? '';
    const setStatus = async (status: 'ACTIVE' | 'BLOCKED', reason: string) =>
      withCommand(server.db.app, await adminActor(server, reason), (c) => identity.setDeviceStatus(c, bal01, status, reason));
    interface Weighing {
      balance: string;
      tare: string;
      gross: string;
      /** Readings (ids) claimed for TARE and GROSS in the command, as the server claims them (DISP-1). */
      claim?: { tare: string; gross: string };
      /**
       * The readings are claimed in a command of their own, committed before the weighing's command, which then names
       * them under the same correlation id (the application chooses correlation ids; review P24).
       */
      claimedEarlier?: boolean;
      /** Something that happens after the claim, before the row is written. */
      between?: () => Promise<void>;
      /** The same claimed readings are named by a second entry of the same command. */
      twice?: boolean;
      /** Changes the state stored beside the command (the engine's answer to it), written past ExecutionTx. */
      stored?: (state: engine.BatchState, before: engine.BatchState) => void;
    }
    // Written past the server, as a server that skips its own claim or checks would write it.
    const weighOn = async (w: Weighing) => {
      const correlationId = randomUUID();
      const claimed = async (c: Parameters<typeof server.built.ctx.deviceReadings.claim>[0]) => {
        const readings: engine.JsonValue[] = [];
        for (const [purpose, id] of w.claim ? ([['TARE', w.claim.tare], ['GROSS', w.claim.gross]] as const) : []) {
          const [r] = await server.built.ctx.deviceReadings.claim(c, { readingIds: [id], room: 'DISP-1', maxAgeUs: READING_MAX_AGE_US, purpose });
          if (!r) throw new Error('SETUP: nothing claimed');
          readings.push({ purpose, readingId: r.readingId, deviceCode: r.deviceCode, value: r.value, unit: r.unit, raw: r.raw, sourceTimeUs: r.sourceTimeUs?.toString() ?? null, trust: r.trust });
        }
        return readings;
      };
      const earlier = w.claimedEarlier ? await withCommand(server.db.app, await actorOf(server, d.browser('operator1'), 'operator1', { correlationId }), claimed) : undefined;
      return withCommand(server.db.app, await actorOf(server, d.browser('operator1'), 'operator1', { correlationId }), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const readings = earlier ?? (await claimed(c));
        await w.between?.();
        const record = async () => {
          const entry = { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', container: containerId(tx.state, undefined), lot: lotForEngine(lot), gross: w.gross, tare: w.tare, unit: 'kg', balance: w.balance, source: 'DEVICE' };
          const command: engine.Command = { type: 'RECORD_ENTRY', commandId: randomUUID(), actor: engineActor(personaIn(server, 'operator1').personId, roles), step: 'p-disp-pcm', context: [], entry };
          if (!w.stored) return tx.command(command, roles, { readings });
          const r = engineResult(tx, command);
          w.stored(r.state, tx.state);
          await appendAs(tx, command, r, roles, undefined, undefined, { readings });
          return r;
        };
        const r = await record();
        if (w.twice) await record();
        return r;
      });
    };
    const bal = (purpose: 'TARE' | 'GROSS', value: string) => reading('TEST-BAL-01', 'SIM-0001', purpose, value);
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const outcomes = {
      otherRoomBalance: await codeOf(weighOn({ balance: 'TEST-BAL-02', tare: '1.250', gross: '11.250' })),
      notAnInstrument: await codeOf(weighOn({ balance: 'TEST-KIOSK-DISP-1', tare: '1.250', gross: '11.250' })),
      // The room's own balance, with invented weights and no reading behind them.
      noReadings: await codeOf(weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250' })),
      // Readings claimed for the entry, but the entry states other weights than they read.
      otherWeights: await codeOf(weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '21.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') } })),
      // One claim, two entries.
      readingsTwice: await codeOf(weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') }, twice: true })),
      // The balance is blocked after its readings were claimed, before the weighing is recorded.
      blockedBalance: await codeOf(
        weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') }, between: () => setStatus('BLOCKED', 'Balance failed its daily check (test)') }),
      ),
    };
    await setStatus('ACTIVE', 'Balance recalibrated and checked (test)');
    // The readings were claimed and committed in an earlier command, by the same person's session, for the same room,
    // under the correlation id the weighing's command then reuses: they were not claimed in this command.
    const claimedEarlier = await messageOf(weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') }, claimedEarlier: true }));
    // The command states the weights its readings read; the entry stored beside it holds another gross.
    const storedOtherGross = await messageOf(
      weighOn({
        balance: 'TEST-BAL-01',
        tare: '1.250',
        gross: '11.250',
        claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') },
        stored: (s, before) => {
          const [added, ...more] = Object.values(s.entries).filter((e) => !before.entries[e.id]);
          if (!added || more.length > 0 || added.data['gross'] !== '11.250') throw new Error(`SETUP: the engine stored ${String(added?.id)} and ${more.length} more`);
          added.data = { ...added.data, gross: '12.250' };
        },
      }),
    );
    expect(outcomes).toEqual({
      otherRoomBalance: 'EBMR-EXE-124',
      notAnInstrument: 'EBMR-EXE-124',
      noReadings: 'EBMR-EXE-124',
      otherWeights: 'EBMR-EXE-124',
      readingsTwice: 'EBMR-EXE-124',
      blockedBalance: 'EBMR-EXE-124',
    });
    expect({ claimedEarlier, storedOtherGross }).toEqual({
      claimedEarlier: expect.stringMatching(/the tare reading [0-9a-f-]{36} was not claimed as tare by this person's session, in this command, for room DISP-1 .*\[EBMR-EXE-124\]/) as unknown,
      storedOtherGross: expect.stringMatching(/Entry [A-Z]+-\d+ stores another gross than its RECORD_ENTRY sent .*\[EBMR-EXE-126\]/) as unknown,
    });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    // Controls: readings claimed in the weighing's own command, as the server claims them; and the same written past
    // ExecutionTx with the state the engine stores for it.
    const ok = await weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') } });
    expect(ok.accepted).toBe(true);
    const storedAsComputed = await weighOn({ balance: 'TEST-BAL-01', tare: '1.250', gross: '11.250', claim: { tare: await bal('TARE', '1.250'), gross: await bal('GROSS', '11.250') }, stored: () => undefined });
    expect(storedAsComputed.accepted).toBe(true);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 2);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20] the database refuses a step row written past the server from a terminal outside the step\'s room', async () => {
    const d = await newRun({ operator2: ['operator2'], office: ['operator1', 'TEST-PC-01'] });
    const run = await runContext(server.db.admin, d.runId);
    const start = async (browser: string, persona: string) =>
      withCommand(server.db.app, await actorOfBrowser(server, d.browser(browser), persona), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        return tx.command({ type: 'START_STEP', commandId: randomUUID(), actor: engineActor(personaIn(server, persona).personId, roles), step: 'p-disp-clear', context: [] }, roles);
      });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    expect(await codeOf(start('operator2', 'operator2'))).toBe('EBMR-EXE-123');
    expect(await codeOf(start('office', 'operator1'))).toBe('EBMR-EXE-123');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    expect(await codeOf(start('operator1', 'operator1'))).toBe('ok');
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});

/** A step instance of a state (it must exist). */
function stepOf(state: engine.BatchState, key: string): engine.StepInstance {
  const inst = state.steps[key];
  if (!inst) throw new Error(`SETUP: no step instance ${key}`);
  return inst;
}

/**
 * What a writer holding the application role's credentials stores past the server, in a command of `persona` on its
 * own terminal: `forge` returns the engine command, the state beside it (the engine's answer, possibly edited) and,
 * optionally, the JSON recorded in place of the command; appended as accepted. The database's refusal code, or 'ok'.
 */
async function forged(
  d: RunDriver,
  persona: string,
  forge: (tx: execution.ExecutionTx, me: engine.Actor) => { command: engine.Command; result: Pick<engine.StepResult, 'state' | 'events'>; recorded?: engine.JsonValue },
): Promise<string> {
  return codeOf(forgedRow(d, persona, forge));
}

/** `forged`, rejected with the database's refusal itself (for its message). */
async function forgedRow(
  d: RunDriver,
  persona: string,
  forge: (tx: execution.ExecutionTx, me: engine.Actor) => { command: engine.Command; result: Pick<engine.StepResult, 'state' | 'events'>; recorded?: engine.JsonValue },
): Promise<void> {
  const run = await runContext(server.db.admin, d.runId);
  await withCommand(server.db.app, await actorOf(server, d.browser(persona), persona), async (c) => {
    const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
    const roles = await engineRoles(c);
    const f = forge(tx, engineActor(personaIn(server, persona).personId, roles));
    await appendAs(tx, f.command, f.result, roles, f.recorded ?? engine.encodeCommand(f.command));
  });
}

describe('P36 (round-1 residuals a, b, d): a row changes only the step it acts on, names a step of the MBR, and a refusal is recorded from any room', () => {
  it('[DI-20][DI-34][DI-35][INV-03][INV-10] a room-free exception completing the DISP-1 clearance, a start bringing in the next step already started (or only marked IN_PROGRESS), or an entry completing or signing its own step, is refused; the honest rows are recorded', async () => {
    const d = await newRun({ operator2: ['operator2'] }); // operator2 on TEST-KIOSK-BLEND-1
    const start = (me: engine.Actor): engine.Command => ({ type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [] });
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const beforeStart = {
      // Raising an exception is open to any room; its state must not carry the clearance, completed, with it.
      exceptionCompletesClearance: await forged(d, 'operator2', (tx, me) => {
        const command: engine.Command = { type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: me, description: 'Seen from the blending room: booth door open', severity: 'ALERT' };
        const result = engineResult(tx, command);
        const clear = stepOf(result.state, CLEAR);
        clear.status = 'COMPLETED';
        clear.completedAt = tx.nowUs;
        return { command, result };
      }),
      // The clearance start from its own kiosk, with the balance check (the next step) brought in already started,
      // told by the system's event from PENDING as a step the token enabled would be (so recipe-core 0299 lets it by).
      startBringsInNextStep: await forged(d, 'operator1', (tx, me) => {
        const command = start(me);
        const result = engineResult(tx, command);
        result.state.steps['p-disp-bal@'] = { ...structuredClone(stepOf(result.state, CLEAR)), key: 'p-disp-bal@', step: 'p-disp-bal' };
        result.state.seq += 1;
        const events: engine.EngineEvent[] = [
          ...result.events,
          { type: 'STEP_STATUS_CHANGED', stepKey: 'p-disp-bal@', step: 'p-disp-bal', from: 'PENDING', to: 'IN_PROGRESS', by: 'SYSTEM', seq: result.state.seq, at: tx.nowUs },
        ];
        return { command, result: { state: result.state, events } };
      }),
    };
    // The same start, with the balance check brought in IN_PROGRESS but otherwise exactly as the token enables a step
    // (no start, no person, no signature): only its status says it is not a step the system brought in.
    const bareInProgress = await messageOf(
      forgedRow(d, 'operator1', (tx, me) => {
        const command = start(me);
        const result = engineResult(tx, command);
        const enabled = stepOf(tx.state, CLEAR);
        if (enabled.status !== 'ENABLED' || enabled.startedAt !== undefined) throw new Error(`SETUP: ${CLEAR} is ${enabled.status} before its start`);
        result.state.steps['p-disp-bal@'] = { ...structuredClone(enabled), key: 'p-disp-bal@', step: 'p-disp-bal', status: 'IN_PROGRESS' };
        result.state.seq += 1;
        const events: engine.EngineEvent[] = [
          ...result.events,
          { type: 'STEP_STATUS_CHANGED', stepKey: 'p-disp-bal@', step: 'p-disp-bal', from: 'PENDING', to: 'IN_PROGRESS', by: 'SYSTEM', seq: result.state.seq, at: tx.nowUs },
        ];
        return { command, result: { state: result.state, events } };
      }),
    );
    expect(beforeStart).toEqual({ exceptionCompletesClearance: 'EBMR-EXE-128', startBringsInNextStep: 'EBMR-EXE-128' });
    expect(bareInProgress).toMatch(/Step instance p-disp-bal@ is new in the state, and it appears IN_PROGRESS, not as a step the token enables or an untaken branch sets not applicable.*\[EBMR-EXE-128\]/);
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const [check] = clearance;
    if (!check) throw new Error('SETUP: no clearance entry');
    const entry = (me: engine.Actor): engine.Command => ({ type: 'RECORD_ENTRY', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [], entry: check.entry });
    const afterStart: Record<string, string> = {
      entryCompletesOwnStep: await forged(d, 'operator1', (tx, me) => {
        const command = entry(me);
        const result = engineResult(tx, command);
        const clear = stepOf(result.state, CLEAR);
        clear.status = 'COMPLETED';
        clear.completedAt = tx.nowUs;
        return { command, result };
      }),
    };
    // An entry of the step whose state signs the step: a PERFORMED signature appended with an id this row does not
    // carry (no e-signature stands behind it), or the entering person added as a PERFORMED signer with no signature at
    // all. Only the accepted SIGN_PERFORMED of that person, with its e-signature, adds either.
    const signs = {
      signatureNotCarried: await messageOf(
        forgedRow(d, 'operator1', (tx, me) => {
          const command = entry(me);
          const result = engineResult(tx, command);
          stepOf(result.state, CLEAR).signatures.push({ id: randomUUID(), meaning: 'LINE_CLEARANCE_PERFORMED', signer: me.id, at: tx.nowUs, role: 'PERFORMED', valid: true });
          return { command, result };
        }),
      ),
      performedSignerAdded: await messageOf(
        forgedRow(d, 'operator1', (tx, me) => {
          const command = entry(me);
          const result = engineResult(tx, command);
          stepOf(result.state, CLEAR).performedSigners.push(me.id);
          return { command, result };
        }),
      ),
    };
    afterStart['control'] = await forged(d, 'operator1', (tx, me) => {
      const command = entry(me);
      return { command, result: engineResult(tx, command) };
    });
    expect(afterStart).toEqual({ entryCompletesOwnStep: 'EBMR-EXE-128', control: 'ok' });
    expect(signs).toEqual({
      signatureNotCarried: expect.stringMatching(/The state of step p-disp-clear@ after this RECORD_ENTRY row does not follow from it: signature [0-9a-f-]{36} is not an e-signature this row carries .*\[EBMR-EXE-128\]/) as unknown,
      performedSignerAdded: expect.stringMatching(/The state of step p-disp-clear@ after this RECORD_ENTRY row does not follow from it: a PERFORMED signer is added that did not sign it performed in this row .*\[EBMR-EXE-128\]/) as unknown,
    });
    const st = await execution.loadState(server.db.admin, d.runId);
    expect(st?.state.steps[CLEAR]?.status).toBe('IN_PROGRESS');
    expect(st?.state.steps['p-disp-bal@']).toBeUndefined();
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-34] an accepted step row that names no step, or a step the MBR does not hold, is refused from any terminal; the room of such a step is a problem, never "no room"', async () => {
    const d = await newRun({ operator2: ['operator2'] });
    const noStep = (persona: string) =>
      forged(d, persona, (tx, me) => {
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-disp-clear', context: [] };
        const recorded = Object.fromEntries(Object.entries(engine.encodeCommand(command) as Record<string, engine.JsonValue>).filter(([k]) => k !== 'step'));
        return { command, result: nextState(tx), recorded };
      });
    const unknownStep = (persona: string) =>
      forged(d, persona, (tx, me) => ({ command: { type: 'START_STEP', commandId: randomUUID(), actor: me, step: 'p-no-such-step', context: [] }, result: nextState(tx) }));
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const outcomes = {
      noStepFromDisp1: await noStep('operator1'),
      noStepFromBlend1: await noStep('operator2'),
      unknownFromDisp1: await unknownStep('operator1'),
      unknownFromBlend1: await unknownStep('operator2'),
    };
    expect(outcomes).toEqual({ noStepFromDisp1: 'EBMR-EXE-125', noStepFromBlend1: 'EBMR-EXE-125', unknownFromDisp1: 'EBMR-EXE-125', unknownFromBlend1: 'EBMR-EXE-125' });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
    const problem = async (step: string | null, room: string | null) =>
      (
        await server.db.admin.query<{ p: string | null }>(
          'select recipe.step_room_problem(pk.content, $2, $3) as p from recipe.batch_execution b join recipe.test_package pk on pk.package_hash = b.package_hash where b.id = $1',
          [d.runId, step, room],
        )
      ).rows[0]?.p ?? null;
    const problems = { none: await problem(null, 'DISP-1'), unknown: await problem('p-no-such-step', 'DISP-1'), own: await problem('p-disp-clear', 'DISP-1'), other: await problem('p-disp-clear', 'BLEND-1') };
    expect(problems.none).toMatch(/has no step/);
    expect(problems.unknown).toMatch(/has no step p-no-such-step/);
    expect(problems.own).toBeNull();
    expect(problems.other).toMatch(/bound to DISP-1/);
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-34][INV-10] a VERIFY from another room is refused before its PIN; the refused row a signing dry run records there when the engine refuses the act (the run moved on) is kept with the engine\'s refusal, nothing signed', async () => {
    const d = await newRun({ verifier2: ['verifier2'] }); // verifier2 on TEST-KIOSK-BLEND-1
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    const signatures = async () => (await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1', [`${d.runId}:${CLEAR}`])).rows.length;
    const signedBefore = await signatures();
    // Over HTTP the signing from the BLEND-1 kiosk is refused when it is requested, before a challenge and a PIN.
    const intent: SignedIntent = { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' };
    const asked = await d.sign('verifier2', intent);
    expect(asked.stage).toBe('challenge');
    expect(refusalOf(asked.result).code).toBe('EBMR-EXE-123');
    // The refused COMMAND row a signing dry run records when the engine refuses the act (here the run moved on since
    // the screen was read: ENG-STALE), written from the BLEND-1 kiosk as the dry run writes it, with the placeholder
    // signature: the database keeps it with the engine's refusal and the terminal's room, since it changes nothing.
    const run = await runContext(server.db.admin, d.runId);
    const read = (await d.version('operator1')) - 1;
    const dry = await withCommand(server.db.app, await actorOf(server, d.browser('verifier2'), 'verifier2'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const actor = engineActor(personaIn(server, 'verifier2').personId, roles);
      const command: engine.Command = {
        type: 'VERIFY',
        commandId: `ESIG-DRY:${randomUUID()}`,
        actor,
        expectedVersion: read,
        step: 'p-disp-clear',
        context: [],
        signature: { id: engine.PLACEHOLDER_SIGNATURE_ID, meaning: 'LINE_CLEARANCE_VERIFIED', signer: actor.id },
      };
      return tx.command(command, roles, { signing: 'refused before signing', meaning: 'LINE_CLEARANCE_VERIFIED' });
    });
    expect(dry.accepted).toBe(false);
    const { rows } = await server.db.admin.query<{ command_type: string; accepted: boolean; refusal: { code: string } | null; room_code: string | null; signature_ids: string[] }>(
      'select command_type, accepted, refusal, room_code, signature_ids::text[] as signature_ids from recipe.execution_command where batch_id = $1 order by seq desc limit 1',
      [d.runId],
    );
    expect(rows[0]).toMatchObject({ command_type: 'VERIFY', accepted: false, refusal: { code: 'ENG-STALE' }, room_code: 'BLEND-1', signature_ids: [] });
    expect(await signatures()).toBe(signedBefore);
    expect((await d.stepView('operator1', CLEAR)).step.status).toBe('AWAITING_VERIFICATION');
    // Accepted by the engine, the same VERIFY from there is still refused (before its PIN; the database refuses the
    // signed row, see the signature test above).
    const again = await d.sign('verifier2', intent);
    expect(refusalOf(again.result).code).toBe('EBMR-EXE-123');
    expect(await signatures()).toBe(signedBefore);
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});

describe('P36 (round-2 verification): a row from another room cannot rewrite what the step recorded (recipe-core 0303)', () => {
  it('[DI-20][DI-32][DI-24][PR-21] an exception raised from the BLEND-1 kiosk whose state rewrites the DISP-1 device weighing, relabels it as a hand entry, or takes its container out of quarantine is refused; the honest exception is recorded', async () => {
    const d = await newRun({ operator2: ['operator2'] }); // operator2 on TEST-KIOSK-BLEND-1
    await prepareDispensing(d);
    valueOf(await d.command('operator1', weigh(await reading('TEST-BAL-01', 'SIM-0001', 'TARE', '1.250'), await reading('TEST-BAL-01', 'SIM-0001', 'GROSS', '11.250'))));
    const recorded = (await execution.loadState(server.db.admin, d.runId))?.state;
    const weighing = Object.values(recorded?.entries ?? {}).find((e) => e.stepKey === PCM && e.kind === 'CONTAINER_WEIGHING');
    const container = Object.values(recorded?.containers ?? {}).find((c) => c.producedBy === PCM);
    if (!weighing || !container) throw new Error('SETUP: the DISP-1 weighing registered no entry or container');
    expect(weighing.data).toMatchObject({ source: 'DEVICE', balance: 'TEST-BAL-01', gross: '11.250', tare: '1.250' });
    expect(container.status).toBe('QUARANTINE');
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const fromBlend = (edit: (s: engine.BatchState) => void) =>
      forged(d, 'operator2', (tx, me) => {
        const command: engine.Command = { type: 'RAISE_EXCEPTION', commandId: randomUUID(), actor: me, description: 'Seen from the blending room: booth door open', severity: 'ALERT' };
        const result = engineResult(tx, command);
        edit(result.state);
        return { command, result };
      });
    const entryOf = (s: engine.BatchState) => s.entries[weighing.id] as engine.EntryRecord;
    const containerOf = (s: engine.BatchState) => s.containers[container.id] as engine.ContainerRecord;
    const outcomes = {
      otherGross: await fromBlend((s) => void (entryOf(s).data = { ...entryOf(s).data, gross: '12.250', net: '11' })),
      handEntry: await fromBlend((s) => void (entryOf(s).data = { ...entryOf(s).data, source: 'MANUAL' })),
      otherNet: await fromBlend((s) => void (containerOf(s).net = { value: '11', unit: 'kg' })),
      consumed: await fromBlend((s) => {
        containerOf(s).status = 'CONSUMED';
        containerOf(s).consumedBy = 'p-blend-charge@';
      }),
      control: await fromBlend(() => undefined),
    };
    expect(outcomes).toEqual({ otherGross: 'EBMR-EXE-126', handEntry: 'EBMR-EXE-126', otherNet: 'EBMR-EXE-126', consumed: 'EBMR-EXE-126', control: 'ok' });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    const after = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(after?.entries[weighing.id]).toEqual(weighing);
    expect(after?.containers[container.id]).toEqual(container);
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});
