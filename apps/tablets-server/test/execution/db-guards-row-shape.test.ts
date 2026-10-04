/**
 * Phase 2 exit review F12, round 7 (the round-6 verification; DI-05, DI-30; recipe-core 0335; ADR 0012): a row
 * records the engine command of its type with exactly the members that type declares, each of the JSON type it
 * declares, and the evidence the server records; a test batch pins exactly the engine policy's members.
 *
 * Before recipe-core 0335, recipe-core 0332 read only the entry of a RECORD_ENTRY and the start data of a START_STEP, and
 * only where they had the JSON type their block's schema declares; nothing read the command's other members, a
 * preparation's or an issue's command, the policy a batch pins or the evidence stored with a row. Through the
 * application role (the writer here, as in the other db-guards files) the round-6 verification stored the real-format
 * lot number L2409-0017 in a test run's record in each of those places, 'ok', with no violation reported: an accepted
 * clearance with it at the top of its command (probe A) and in its evidence (C), a START_STEP carrying an entry (D), a
 * refused clearance answered NO with it at the top, its answers as a text or as lists, or start data on the entry (E),
 * and a refused START_STEP with start data as a text or a list or carrying an entry (F). Each test below stored every one
 * of its probes before 0335. The engine ignores a member it does not read, so the release gate's replay would not have
 * flagged these rows either.
 *
 * Own file and server: the kiosk's device nonces are rate-limited per terminal and minute, so one file holds only a few
 * runs (as the stale-row files).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf, unmatched } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

type Json = Record<string, unknown>;
const CLEAR = 'p-disp-clear@';
const CHECKED = ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'];

/** A dc-mini run issued by `issuer`, with operator1 (and verifier1) on their kiosks. */
async function issuedRun(): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
  const d = new RunDriver(sbx, runId, { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/** The same, the booth clearance started. */
async function startedRun(): Promise<RunDriver> {
  const d = await issuedRun();
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  return d;
}

/** The same, at the start of the paracetamol dispensing. */
async function atDispensing(): Promise<RunDriver> {
  const d = await startedRun();
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
  await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
  for (const [key, entries] of [
    ['p-disp-bal@', [{ kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'LBL-BAL', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) }]],
    ['p-disp-sop@', [{ kind: 'ACKNOWLEDGE', mode: 'READ' }]],
    ['p-disp-calc@', []],
  ] as const) {
    await d.ok('operator1', { type: 'START_STEP', stepKey: key });
    for (const entry of entries) await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: key, entry });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: key });
  }
  await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-pcm@' });
  return d;
}

async function stateHolding(runId: string, text: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2', [runId, `%${text}%`]);
  return Number(rows[0]?.n ?? '0');
}

async function entriesOf(runId: string, kind: string): Promise<Json[]> {
  return Object.values((await execution.loadState(sbx.db.admin, runId))?.state.entries ?? {}).filter((e) => e.kind === kind).map((e) => e.data);
}

describe('F12 round 7: a row records its command and evidence as the server does, and a batch pins exactly the engine policy (DI-05, DI-30)', () => {
  const ROW_SHAPE = String.raw`\. A row records the engine command of its type with exactly the members that type declares, each of the JSON type it declares, and with evidence of the shape the server records, so nothing sits in the record unread \(DI-05, DI-30\)\. \[EBMR-EXE-126\]$`;
  type Intent = Parameters<typeof resolveClientIntent>[1];

  /**
   * operator1's `intent` at run `d`, resolved as the server resolves it, its command and evidence changed by `forge`, then
   * run and stored as the server runs and stores a command (ExecutionTx.command: the engine decides at the trusted time,
   * ignoring a member it does not read, and the row is appended accepted or refused). 'ok' or the refusal's message.
   */
  async function sentAs(d: RunDriver, intent: Intent, forge: (x: { command: Json; evidence: Json }) => void = () => undefined): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          intent,
        );
        const command = structuredClone(resolved.command) as unknown as Json;
        const evidence = structuredClone(resolved.evidence);
        forge({ command, evidence });
        await tx.command(command as unknown as engine.Command, roles, evidence as engine.JsonValue);
      }),
    );
  }

  /** Rows of run `runId` whose command or evidence holds `text`. */
  async function rowsWith(runId: string, text: string): Promise<number> {
    const { rows } = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2)', [runId, `%${text}%`]);
    return Number(rows[0]?.n ?? '0');
  }

  /** The last `n` rows of run `runId`: type, verdict, the engine's refusal code. */
  async function lastRows(runId: string, n: number): Promise<{ type: string; accepted: boolean; code: string | undefined }[]> {
    return (await rowsOf(sbx, runId)).slice(-n).map((r) => ({ type: r.command_type, accepted: r.accepted, code: r.refusal?.code }));
  }

  it('[DI-05][DI-30] round 7: an accepted row whose command or evidence carries a member its type does not declare is refused (EBMR-EXE-126) and nothing holds L2409-0017: the round-6 verification\'s clearance with lotNumber at the top of its command and in its evidence, a START_STEP carrying an entry, a member of the actor, an idempotency key that is no UUID; the honest rows are recorded', async () => {
    const d = await issuedRun();
    const start: Intent = { type: 'START_STEP', stepKey: CLEAR };
    const record: Intent = { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id) => ({ id, answer: 'CONFIRMED' as const })) } };
    const outcomes: Record<string, string> = {
      // The round-6 verification's probe D, and a member of the engine actor.
      startWithEntry: await sentAs(d, start, ({ command }) => void (command['entry'] = { kind: 'CONTAINER_WEIGHING', lotNumber: 'L2409-0017' })),
      actorMember: await sentAs(d, start, ({ command }) => void ((command['actor'] as Json)['lot'] = 'L2409-0017')),
    };
    expect(await sentAs(d, start)).toBe('ok');
    // The round-6 verification's probes A and C, and an idempotency key that is no UUID.
    outcomes['topLevel'] = await sentAs(d, record, ({ command }) => void (command['lotNumber'] = 'L2409-0017'));
    outcomes['evidence'] = await sentAs(d, record, ({ evidence }) => void (evidence['lotNumber'] = 'L2409-0017'));
    outcomes['idempotencyKey'] = await sentAs(d, record, ({ evidence }) => void (evidence['idempotencyKey'] = 'L2409-0017'));
    expect(unmatched(outcomes, {
      startWithEntry: new RegExp(String.raw`^This accepted START_STEP row cannot be recorded: command\.entry is a member a START_STEP command does not declare` + ROW_SHAPE),
      actorMember: new RegExp(String.raw`^This accepted START_STEP row cannot be recorded: command\.actor\.lot is a member command\.actor does not declare` + ROW_SHAPE),
      topLevel: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: command\.lotNumber is a member a RECORD_ENTRY command does not declare` + ROW_SHAPE),
      evidence: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.lotNumber is a member the server does not record with a RECORD_ENTRY command of a CLEARANCE_CHECK entry` + ROW_SHAPE),
      idempotencyKey: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.idempotencyKey must be the idempotency key of the request \(a UUID\)` + ROW_SHAPE),
    })).toEqual({});
    expect(await rowsWith(d.runId, 'L2409-0017')).toBe(0);
    expect(await stateHolding(d.runId, 'L2409-0017')).toBe(0);
    // The honest clearance through the store, and over HTTP with the request's idempotency key: recorded.
    expect(await sentAs(d, record)).toBe('ok');
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
    expect(await lastRows(d.runId, 3)).toEqual([
      { type: 'START_STEP', accepted: true, code: undefined },
      { type: 'RECORD_ENTRY', accepted: true, code: undefined },
      { type: 'RECORD_ENTRY', accepted: true, code: undefined },
    ]);
  }, 300_000);

  it('[DI-05][DI-30] round 7: a refused row keeps what was sent, but not a member its command type does not declare, nor a text or list where its entry or start data declares an object or a list: the round-6 verification\'s clearance answered NO with lotNumber at the top, answers as a text or as lists, start data on an entry, and a START_STEP refused with start data as a text or a list, an entry or a member of a frame, are refused (EBMR-EXE-126); the honest refusals are recorded', async () => {
    const d = await startedRun();
    const answeredNo: Intent = { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id, i) => ({ id, answer: (i === 0 ? 'NO' : 'CONFIRMED') as 'CONFIRMED' })) } };
    const restart: Intent = { type: 'START_STEP', stepKey: CLEAR };
    const entry = (command: Json): Json => command['entry'] as Json;
    const outcomes = {
      // The round-6 verification's probes E and F.
      topLevel: await sentAs(d, answeredNo, ({ command }) => void (command['lotNumber'] = 'L2409-0017')),
      answersText: await sentAs(d, answeredNo, ({ command }) => void (entry(command)['answers'] = 'L2409-0017')),
      answersLists: await sentAs(d, answeredNo, ({ command }) => void (entry(command)['answers'] = [['L2409-0017']])),
      startDataOnEntry: await sentAs(d, answeredNo, ({ command }) => void (command['blockData'] = { lotNumber: 'L2409-0017' })),
      startDataText: await sentAs(d, restart, ({ command }) => void (command['blockData'] = 'L2409-0017')),
      startDataList: await sentAs(d, restart, ({ command }) => void (command['blockData'] = ['L2409-0017'])),
      startWithEntry: await sentAs(d, restart, ({ command }) => void (command['entry'] = { kind: 'CLEARANCE_CHECK', lotNumber: 'L2409-0017' })),
      frameMember: await sentAs(d, restart, ({ command }) => void (command['context'] = [{ construct: 'c', index: 0, lot: 'L2409-0017' }])),
    };
    expect(unmatched(outcomes, {
      topLevel: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: command\.lotNumber is a member a RECORD_ENTRY command does not declare` + ROW_SHAPE),
      answersText: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: command\.entry\.answers must be a list` + ROW_SHAPE),
      answersLists: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: command\.entry\.answers\[0\] must be an object` + ROW_SHAPE),
      startDataOnEntry: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: command\.blockData is a member a RECORD_ENTRY command does not declare` + ROW_SHAPE),
      startDataText: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.blockData must be an object` + ROW_SHAPE),
      startDataList: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.blockData must be an object` + ROW_SHAPE),
      startWithEntry: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.entry is a member a START_STEP command does not declare` + ROW_SHAPE),
      frameMember: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.context\[0\]\.lot is a member command\.context\[0\] does not declare` + ROW_SHAPE),
    })).toEqual({});
    expect(await rowsWith(d.runId, 'L2409-0017')).toBe(0);
    // The honest refusals are part of the record: the answer NO (the engine's schema) and a second start of the step.
    expect(await sentAs(d, answeredNo)).toBe('ok');
    expect(await sentAs(d, restart)).toBe('ok');
    const last = await lastRows(d.runId, 2);
    expect(last.map((r) => [r.type, r.accepted])).toEqual([['RECORD_ENTRY', false], ['START_STEP', false]]);
    expect(last[0]?.code).toBe('ENG-ENTRY-SCHEMA');
  }, 300_000);

  it('[DI-05][DI-30][PR-18][PR-20] round 7: a weighing\'s evidence holds only what the server records, bound to its entry and row: a lot stated otherwise than the entry names it or with a member of its own, a manual record with a member of its own, another room or a scale that is no test device, and readings on a weighing keyed by hand are refused (EBMR-EXE-126) and nothing holds L2409-0017; the honest weighing is recorded', async () => {
    const disp = await atDispensing();
    const weighing: Intent = { type: 'RECORD_ENTRY', stepKey: 'p-disp-pcm@', entry: { kind: 'CONTAINER_WEIGHING', item: 'pcmDispensed', bomLine: 'BOM-PCM', lotCode: 'TEST-L26-0101', manual: { gross: '51.250', tare: '1.250', unit: 'kg' } } };
    const manual = (evidence: Json): Json => evidence['manual'] as Json;
    const outcomes = {
      lotCode: await sentAs(disp, weighing, ({ evidence }) => void ((evidence['lot'] as Json)['code'] = 'L2409-0017')),
      lotMember: await sentAs(disp, weighing, ({ evidence }) => void ((evidence['lot'] as Json)['lotNumber'] = 'L2409-0017')),
      manualMember: await sentAs(disp, weighing, ({ evidence }) => void (manual(evidence)['lot'] = 'L2409-0017')),
      manualRoom: await sentAs(disp, weighing, ({ evidence }) => void (manual(evidence)['room'] = 'L2409-0017')),
      scale: await sentAs(disp, weighing, ({ evidence }) => void (manual(evidence)['scales'] = [{ deviceCode: 'L2409-0017', status: 'OFFLINE', lastHeartbeatUs: null }])),
      readings: await sentAs(disp, weighing, ({ evidence }) => void (evidence['readings'] = [])),
    };
    expect(unmatched(outcomes, {
      lotCode: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.lot must be the code, material and status of the lot its entry names` + ROW_SHAPE),
      lotMember: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.lot must be the code, material and status of the lot its entry names` + ROW_SHAPE),
      manualMember: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.manual\.lot is a member evidence\.manual does not declare` + ROW_SHAPE),
      manualRoom: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.manual\.room must be the room of the row \(DISP-1\)` + ROW_SHAPE),
      scale: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: evidence\.manual\.scales\[0\]\.deviceCode "L2409-0017" is not a test device label: .*\(DI-05\)` + ROW_SHAPE),
      // Tablets 0590 refuses a list of used readings that is not the stored tare and gross before this check reads it.
      readings: /^A weighing captured from a device uses exactly its tare and its gross reading, in that order, each as stored, and nothing else: .*\[EBMR-EXE-124\]$/,
    })).toEqual({});
    expect(await rowsWith(disp.runId, 'L2409-0017')).toBe(0);
    expect(await entriesOf(disp.runId, 'CONTAINER_WEIGHING')).toEqual([]);
    expect(await sentAs(disp, weighing)).toBe('ok');
    expect((await entriesOf(disp.runId, 'CONTAINER_WEIGHING')).length).toBe(1);
  }, 300_000);

  /**
   * operator1's preparation for signing step p-disp-clear@ performed at run `d` (the engine's own result at the trusted
   * time), stored through the application role with its command changed by `forge` and with `evidence`. 'ok' or the refusal.
   */
  async function preparedAs(d: RunDriver, forge: (command: Json) => void = () => undefined, evidence?: Json): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const actor = engineActor(who.personId, roles);
        const target: engine.SignatureTarget = { type: 'SIGN_PERFORMED', step: 'p-disp-clear', context: [] };
        const p = engine.prepareForSignature(tx.def, tx.state, target, actor, { nowUs: tx.nowUs });
        const command = engine.encode({ type: 'PREPARE', target, actor, meaning: 'PERFORMED' }) as Json;
        forge(command);
        return execution.appendExecution(c, {
          batchId: d.runId, expectedSeq: tx.lastSeq, kind: 'PREPARE', command: command as engine.JsonValue, commandId: `PREPARE:${randomUUID()}`, nowUs: tx.nowUs,
          accepted: true, state: p.state, events: p.events, roles, contents: engine.changedContents(tx.def, tx.state, p.state), ...(evidence ? { evidence: evidence as engine.JsonValue } : {}),
        });
      }),
    );
  }

  it('[DI-05][DI-30] round 7: a preparation for a signature records exactly its target, actor and meaning: a member of its own at the top or in its target, a meaning that is no signature meaning, and evidence, are refused (EBMR-EXE-126); the honest preparation is recorded', async () => {
    const d = await startedRun();
    const outcomes = {
      topLevel: await preparedAs(d, (command) => void (command['lotNumber'] = 'L2409-0017')),
      targetMember: await preparedAs(d, (command) => void ((command['target'] as Json)['lot'] = 'L2409-0017')),
      meaning: await preparedAs(d, (command) => void (command['meaning'] = 'L2409-0017')),
      evidence: await preparedAs(d, () => undefined, { lotNumber: 'L2409-0017' }),
    };
    expect(unmatched(outcomes, {
      topLevel: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: command\.lotNumber is a member a preparation for a signature does not declare` + ROW_SHAPE),
      targetMember: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: command\.target\.lot is a member command\.target does not declare` + ROW_SHAPE),
      meaning: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: command\.meaning "L2409-0017" is not a signature meaning of the kernel` + ROW_SHAPE),
      evidence: new RegExp(String.raw`^This preparation PREPARE:SIGN_PERFORMED row cannot be recorded: evidence\.lotNumber is a member the server does not record with a preparation for a signature` + ROW_SHAPE),
    })).toEqual({});
    expect(await rowsWith(d.runId, 'L2409-0017')).toBe(0);
    expect(await preparedAs(d)).toBe('ok');
  }, 300_000);

  it('[DI-05][DI-30] round 7: an issue records exactly the engine\'s issue request, its pinned policy exactly the engine policy\'s members, and its evidence only the package it was issued from: a member of their own, a policy role that is no engine role and another package are refused (EBMR-EXE-126) and no batch holds L2409-0017; the honest issue is recorded', async () => {
    const d = await startedRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const issuer = personaIn(sbx, 'issuer');
    const request = { batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION' as const, variants: {}, inputs: { tabletsPerBatch: { value: { kind: 'COUNT' as const, value: '100000' }, source: 'F12 round 7' } }, issuedBy: { id: issuer.personId, kind: 'PERSON' as const, roles: [] } };
    const issueAs = async (forge: { request?: Json; policy?: Json; evidence?: engine.JsonValue } = {}): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('issuer'), 'issuer'), (c) =>
          execution.issueBatch(c, {
            def: { ...run.def, policy: { ...run.def.policy, ...(forge.policy ?? {}) } },
            batchId: randomUUID(),
            packageHash: run.batch.packageHash,
            request: { ...request, ...(forge.request ?? {}) },
            evidence: forge.evidence ?? { packageHash: run.batch.packageHash },
          }),
        ),
      );
    const before = await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution');
    const outcomes = {
      requestMember: await issueAs({ request: { lotNumber: 'L2409-0017' } }),
      inputMember: await issueAs({ request: { inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'F12 round 7', lot: 'L2409-0017' } } } }),
      policyMember: await issueAs({ policy: { lotNumber: 'L2409-0017' } }),
      policyRole: await issueAs({ policy: { qaRoles: ['L2409-0017'] } }),
      otherPackage: await issueAs({ evidence: { packageHash: 'f'.repeat(64) } }),
    };
    expect(unmatched(outcomes, {
      requestMember: new RegExp(String.raw`^This issue ISSUE row cannot be recorded: command\.request\.lotNumber is a member an issue request does not declare` + ROW_SHAPE),
      inputMember: new RegExp(String.raw`^This issue ISSUE row cannot be recorded: command\.request\.inputs\.tabletsPerBatch\.lot is a member command\.request\.inputs\.tabletsPerBatch does not declare` + ROW_SHAPE),
      policyMember: /^The pinned engine policy of test batch TEST-B\d{2}-\d{4} cannot be recorded: policy\.lotNumber is a member the engine policy does not declare\. .*\[EBMR-EXE-126\]$/,
      policyRole: /^The pinned engine policy of test batch TEST-B\d{2}-\d{4} cannot be recorded: policy\.qaRoles\[0\] "L2409-0017" is not an engine role\. .*\[EBMR-EXE-126\]$/,
      otherPackage: new RegExp(String.raw`^This issue ISSUE row cannot be recorded: evidence\.packageHash must be the package the batch is issued from` + ROW_SHAPE),
    })).toEqual({});
    expect((await sbx.db.admin.query<{ n: string }>('select count(*)::text as n from recipe.batch_execution')).rows[0]?.n).toBe(before.rows[0]?.n);
    const held = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.batch_execution where policy::text like '%L2409-0017%' or issue_request::text like '%L2409-0017%'");
    expect(held.rows[0]?.n).toBe('0');
    expect(await issueAs()).toBe('ok');
  }, 300_000);

  /**
   * operator1's `intent` at run `d`, resolved as the server resolves it and run through the engine at the trusted time,
   * stored through the application role with the verdict `accepted` and the refusal `refusal` gives from the engine's
   * own. 'ok' or the refusal's message.
   */
  async function storedWith(d: RunDriver, intent: Intent, accepted: boolean, refusal: (own: Json | undefined) => unknown): Promise<string> {
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'operator1');
    return messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const resolved = await resolveClientIntent(
          { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
          intent,
        );
        const r = engine.step(tx.def, tx.state, resolved.command, { nowUs: tx.nowUs });
        if (r.accepted !== accepted) throw new Error(`SETUP: the engine ${r.accepted ? 'accepted' : 'refused'} the command`);
        return execution.appendExecution(tx.client, {
          batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(resolved.command), commandId: resolved.command.commandId, nowUs: tx.nowUs,
          accepted, refusal: refusal(r.refusal as Json | undefined) as engine.Refusal | undefined, state: r.state, events: r.events, roles, contents: engine.changedContents(tx.def, tx.state, r.state), evidence: resolved.evidence as engine.JsonValue,
        });
      }),
    );
  }

  it('[DI-05][DI-30][DI-34] round 7: a refused row records the engine\'s refusal as the engine builds it, and an accepted row none: a member of its own, a code or a control that is no rule code or control id, controls as a text, and a refusal beside an accepted row are refused (EBMR-EXE-126) and nothing holds L2409-0017; the engine\'s own refusal is recorded', async () => {
    const d = await startedRun();
    const answeredNo: Intent = { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id, i) => ({ id, answer: (i === 0 ? 'NO' : 'CONFIRMED') as 'CONFIRMED' })) } };
    const record: Intent = { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id) => ({ id, answer: 'CONFIRMED' as const })) } };
    const outcomes = {
      member: await storedWith(d, answeredNo, false, (own) => ({ ...own, lotNumber: 'L2409-0017' })),
      code: await storedWith(d, answeredNo, false, (own) => ({ ...own, code: 'L2409-0017' })),
      control: await storedWith(d, answeredNo, false, (own) => ({ ...own, controls: ['DI-30', 'L2409-0017'] })),
      controlsText: await storedWith(d, answeredNo, false, (own) => ({ ...own, controls: 'L2409-0017' })),
      besideAccepted: await storedWith(d, record, true, () => ({ code: 'ENG-STALE', message: 'L2409-0017', controls: ['DI-34'] })),
    };
    const REFUSAL = String.raw`\. A refused row records the engine's refusal as the engine builds it, \{code, message, controls\}, and an accepted row none, so nothing sits in the record unread \(DI-05, DI-30, DI-34\)\. \[EBMR-EXE-126\]$`;
    expect(unmatched(outcomes, {
      member: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: refusal\.lotNumber is a member the engine's refusal does not declare` + REFUSAL),
      code: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: refusal\.code has an invalid format` + REFUSAL),
      control: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: refusal\.controls\[1\] has an invalid format` + REFUSAL),
      controlsText: new RegExp(String.raw`^This refused RECORD_ENTRY row cannot be recorded: refusal\.controls must be a list` + REFUSAL),
      besideAccepted: new RegExp(String.raw`^This accepted RECORD_ENTRY row cannot be recorded: an accepted row records no refusal` + REFUSAL),
    })).toEqual({});
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.execution_command where batch_id = $1 and refusal::text like '%L2409-0017%'", [d.runId]);
    expect(rows[0]?.n).toBe('0');
    // The engine's own refusal is recorded, as it built it.
    expect(await storedWith(d, answeredNo, false, (own) => own)).toBe('ok');
    expect((await lastRows(d.runId, 1))[0]).toEqual({ type: 'RECORD_ENTRY', accepted: false, code: 'ENG-ENTRY-SCHEMA' });
  }, 300_000);

  it('[DI-05][DI-10][DI-34] round 7: a batch is issued only with a request its MBR accepts, as the engine checks it at issue: written past the engine with the state of an honest request, a request naming L2409-0017 as its batch size, a market, a variant or an input, or giving an input of another type, is refused (EBMR-EXE-126) and no batch holds it; the honest issue is recorded', async () => {
    const d = await startedRun();
    const run = await runContext(sbx.db.admin, d.runId);
    const issuer = personaIn(sbx, 'issuer');
    const issueAs = async (forge: (request: Json) => void = () => undefined): Promise<string> =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('issuer'), 'issuer'), async (c) => {
          const batchId = randomUUID();
          const begun = await execution.beginIssue(c, batchId);
          const request: engine.IssueRequest = {
            batchId, batchNumber: begun.batchNumber, batchSize: run.batch.batchSize, marketSet: ['IN'], purpose: 'VALIDATION', variants: {},
            inputs: { tabletsPerBatch: { value: { kind: 'COUNT', value: '100000' }, source: 'F12 round 7' } }, issuedBy: { id: issuer.personId, kind: 'PERSON', roles: [] },
          };
          const r = engine.issue(run.def, request, { nowUs: begun.nowUs });
          const recorded = engine.encode(request) as Json;
          forge(recorded);
          await execution.issueExecution(c, {
            batchId, packageHash: run.batch.packageHash, batchNumber: begun.batchNumber, request: recorded as engine.JsonValue, policy: execution.pinnedPolicy(run.def.policy),
            registryFingerprint: run.def.registry.fingerprint(), engineVersion: engine.ENGINE_VERSION, nowUs: begun.nowUs, state: r.state, events: r.events,
            contents: engine.changedContents(run.def, undefined, r.state), evidence: { packageHash: run.batch.packageHash },
          });
        }),
      );
    const inputs = (request: Json): Json => request['inputs'] as Json;
    const outcomes = {
      batchSize: await issueAs((q) => void (q['batchSize'] = 'L2409-0017')),
      market: await issueAs((q) => void (q['marketSet'] = ['IN', 'L2409-0017'])),
      variant: await issueAs((q) => void (q['variants'] = { 'L2409-0017': 'X' })),
      input: await issueAs((q) => void (inputs(q)['L2409-0017'] = { value: { kind: 'TEXT', value: 'X' }, source: 'F12 round 7' })),
      inputType: await issueAs((q) => void (inputs(q)['tabletsPerBatch'] = { value: { kind: 'TEXT', value: 'L2409-0017' }, source: 'F12 round 7' })),
    };
    const ISSUE = String.raw`\. A batch is issued only with a request its MBR accepts, as the engine checks it at issue, so nothing sits in the record unread \(DI-05, DI-10, DI-34\)\. \[EBMR-EXE-126\]$`;
    const head = String.raw`^The issue request of test batch TEST-B\d{2}-\d{4} cannot be recorded: `;
    expect(unmatched(outcomes, {
      batchSize: new RegExp(head + String.raw`the batch size L2409-0017 is not one of the approved sizes of its MBR \(ENG-ISSUE-SIZE\)` + ISSUE),
      market: new RegExp(head + String.raw`its market set names L2409-0017, a market its MBR is not approved for \(ENG-ISSUE-MARKETS\)` + ISSUE),
      variant: new RegExp(head + String.raw`it names L2409-0017, which is not a variant of its MBR \(ENG-ISSUE-VARIANT\)` + ISSUE),
      input: new RegExp(head + String.raw`it gives L2409-0017, which is not a header or master-data input of its MBR \(ENG-ISSUE-INPUT\)` + ISSUE),
      inputType: new RegExp(head + String.raw`input tabletsPerBatch is not given as its declared type COUNT \(ENG-ISSUE-INPUT\)` + ISSUE),
    })).toEqual({});
    const held = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from recipe.batch_execution where issue_request::text like '%L2409-0017%' or batch_size = 'L2409-0017'");
    expect(held.rows[0]?.n).toBe('0');
    expect(await issueAs()).toBe('ok');
  }, 300_000);
});
