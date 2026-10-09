/**
 * What a signature covers and which signatures a row needs, through the store and the kernel's content provider (SQL
 * mutation group "signed-content": recipe-core 0210, 0296, 0297, 0319, 0333). These tests close the gaps the SQL mutation
 * run (tools/sql-mutation, batch 2) found in the server's signed-content and db-guards tests:
 *   - recipe.execution_content_of (0319): a record id that is not a record of this system, or names no stored record,
 *     is answered as not there (nothing is signable); the act a witness watches is the step's own SIGN_PERFORMED, on the
 *     terminal that recorded it, whatever was recorded after it on another terminal; a signed-off stage reads
 *     SIGNED_OFF; only a sign-off listed as made before 0319 is read without its summary;
 *   - recipe.current_proposal (0210): the disposition an exception's signature covers is the one proposed for that very
 *     exception, never another exception's;
 *   - recipe.check_signatures (0297): a command type that is not signed carries no signature or approval, a signed type
 *     the release cannot check is refused, the signature reference is a well-formed id of this system, names the person
 *     who uses it and was made by that person; the signer's own signature is checked by its own SIGNATURE use in this
 *     transaction, whatever badge tap attributes the command; a VERIFY is signed with the check its step requires when
 *     the row is recorded: a block check meaning a release commits while the VERIFY waits between its two reads of the
 *     step's meanings is caught by the second guard (P37), which names the check now required;
 *   - recipe.step_signature_meanings (0296): a decision is signed only on a hold point, and only one it lists;
 *   - recipe.step_check_meanings (0333): the trusted time of a witness is the marker of the batch it checks, never
 *     another batch's in the same transaction.
 *
 * Controls: DI-35, DI-36, DI-37, INV-10, PR-14, PR-20, PR-45, PR-49, IN-15, PR-16, DI-20, INV-40. The application role
 * (ebmr_sandbox; ADR 0012) is the writer: the kernel signs, the store appends, the server's own checks are bypassed where a
 * case needs a row the ceremony would never write. The private derivations are called as the superuser, as the module
 * tests do, with the arguments their callers pass.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { esig, withCommand } from '@ebmr/kernel';
import { engine, execution, type flow } from '@ebmr/recipe-core';
import { terminalOf } from '@ebmr/test-kit';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, engineResult, messageOf, nextState, prepareSignature, signatureAlone, unmatched } from '../execution/db-guards-support.ts';
import {
  dcMini,
  dcMiniVariant,
  dispensingAwaitingSignOff,
  importAndIssue,
  personaIn,
  rowsOf,
  RunDriver,
  startExecServer,
  withEarlyHoldPoint,
  writePackage,
  type ExecServer,
} from '../execution/support.ts';

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
type CommandClient = Parameters<Parameters<typeof withCommand>[2]>[0];

const CLEAR = 'p-disp-clear@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

/** A run of `content` issued by the issuer, driven by `personas` on their home terminals. */
async function driver(content: flow.MbrContent = dcMini(), personas: string[] = ['operator1', 'verifier1', 'qa1']): Promise<RunDriver> {
  const issuer = await sbx.asPersona('issuer');
  const runId = await importAndIssue(sbx, issuer, writePackage(sbx, content));
  const browsers: Record<string, Awaited<ReturnType<ExecServer['asPersona']>>> = { issuer };
  for (const p of personas) browsers[p] = await sbx.asPersona(p);
  const d = new RunDriver(sbx, runId, browsers);
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  return d;
}

async function startClearance(d: RunDriver): Promise<void> {
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok('operator1', c);
}

/**
 * In the open transaction of `c` (the superuser's), acts as a software release does: as the owner, attributed to the
 * system's SOFTWARE_RELEASE context (the release tables are audited).
 */
async function asSoftwareRelease(c: pg.PoolClient, purpose: string): Promise<void> {
  await c.query('set local role ebmr_owner');
  await c.query(
    `select kernel.set_actor_context(jsonb_build_object(
       'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
       'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
       'site_zone', 'UTC', 'correlation_id', gen_random_uuid(), 'legal_name', $1::text))`,
    [`Software release (test: ${purpose})`],
  );
}

/** The kernel's content of a record as the application reads it (tab.record_content_for_signing, tablets 0410). */
async function contentOf(type: string, id: string): Promise<Json> {
  const { rows } = await sbx.db.app.query<{ r: Json }>('select tab.record_content_for_signing($1, $2) as r', [type, id]);
  return rows[0]?.r ?? {};
}

/** The content object of a record's signable text. */
const signedText = (c: Json): Json => (JSON.parse(typeof c['canonical'] === 'string' ? c['canonical'] : '{}') as { content: Json }).content;

/**
 * `persona` records `command` (or the JSON `recorded` in its place) in a command of its own on its browser, with the
 * engine's result of `command` (or the prior state moved on): 'ok' or the refusal's message.
 */
async function record(d: RunDriver, persona: string, build: (who: { personId: string }, roles: readonly execution.RoleEvidence[], tx: execution.ExecutionTx) => { command: engine.Command; recorded?: engine.JsonValue; forged?: boolean }): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, persona);
  return messageOf(
    withCommand(sbx.db.app, await actorOf(sbx, d.browser(persona), persona), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const { command, recorded, forged } = build(who, roles, tx);
      return appendAs(tx, command, forged ? nextState(tx) : engineResult(tx, command), roles, recorded ?? engine.encodeCommand(command));
    }),
  );
}

describe('the content provider: a record that is not there is not signable (recipe-core 0319)', () => {
  it('[DI-37][DI-36] an id that is not a record id of this system, or names no stored record, is answered as not there; the record itself is there', async () => {
    const d = await driver(dcMini(), ['operator1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    const cases: Record<string, [string, string]> = {
      control: ['batch_step', `${d.runId}:${CLEAR}`],
      notARecordId: ['batch_step', 'not-a-record'],
      noKeyAfterTheBatch: ['batch_step', d.runId],
      noSuchStep: ['batch_step', `${d.runId}:p-not-a-step@`],
      noSuchBatch: ['batch_step', `${randomUUID()}:${CLEAR}`],
      noSuchStage: ['batch_stage', `${d.runId}:S-NOT-A-STAGE@`],
      noSuchException: ['batch_exception', `${d.runId}:EX-999`],
    };
    const got: Record<string, unknown> = {};
    for (const [k, [type, id]] of Object.entries(cases)) {
      try {
        const c = await contentOf(type, id);
        got[k] = c['exists'] === true ? 'exists' : c;
      } catch (e) {
        got[k] = e instanceof Error ? e.message : String(e);
      }
    }
    expect(got).toEqual({
      control: 'exists',
      ...Object.fromEntries(Object.entries(cases).filter(([k]) => k !== 'control').map(([k, [type, id]]) => [k, { exists: false, aggregate_type: type, aggregate_id: id }])),
    });
  }, 240_000);
});

describe('the act a witness watches is the step\'s own SIGN_PERFORMED (recipe-core 0319, esig.check_witness)', () => {
  /** dc-mini with the booth clearance witnessed and its stage bound to both rooms (DISP-1 and BLEND-1). */
  const witnessedInTwoRooms = (): flow.MbrContent =>
    dcMiniVariant((prep, content) => {
      const stage = (((content['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json;
      stage['binding'] = { ...(stage['binding'] as Json), rooms: ['DISP-1', 'BLEND-1'] };
      const [clear, ...rest] = prep as [Json, ...Json[]];
      return [{ ...clear, signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'WITNESSED', role: 'PRODUCTION_VERIFIER' } } }, ...rest];
    });

  it('[DI-35][PR-14][DI-20] a witness at the booth witnesses the PERFORMED signature recorded at the booth, although the step was started and the run written to from the blending room\'s kiosk; the witness record names the booth\'s terminal', async () => {
    const d = await driver(witnessedInTwoRooms(), ['verifier1']);
    // operator1 on the kiosk of either room (the stage admits both); a person has one session, so each move to a kiosk
    // signs in there again.
    const operatorAt = async (terminal: string): Promise<RunDriver> => {
      const at = new RunDriver(sbx, d.runId, { operator1: await sbx.asPersona('operator1', terminal) });
      at.beforeTap = d.beforeTap;
      return at;
    };
    const blend = await operatorAt('TEST-KIOSK-BLEND-1');
    await blend.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await blend.ok('operator1', c);
    // The PERFORMED signature at the booth's kiosk.
    await (await operatorAt('TEST-KIOSK-DISP-1')).signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    // Then, from the BLEND-1 kiosk: an alert about the batch (accepted) and an entry on the step (refused: it awaits
    // its witness). Neither moves the run on.
    const again = await operatorAt('TEST-KIOSK-BLEND-1');
    await again.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const refused = await again.command('operator1', clearance[1] as (typeof clearance)[1]);
    expect(refused.ok).toBe(false);
    const rows = await sbx.db.admin.query<{ command_type: string; accepted: boolean; device_id: string }>(
      "select command_type, accepted, device_id::text from recipe.execution_command where batch_id = $1 and kind = 'COMMAND' order by seq",
      [d.runId],
    );
    const disp = terminalOf(sbx.seed, 'TEST-KIOSK-DISP-1').deviceId;
    const blendKiosk = terminalOf(sbx.seed, 'TEST-KIOSK-BLEND-1').deviceId;
    // SETUP: the step's other rows and the rows after its act come from the BLEND-1 kiosk; its act from the booth's.
    expect(rows.rows.map((r) => `${r.command_type}${r.accepted ? '' : ' (refused)'}@${r.device_id === disp ? 'DISP-1' : r.device_id === blendKiosk ? 'BLEND-1' : r.device_id}`)).toEqual([
      'START_STEP@BLEND-1',
      'RECORD_ENTRY@BLEND-1',
      'RECORD_ENTRY@BLEND-1',
      'SIGN_PERFORMED@DISP-1',
      'RAISE_EXCEPTION@BLEND-1',
      'RECORD_ENTRY (refused)@BLEND-1',
    ]);

    // recipe.step_check_meanings: the time of the witness is this batch's marker; without one in the transaction it is
    // unknown and the witness stays due, whatever marker another batch has there (rolled back).
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const meanings = async (markerBatch: string): Promise<string[] | null> => {
      const c = await sbx.db.admin.connect();
      try {
        await c.query('begin');
        // A day after the act: the window has passed by then.
        await c.query("insert into recipe.execution_clock (xact_id, backend_pid, batch_id, now_us) values (pg_current_xact_id(), pg_backend_pid(), $1, (extract(epoch from clock_timestamp() + interval '1 day') * 1000000)::bigint)", [markerBatch]);
        const { rows: r } = await c.query<{ m: string[] | null }>('select recipe.step_check_meanings($1, $2::jsonb, $3::jsonb) as m', [
          d.runId,
          JSON.stringify(engine.encodeState(state as engine.BatchState)),
          JSON.stringify({ type: 'VERIFY', step: 'p-disp-clear', context: [] }),
        ]);
        return r[0]?.m ?? null;
      } finally {
        await c.query('rollback');
        c.release();
      }
    };
    expect({ otherBatchMarker: await meanings(randomUUID()), ownMarker: await meanings(d.runId) }).toEqual({ otherBatchMarker: ['WITNESSED'], ownMarker: ['LINE_CLEARANCE_VERIFIED'] });

    // The witness at the booth's kiosk: its act is the booth's SIGN_PERFORMED.
    const witnessed = await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' });
    expect(witnessed.result.ok, JSON.stringify(witnessed.result.ok ? '' : witnessed.result.error)).toBe(true);
    const { rows: sig } = await sbx.db.admin.query<{ act: string; witness: string; same: boolean }>(
      "select witness ->> 'act_device_id' as act, witness ->> 'witness_device_id' as witness, (witness ->> 'same_device')::boolean as same from esig.signature where aggregate_id = $1 and meaning_code = 'WITNESSED'",
      [`${d.runId}:${CLEAR}`],
    );
    expect(sig).toEqual([{ act: disp, witness: disp, same: true }]);
    expect((await d.stepView('verifier1', CLEAR)).step.status).toBe('COMPLETED');
  }, 300_000);
});

describe('a stage sign-off is read as signed off, on the text with its summary (recipe-core 0319)', () => {
  it('[DI-37][IN-15][PR-16][DI-23] once signed off, the stage reads SIGNED_OFF and its text keeps its summary, also when other sign-offs are listed as made before 0319; its signature stays VALID', async () => {
    const d = await dispensingAwaitingSignOff(sbx, () => vi.advanceTimersByTime(7_000));
    const aggregateId = `${d.runId}:S-DISP@`;
    expect((await contentOf('batch_stage', aggregateId))['state']).toBe('AWAITING_SIGN_OFF');
    await d.signed('supervisor1', { type: 'SIGN_OFF_STAGE', stageKey: 'S-DISP@' });
    const signOff = (await execution.loadState(sbx.db.admin, d.runId))?.state.stages['S-DISP@']?.signOff;
    if (!signOff) throw new Error('SETUP: no sign-off was recorded');
    const after = await contentOf('batch_stage', aggregateId);
    expect(after['state']).toBe('SIGNED_OFF');
    const withSummary = signedText(after);
    expect(withSummary['summary']).toMatchObject({ statement: 'COMPLETED_PER_MBR' });
    expect((await esig.signatureState(sbx.db.admin, signOff.signature)).status).toBe('VALID');

    // Sign-offs listed as made before 0319 (as the migration lists them; rolled back): another frame's, and an earlier
    // sign-off of this frame under another signature. Only the listed signature of this frame is read without its
    // summary.
    const c = await sbx.db.admin.connect();
    const listed = async (key: string, signature: string): Promise<{ text: Json; status: string }> => {
      await c.query('savepoint listed');
      try {
        await c.query('insert into recipe.execution_stage_summary_legacy (batch_id, aggregate_id, signature_id) values ($1, $2, $3)', [d.runId, `${d.runId}:${key}`, signature]);
        const provided = await esig.contentForSigning(c, 'batch_stage', aggregateId);
        return { text: (JSON.parse(provided.canonical ?? '{}') as { content: Json }).content, status: (await esig.signatureState(c, signOff.signature)).status };
      } finally {
        await c.query('rollback to savepoint listed');
      }
    };
    try {
      await c.query('begin');
      await asSoftwareRelease(c, 'sign-offs made before 0319');
      const outcomes = {
        anotherFrame: await listed('S-BLEND@', randomUUID()),
        anEarlierSignOffOfThisFrame: await listed('S-DISP@', randomUUID()),
        thisSignOff: await listed('S-DISP@', signOff.signature),
      };
      const { summary: _summary, ...stored } = withSummary;
      void _summary;
      expect(outcomes).toEqual({
        anotherFrame: { text: withSummary, status: 'VALID' },
        anEarlierSignOffOfThisFrame: { text: withSummary, status: 'VALID' },
        thisSignOff: { text: stored, status: expect.any(String) as unknown },
      });
    } finally {
      await c.query('rollback');
      c.release();
    }
  }, 600_000);
});

describe('the disposition an exception\'s signature covers is the one proposed for that exception (recipe-core 0210, 0295)', () => {
  it('[PR-49][DI-37][INV-10] with proposals made for two exceptions, each exception\'s signable text holds its own proposal; the honest disposition of the first is signed and stays VALID', async () => {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Second label printer jam', severity: 'ALERT' });
    const [first, second] = (await d.runView('qa1')).exceptions.map((e) => e.exceptionId).sort();
    if (!first || !second) throw new Error('SETUP: two exceptions');
    const A = 'Reprint reconciled; no impact on the batch.';
    const B = 'Printer serviced; second reprint reconciled.';
    const propose = async (exception: string, justification: string) =>
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('qa1'), 'qa1'), (c: CommandClient) =>
        execution.proposeDisposition(c, d.runId, exception, { outcome: 'NO_IMPACT', justification, deviationRef: null }),
      );
    await propose(first, A);
    await propose(second, B);
    const proposed = async (exception: string) => signedText(await contentOf('batch_exception', `${d.runId}:${exception}`))['proposedDisposition'];
    expect({ first: await proposed(first), second: await proposed(second) }).toEqual({
      first: { outcome: 'NO_IMPACT', justification: A, deviationRef: null },
      second: { outcome: 'NO_IMPACT', justification: B, deviationRef: null },
    });
    const signed = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception: first, outcome: 'NO_IMPACT', justification: A });
    expect(signed.result.ok).toBe(true);
    const x = (await execution.loadState(sbx.db.admin, d.runId))?.state.exceptions[first];
    expect({ status: x?.status, justification: x?.disposition?.justification }).toEqual({ status: 'DISPOSITIONED', justification: A });
    expect((await esig.signatureState(sbx.db.admin, x?.disposition?.signature ?? '')).status).toBe('VALID');
  }, 300_000);
});

describe('which signatures a row carries (recipe-core 0297)', () => {
  it('[DI-35][INV-10] a command type that is not signed carries no e-signature, approval or approvals: each is refused (EBMR-EXE-050); the plain command is recorded', async () => {
    const d = await driver(dcMini(), ['operator1']);
    const start = (extra: Json) =>
      record(d, 'operator1', (who, roles) => {
        const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [] };
        return { command, recorded: { ...(engine.encodeCommand(command) as Json), ...extra } as engine.JsonValue };
      });
    const sig = { id: randomUUID(), meaning: 'PERFORMED', signer: personaIn(sbx, 'operator1').personId };
    const outcomes = {
      signature: await start({ signature: sig }),
      approval: await start({ approval: { approver: { kind: 'PERSON', id: personaIn(sbx, 'verifier1').personId }, signature: sig } }),
      approvals: await start({ approvals: [{ approver: { kind: 'PERSON', id: personaIn(sbx, 'verifier1').personId }, signature: sig }] }),
    };
    const refusal = /^START_STEP carries e-signatures, which test runs do not accept in this release \(DI-35\)\. \[EBMR-EXE-050\]$/;
    expect(unmatched(outcomes, { signature: refusal, approval: refusal, approvals: refusal })).toEqual({});
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.kind === 'COMMAND')).toEqual([]);
    expect(await start({})).toBe('ok');
  }, 240_000);

  it('[DI-35][INV-10] the signature reference is a well-formed e-signature id of this system that names the person who uses it, and the signature was made by that person (EBMR-EXE-051, EBMR-EXE-052)', async () => {
    const d = await driver(dcMini(), ['operator1', 'verifier1']);
    const verifier2 = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
    await startClearance(d);
    const op1 = personaIn(sbx, 'operator1');
    const ver1 = personaIn(sbx, 'verifier1');
    const run = await runContext(sbx.db.admin, d.runId);
    const agg = `${d.runId}:${CLEAR}`;
    // operator1 signs PERFORMED in the recording command; the command carries the reference `ref(id)` instead.
    const performed = async (ref: (id: string) => Json): Promise<string> => {
      const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', agg, 'LINE_CLEARANCE_PERFORMED');
      return messageOf(
        withCommand(sbx.db.app, await p.actor(), async (c) => {
          const id = await p.sign(c);
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(op1.personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning: 'LINE_CLEARANCE_PERFORMED', signer: op1.personId } };
          return appendAs(tx, command, engineResult(tx, command), roles, { ...(engine.encodeCommand(command) as Json), signature: ref(id) } as engine.JsonValue);
        }),
      );
    };
    const outcomes: Record<string, string> = {
      noId: await performed(() => ({ meaning: 'LINE_CLEARANCE_PERFORMED', signer: op1.personId })),
      idNotAnId: await performed(() => ({ id: 'not-a-signature', meaning: 'LINE_CLEARANCE_PERFORMED', signer: op1.personId })),
      namesAnotherSigner: await performed((id) => ({ id, meaning: 'LINE_CLEARANCE_PERFORMED', signer: ver1.personId })),
    };
    expect(
      unmatched(outcomes, {
        noId: /^SIGN_PERFORMED needs an e-signature \(DI-35, INV-10\)\. \[EBMR-EXE-051\]$/,
        idNotAnId: /^SIGN_PERFORMED names signature not-a-signature, which is not an e-signature of this system \(DI-35, INV-10\)\. \[EBMR-EXE-051\]$/,
        namesAnotherSigner: new RegExp(`^Signature \\S+ is used by ${op1.personId} but names ${ver1.personId} as its signer: nobody signs for someone else \\(DI-35, INV-10\\)\\. \\[EBMR-EXE-052\\]$`),
      }),
    ).toEqual({});
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.command_type === 'SIGN_PERFORMED' && r.accepted)).toEqual([]);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });

    // verifier1's own signature of the step's check (made and committed alone, never applied), used by verifier2 in a
    // VERIFY that names verifier2 as its signer: refused as a signature verifier2 did not make.
    const early = await signatureAlone(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', agg, 'LINE_CLEARANCE_VERIFIED');
    const ver2 = personaIn(sbx, 'verifier2');
    const notMine = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, verifier2, 'verifier2'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(ver2.personId, roles), step: 'p-disp-clear', context: [], signature: { id: early, meaning: 'LINE_CLEARANCE_VERIFIED', signer: ver2.personId } };
        return appendAs(tx, command, engineResult(tx, command), roles);
      }),
    );
    expect(notMine).toBe(`Signature ${early} was not made by ${ver2.personId} (DI-35, INV-10). [EBMR-EXE-052]`);
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.command_type === 'VERIFY' && r.accepted)).toEqual([]);
  }, 300_000);

  it('[INV-10][DI-35][INV-40] the signer\'s own signature made in the recording transaction is recorded whatever badge tap attributes the command: the rule reads the SIGNATURE use of the signature\'s own authentication', async () => {
    const d = await driver(dcMini(), ['operator1']);
    await startClearance(d);
    const op1 = personaIn(sbx, 'operator1');
    const run = await runContext(sbx.db.admin, d.runId);
    const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', `${d.runId}:${CLEAR}`, 'LINE_CLEARANCE_PERFORMED');
    // The command is attributed by a fresh badge tap of operator1 (another authentication event than the signature's).
    let signature = '';
    const outcome = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
        signature = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(op1.personId, roles), step: 'p-disp-clear', context: [], signature: { id: signature, meaning: 'LINE_CLEARANCE_PERFORMED', signer: op1.personId } };
        return appendAs(tx, command, engineResult(tx, command), roles);
      }),
    );
    expect(outcome).toBe('ok');
    const { rows } = await sbx.db.admin.query<{ row_event: string; sig_event: string; uses: string[] }>(
      `select c.auth_event_id::text as row_event, s.auth_event_id::text as sig_event,
              array(select u.use_kind from iam.auth_event_use u where u.auth_event_id = s.auth_event_id order by 1) as uses
         from recipe.execution_command c join esig.signature s on s.id = c.signature_ids[1]
        where c.batch_id = $1 and c.command_type = 'SIGN_PERFORMED' and c.accepted`,
      [d.runId],
    );
    // SETUP: the row carries the tap that attributed it; the signature's own event was used for the signature only.
    expect(rows.length).toBe(1);
    expect({ sameEvent: rows[0]?.row_event === rows[0]?.sig_event, uses: rows[0]?.uses }).toEqual({ sameEvent: false, uses: ['SIGNATURE'] });
    expect((await esig.signatureState(sbx.db.admin, signature)).status).toBe('VALID');
  }, 240_000);
});

describe('a decision is signed on a hold point that lists it (recipe-core 0296)', () => {
  it('[PR-45][DI-35][INV-10] in the batch\'s MBR content as stored, a phase that lists decisions is not a hold point, and a hold point without a list of decisions offers none: no meaning is accepted for either', async () => {
    const d = await driver(withEarlyHoldPoint(), ['operator1']);
    const run = await runContext(sbx.db.admin, d.runId);
    const state = (await execution.loadState(sbx.db.admin, d.runId))?.state;
    const content = JSON.parse(JSON.stringify(run.pkg.content)) as Json;
    // procedure -> sequence -> S-DISP -> its sequence -> O-DISP-PREP -> its sequence: the children of the preparation.
    const nodes = (c: Json): Json[] => {
      const stage = (((c['procedure'] as Json)['body'] as Json)['children'] as Json[])[0] as Json;
      const prep = ((stage['body'] as Json)['children'] as Json[])[0] as Json;
      return (prep['body'] as Json)['children'] as Json[];
    };
    // SETUP: the booth clearance and the hold point H-TEST open the dispensing preparation.
    expect(nodes(content).slice(0, 2).map((n) => `${String(n['kind'])}:${String(n['id'])}`)).toEqual(['phase:p-disp-clear', 'holdPoint:H-TEST']);
    const variant = (edit: (clear: Json, hold: Json) => void): Json => {
      const c = structuredClone(content);
      const [clear, hold] = nodes(c) as [Json, Json];
      edit(clear, hold);
      return c;
    };
    const cases: Record<string, [Json, string, string]> = {
      control: [content, 'H-TEST', 'APPROVED'],
      notListed: [content, 'H-TEST', 'RELEASED'],
      aPhaseThatListsDecisions: [variant((clear) => void (clear['dispositions'] = ['APPROVED'])), 'p-disp-clear', 'APPROVED'],
      aHoldPointWithoutItsList: [variant((_clear, hold) => void delete hold['dispositions']), 'H-TEST', 'APPROVED'],
    };
    // The stored content is replaced in a transaction that is rolled back (the database's import does not parse it).
    const got: Record<string, string[] | null> = {};
    const c = await sbx.db.admin.connect();
    try {
      for (const [k, [mbr, step, disposition]] of Object.entries(cases)) {
        await c.query('begin');
        try {
          await c.query('set local session_replication_role = replica');
          await c.query('update recipe.test_package set content = $1::jsonb where package_hash = $2', [JSON.stringify(mbr), run.pkg.packageHash]);
          const { rows } = await c.query<{ m: string[] | null }>('select recipe.step_signature_meanings($1, $2::jsonb, $3::jsonb) as m', [
            d.runId,
            JSON.stringify(engine.encodeState(state as engine.BatchState)),
            JSON.stringify({ type: 'DISPOSITION_HOLD_POINT', step, context: [], disposition }),
          ]);
          got[k] = rows[0]?.m ?? null;
        } finally {
          await c.query('rollback');
        }
      }
    } finally {
      c.release();
    }
    expect(got).toEqual({ control: ['HOLD_POINT_RELEASED'], notListed: [], aPhaseThatListsDecisions: [], aHoldPointWithoutItsList: [] });
  }, 240_000);
});

describe('a signed command type the release cannot check (recipe-core 0297)', () => {
  it('[DI-35][INV-10] a command type listed as signed by a later release, for which this release has no signature check, is refused (EBMR-EXE-050)', async () => {
    const d = await driver(dcMini(), ['supervisor1']);
    // ABORT_BATCH arrives with a later increment as a signed command type (A2); its row is added as a migration would
    // add it (the table is insert-only), before this release checks its signatures.
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await asSoftwareRelease(c, 'a later signed command type');
      await c.query("insert into recipe.execution_command_permission (command_type, permissions, signed) values ('ABORT_BATCH', array['STEP.SUPERVISE'], true)");
      await c.query('commit');
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
    const outcome = await record(d, 'supervisor1', (who, roles) => {
      const placeholder: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [] };
      const actor = (engine.encodeCommand(placeholder) as Json)['actor'] as engine.JsonValue;
      return { command: placeholder, forged: true, recorded: { type: 'ABORT_BATCH', commandId: placeholder.commandId, actor, reason: 'Test run abandoned' } };
    });
    expect(outcome).toBe('ABORT_BATCH is a signed act whose signature test runs cannot check in this release (DI-35). [EBMR-EXE-050]');
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.kind === 'COMMAND')).toEqual([]);
  }, 240_000);
});

describe('a verifier signs the check its step requires when the row is recorded (recipe-core 0297, P37)', () => {
  /** dc-mini with the SOP reading first (block G-03 1, which has no check meaning of its own), checked by a verifier with the MBR's VERIFIED. */
  const checkedSopFirst = (): flow.MbrContent =>
    dcMiniVariant((prep) => {
      const sop = prep.find((n) => n['id'] === 'p-disp-sop');
      if (!sop) throw new Error('SETUP: dc-mini has no p-disp-sop');
      const checked = { ...sop, signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } };
      return [checked, ...prep.filter((n) => n !== sop)];
    });

  /** Whether a backend of this test database waits for a lock on recipe.block_signature_meaning. */
  const waitsOnBlockMeanings = async (): Promise<boolean> => {
    const { rows } = await sbx.db.admin.query<{ n: number }>(
      `select count(*)::int as n from pg_locks l
        where l.database = (select oid from pg_database where datname = current_database())
          and l.relation = 'recipe.block_signature_meaning'::regclass and not l.granted`,
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  it('[DI-35][PR-14][PR-20][INV-10] a block check meaning a release commits while a VERIFY waits to read its step\'s meanings: the VERIFY signed with the check the step no longer requires is refused by the second check, which names the check now required (EBMR-EXE-051); nothing is recorded or signed', async () => {
    const SOP = 'p-disp-sop@';
    const d = await driver(checkedSopFirst(), ['operator1', 'verifier1']);
    await d.ok('operator1', { type: 'START_STEP', stepKey: SOP });
    await d.ok('operator1', { type: 'RECORD_ENTRY', stepKey: SOP, entry: { kind: 'ACKNOWLEDGE', mode: 'READ' } });
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: SOP });
    const agg = `${d.runId}:${SOP}`;
    const ver1 = personaIn(sbx, 'verifier1');
    const run = await runContext(sbx.db.admin, d.runId);
    // SETUP: G-03 1 has no check meaning of its own, so the step requires the MBR's VERIFIED.
    const { rows: own } = await sbx.db.admin.query<{ n: number }>("select count(*)::int as n from recipe.block_signature_meaning where block_type = 'G-03' and part = 'check'");
    expect(own[0]?.n).toBe(0);
    const p = await prepareSignature(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', agg, 'VERIFIED');
    const actor = await p.actor();

    // A release adds G-03 1's check CONTAINER_CHECKED as a migration adds it (the table is insert-only), holding the
    // table until verifier1's VERIFY, signed VERIFIED in the transaction that records it (the application role), waits
    // to read the step's meanings: recipe.check_signatures then reads the meanings the engine accepts on the step
    // before the release commits and the check the step requires after it.
    const release = await sbx.db.admin.connect();
    const verifying = { settled: false };
    let waited = false;
    let outcome: string;
    try {
      await release.query('begin');
      await asSoftwareRelease(release, 'a block check meaning added while a VERIFY is recorded');
      await release.query('lock table recipe.block_signature_meaning in access exclusive mode');
      await release.query("insert into recipe.block_signature_meaning (block_type, block_version, part, meaning_code) values ('G-03', '1', 'check', 'CONTAINER_CHECKED')");
      const verify = messageOf(
        withCommand(sbx.db.app, actor, async (c) => {
          const id = await p.sign(c);
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(ver1.personId, roles), step: 'p-disp-sop', context: [], signature: { id, meaning: 'VERIFIED', signer: ver1.personId } };
          return appendAs(tx, command, engineResult(tx, command), roles);
        }),
      ).then((m) => {
        verifying.settled = true;
        return m;
      });
      for (let i = 0; i < 1200 && !verifying.settled && !waited; i += 1) {
        waited = await waitsOnBlockMeanings();
        if (!waited) await new Promise((res) => setTimeout(res, 25));
      }
      await release.query('commit');
      outcome = await verify;
    } catch (e) {
      await release.query('rollback');
      throw e;
    } finally {
      release.release();
    }
    // SETUP: the VERIFY waited for the release's lock.
    expect(waited).toBe(true);
    expect(outcome).toBe(
      'Step p-disp-sop requires the check CONTAINER_CHECKED, not VERIFIED: a verifier signs the check the step requires (its re-verification, the MBR\'s witness, or its block\'s own check), never another in its place (DI-35, PR-14, PR-20). [EBMR-EXE-051]',
    );
    expect((await rowsOf(sbx, d.runId)).filter((r) => r.command_type === 'VERIFY')).toEqual([]);
    const { rows: signed } = await sbx.db.admin.query<{ n: number }>("select count(*)::int as n from esig.signature where aggregate_id = $1 and meaning_code = 'VERIFIED'", [agg]);
    expect(signed[0]?.n).toBe(0);
    expect((await execution.loadState(sbx.db.admin, d.runId))?.state.steps[SOP]?.status).toBe('AWAITING_VERIFICATION');
  }, 300_000);
});
