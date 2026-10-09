/**
 * Phase 2 exit review F12, round 10: closed for the class (DI-05, DI-30, PR-23, PR-47; recipe-core 0344 and 0345,
 * kernel 1030; ADR 0012).
 *
 * Nine rounds bound, one by one, the members of a test run's record a verification had found holding the real-format
 * lot number L2409-0017, and each next verification found another. The round-3 verification of the lane stored it as
 * the authoriser of a reprocessing's start data (G-24 authorisedBy, on the honest store and engine path) and as the
 * equipment of an equipment status at a step that lists none (over HTTP, through the honest server), both accepted.
 *
 * recipe-core 0344 now reads every text of the record with the kernel's identifier rule (kernel 1030 reads it in text):
 * every string and member name of the command, evidence, refusal, state, events, content versions, proposals and issue
 * request, and the reason and business entries of the run's audit chains, at any depth. A word the rule reads as a real
 * batch or lot number is refused (EBMR-EXE-147) unless the run's record has it from a bound source (its MBR, its batch
 * number and location, the engine's own names). recipe-core 0345 binds the two members the verification found (needs A
 * and B): an accepted START_STEP records no start data, a start-data authoriser is a person of this installation, and
 * an equipment status names equipment the MBR binds where its step runs (EBMR-EXE-126).
 *
 * The writer is the application role, through the honest server (HTTP) or on the store and engine path (the server's own
 * code with the command or its result changed), as in the other db-guards files. Own file and server: the kiosk's device
 * nonces are rate-limited per terminal and minute.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf, unmatched } from './db-guards-support.ts';
import { dcMini, dcMiniVariant, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

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
type Intent = Parameters<typeof resolveClientIntent>[1];
const LOT = 'L2409-0017';
const CLEAR = 'p-disp-clear@';
const CHECKED = ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'];
const STATUS_ANSWERS = ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const }));
const ROOMS: Readonly<Record<string, string>> = { operator1: 'DISP-1', verifier1: 'DISP-1', supervisor1: 'BLEND-1', qa1: 'BLEND-1' };

/** A phase of the dispensing preparation (dc-mini's shape), with `extra` members. */
const phase = (id: string, name: string, block: string, extra: Json = {}): Json => ({
  kind: 'phase', id, name, block: { type: block, version: '1' }, config: {}, records: [], computes: [], reads: [], consumes: [], produces: [], uses: [],
  equipment: [], signatures: { perform: { role: 'PRODUCTION_OPERATOR' } }, significant: false, riskClass: 'MEDIUM', ...extra,
});

/** dc-mini with a recovery (G-24) first: the round-3 verification's p-rework. */
const withRework = (): flow.MbrContent =>
  dcMiniVariant((prep) => [phase('p-rework', 'Recovery of an earlier batch', 'G-24', { significant: true, riskClass: 'HIGH', reprocessing: { case: 'RECOVERY', maxPercent: '3', maxAge: { value: '90', unit: 'd' }, maxSourceBatches: 1 } }), ...prep]);

/** dc-mini with an equipment status first that lists no equipment: the round-3 verification's p-room-status. */
const withRoomStatus = (): flow.MbrContent => dcMiniVariant((prep) => [phase('p-room-status', 'Equipment status of the booth', 'G-09'), ...prep]);

/** A run of `content` issued by the issuer, with the kiosks of operator1, verifier1, supervisor1 and qa1. */
async function issued(content: flow.MbrContent): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const d = new RunDriver(sbx, runId, {
    issuer,
    operator1: await sbx.asPersona('operator1'),
    verifier1: await sbx.asPersona('verifier1'),
    supervisor1: await sbx.asPersona('supervisor1'),
    qa1: await sbx.asPersona('qa1'),
  });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

/**
 * `persona`'s `intent` at run `d`, resolved as the server resolves it, its command and evidence changed by `forge`, then
 * run and stored as the server runs and stores a command (ExecutionTx.command), in a command whose actor context carries
 * `context`. 'ok' or the refusal's message.
 */
async function sentAs(d: RunDriver, persona: string, intent: Intent, forge: (x: { command: Json; evidence: Json }) => void = () => undefined, context: Partial<ActorContext> = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, persona);
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser(persona), persona, context), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: ROOMS[persona] ?? 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        intent,
      );
      const command = structuredClone(resolved.command) as unknown as Json;
      const evidence = structuredClone(resolved.evidence);
      forge({ command, evidence });
      await tx.command(command as unknown as engine.Command, roles, evidence as engine.JsonValue);
    }),
  );
}

/** operator1's `intent` at run `d` as the engine refuses it, recorded refused with `forge` applied to the engine's refusal. */
async function refusedAs(d: RunDriver, intent: Intent, forge: (refusal: Json) => void): Promise<string> {
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
      const r = tx.dryRun(resolved.command);
      if (r.accepted || !r.refusal) throw new Error('SETUP: the engine accepted the command');
      const refusal = structuredClone(r.refusal) as unknown as Json;
      forge(refusal);
      await execution.appendExecution(c, {
        batchId: tx.locked.batch.id, expectedSeq: tx.lastSeq, kind: 'COMMAND', command: engine.encodeCommand(resolved.command), commandId: resolved.command.commandId,
        nowUs: tx.nowUs, accepted: false, refusal: refusal as unknown as engine.Refusal, state: r.state, events: r.events, roles, contents: [], evidence: resolved.evidence as engine.JsonValue,
      });
    }),
  );
}

/** Where the record of run `runId` holds `text`: rows, events, state, content versions, proposals and its audit chains. */
async function recordHolding(runId: string, text: string): Promise<Record<string, number>> {
  const like = `%${text}%`;
  const count = async (sql: string) => Number((await sbx.db.admin.query<{ n: string }>(sql, [runId, like])).rows[0]?.n ?? '0');
  return {
    rows: await count(`select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2 or coalesce(refusal::text, '') like $2)`),
    events: await count('select count(*)::text as n from recipe.execution_event where batch_id = $1 and event::text like $2'),
    state: await count('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2'),
    contents: await count(`select count(*)::text as n from (
       select content from recipe.execution_step_content where batch_id = $1 union all select content from recipe.execution_stage_content where batch_id = $1
       union all select content from recipe.execution_exception_content where batch_id = $1 union all select content from recipe.execution_point_content where batch_id = $1) x
      where x.content::text like $2`),
    proposals: await count(`select count(*)::text as n from (select proposal from recipe.execution_disposition_proposal where batch_id = $1
       union all select proposal from recipe.execution_decision_proposal where batch_id = $1) x where x.proposal::text like $2`),
    audit: await count(`select count(*)::text as n from kernel.audit_event e
      where (e.chain_key = 'batch:' || $1 or e.chain_key ~ ('^(esig_challenge:|esig_signature:)?batch_(step|stage|exception|point):' || $1 || ':')) and e.payload::text like $2`),
  };
}

const NOTHING = { rows: 0, events: 0, state: 0, contents: 0, proposals: 0, audit: 0 };

describe('F12 round 10: what a test run records holds no real-format batch, lot or container identifier, in any member (DI-05, DI-30)', () => {
  it('[DI-05][DI-30][PR-47][PR-23] round 10 (recipe-core 0345): the round-3 verification\'s probes are refused (EBMR-EXE-126) and nothing holds L2409-0017: an accepted START_STEP of a recovery with start data authorised by L2409-0017 (or by a person of the installation: no accepted start data at all), a refused one authorised by L2409-0017 or by a person id the installation does not have, and over HTTP an equipment status naming L2409-0017, or equipment of another stage, at a status step that lists none; the server\'s own START_STEP of the recovery is recorded refused G24-NOT-AUTHORISED, a refused start authorised by a person of the installation is recorded, and the status of the equipment its stage binds is recorded', async () => {
    const qa1 = personaIn(sbx, 'qa1').personId;
    const refs = { investigationRef: 'TEST-INV-0001', riskEvaluationRef: 'TEST-RA-0001', authorisationRef: 'TEST-AUTH-0001' };
    const START_DATA = String.raw`\. A test run records only start data it can bind, so nothing sits in the record unread \(DI-05, DI-30, PR-47\)\. \[EBMR-EXE-126\]$`;

    const rework = await issued(withRework());
    // The server sends no start data: its START_STEP of the recovery is the engine's refusal, recorded.
    expect(outcomeOf(await rework.command('operator1', { type: 'START_STEP', stepKey: 'p-rework@' }))).toBe('422:G24-NOT-AUTHORISED');
    const start: Intent = { type: 'START_STEP', stepKey: 'p-rework@' };
    const outcomes: Record<string, string> = {
      // Need A: the round-3 verification's probe, and the same start data authorised by a person of this installation.
      acceptedLot: await sentAs(rework, 'operator1', start, ({ command }) => void (command['blockData'] = { ...refs, authorisedBy: LOT })),
      acceptedPerson: await sentAs(rework, 'operator1', start, ({ command }) => void (command['blockData'] = { ...refs, authorisedBy: qa1 })),
      // Refused by the engine (no investigation reference), so recorded as sent: the authoriser is still a person.
      refusedLot: await sentAs(rework, 'operator1', start, ({ command }) => void (command['blockData'] = { riskEvaluationRef: refs.riskEvaluationRef, authorisationRef: refs.authorisationRef, authorisedBy: LOT })),
      refusedUnknown: await sentAs(rework, 'operator1', start, ({ command }) => void (command['blockData'] = { riskEvaluationRef: refs.riskEvaluationRef, authorisationRef: refs.authorisationRef, authorisedBy: randomUUID() })),
      refusedPerson: await sentAs(rework, 'operator1', start, ({ command }) => void (command['blockData'] = { riskEvaluationRef: refs.riskEvaluationRef, authorisationRef: refs.authorisationRef, authorisedBy: qa1 })),
    };
    expect(unmatched(outcomes, {
      acceptedLot: new RegExp(String.raw`^This accepted START_STEP row cannot be recorded: command\.blockData is start data, which an accepted START_STEP never records: the server sends none, and a reprocessing's authorisation by the quality unit is not given through a test run in this release` + START_DATA),
      acceptedPerson: new RegExp(String.raw`^This accepted START_STEP row cannot be recorded: command\.blockData is start data, which an accepted START_STEP never records: the server sends none, and a reprocessing's authorisation by the quality unit is not given through a test run in this release` + START_DATA),
      refusedLot: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.blockData\.authorisedBy is not the id of a person of this installation` + START_DATA),
      refusedUnknown: new RegExp(String.raw`^This refused START_STEP row cannot be recorded: command\.blockData\.authorisedBy is not the id of a person of this installation` + START_DATA),
      refusedPerson: 'ok',
    })).toEqual({});
    expect((await execution.loadState(sbx.db.admin, rework.runId))?.state.steps['p-rework@']?.status).not.toBe('IN_PROGRESS');
    expect(await recordHolding(rework.runId, LOT)).toEqual(NOTHING);

    // Need B: over HTTP, through the honest server.
    const room = await issued(withRoomStatus());
    await room.ok('operator1', { type: 'START_STEP', stepKey: 'p-room-status@' });
    const status = (equipmentRef: string) => room.command('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-room-status@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef, labelId: 'TEST-LBL-0001', answers: STATUS_ANSWERS } });
    const lot = await status(LOT);
    expect(outcomeOf(lot)).toBe('422:EBMR-EXE-126');
    expect(JSON.stringify(lot)).toMatch(/stores entry EN-\d+ \(EQUIPMENT_STATUS\) of step p-room-status@ for equipment that the batch's MBR does not bind where step p-room-status runs \(it binds BAL there\): an equipment status names equipment the MBR binds where its step runs/);
    // Equipment the MBR binds to another stage (no digit, so no form the identifier rule reads) is refused as well.
    expect(outcomeOf(await status('BLENDER'))).toBe('422:EBMR-EXE-126');
    expect(outcomeOf(await status('BAL'))).toBe('ok');
    expect(await recordHolding(room.runId, LOT)).toEqual(NOTHING);
    expect(await recordHolding(room.runId, 'BLENDER')).toMatchObject({ rows: 0, state: 0 });
  }, 300_000);

  it('[DI-05][DI-30] round 10 (recipe-core 0344): L2409-0017 is refused (EBMR-EXE-147) wherever a test run would record it: over HTTP a comment, a reason, a free-text answer, a deviation reference and a check id three levels down in a refused entry; on the store and engine path a refusal\'s message, the evidence, start data, the reason of the actor context, and a business entry of the run\'s audit chain (its message and a member three levels down); nothing holds it, and prose, TEST- identifiers and the MBR\'s own codes are recorded', async () => {
    const d = await issued(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const http = {
      comment: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: `Seal of drum ${LOT} torn`, severity: 'ALERT' })),
      reason: outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold until drum ${LOT} is found` })),
      answer: outcomeOf(await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: `Paracetamol 500 mg from lot ${LOT}`, batchNumber: 'TEST-B26-9999' } })),
      // The round-6 verification's probe H: the engine refuses an unknown check id, and the refused row would keep it.
      nested: outcomeOf(await d.command('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: [{ id: LOT, answer: 'CONFIRMED' as const }, ...CHECKED.slice(1).map((id) => ({ id, answer: 'CONFIRMED' as const }))] } })),
    };
    // A deviation reference, on an honest exception.
    const raised = await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open on the 2nd round; 12.5 g at 100% load; drum TEST-L26-0101 set aside per SOP-DISP-001', severity: 'ALERT' });
    expect(raised).toBeDefined();
    const exception = Object.keys((await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions ?? {})[0] ?? '';
    const deviation = outcomeOf(await d.command('supervisor1', { type: 'ATTACH_DEVIATION', exception, deviationRef: `DEV-${LOT}` }));
    expect({ ...http, deviation }).toEqual({ comment: '422:EBMR-EXE-147', reason: '422:EBMR-EXE-147', answer: '422:EBMR-EXE-147', nested: '422:EBMR-EXE-147', deviation: '422:EBMR-EXE-147' });

    const ROW = String.raw`, a word of the form of a batch or lot number that is not a test one\. A test run names a batch, lot or container only by a TEST- identifier \(for example TEST-L24-0001\), or describes it in words, whatever member holds it, so a real GMP identifier is never reused \(DI-05, DI-30\)\. \[EBMR-EXE-147\]$`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. A test run names a batch, lot or container only by a TEST- identifier \(for example TEST-L24-0001\), or describes it in words, also in a reason or a business entry of its audit trail \(DI-05, DI-30\)\. \[EBMR-EXE-147\]$`;
    const RUN = String.raw`of test batch [0-9a-f-]{36} cannot be recorded: `;
    const store: Record<string, string> = {
      refusal: await refusedAs(d, { type: 'START_STEP', stepKey: CLEAR }, (r) => void (r['message'] = `${String(r['message'])} (drum ${LOT})`)),
      evidence: await sentAs(d, 'operator1', { type: 'RECORD_DATA', stepKey: CLEAR, item: 'blendTime', value: { kind: 'DECIMAL', value: '15', unit: 'min' }, source: { mode: 'MANUAL' } }, ({ evidence }) => void (evidence['unattestedScan'] = { code: `scan of ${LOT}`, recordedAs: 'MANUAL' })),
      startData: await sentAs(d, 'operator1', { type: 'START_STEP', stepKey: CLEAR }, ({ command }) => void (command['blockData'] = { investigationRef: `Investigation of drum ${LOT}` })),
      contextReason: await sentAs(d, 'operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door seal torn', severity: 'ALERT' }, () => undefined, { reasonCode: 'ENTRY_ERROR', reasonText: `recount of drum ${LOT}` }),
      businessEntry: await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query("select kernel.audit_business_event($1, $2, '{}'::jsonb)", [`batch:${d.runId}`, `Drum ${LOT} moved to the booth`]))),
      businessDetails: await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [`batch:${d.runId}`, 'Drum moved to the booth', JSON.stringify({ drum: { lot: { code: LOT } } })]))),
      businessProse: await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query("select kernel.audit_business_event($1, $2, '{}'::jsonb)", [`batch:${d.runId}`, 'Drum TEST-L26-0101 moved to the booth on the 2nd shift']))),
    };
    expect(unmatched(store, {
      refusal: new RegExp(String.raw`^This execution_command row ${RUN}refusal holds, at \$\.message` + ROW),
      evidence: new RegExp(String.raw`^This execution_command row ${RUN}evidence holds, at \$\.unattestedScan\.code` + ROW),
      startData: new RegExp(String.raw`^This execution_command row ${RUN}command holds, at \$\.blockData\.investigationRef` + ROW),
      contextReason: new RegExp(String.raw`^This insert entry of audit chain batch:[0-9a-f-]{36} ${RUN}it holds, at \$\.reason_text` + AUDIT),
      businessEntry: new RegExp(String.raw`^This business entry of audit chain batch:[0-9a-f-]{36} ${RUN}it holds, at \$\.body\.message` + AUDIT),
      businessDetails: new RegExp(String.raw`^This business entry of audit chain batch:[0-9a-f-]{36} ${RUN}it holds, at \$\.body\.details\.drum\.lot\.code` + AUDIT),
      businessProse: 'ok',
    })).toEqual({});
    expect(await recordHolding(d.runId, LOT)).toEqual(NOTHING);
    expect(await recordHolding(d.runId, 'TEST-L26-0101 set aside per SOP-DISP-001')).toMatchObject({ rows: 1 });
  }, 300_000);

  it('[DI-05][DI-30] round 10 (recipe-core 0344, kernel 1030): every real format the identifier rule knows is refused in a test run\'s free text (EBMR-EXE-147), as written, in lower case, in full-width letters, with percent or backslash escapes, glued to a longer word or nested in a member name; the run\'s own TEST- identifiers, its MBR\'s codes, the engine\'s names, numbers, dates, ranges, ordinals and plain prose are recorded', async () => {
    const d = await issued(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const raise = (description: string) => sentAs(d, 'operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description, severity: 'ALERT' });
    const refused: Record<string, string> = {};
    for (const [name, text] of Object.entries({
      lot: `lot ${LOT}`,
      kernelLotExample: 'lot L24-0001',
      kernelBatchExample: 'after batch B24-0001',
      deviceLabelBody: 'scale SCALE-01 was used',
      personLabelBody: 'trainee TRAINEE-01 assisted',
      lowerCase: 'lot l2409-0017',
      fullWidth: 'lot Ｌ２４０９－００１７',
      percentEscape: 'lot %4C2409-0017',
      backslashEscape: 'lot \\u004C2409-0017',
      glued: `drum-${LOT}-from-the-supplier-warehouse-north`,
      slashed: `${LOT}/1`,
    })) {
      refused[name] = await raise(text);
    }
    // A member name: in a business entry of the run's audit chain, whose details are free JSON.
    refused['memberName'] = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) =>
        c.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [`batch:${d.runId}`, 'Drum moved to the booth', JSON.stringify({ drums: { [LOT]: 1 } })]),
      ),
    );
    expect(Object.entries(refused).filter(([, m]) => !/\[EBMR-EXE-147\]$/.test(m))).toEqual([]);
    expect(refused['memberName']).toMatch(/it holds, at \$\.body\.details\.drums \(the name of one of its members\), a word of the form of a batch or lot number/);
    const recorded: Record<string, string> = {};
    for (const [name, text] of Object.entries({
      prose: 'Booth door found open after the clearance; checked twice by the second operator',
      numbers: 'Seal torn on 2026-10-04 at 10:15; 12.5 g, 15-25 C, 100% of drums, 1/2 tablet, version 1.5.0, 3rd attempt',
      testIdentifiers: 'Drum TEST-L26-0101 and batch TEST-B26-9999 set aside; label TEST-LBL-0001',
      mbrCodes: 'Followed SOP-DISP-001 for PCM500 on BAL',
      engineNames: 'See EX-1 and G07-LOT-STATUS (DI-05, PR-18)',
    })) {
      recorded[name] = await raise(text);
    }
    expect(recorded).toEqual({ prose: 'ok', numbers: 'ok', testIdentifiers: 'ok', mbrCodes: 'ok', engineNames: 'ok' });
    for (const text of [LOT, 'L24-0001', 'B24-0001', 'SCALE-01', 'TRAINEE-01', 'l2409-0017', 'Ｌ２４０９', '%4C2409', '\\u004C2409']) {
      expect(await recordHolding(d.runId, text), text).toEqual(NOTHING);
    }
  }, 300_000);
});
