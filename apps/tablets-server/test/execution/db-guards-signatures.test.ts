/**
 * Review P24 (INV-10, DI-35, DI-37, Part 11 signature manifestation and linking) and P25 (PR-49, DI-37, DI-26,
 * INV-41, Annex 11 signature binding): recipe.check_signatures (recipe-core 0270) fails closed. An accepted command of
 * a signed type needs its e-signature, with a meaning its type allows AND the engine allows on that very step (the
 * step's block, its check meaning in the MBR, its re-verification state, a hold point's decisions), never used
 * before, bound to the record as it is now and made in this command; an accepted DISPOSITION_EXCEPTION carries the
 * proposal its signature covers, the state records it as signed, and no row changes an exception otherwise.
 *
 * The database is the enforcement point (ADR 0012): each case below is the application role (ebmr_sandbox here)
 * recording a signed act differently from what was signed, inside a correctly attributed command; the TypeScript
 * checks it would have to bypass are bypassed by calling the store directly, by signing through the kernel with
 * another meaning than the ceremony offers, or by rewriting the command on its way to the store.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, appendAs, codeOf, engineResult, interceptSigned, messageOf, nextState, prepareSignature, signatureAlone, unmatched } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, withEarlyHoldPoint, withWitnessedClearance, writePackage, type ExecServer } from './support.ts';

let sbx: ExecServer;
beforeAll(async () => {
  sbx = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await sbx?.close();
});

const CLEAR = 'p-disp-clear@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

async function driver(content = dcMini(), personas: string[] = ['operator1', 'verifier1', 'qa1']): Promise<RunDriver> {
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

async function performClearance(d: RunDriver): Promise<void> {
  await startClearance(d);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
}

async function signatureCount(runId: string, meaning?: string): Promise<number> {
  const { rows } = await sbx.db.admin.query<{ n: string }>(
    'select count(*)::text as n from esig.signature where aggregate_id like $1 and ($2::text is null or meaning_code = $2)',
    [`${runId}:%`, meaning ?? null],
  );
  return Number(rows[0]?.n);
}

/** The encoded command without one of its members. */
function without(command: engine.Command, member: string): engine.JsonValue {
  const encoded = { ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>) };
  delete encoded[member];
  return encoded;
}

/**
 * `persona` signs the step `stepKey` of the run through the kernel with `meaning` and, in the same command, records
 * `type` with that signature: the engine's result is the one of the same command signed `engineMeaning` (the meaning
 * the engine accepts there), so only the database's guard decides. Returns 'ok' or the refusal.
 */
async function signAndRecord(d: RunDriver, persona: string, type: 'SIGN_PERFORMED' | 'VERIFY', stepKey: string, meaning: string, engineMeaning = meaning): Promise<string> {
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, persona);
  const p = await prepareSignature(sbx, d.browser(persona), persona, 'batch_step', `${d.runId}:${stepKey}`, meaning);
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const base = { commandId: randomUUID(), actor: engineActor(who.personId, roles), step: stepKey.replace(/@.*$/, ''), context: [] };
      const signed = (m: string): engine.Command => ({ type, ...base, signature: { id, meaning: m, signer: who.personId } });
      return appendAs(tx, signed(meaning), engineResult(tx, signed(engineMeaning)), roles);
    }),
  );
}

describe('P24: a signed command type needs its own e-signature', () => {
  it('[INV-10][DI-35][Part 11 11.50/11.70] an accepted VERIFY without an e-signature is refused by the database', async () => {
    const d = await driver();
    await performClearance(d);
    const view = await d.stepView('verifier1', CLEAR);
    expect(view.step.status).toBe('AWAITING_VERIFICATION');

    const sigsBefore = await signatureCount(d.runId);
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'verifier1');
    // verifier1 (uninvolved, holds STEP.VERIFY) on the kiosk: a properly attributed command of the application role.
    const unsigned = withCommand(sbx.db.app, await actorOf(sbx, d.browser('verifier1'), 'verifier1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const commandId = randomUUID();
      // The engine's own result of this verification (it needs a SignatureRef; a placeholder is given) ...
      const signedCmd: engine.Command = { type: 'VERIFY', commandId, actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], signature: { id: randomUUID(), meaning: 'LINE_CLEARANCE_VERIFIED', signer: who.personId } };
      // ... recorded with a command that carries no signature at all.
      return appendAs(tx, signedCmd, engineResult(tx, signedCmd), roles, without(signedCmd, 'signature'));
    });
    const outcome = await codeOf(unsigned);

    const unsignedVerifications = (await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted && x.signature_ids.length === 0);
    expect(await signatureCount(d.runId), 'no e-signature was made for the verification').toBe(sigsBefore);
    expect(unsignedVerifications, 'the database stored an accepted VERIFY with no e-signature (signature_ids {})').toEqual([]);
    expect(outcome).toBe('EBMR-EXE-051');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[INV-10][DI-35] a signature already used by another row is refused, even for the same act by the same person', async () => {
    const d = await driver();
    await performClearance(d);
    const rows = await rowsOf(sbx, d.runId);
    const signedRow = rows.find((x) => x.command_type === 'SIGN_PERFORMED' && x.accepted);
    const used = signedRow?.signature_ids[0];
    if (!used) throw new Error('SETUP: no signed PERFORMED row');
    const { rows: sig } = await sbx.db.admin.query<{ meaning_code: string }>('select meaning_code from esig.signature where id = $1', [used]);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    // operator1, in a later command, records the same PERFORMED signature again (a forged next state: the engine
    // itself refuses a used signature, ENG-SIGNATURE-REUSED).
    const again = withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-disp-clear', context: [], signature: { id: used, meaning: sig[0]?.meaning_code ?? '', signer: me.personId } };
      return appendAs(tx, command, nextState(tx), roles);
    });
    const message = await messageOf(again);
    expect(message).toMatch(/already used by row.*\[EBMR-EXE-051\]/);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.signature_ids.includes(used))).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-45][DI-35][INV-10] a hold-point decision recorded with the signature of the other decision class is refused', async () => {
    const d = await driver(withEarlyHoldPoint());
    await performClearance(d);
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const before = await signatureCount(d.runId);
    // qa1 signs the release (HOLD_POINT_RELEASED); the application records the decision NOT_APPROVED with it.
    const r = await interceptSigned(
      'DISPOSITION_HOLD_POINT',
      async (tx, command, roles) => {
        if (command.type !== 'DISPOSITION_HOLD_POINT') throw new Error('SETUP: not a hold point');
        const flipped: engine.Command = { ...command, disposition: 'NOT_APPROVED' };
        const res = engineResult(tx, { ...flipped, signature: { ...command.signature, meaning: 'HOLD_POINT_NOT_RELEASED' } });
        await appendAs(tx, flipped, res, roles);
        return res;
      },
      () => d.sign('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TEST@', disposition: 'APPROVED' }),
    );
    expect(r.out.stage).toBe('sign');
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/signed HOLD_POINT_RELEASED.*\[EBMR-EXE-051\]/);
    expect(r.out.result.ok).toBe(false);
    expect(await signatureCount(d.runId)).toBe(before);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'DISPOSITION_HOLD_POINT' && x.accepted)).toEqual([]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-45][DI-35] a hold-point decision the hold point does not offer is refused, even signed with the meaning of its class', async () => {
    const d = await driver(withEarlyHoldPoint());
    await performClearance(d);
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    // qa1 signs the release; the application records RELEASED, a releasing decision H-TEST does not list.
    const r = await interceptSigned(
      'DISPOSITION_HOLD_POINT',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        await appendAs(tx, command, res, roles, { ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>), disposition: 'RELEASED' });
        return res;
      },
      () => d.sign('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TEST@', disposition: 'APPROVED' }),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/On step H-TEST the engine accepts DISPOSITION_HOLD_POINT signed with no meaning, not HOLD_POINT_RELEASED.*\[EBMR-EXE-051\]/);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'DISPOSITION_HOLD_POINT' && x.accepted)).toEqual([]);
    // The decision it offers, signed the same way, is recorded.
    expect((await d.sign('qa1', { type: 'DISPOSITION_HOLD_POINT', stepKey: 'H-TEST@', disposition: 'APPROVED' })).result.ok).toBe(true);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

describe('P24: the meaning is the one the engine allows on that step', () => {
  it('[DI-35][INV-10] SIGN_PERFORMED signed with another block\'s perform meaning, or with the generic PERFORMED on a block with its own, is refused; the step block\'s own meaning is recorded', async () => {
    const d = await driver();
    await startClearance(d);
    // The booth clearance is a G-10 step: LINE_CLEARANCE_PERFORMED only (engine 1.1.0, recipe-core 0296). IPC_PERFORMED
    // is G-13's; the generic PERFORMED would drop the line clearance the block's meaning attests.
    const other = await signAndRecord(d, 'operator1', 'SIGN_PERFORMED', CLEAR, 'IPC_PERFORMED', 'LINE_CLEARANCE_PERFORMED');
    const sample = await signAndRecord(d, 'operator1', 'SIGN_PERFORMED', CLEAR, 'SAMPLE_TAKEN', 'LINE_CLEARANCE_PERFORMED');
    const generic = await signAndRecord(d, 'operator1', 'SIGN_PERFORMED', CLEAR, 'PERFORMED', 'LINE_CLEARANCE_PERFORMED');
    const own = await signAndRecord(d, 'operator1', 'SIGN_PERFORMED', CLEAR, 'LINE_CLEARANCE_PERFORMED');
    expect(generic).toMatch(/On step p-disp-clear the engine accepts SIGN_PERFORMED signed LINE_CLEARANCE_PERFORMED, not PERFORMED.*\[EBMR-EXE-051\]/);
    expect(other).toMatch(/On step p-disp-clear the engine accepts SIGN_PERFORMED signed LINE_CLEARANCE_PERFORMED, not IPC_PERFORMED.*\[EBMR-EXE-051\]/);
    expect(sample).toMatch(/not SAMPLE_TAKEN.*\[EBMR-EXE-051\]/);
    expect(own).toBe('ok');
    const signed = (await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'SIGN_PERFORMED' && x.accepted);
    expect(signed).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-35][INV-10][PR-14] a VERIFIED signature on a step whose MBR asks for a witness is refused; WITNESSED is recorded', async () => {
    const d = await driver(withWitnessedClearance());
    await performClearance(d);
    // The engine accepts only WITNESSED here (and raises WITNESS_LATE past its window); VERIFIED would skip both.
    const verified = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'VERIFIED', 'WITNESSED');
    const lineVerified = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'LINE_CLEARANCE_VERIFIED', 'WITNESSED');
    const witnessed = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'WITNESSED');
    expect(verified).toMatch(/On step p-disp-clear the engine accepts VERIFY signed WITNESSED, not VERIFIED.*\[EBMR-EXE-051\]/);
    expect(lineVerified).toMatch(/signed WITNESSED, not LINE_CLEARANCE_VERIFIED.*\[EBMR-EXE-051\]/);
    expect(witnessed).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-24][DI-35][PR-14][PR-20] a verification of a block step is signed with the block\'s own check only: RE_VERIFIED_AFTER_CORRECTION with no re-verification due, the generic VERIFIED, WITNESSED and another block\'s check are refused', async () => {
    const d = await driver();
    await performClearance(d);
    const reverified = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'RE_VERIFIED_AFTER_CORRECTION', 'LINE_CLEARANCE_VERIFIED');
    const generic = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'VERIFIED', 'LINE_CLEARANCE_VERIFIED');
    const witnessed = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'WITNESSED', 'LINE_CLEARANCE_VERIFIED');
    const other = await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'IPC_VERIFIED', 'LINE_CLEARANCE_VERIFIED');
    expect(generic).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not VERIFIED.*\[EBMR-EXE-051\]/);
    expect(witnessed).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not WITNESSED.*\[EBMR-EXE-051\]/);
    expect(reverified).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not RE_VERIFIED_AFTER_CORRECTION.*\[EBMR-EXE-051\]/);
    expect(other).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not IPC_VERIFIED.*\[EBMR-EXE-051\]/);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted)).toEqual([]);
    expect(await signAndRecord(d, 'verifier1', 'VERIFY', CLEAR, 'LINE_CLEARANCE_VERIFIED')).toBe('ok');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-35][INV-10] a signature for a step the batch\'s MBR does not hold accepts no meaning', async () => {
    const d = await driver();
    await startClearance(d);
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    const p = await prepareSignature(sbx, d.browser('operator1'), 'operator1', 'batch_step', `${d.runId}:${CLEAR}`, 'LINE_CLEARANCE_PERFORMED');
    // The application relabels the command as a step of another MBR (its aggregate is then another, so the
    // signature could not be valid there either: the database refuses it before it looks the signature up).
    const message = await messageOf(
      withCommand(sbx.db.app, await p.actor(), async (c) => {
        const id = await p.sign(c);
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'SIGN_PERFORMED', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning: 'LINE_CLEARANCE_PERFORMED', signer: me.personId } };
        return appendAs(tx, command, engineResult(tx, command), roles, { ...(engine.encodeCommand(command) as Record<string, engine.JsonValue>), step: 'p-not-in-this-mbr' });
      }),
    );
    expect(message).toMatch(/On step p-not-in-this-mbr the engine accepts SIGN_PERFORMED signed with no meaning, not LINE_CLEARANCE_PERFORMED.*\[EBMR-EXE-051\]/);
  }, 240_000);
});

describe('P24: the signature was made for this act, in this command', () => {
  it('[INV-10][DI-35] a signature made in an earlier command (never used, still valid) is refused; signed in the recording command it is recorded', async () => {
    const d = await driver();
    // verifier2 at the booth's kiosk (a step's data and signatures come from a terminal of its room, DI-20).
    const verifier2 = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
    await performClearance(d);
    const agg = `${d.runId}:${CLEAR}`;
    // The step's own check (the engine accepts no other meaning here, engine 1.1.0).
    const early = await signatureAlone(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', agg, 'LINE_CLEARANCE_VERIFIED');
    const run = await runContext(sbx.db.admin, d.runId);
    const verify = (persona: string, id: string) => async (c: Parameters<Parameters<typeof withCommand>[2]>[0]) => {
      const who = personaIn(sbx, persona);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      return tx.command({ type: 'VERIFY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning: 'LINE_CLEARANCE_VERIFIED', signer: who.personId } }, roles);
    };
    const late = await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('verifier1'), 'verifier1'), verify('verifier1', early)));
    expect(late).toMatch(/Signature \S+ was made in another command; a signed act is recorded by the command that signed it.*\[EBMR-EXE-051\]/);
    expect(await signatureCount(d.runId, 'LINE_CLEARANCE_VERIFIED')).toBe(1);
    // The act signed in the command that records it is recorded (by verifier2: the kernel refuses verifier1 a second
    // LINE_CLEARANCE_VERIFIED signature while the early one is valid, EBMR-ESIG-042).
    const p = await prepareSignature(sbx, verifier2, 'verifier2', 'batch_step', agg, 'LINE_CLEARANCE_VERIFIED');
    const ok = await withCommand(sbx.db.app, await p.actor(), async (c) => verify('verifier2', await p.sign(c))(c));
    expect(ok.accepted).toBe(true);
    const verified = (await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted);
    expect(verified.map((x) => x.signature_ids.includes(early))).toEqual([false]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-37][INV-10] a signature applied while the record was in another state is refused', async () => {
    const d = await driver();
    const verifier2 = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
    await performClearance(d);
    // verifier2 signs the step's check (LINE_CLEARANCE_VERIFIED) while the step awaits verification; it is not applied.
    const early = await signatureAlone(sbx, verifier2, 'verifier2', 'batch_step', `${d.runId}:${CLEAR}`, 'LINE_CLEARANCE_VERIFIED');
    // The step is then verified by verifier1 through the ceremony: COMPLETED, its content unchanged.
    await d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });
    const run = await runContext(sbx.db.admin, d.runId);
    const who = personaIn(sbx, 'verifier2');
    // The application records a second verification with verifier2's early signature (a forged next state).
    const message = await messageOf(
      withCommand(sbx.db.app, await actorOf(sbx, verifier2, 'verifier2'), async (c) => {
        const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
        const roles = await engineRoles(c);
        const command: engine.Command = { type: 'VERIFY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], signature: { id: early, meaning: 'LINE_CLEARANCE_VERIFIED', signer: who.personId } };
        return appendAs(tx, command, nextState(tx), roles);
      }),
    );
    expect(message).toMatch(/Signature \S+ is not bound to the record as it is now: .*\[EBMR-EXE-051\]/);
    expect((await rowsOf(sbx, d.runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted)).toHaveLength(1);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

describe('P25: an accepted DISPOSITION_EXCEPTION is bound to the proposal its signature covers', () => {
  const SIGNED = 'Reprint reconciled; no impact on the batch.';
  const TAMPERED = 'Investigated; root cause operator error.';

  async function withException(): Promise<{ d: RunDriver; exception: string }> {
    const d = await driver(dcMini(), ['operator1', 'qa1']);
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Label printer jammed once; label reprinted', severity: 'ALERT' });
    const exception = (await d.runView('qa1')).exceptions[0]?.exceptionId;
    if (!exception) throw new Error('no exception');
    return { d, exception };
  }

  /** What was recorded: the exception's status and justification, and its EXCEPTION_DISPOSITIONED signatures. */
  async function recorded(d: RunDriver, exception: string) {
    const st = await execution.loadState(sbx.db.admin, d.runId);
    const x = st?.state.exceptions[exception];
    const { rows } = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from esig.signature where aggregate_id = $1 and meaning_code = 'EXCEPTION_DISPOSITIONED'", [`${d.runId}:${exception}`]);
    return { status: x?.status, justification: x?.disposition?.justification ?? null, signatures: Number(rows[0]?.n) };
  }

  const sign = (d: RunDriver, exception: string) => () => d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED });

  it('[PR-49][DI-37][INV-10][Part 11 11.70] a disposition whose justification differs from the signed proposal is refused by the database', async () => {
    const { d, exception } = await withException();
    const r = await interceptSigned(
      'DISPOSITION_EXCEPTION',
      async (tx, command, roles) => {
        if (command.type !== 'DISPOSITION_EXCEPTION') throw new Error('SETUP: not a disposition');
        const tampered: engine.Command = { ...command, justification: TAMPERED };
        const res = engineResult(tx, tampered);
        await appendAs(tx, tampered, res, roles);
        return res;
      },
      sign(d, exception),
    );
    expect(r.out.stage).toBe('sign');
    expect(r.calls).toBe(1);
    // What the signature covers: the proposal on the exception's current content version.
    const agg = `${d.runId}:${exception}`;
    const { rows } = await sbx.db.admin.query<{ p: { outcome: string; justification: string } | null }>(
      'select recipe.current_proposal($1::text, (select max(content_version) from recipe.execution_exception_content where aggregate_id = $1::text)) as p',
      [agg],
    );
    expect(rows[0]?.p).toMatchObject({ outcome: 'NO_IMPACT', justification: SIGNED });
    expect(String(r.error)).toMatch(/\[EBMR-EXE-086\]/);
    // The whole sign command rolled back: no signature, the exception stays OPEN.
    expect({ signOk: r.out.result.ok, ...(await recorded(d, exception)) }).toEqual({ signOk: false, status: 'OPEN', justification: null, signatures: 0 });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-49][DI-37][INV-10] a proposal replaced after the signature was applied is not what the signature covers: refused', async () => {
    // A companion guard of P25 (it held before 0270): the proposal is part of the signed content, so a new
    // proposal after signing would make the signature's content hash stale. The kernel refused the signature
    // (EBMR-ESIG-070); since recipe-core 0309 (Phase 2 exit review F37) the database refuses the new proposal itself,
    // on the content version the disposition was signed on.
    const { d, exception } = await withException();
    // Inside the sign command, after esig.sign: a new proposal (so the command matches the "current" proposal).
    const r = await interceptSigned(
      'DISPOSITION_EXCEPTION',
      async (tx, command, roles) => {
        await execution.proposeDisposition(tx.client, tx.locked.batch.id, exception, { outcome: 'NO_IMPACT', justification: TAMPERED, deviationRef: null });
        if (command.type !== 'DISPOSITION_EXCEPTION') throw new Error('SETUP: not a disposition');
        const tampered: engine.Command = { ...command, justification: TAMPERED };
        const res = engineResult(tx, tampered);
        await appendAs(tx, tampered, res, roles);
        return res;
      },
      sign(d, exception),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/A disposition of exception EX-\d+ is already signed on content version 1; no other is proposed on it \(INV-09, DI-37\)\. \[EBMR-EXE-084\]/);
    expect({ signOk: r.out.result.ok, ...(await recorded(d, exception)) }).toEqual({ signOk: false, status: 'OPEN', justification: null, signatures: 0 });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[PR-49][DI-37][INV-10] a state that records another justification than the signed command is refused', async () => {
    const { d, exception } = await withException();
    const r = await interceptSigned(
      'DISPOSITION_EXCEPTION',
      async (tx, command, roles) => {
        const res = engineResult(tx, command);
        const x = res.state.exceptions[exception];
        if (!x?.disposition) throw new Error('SETUP: the engine recorded no disposition');
        x.disposition = { ...x.disposition, justification: TAMPERED };
        await appendAs(tx, command, res, roles);
        return res;
      },
      sign(d, exception),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/records another disposition .*\[EBMR-EXE-086\]/);
    expect({ signOk: r.out.result.ok, ...(await recorded(d, exception)) }).toEqual({ signOk: false, status: 'OPEN', justification: null, signatures: 0 });
    // The honest signing of the same disposition then goes through.
    const ok = await d.sign('qa1', { type: 'DISPOSITION_EXCEPTION', exception, outcome: 'NO_IMPACT', justification: SIGNED });
    expect(ok.result.ok).toBe(true);
    expect(await recorded(d, exception)).toEqual({ status: 'DISPOSITIONED', justification: SIGNED, signatures: 1 });
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);

  it('[DI-26][INV-41][PR-49] the disposition row may not also change the exception as raised, link a deviation to it or close another exception', async () => {
    const { d, exception } = await withException();
    await d.ok('operator1', { type: 'RAISE_EXCEPTION', stepKey: undefined, description: 'Second label printer jam', severity: 'ALERT' });
    const second = (await d.runView('qa1')).exceptions.map((e) => e.exceptionId).find((e) => e !== exception);
    if (!second) throw new Error('SETUP: no second exception');
    const qa1 = personaIn(sbx, 'qa1').personId;
    const forge = async (edit: (s: engine.BatchState, x: engine.ExceptionRecord) => void) => {
      const r = await interceptSigned(
        'DISPOSITION_EXCEPTION',
        async (tx, command, roles) => {
          const res = engineResult(tx, command);
          const x = res.state.exceptions[exception];
          if (!x?.disposition) throw new Error('SETUP: the engine recorded no disposition');
          edit(res.state, x);
          await appendAs(tx, command, res, roles);
          return res;
        },
        sign(d, exception),
      );
      expect(r.calls).toBe(1);
      return String(r.error);
    };
    const outcomes = {
      relaxed: await forge((_s, x) => {
        x.releaseBlocking = !x.releaseBlocking;
      }),
      linked: await forge((_s, x) => {
        x.deviation = { ref: 'TEST-DEV-0009', linkedBy: qa1, at: x.raisedAt };
      }),
      otherClosed: await forge((s, x) => {
        const o = s.exceptions[second];
        if (!o || !x.disposition) throw new Error('SETUP');
        o.status = 'DISPOSITIONED';
        o.disposition = { ...x.disposition };
      }),
    };
    expect(
      unmatched(outcomes, {
        relaxed: /changes exception \S+ as it was raised.*\[EBMR-EXE-044\]/,
        linked: /changes the deviation link of exception \S+.*\[EBMR-EXE-044\]/,
        otherClosed: new RegExp(`changes the status or disposition of exception ${second} without its own signed disposition.*\\[EBMR-EXE-044\\]`),
      }),
    ).toEqual({});
    expect({ ...(await recorded(d, exception)) }).toEqual({ status: 'OPEN', justification: null, signatures: 0 });
    expect(await recorded(d, second)).toEqual({ status: 'OPEN', justification: null, signatures: 0 });
    // The honest disposition leaves the other exception open.
    expect((await sign(d, exception)()).result.ok).toBe(true);
    expect([(await recorded(d, exception)).status, (await recorded(d, second)).status]).toEqual(['DISPOSITIONED', 'OPEN']);
    expect(await violations(sbx)).toEqual([]);
  }, 300_000);

  it('[PR-49][INV-41][DI-37] a command other than the exception\'s own signed disposition that closes it is refused', async () => {
    const { d, exception } = await withException();
    const run = await runContext(sbx.db.admin, d.runId);
    const me = personaIn(sbx, 'operator1');
    const start = async (forge: boolean) =>
      messageOf(
        withCommand(sbx.db.app, await actorOf(sbx, d.browser('operator1'), 'operator1'), async (c) => {
          const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
          const roles = await engineRoles(c);
          const command: engine.Command = { type: 'START_STEP', commandId: randomUUID(), actor: engineActor(me.personId, roles), step: 'p-disp-clear', context: [] };
          const res = engineResult(tx, command);
          const x = res.state.exceptions[exception];
          if (forge && x) {
            // The state closes the exception on the way, without its signed disposition.
            x.status = 'DISPOSITIONED';
            x.disposition = { by: me.personId, outcome: 'NO_IMPACT', justification: 'Closed on the way', signature: randomUUID(), at: x.raisedAt };
          }
          return appendAs(tx, command, res, roles);
        }),
      );
    expect(await start(true)).toMatch(new RegExp(`changes the status or disposition of exception ${exception} without its own signed disposition.*\\[EBMR-EXE-044\\]`));
    expect(await start(false)).toBe('ok');
    expect((await recorded(d, exception)).status).toBe('OPEN');
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});

