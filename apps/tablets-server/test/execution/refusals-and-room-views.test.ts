/**
 * What a refusal and a step screen tell the person (round-1 verification item execution-refusal-guidance-and-room-ux;
 * review findings P34, P36, P46 and P58 follow-ups).
 *
 * Before the fix:
 *  - the idempotent command wrapper turned every refusal the server threw inside a command into a kernel error, so
 *    EBMR-EXE-121, 122 and 123 reached the person with the generic "the test run refused this action" and the control
 *    DI-34, not the controls and advice declared with them (the room to go to, the hand-entry rules);
 *  - the refusals the database raises for what a step records, its room and its state, and EBMR-EXE-044, had no
 *    guidance of their own, and EBMR-EXE-086 spoke only of exception dispositions although it also guards hold-point
 *    decisions (PR-45);
 *  - a step screen opened on a terminal outside the step's room offered start, record, sign and verify as available
 *    (each then refused, a signature only after the PIN), and its header showed the scale of the viewer's room;
 *  - a verification greyed for the person who performed the step named nobody who could give it (P46);
 *  - a command committed before its answer view failed was answered "nothing was saved".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { routes } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core';
import { DEMO_GATEWAY, DEMO_INSTRUMENTS, enrolGateway } from '../../src/features/devices/enrol.ts';
import { EXECUTION_GUIDANCE } from '../../src/features/execution/guidance.ts';
import { mapError } from '../../src/platform/http/errors.ts';
import { adminActor, gatewayKey } from '../devices/support.ts';
import { dcMini, dcMiniVariant, importAndIssue, personaIn, refusalOf, rowsOf, RunDriver, startExecServer, valueOf, violations, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;

beforeAll(async () => {
  server = await startExecServer();
  // Both balances of the demo site are bound: TEST-BAL-01 (DISP-1) and TEST-BAL-02 (BLEND-1).
  await enrolGateway(server.db.app, await adminActor(server), {
    ...DEMO_GATEWAY,
    spki: gatewayKey(server).publicKeySpki,
    instruments: [...DEMO_INSTRUMENTS, { deviceCode: 'TEST-BAL-02', serial: 'SIM-0002', unit: 'kg', resolution: '0.001' }],
  });
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

type Json = Record<string, unknown>;

const CLEAR = 'p-disp-clear@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'X', batchNumber: 'TEST-B26-9' } },
];

async function newRun(content: flow.MbrContent = dcMini(), extra: Record<string, [persona: string, terminal?: string]> = {}): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
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

async function performClearance(d: RunDriver): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok('operator1', c);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
}

/** The booth clearance with another check: `check` replaces its check signature. */
const clearanceCheckedBy = (check: Json): flow.MbrContent =>
  dcMiniVariant(([clear, ...rest]) => [{ ...(clear as Json), signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check } }, ...rest]);

// ---------------------------------------------------------------------------------------------
// The controls the database's messages declare, per refusal code (the "(DI-30, DI-32). [EBMR-EXE-121]" of each message)

const SQL_DIRS = ['../../../../packages/recipe-core/sql/', '../../sql/'].map((d) => new URL(d, import.meta.url).pathname);

function declaredControls(code: string): Set<string> {
  const out = new Set<string>();
  const message = new RegExp(`\\(((?:[A-Z]{2,3}-\\d{2,3})(?:,\\s*[A-Z]{2,3}-\\d{2,3})*)\\)[^()\\[]*\\[${code}\\]`, 'g');
  for (const dir of SQL_DIRS) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      for (const m of readFileSync(`${dir}${f}`, 'utf8').matchAll(message)) for (const c of (m[1] ?? '').split(',')) out.add(c.trim());
    }
  }
  return out;
}

const NEW_DATABASE_REFUSALS = ['EBMR-EXE-044', 'EBMR-EXE-078', 'EBMR-EXE-086', 'EBMR-EXE-087', 'EBMR-EXE-121', 'EBMR-EXE-122', 'EBMR-EXE-123', 'EBMR-EXE-124', 'EBMR-EXE-125', 'EBMR-EXE-126', 'EBMR-EXE-127', 'EBMR-EXE-128', 'EBMR-EXE-129', 'EBMR-EXE-130', 'EBMR-EXE-131', 'EBMR-EXE-132', 'EBMR-EXE-133', 'EBMR-EXE-134', 'EBMR-EXE-135', 'EBMR-EXE-140', 'EBMR-EXE-141'];

describe('refusals keep their declared controls and advice', () => {
  it('[DI-20][DI-26][DI-30][DI-32][PR-14][PR-45][PR-49] each refusal the database raises for a step\'s source, room and state, and for exceptions and decisions, is answered with its own guidance naming every control its messages declare', () => {
    const wildcard = EXECUTION_GUIDANCE['EBMR-EXE-*'];
    for (const code of NEW_DATABASE_REFUSALS) {
      const declared = declaredControls(code);
      expect(declared.size, `${code} is raised by the database with its controls`).toBeGreaterThan(0);
      const entry = EXECUTION_GUIDANCE[code];
      expect(entry, `${code} has its own guidance`).toBeDefined();
      expect(entry?.controls ?? [], `${code} names the controls its messages declare`).toEqual(expect.arrayContaining([...declared]));
      // As the error mapper answers the database's error: the entry's own words, not the family's generic ones.
      const mapped = mapError(server.built.ctx, new Error(`the database's message (${[...declared].join(', ')}). [${code}]`), 'test').envelope.refusal;
      expect(mapped).toMatchObject({ code, whatHappened: entry?.whatHappened, controls: entry?.controls, whatYouCanDo: entry?.whatYouCanDo });
      expect(mapped.whatHappened).not.toBe(wildcard?.whatHappened);
    }
    // EBMR-EXE-086 guards a hold point's decision as well as an exception's disposition (recipe-core 0295, 0270).
    expect(EXECUTION_GUIDANCE['EBMR-EXE-086']?.whatHappened).toMatch(/hold point/);
    expect(EXECUTION_GUIDANCE['EBMR-EXE-086']?.whatHappened).toMatch(/disposition/);
  });

  it('[DI-30][DI-32][PR-14][DI-20][PR-23] a scan claim, an attachment hash and a terminal outside the step\'s room are answered with the controls, reason and advice the server declared, not the generic refusal', async () => {
    const d = await newRun(dcMini(), { operator2: ['operator2'] }); // operator2 on TEST-KIOSK-BLEND-1
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const scan = refusalOf(await d.command('operator1', { type: 'RECORD_DATA', stepKey: CLEAR, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'SCAN', code: 'X' } }));
    expect(scan).toEqual({
      status: 422,
      code: 'EBMR-EXE-121',
      kind: 'INVALID_INPUT',
      whatHappened: 'The value was sent as scanned, but blendTime is keyed by hand in this MBR, not scanned. Nothing was saved.',
      why: 'blendTime is keyed by hand in this MBR, not scanned; a value the terminal only says was scanned is not objective evidence, and the server cannot attest a scan made on the terminal.',
      controls: ['DI-30', 'DI-32', 'PR-14'],
      whatYouCanDo: ['Enter the value as the screen asks; a critical value keyed by hand is checked by a second person.'],
      whoCanHelp: ['The shift supervisor'],
      retryable: false,
    });
    const printout = refusalOf(
      await d.command('operator1', { type: 'RECORD_DATA', stepKey: CLEAR, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL', evidence: { kind: 'PRINTOUT', sha256: 'a'.repeat(64) } } }),
    );
    expect(printout).toMatchObject({
      status: 422,
      code: 'EBMR-EXE-122',
      whatHappened: 'A photo or printout cannot be attached to a value on this installation yet: the hash names no stored attachment. Nothing was saved.',
      controls: ['DI-30', 'DI-32'],
      whatYouCanDo: ['Enter the value without an attachment; a critical value keyed by hand is checked by a second person.'],
    });
    expect(printout.why).toMatch(/^The printout hash aaaaaaaaaaaa\.\.\. names no stored attachment/);
    const elsewhere = refusalOf(await d.command('operator2', { type: 'START_STEP', stepKey: CLEAR }));
    expect(elsewhere).toEqual({
      status: 422,
      code: 'EBMR-EXE-123',
      kind: 'NOT_ALLOWED',
      whatHappened: 'This terminal is in room BLEND-1, but this step is done in DISP-1. Nothing was saved.',
      why: 'This terminal is in room BLEND-1; step p-disp-clear belongs to stage S-DISP, which is bound to DISP-1. The data of a step is accepted only from a terminal and a scale of the step\'s room.',
      controls: ['DI-20', 'PR-23'],
      whatYouCanDo: ['Go to the terminal in DISP-1 and do the step there.'],
      whoCanHelp: ['The shift supervisor'],
      retryable: false,
    });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore);
  }, 300_000);
});

describe('a step screen on a terminal outside the step\'s room (DI-20)', () => {
  it('[DI-20][PR-23] offers none of the step\'s own actions: start, record, sign and verify are greyed with the room to go to; raising an exception stays open; the terminal of the room is offered them', async () => {
    const d = await newRun(dcMini(), { operator2: ['operator2'], office: ['operator1', 'TEST-PC-01'], verifier2: ['verifier2'] });
    const action = async (who: string, kind: string, key = CLEAR) => (await d.stepView(who, key)).actions.find((a) => a.action === kind);
    const blend = 'This terminal is in room BLEND-1, but this step is done in DISP-1: go to the terminal in DISP-1 (EBMR-EXE-123; DI-20, PR-23)';
    const office = 'This terminal is registered to no room, but this step is done in DISP-1: go to the terminal in DISP-1 (EBMR-EXE-123; DI-20, PR-23)';
    expect(await action('operator1', 'START_STEP')).toMatchObject({ available: true, primary: true, reason: null });
    expect(await action('operator2', 'START_STEP')).toMatchObject({ available: false, primary: true, reason: blend });
    expect(await action('office', 'START_STEP')).toMatchObject({ available: false, primary: true, reason: office });
    expect(await action('operator2', 'RAISE_EXCEPTION')).toMatchObject({ available: true });
    // The work queue of an office PC lists every step; the clearance's start is greyed there too.
    const queue = valueOf(await d.browser('office').call(routes.execution.workQueue, {}));
    expect(queue.items.find((i) => i.runId === d.runId && i.stepKey === CLEAR)?.action).toMatchObject({ action: 'START_STEP', available: false, reason: office });

    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    expect(await action('operator1', 'RECORD_ENTRY')).toMatchObject({ available: true });
    expect(await action('operator2', 'RECORD_ENTRY')).toMatchObject({ available: false, reason: blend });
    for (const c of clearance) await d.ok('operator1', c);
    expect(await action('operator1', 'SIGN_PERFORMED')).toMatchObject({ available: true });
    // operator1 signing in on the blending kiosk ends the DISP-1 session: look from there, then come back.
    const atBlend = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1', 'TEST-KIOSK-BLEND-1') });
    expect((await atBlend.stepView('operator1', CLEAR)).actions.find((a) => a.action === 'SIGN_PERFORMED')).toMatchObject({ available: false, primary: true, reason: blend });
    const back = new RunDriver(server, d.runId, { operator1: await server.asPersona('operator1'), verifier1: d.browser('verifier1'), verifier2: d.browser('verifier2') });
    back.beforeTap = d.beforeTap;
    await back.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    expect((await back.stepView('verifier1', CLEAR)).actions.find((a) => a.action === 'VERIFY')).toMatchObject({ available: true, primary: true, reason: null });
    expect((await back.stepView('verifier2', CLEAR)).actions.find((a) => a.action === 'VERIFY')).toMatchObject({ available: false, primary: true, reason: blend, whoCanHelp: [] });
    expect(await violations(server)).toEqual([]);
  }, 300_000);

  it('[DI-20][DI-32] the header of a weighing step shows the room and the scales of the step\'s room, never those of the viewer\'s room', async () => {
    const d = await newRun(dcMini(), { operator2: ['operator2'] });
    const PCM = 'p-disp-pcm@'; // stage S-DISP, room DISP-1; weighs on a balance
    const own = (await d.stepView('operator1', PCM)).run;
    const other = (await d.stepView('operator2', PCM)).run;
    for (const h of [own, other]) {
      expect(h.room).toBe('DISP-1');
      expect(h.scale?.deviceCode).toBe('TEST-BAL-01');
      expect(h.scale?.roomCode).toBe('DISP-1');
      expect(h.scales.map((s) => [s.deviceCode, s.roomCode])).toEqual([['TEST-BAL-01', 'DISP-1']]);
    }
    // A step that does not weigh shows no scale.
    expect((await d.stepView('operator2', CLEAR)).run).toMatchObject({ scale: null, scales: [] });
  }, 300_000);
});

describe('who may verify a step (P46; INV-03)', () => {
  it('[INV-03][DI-17] the performer\'s verification is greyed and names who may verify: the roles that may give the check, and never the person who performed the step', async () => {
    const d = await newRun();
    await performClearance(d);
    const operator = personaIn(server, 'operator1').legalName;
    const notThePerformer = `Not ${operator}: a person who performed, entered data in or corrected the step never checks it (INV-03)`;
    const own = (await d.stepView('operator1', CLEAR)).actions.find((a) => a.action === 'VERIFY');
    expect(own).toMatchObject({ available: false, primary: true, whoCanHelp: ['Verifier / checker (VERIFIER)', notThePerformer] });
    expect((await d.stepView('verifier1', CLEAR)).actions.find((a) => a.action === 'VERIFY')).toMatchObject({ available: true, whoCanHelp: [] });
    // Actions a person is not refused by role or segregation name nobody.
    expect((await d.stepView('operator1', CLEAR)).actions.filter((a) => a.action !== 'VERIFY').every((a) => a.whoCanHelp.length === 0)).toBe(true);

    // A witness by QA: the roles that carry QA and may witness (STEP.WITNESS), which may not verify (STEP.VERIFY).
    const w = await newRun(clearanceCheckedBy({ meaning: 'WITNESSED', role: 'QA' }));
    await performClearance(w);
    expect((await w.stepView('operator1', CLEAR)).actions.find((a) => a.action === 'WITNESS')).toMatchObject({
      available: false,
      whoCanHelp: ['QA operations (shop floor) (QA_SHOP_FLOOR)', notThePerformer],
    });

    // The check role is the performing role (the INV-03 E2E variant): the performer passes the role rule and is refused
    // by INV-03, and no role of the installation that carries the check role may verify.
    const s = await newRun(clearanceCheckedBy({ meaning: 'VERIFIED', role: 'PRODUCTION_OPERATOR' }));
    await performClearance(s);
    const seg = (await s.stepView('operator1', CLEAR)).actions.find((a) => a.action === 'VERIFY');
    expect(seg?.reason).toMatch(/\(ENG-SEGREGATION; INV-03/);
    expect(seg?.whoCanHelp).toEqual(['No role of this installation may give this check: none that carries PRODUCTION_OPERATOR holds STEP.VERIFY. Ask QA or the MBR author.', notThePerformer]);
    expect(await violations(server)).toEqual([]);
  }, 300_000);
});

describe('the answer of a committed command (DI-34)', () => {
  it('[DI-34] a command committed before its answer view fails is answered as saved, with the step left to the screen to read again, never "nothing was saved"', async () => {
    const d = await newRun();
    const rowsBefore = (await rowsOf(server, d.runId)).length;
    const expectedVersion = await d.version('operator1');
    // After the commit, building the step view fails (its site-time formatting throws); nothing before the commit
    // formats an instant.
    let failed = 0;
    const spy = vi.spyOn(server.built.ctx, 'formatInstant').mockImplementation(() => {
      failed += 1;
      throw new Error('the view could not be built (test)');
    });
    let answer;
    try {
      answer = await d.command('operator1', { type: 'START_STEP', stepKey: CLEAR }, { expectedVersion });
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBeGreaterThan(0);
    expect(valueOf(answer)).toEqual({ accepted: true, version: await d.version('operator1'), step: null });
    expect((await rowsOf(server, d.runId)).length).toBe(rowsBefore + 1);
    expect((await d.stepView('operator1', CLEAR)).step.status).toBe('IN_PROGRESS');
  }, 300_000);
});
