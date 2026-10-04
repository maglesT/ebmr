/**
 * Phase 2 exit follow-up F12, round 11: the words a test run's record may hold are bound to the run, not to their form
 * (DI-05, DI-30, INV-18; kernel 1040, recipe-core 0346; ADR 0012).
 *
 * The round-10 catch-all (recipe-core 0344) read every text of the record with the kernel's identifier rule, but the
 * lane's round-11 verification stored the real-format batch number S24090017 and lot numbers of the same class in a
 * test run through the application role and the honest server:
 *  - (G1) any word of the form of an engine name was allowed in every member, whether or not the run had such a record
 *    or register entry (S24090017, E24090017, EX-24090017, DV-24090017, HOLD-2409017, G24-LOT, E2409/0017);
 *  - (G2) the administrator renamed operator1 'TEST-Priya L2409-0017', and the run's rows, signature and audit entries
 *    printed it;
 *  - (G3) reading a text only with its escapes read hid the identifier written right after one ('50%B24-0001');
 *  - (G4) on a scale reading's audit chain only the reason was read, so the application role appended a business entry
 *    naming L2409-0017 there;
 *  - (G5) the refusal's JSON path repeated a member name that itself held a real-format word.
 * Now (recipe-core 0346) the words allowed are the run's MBR, batch number, site and room, the names of the engine's
 * registers (recipe.engine_name), the ids of the records the run's state holds, the edges of its MBR's flow and the
 * compounds the engine builds of them; a person's name is read where the record copies it, and the register refuses one
 * (kernel 1040); a text is read as written and with its escapes read (kernel 1040); a reading's chain is read in full;
 * a refusal never repeats a word it refuses.
 *
 * The writer is the application role, through the honest server (HTTP) or with the application's own credentials (a
 * business entry of the audit trail, the administrator's rename), as in the other db-guards files. Own file and server:
 * the kiosk's device nonces are rate-limited per terminal and minute.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { execution, type engine, type flow } from '@ebmr/recipe-core';
import { passwordActor } from '@ebmr/test-kit';
import { resolveClientIntent } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, personaIn, RunDriver, startExecServer, writePackage, type ExecServer } from './support.ts';

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
const REFUSED = '422:EBMR-EXE-147';

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
 * operator1's `intent` at run `d`, resolved as the server resolves it, run and stored as the server stores a command, in a
 * command whose actor context carries `context`.
 */
async function sentAs(d: RunDriver, intent: Intent, context: Partial<ActorContext> = {}): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'operator1');
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1', context), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const resolved = await resolveClientIntent(
        { client: c, app: sbx.built.ctx, def: run.def, state: tx.state, room: 'DISP-1', actor: engineActor(who.personId, roles), commandId: randomUUID(), expectedVersion: tx.state.version, useReadings: true },
        intent,
      );
      await tx.command(resolved.command, roles, resolved.evidence as engine.JsonValue);
    }),
  );
}

/** A business entry the application role appends itself, as operator1 at its kiosk (room DISP-1). */
async function businessEntry(d: RunDriver, chainKey: string, message: string, details: Json = {}): Promise<string> {
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), (c) => c.query('select kernel.audit_business_event($1, $2, $3::jsonb)', [chainKey, message, JSON.stringify(details)])),
  );
}

/** Where the record of run `runId` holds `text`: rows, events, state, content versions, proposals, signatures and its audit chains. */
async function recordHolding(runId: string, text: string): Promise<Record<string, number>> {
  const like = `%${text}%`;
  const count = async (sql: string) => Number((await sbx.db.admin.query<{ n: string }>(sql, [runId, like])).rows[0]?.n ?? '0');
  return {
    rows: await count(`select count(*)::text as n from recipe.execution_command where batch_id = $1 and (command::text like $2 or evidence::text like $2 or coalesce(refusal::text, '') like $2 or coalesce(actor_legal_name, '') like $2)`),
    events: await count('select count(*)::text as n from recipe.execution_event where batch_id = $1 and event::text like $2'),
    state: await count('select count(*)::text as n from recipe.execution_state where batch_id = $1 and state::text like $2'),
    contents: await count(`select count(*)::text as n from (
       select content from recipe.execution_step_content where batch_id = $1 union all select content from recipe.execution_stage_content where batch_id = $1
       union all select content from recipe.execution_exception_content where batch_id = $1 union all select content from recipe.execution_point_content where batch_id = $1) x
      where x.content::text like $2`),
    proposals: await count(`select count(*)::text as n from (select proposal from recipe.execution_disposition_proposal where batch_id = $1
       union all select proposal from recipe.execution_decision_proposal where batch_id = $1) x where x.proposal::text like $2`),
    signatures: await count(`select count(*)::text as n from esig.signature where aggregate_id like $1 || ':%' and (signer_legal_name like $2 or signer_login like $2 or manifestation::text like $2)`),
    audit: await count(`select count(*)::text as n from kernel.audit_event e
      where (e.chain_key = 'batch:' || $1 or e.chain_key ~ ('^(esig_challenge:|esig_signature:)?batch_(step|stage|exception|point):' || $1 || ':')) and (e.payload::text like $2 or e.chain_key like $2)`),
  };
}

const NOTHING = { rows: 0, events: 0, state: 0, contents: 0, proposals: 0, signatures: 0, audit: 0 };

describe('F12 round 11: the words a test run records are bound to the run (DI-05, DI-30)', () => {
  it('[DI-05][DI-30] round 11 (recipe-core 0346): a word of the form of an engine name is recorded only as the run has it: over HTTP S24090017 (also in lower case), E24090017, EX-24090017, DV-24090017, HOLD-2409017, G24-LOT, E2409/0017 and EX-9 (an exception the run does not have) in an exception\'s description and in a hold reason are refused (EBMR-EXE-147) and nothing holds them; an exception of the run, a block rule code, block type and controls of the registers, prose, numbers and TEST- identifiers are recorded', async () => {
    const d = await issued(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const probes: Record<string, string> = {
      S24090017: 'Drum of batch S24090017 set aside',
      s24090017: 'drum of batch s24090017 set aside',
      E24090017: 'previous batch E24090017',
      'EX-24090017': 'Lot EX-24090017',
      'DV-24090017': 'Lot DV-24090017',
      'HOLD-2409017': 'Lot HOLD-2409017',
      'G24-LOT': 'Lot G24-LOT',
      'E2409/0017': 'Lot E2409/0017',
      'EX-9': 'Follow-up of EX-9',
    };
    const raised: Record<string, string> = {};
    for (const [word, text] of Object.entries(probes)) {
      raised[word] = outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: text, severity: 'ALERT' }));
    }
    expect(raised).toEqual(Object.fromEntries(Object.keys(probes).map((w) => [w, REFUSED])));
    // The engine's own names, as the run has them: its first exception is EX-1, raised by this very row.
    const honest = {
      first: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open on the 2nd round; 12.5 g at 100% load; drum TEST-L26-0101 set aside per SOP-DISP-001', severity: 'ALERT' })),
      engineNames: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Follow-up of EX-1 under G07-LOT-STATUS on G-10 (DI-05, PR-18, INV-25)', severity: 'ALERT' })),
    };
    expect(honest).toEqual({ first: 'ok', engineNames: 'ok' });
    // A hold reason is read the same way (the batch is not held: every probe is refused before anything is written).
    const held: Record<string, string> = {};
    for (const [word, text] of Object.entries(probes)) {
      held[word] = outcomeOf(await d.command('supervisor1', { type: 'HOLD_BATCH', holdType: 'SUPERVISOR', reason: `Hold: ${text}` }));
    }
    expect(held).toEqual(Object.fromEntries(Object.keys(probes).map((w) => [w, REFUSED])));
    for (const word of [...Object.keys(probes), '24090017', '2409017', 'G24-LOT']) {
      expect(await recordHolding(d.runId, word), word).toEqual(NOTHING);
    }
    expect(await recordHolding(d.runId, 'Follow-up of EX-1 under G07-LOT-STATUS')).toMatchObject({ rows: 1 });
  }, 300_000);

  it('[DI-05][DI-30][INV-18] round 11 (kernel 1040, recipe-core 0346): a person\'s name holds no real-format identifier: the administrator\'s rename of operator1 to TEST-Priya L2409-0017 through the application role is refused (EBMR-SBX-024), operator1\'s run then holds it in no row, signature or audit entry; a name stored before kernel 1040 is refused where the run would copy it (EBMR-EXE-147), its challenge included, and the honest name is recorded again', async () => {
    const op = personaIn(sbx, 'operator1');
    const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint);
    const asAdmin = (): ActorContext => ({ ...admin, reasonCode: 'TEST_SETUP', reasonText: 'F12 round 11: the verification\'s rename', correlationId: randomUUID() });
    const renameTo = (name: string) => messageOf(withCommand(sbx.db.app, asAdmin(), (c) => identity.renamePerson(c, op.personId, name)));
    const d = await issued(dcMini());
    try {
      const rename = await renameTo(`TEST-Priya ${LOT}`);
      expect(rename).toMatch(/^iam\.person legal_name holds a word of the form of a batch or lot number that is not a test one: .* \[EBMR-SBX-024\]$/);
      expect(rename).not.toContain(LOT);
      expect((await sbx.db.admin.query<{ n: string }>('select legal_name as n from iam.person where id = $1', [op.personId])).rows[0]?.n).toBe('TEST-Priya Nair');

      await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK', answers: CHECKED.map((id) => ({ id, answer: 'CONFIRMED' as const })) } });
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH', product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } });
      await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
      expect(await recordHolding(d.runId, LOT)).toEqual(NOTHING);
      const named = await recordHolding(d.runId, 'TEST-Priya Nair');
      expect(named['rows']).toBeGreaterThanOrEqual(4);
      expect(named['signatures']).toBe(1);
      // The next step made ready for operator1's signature.
      await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
      await d.ok('operator1', { type: 'START_STEP', stepKey: 'p-disp-bal@' });
      await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: 'p-disp-bal@', entry: { kind: 'EQUIPMENT_STATUS', equipmentRef: 'BAL', labelId: 'TEST-LBL-0001', answers: ['CALIBRATED', 'DAILY_CHECK', 'CLEAN'].map((id) => ({ id, answer: 'YES' as const })) } });

      // A name stored before kernel 1040 held the register to the rule (the superuser sets the guard aside for the rename).
      await sbx.db.admin.query('alter table iam.person disable trigger ac_sandbox_free_text');
      try {
        await withCommand(sbx.db.app, asAdmin(), (c) => identity.renamePerson(c, op.personId, `TEST-Priya ${LOT}`));
      } finally {
        await sbx.db.admin.query('alter table iam.person enable trigger ac_sandbox_free_text');
      }
      const legacy = {
        http: outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open', severity: 'ALERT' })),
        store: await sentAs(d, { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open', severity: 'ALERT' }, { legalName: `TEST-Priya ${LOT}` }),
      };
      expect(legacy.http).toBe(REFUSED);
      expect(legacy.store).toMatch(/(execution_command row of test batch [0-9a-f-]{36} cannot be recorded: actor_legal_name holds, at \$|entry of audit chain batch[a-z_]*:[0-9a-f-]{36}(:\.\.\.)? of test batch [0-9a-f-]{36} cannot be recorded: it holds, at \$\.actor\.legal_name), a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$/);
      expect(legacy.store).not.toContain(LOT);
      // Nor can operator1 sign: the challenge's audit entry of the run's step would print the name.
      const signing = await d.sign('operator1', { type: 'SIGN_PERFORMED', stepKey: 'p-disp-bal@' });
      expect(signing.stage).toBe('challenge');
      expect(JSON.stringify(signing.result)).toMatch(/"code":"EBMR-EXE-147".*entry of audit chain esig_challenge:batch_step:[0-9a-f-]{36}:\.\.\. of test batch [0-9a-f-]{36} cannot be recorded: it holds, at \$\.actor\.legal_name, a word/);
      expect(JSON.stringify(signing.result)).not.toContain(LOT);
    } finally {
      // The honest name again (it passes the register's guard), whatever the probes gave, so no later test inherits another.
      await renameTo('TEST-Priya Nair');
    }
    expect(outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description: 'Booth door found open', severity: 'ALERT' }))).toBe('ok');
    expect(await recordHolding(d.runId, LOT)).toEqual(NOTHING);
  }, 300_000);

  it('[DI-05][DI-30] round 11 (kernel 1040): an escape never hides the identifier written right after it: over HTTP 50%B24-0001, lot %E2409001 found and ref%A24-0001 in an exception\'s description are refused (EBMR-EXE-147) and nothing holds them; a percentage in prose is recorded', async () => {
    const d = await issued(dcMini());
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const raise = async (description: string) => outcomeOf(await d.command('operator1', { type: 'RAISE_EXCEPTION', stepKey: CLEAR, description, severity: 'ALERT' }));
    expect({ a: await raise('50%B24-0001'), b: await raise('lot %E2409001 found'), c: await raise('ref%A24-0001'), prose: await raise('Seal torn at 100% load, 50%RH') }).toEqual({ a: REFUSED, b: REFUSED, c: REFUSED, prose: 'ok' });
    for (const word of ['B24-0001', 'E2409001', 'A24-0001']) expect(await recordHolding(d.runId, word), word).toEqual(NOTHING);
  }, 300_000);

  it('[DI-05][DI-30] round 11 (recipe-core 0346): a scale reading\'s audit chain and a run\'s chain key are read: a business entry the application role appends on a reading\'s chain naming L2409-0017 in its message or three levels down in its details, or on the chain device_reading:L2409-0017 or batch_step:<run>:L2409-0017, is refused (EBMR-EXE-147) without the word in the message; an entry naming the room of the writing session is recorded', async () => {
    const d = await issued(dcMini());
    const reading = `device_reading:${randomUUID()}`;
    const AUDIT = String.raw`, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`;
    const outcomes = {
      message: await businessEntry(d, reading, `Drum ${LOT} on the scale`, { lot: LOT }),
      details: await businessEntry(d, reading, 'Drum on the scale', { drum: { lot: { code: LOT } } }),
      readingKey: await businessEntry(d, `device_reading:${LOT}`, 'Drum on the scale'),
      runKey: await businessEntry(d, `batch_step:${d.runId}:${LOT}`, 'Drum on the scale'),
      room: await businessEntry(d, reading, 'Drum TEST-L26-0101 on the scale in room DISP-1', { room: 'DISP-1' }),
    };
    expect(outcomes.message).toMatch(new RegExp(String.raw`^This business entry of audit chain device_reading:[0-9a-f-]{36} cannot be recorded: it holds, at \$\.body\.message` + AUDIT));
    expect(outcomes.details).toMatch(new RegExp(String.raw`^This business entry of audit chain device_reading:[0-9a-f-]{36} cannot be recorded: it holds, at \$\.body\.details\.drum\.lot\.code` + AUDIT));
    expect(outcomes.readingKey).toMatch(new RegExp(String.raw`^This business entry of audit chain device_reading:\.\.\. cannot be recorded: it holds, at \$\.chain_key` + AUDIT));
    expect(outcomes.runKey).toMatch(new RegExp(String.raw`^This business entry of audit chain batch_step:${d.runId}:\.\.\. of test batch ${d.runId} cannot be recorded: it holds, at \$\.chain_key` + AUDIT));
    expect(outcomes.room).toBe('ok');
    for (const m of Object.values(outcomes)) expect(m).not.toContain(LOT);
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where (chain_key like 'device_reading:%' or chain_key like 'batch%') and (payload::text like $1 or chain_key like $1)", [`%${LOT}%`]);
    expect(rows[0]?.n).toBe('0');
  }, 300_000);

  it('[DI-05][DI-30] round 11 (recipe-core 0346): a refusal never repeats a word it refuses, also through a member name: business details {"Z2409-0018": {"x": "L2409-0017"}} are refused at $.body.details.<member>.x, and neither word is in the message; a member name of the run\'s own words is shown', async () => {
    const d = await issued(dcMini());
    const chain = `batch:${d.runId}`;
    const hidden = await businessEntry(d, chain, 'Drum moved to the booth', { 'Z2409-0018': { x: LOT } });
    expect(hidden).toMatch(new RegExp(String.raw`^This business entry of audit chain batch:${d.runId} of test batch ${d.runId} cannot be recorded: it holds, at \$\.body\.details\.<member>\.x, a word of the form of a batch or lot number that is not a test one\. .*\[EBMR-EXE-147\]$`));
    expect(hidden).not.toContain('Z2409-0018');
    expect(hidden).not.toContain(LOT);
    const shown = await businessEntry(d, chain, 'Drum moved to the booth', { 'SOP-DISP-001': { x: LOT } });
    expect(shown).toMatch(/it holds, at \$\.body\.details\.SOP-DISP-001\.x, a word/);
  }, 300_000);
});
