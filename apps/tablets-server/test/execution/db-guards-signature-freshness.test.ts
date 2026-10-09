/**
 * Review P24, follow-up (INV-10, DI-35; Part 11 signature/record linking): recipe.check_signatures (recipe-core 0270,
 * 0295) tied the signer's own signature to the command recording the act through the correlation id alone
 * (esig.signature.correlation_id = the actor's correlation id). The application chooses correlation ids and nothing
 * makes them unique (kernel.validate_actor_context, iam.command_log), so a valid signature made and committed in an
 * earlier transaction, and never applied, was accepted by a later command that reused that transaction's
 * correlation id. Recipe-core 0297 also requires the signature to have been made in the recording transaction: the
 * SIGNATURE use of its authentication event (iam.auth_event_use) carries this transaction's id.
 *
 * The database is the enforcement point (ADR 0012): the application role (ebmr_sandbox here) records the act inside
 * a correctly attributed command of the signer (fresh badge tap on the kiosk), through the store's own ExecutionTx,
 * with the engine's own result; only the correlation id is chosen to match the earlier signing.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { execution } from '@ebmr/recipe-core';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { actorOf, messageOf, prepareSignature } from './db-guards-support.ts';
import { dcMini, importAndIssue, personaIn, rowsOf, RunDriver, startExecServer, violations, writePackage, type ExecServer } from './support.ts';

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
const CHECK = 'LINE_CLEARANCE_VERIFIED';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

type CommandClient = Parameters<Parameters<typeof withCommand>[2]>[0];

describe('P24 follow-up: the signer\'s own signature is made in the transaction that records the act', () => {
  it('[INV-10][DI-35] a signature made in an earlier transaction is refused even when the recording command reuses that transaction\'s correlation id; signed in the recording transaction it is recorded', async () => {
    const issuer = await sbx.asPersona('issuer');
    const runId = await importAndIssue(sbx, issuer, writePackage(sbx, dcMini()));
    const browsers = { issuer, operator1: await sbx.asPersona('operator1'), verifier1: await sbx.asPersona('verifier1') };
    // verifier2 at the booth's kiosk (a step's data and signatures come from a terminal of its room, DI-20).
    const verifier2 = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
    const d = new RunDriver(sbx, runId, browsers);
    d.beforeTap = () => vi.advanceTimersByTime(7_000);
    await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
    for (const c of clearance) await d.ok('operator1', c);
    await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
    expect((await d.stepView('verifier1', CLEAR)).step.status).toBe('AWAITING_VERIFICATION');
    const agg = `${runId}:${CLEAR}`;
    const run = await runContext(sbx.db.admin, runId);
    const verify = (persona: string, id: string) => async (c: CommandClient) => {
      const who = personaIn(sbx, persona);
      const tx = await execution.ExecutionTx.open(c, run.def, runId);
      const roles = await engineRoles(c);
      return tx.command({ type: 'VERIFY', commandId: randomUUID(), actor: engineActor(who.personId, roles), step: 'p-disp-clear', context: [], signature: { id, meaning: CHECK, signer: who.personId } }, roles);
    };

    // T1, correlation id C: verifier1 signs the step's check (the meaning the step requires) and the transaction
    // commits without recording the act. The signature is valid, sealed and never used.
    const C = randomUUID();
    const p = await prepareSignature(sbx, d.browser('verifier1'), 'verifier1', 'batch_step', agg, CHECK);
    const early = await withCommand(sbx.db.app, await actorOf(sbx, d.browser('verifier1'), 'verifier1', { authEventId: p.authEventId, correlationId: C }), (c) => p.sign(c));
    const stored = await sbx.db.admin.query<{ correlation_id: string }>('select correlation_id::text from esig.signature where id = $1', [early]);
    expect(stored.rows[0]?.correlation_id, 'SETUP: the early signature carries correlation id C').toBe(C);
    const problem = await sbx.db.admin.query<{ p: string | null }>('select esig.signature_state_problem($1) as p', [early]);
    expect(problem.rows[0]?.p ?? null, 'SETUP: the early signature is still valid and bound to the record as it is now').toBeNull();

    // T2, a new command of verifier1 (fresh badge tap) that reuses correlation id C records the VERIFY with it.
    const late = await messageOf(withCommand(sbx.db.app, await actorOf(sbx, d.browser('verifier1'), 'verifier1', { correlationId: C }), verify('verifier1', early)));
    expect(late).toMatch(/Signature \S+ was made in another transaction.*\[EBMR-EXE-051\]/);
    const afterLate = (await rowsOf(sbx, runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted);
    expect(afterLate, 'no VERIFY was recorded with the earlier transaction\'s signature').toEqual([]);

    // The act signed in the transaction that records it is recorded (by verifier2: the kernel refuses verifier1 a
    // second LINE_CLEARANCE_VERIFIED signature while the early one is valid, EBMR-ESIG-042).
    const q = await prepareSignature(sbx, verifier2, 'verifier2', 'batch_step', agg, CHECK);
    const ok = await withCommand(sbx.db.app, await q.actor(), async (c) => verify('verifier2', await q.sign(c))(c));
    expect(ok.accepted).toBe(true);
    const verified = (await rowsOf(sbx, runId)).filter((x) => x.command_type === 'VERIFY' && x.accepted);
    expect(verified.map((x) => x.signature_ids.includes(early))).toEqual([false]);
    expect(await violations(sbx)).toEqual([]);
  }, 240_000);
});
