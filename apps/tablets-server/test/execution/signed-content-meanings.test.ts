/**
 * The meaning a verifier signs is the check the step requires (module C3; DI-35, PR-14, PR-20, DI-37; review
 * finding P37). A VERIFY intent names VERIFIED or WITNESSED, but the server takes the meaning from the step (the
 * MBR's WITNESSED, a re-verification, the block's own check meaning such as LINE_CLEARANCE_VERIFIED or
 * CONTAINER_CHECKED, else VERIFIED), never from the request: a verifier who asks to sign WITNESSED on a step whose
 * block requires another check is refused at the challenge (ESIG_ACTION_MISMATCH, the meaning the action needs is
 * not the one asked for), nothing is signed and the step still waits for its own check. The screen, the challenge
 * and the command name the same meaning. The database is the enforcement point (ADR 0012; recipe-core 0295): an
 * accepted VERIFY recorded with another meaning than the check the step requires (a witness, or a generic
 * verification in place of the block's own check) is refused whatever the server does, and the meaning the
 * database requires is the one the engine asks for on every step (recipe.step_check_meanings, checkMeaning). Engine
 * 1.1.0 and recipe-core 0296 make every step signature exact: the database accepts on each step exactly the meanings
 * the engine accepts there (recipe.step_signature_meanings; engine performMeanings and checkMeanings), so a generic
 * PERFORMED on a block with its own perform meaning is refused too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { engine, execution } from '@ebmr/recipe-core';
import { signedCommand, signedMeaning } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { appendAs, engineResult } from './db-guards-support.ts';
import { dcMini, importAndIssue, outcomeOf, RunDriver, startExecServer, valueOf, violations, withWitnessedClearance, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

const CLEAR = 'p-disp-clear@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

async function performed(content = dcMini()): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok('operator1', c);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  return d;
}

async function checkSignatures(d: RunDriver): Promise<string[]> {
  const st = await execution.loadState(server.db.admin, d.runId);
  return (st?.state.steps[CLEAR]?.signatures ?? []).filter((s) => s.role === 'CHECKED').map((s) => s.meaning);
}

describe('the check meaning a verifier signs (P37)', () => {
  it('[DI-35][PR-14][PR-20][DI-37] P37: a WITNESSED signature asked for on a step whose block requires LINE_CLEARANCE_VERIFIED is refused; nothing is signed', async () => {
    const d = await performed();
    // The screen offers VERIFY with the block's meaning, and no WITNESS action.
    const view = await d.stepView('verifier1', CLEAR);
    expect(view.actions.filter((a) => a.action === 'VERIFY' || a.action === 'WITNESS').map((a) => `${a.action}:${a.meaning}`)).toEqual(['VERIFY:LINE_CLEARANCE_VERIFIED']);
    // The meaning the server requires for a VERIFY intent is the step's, also when the intent asks for WITNESSED.
    const run = await runContext(server.db.admin, d.runId);
    const state = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' })).toBe('LINE_CLEARANCE_VERIFIED');
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).toBe('LINE_CLEARANCE_VERIFIED');
    // The ceremony: a WITNESSED challenge does not match the action's meaning.
    const r = await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' });
    expect({ stage: r.stage, outcome: outcomeOf(r.result), checks: await checkSignatures(d) }).toEqual({ stage: 'challenge', outcome: '422:ESIG_ACTION_MISMATCH', checks: [] });
    expect((await execution.loadState(server.db.admin, d.runId))?.state.steps[CLEAR]?.status).toBe('AWAITING_VERIFICATION');
    // The step's own check is signed as offered.
    const signed = valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result);
    expect(signed.manifestation.meaning).toBe('LINE_CLEARANCE_VERIFIED');
    expect(await checkSignatures(d)).toEqual(['LINE_CLEARANCE_VERIFIED']);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-35][PR-14] a step the MBR declares witnessed is signed WITNESSED, also when the intent names VERIFIED', async () => {
    const d = await performed(withWitnessedClearance());
    const run = await runContext(server.db.admin, d.runId);
    const state = (await execution.loadState(server.db.admin, d.runId))?.state;
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).toBe('WITNESSED');
    expect(signedMeaning(run.def, state, { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' })).toBe('WITNESSED');
  }, 240_000);
});

/**
 * The review's bypass (P37): a server path that lets the challenge and the dry run through with the step's own
 * meaning, then records the VERIFY with a signature of `meaning` (sealed by the kernel for that meaning) as the
 * application role through the execution store, with the engine's result of the same verification signed with the
 * step's own meaning (the engine refuses any other meaning since 1.1.0), so only the database decides. Returns what
 * the database answered and what the step holds.
 */
async function recordVerifyAs(d: RunDriver, meaning: string): Promise<{ stage: string; ok: boolean; refused: string; status: string | undefined; checks: string[] }> {
  const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
  if (!handler) throw new Error('ENGINE_COMMAND is not registered');
  const saved = { describe: handler.describe.bind(handler), prepareForChallenge: handler.prepareForChallenge.bind(handler), dryRun: handler.dryRun.bind(handler), apply: handler.apply.bind(handler) };
  const own = <T extends object>(ctx: T): T => ({ ...ctx, meaning: 'LINE_CLEARANCE_VERIFIED' });
  let refused = '';
  Object.assign(handler, {
    describe: (a: Parameters<typeof saved.describe>[0]) => ({ ...saved.describe(a), meaning: '' }),
    prepareForChallenge: (client: Parameters<typeof saved.prepareForChallenge>[0], ctx: Parameters<typeof saved.prepareForChallenge>[1], a: Parameters<typeof saved.prepareForChallenge>[2]) => saved.prepareForChallenge(client, own(ctx), a),
    dryRun: (client: Parameters<typeof saved.dryRun>[0], ctx: Parameters<typeof saved.dryRun>[1], a: Parameters<typeof saved.dryRun>[2]) => saved.dryRun(client, own(ctx), a),
    apply: async (client: Parameters<typeof saved.apply>[0], ctx: Parameters<typeof saved.apply>[1], a: Parameters<typeof saved.apply>[2], sig: Parameters<typeof saved.apply>[3]) => {
      if (a.kind !== 'ENGINE_COMMAND') throw new Error('SETUP: not an engine command');
      const run = await runContext(client, a.runId);
      const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
      const roles = await engineRoles(client);
      const cmd = signedCommand(tx.state, { type: 'VERIFY', stepKey: CLEAR, meaning: 'WITNESSED' }, engineActor(ctx.actor.personId, roles), { id: sig.signatureId, meaning: sig.meaning, signer: sig.signer }, `ESIG:${sig.signatureId}`, a.expectedVersion);
      if (cmd.type !== 'VERIFY') throw new Error('SETUP: not a VERIFY');
      try {
        await appendAs(tx, cmd, engineResult(tx, { ...cmd, signature: { ...cmd.signature, meaning: 'LINE_CLEARANCE_VERIFIED' } }), roles);
      } catch (e) {
        refused = e instanceof Error ? e.message : String(e);
        throw e;
      }
      return null;
    },
  });
  let r;
  try {
    r = await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: meaning === 'WITNESSED' ? 'WITNESSED' : 'VERIFIED' }, { meaning });
  } finally {
    Object.assign(handler, saved);
  }
  const st = (await execution.loadState(server.db.admin, d.runId))?.state.steps[CLEAR];
  return { stage: r.stage, ok: r.result.ok, refused, status: st?.status, checks: (st?.signatures ?? []).filter((s) => s.role === 'CHECKED').map((s) => s.meaning) };
}

describe('the database requires the check the step requires (P37; ADR 0012)', () => {
  it('[DI-35][PR-14][PR-20][INV-10] P37: a verification recorded as WITNESSED, or as a generic VERIFIED, on a step whose block requires LINE_CLEARANCE_VERIFIED is refused by the database; nothing is signed', async () => {
    const d = await performed();
    const witnessed = await recordVerifyAs(d, 'WITNESSED');
    expect(witnessed.refused).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not WITNESSED.*\[EBMR-EXE-051\]/);
    expect({ stage: witnessed.stage, ok: witnessed.ok, status: witnessed.status, checks: witnessed.checks }).toEqual({ stage: 'sign', ok: false, status: 'AWAITING_VERIFICATION', checks: [] });
    const verified = await recordVerifyAs(d, 'VERIFIED');
    expect(verified.refused).toMatch(/On step p-disp-clear the engine accepts VERIFY signed LINE_CLEARANCE_VERIFIED, not VERIFIED.*\[EBMR-EXE-051\]/);
    expect({ stage: verified.stage, ok: verified.ok, status: verified.status, checks: verified.checks }).toEqual({ stage: 'sign', ok: false, status: 'AWAITING_VERIFICATION', checks: [] });
    const { rows } = await server.db.admin.query('select 1 from esig.signature where aggregate_id = $1 and meaning_code in ($2, $3)', [`${d.runId}:${CLEAR}`, 'WITNESSED', 'VERIFIED']);
    expect(rows).toHaveLength(0);
    // The step's own check, signed as offered, is recorded.
    valueOf((await d.sign('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' })).result);
    expect(await checkSignatures(d)).toEqual(['LINE_CLEARANCE_VERIFIED']);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-35][PR-14] the meaning the database requires is the one the engine asks for, on every phase of the MBR: the block\'s own check, the MBR\'s witness, a re-verification', async () => {
    for (const content of [dcMini(), withWitnessedClearance()]) {
      const d = await performed(content);
      const run = await runContext(server.db.admin, d.runId);
      const { rows } = await server.db.admin.query<{ state: Record<string, unknown> }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
      const state = rows[0]?.state ?? {};
      const stored = (await execution.loadState(server.db.admin, d.runId))?.state;
      const inDb = async (prior: Record<string, unknown>, step: string): Promise<string[]> =>
        (await server.db.admin.query<{ m: string[] }>('select recipe.step_check_meanings($1, $2::jsonb, $3::jsonb) as m', [d.runId, JSON.stringify(prior), JSON.stringify({ type: 'VERIFY', step, context: [] })])).rows[0]?.m ?? [];
      const phases = [...run.def.steps.values()].filter((s) => s.node.kind === 'phase');
      expect(phases.length).toBeGreaterThan(3);
      for (const s of phases) {
        const inst = stored?.steps[engine.stepKey(s.id, [])];
        expect(await inDb(state, s.id), s.id).toEqual([engine.checkMeaning(run.def, inst, s.id, stored)]);
      }
      // The clearance awaiting re-verification (after a correction) is re-verified, in both.
      const steps = state['steps'] as Record<string, Record<string, unknown>>;
      const reverifying = { ...state, steps: { ...steps, [CLEAR]: { ...steps[CLEAR], reverification: true } } };
      const inst = stored?.steps[CLEAR];
      expect(await inDb(reverifying, 'p-disp-clear')).toEqual([engine.checkMeaning(run.def, inst ? { ...inst, reverification: true } : undefined, 'p-disp-clear', stored)]);
      expect(await inDb(reverifying, 'p-disp-clear')).toEqual(['RE_VERIFIED_AFTER_CORRECTION']);
      // A step the MBR does not hold requires no meaning the database would accept.
      expect(await inDb(state, 'p-not-in-this-mbr')).toEqual([]);
    }
  }, 240_000);

  it('[DI-35][INV-10][PR-14][PR-20] engine 1.1.0 and recipe-core 0296: on every phase the database accepts exactly the step signature meanings the engine accepts, PERFORMED only on a block without its own perform meaning', async () => {
    for (const content of [dcMini(), withWitnessedClearance()]) {
      const d = await performed(content);
      const run = await runContext(server.db.admin, d.runId);
      const { rows } = await server.db.admin.query<{ state: Record<string, unknown> }>('select state from recipe.execution_state where batch_id = $1', [d.runId]);
      const state = rows[0]?.state ?? {};
      const stored = (await execution.loadState(server.db.admin, d.runId))?.state;
      const inDb = async (prior: Record<string, unknown>, type: 'SIGN_PERFORMED' | 'VERIFY', step: string): Promise<string[]> =>
        (await server.db.admin.query<{ m: string[] }>('select recipe.step_signature_meanings($1, $2::jsonb, $3::jsonb) as m', [d.runId, JSON.stringify(prior), JSON.stringify({ type, step, context: [] })])).rows[0]?.m ?? [];
      const sorted = (xs: readonly string[]): string[] => [...xs].sort();
      const phases = [...run.def.steps.values()].filter((s) => s.node.kind === 'phase');
      expect(phases.length).toBeGreaterThan(3);
      const blockPerform = phases.filter((s) => (s.block?.handler?.meanings?.perform ?? []).length > 0);
      expect(blockPerform.map((s) => s.id), 'the MBR has a block with its own perform meaning').toContain('p-disp-clear');
      for (const s of phases) {
        const inst = stored?.steps[engine.stepKey(s.id, [])];
        expect(await inDb(state, 'SIGN_PERFORMED', s.id), `${s.id} SIGN_PERFORMED`).toEqual(sorted(engine.performMeanings(s)));
        expect(await inDb(state, 'VERIFY', s.id), `${s.id} VERIFY`).toEqual(sorted(engine.checkMeanings(s, inst, engine.handEntriesWithoutDeclaredEvidence(run.def, stored, inst))));
      }
      // The generic PERFORMED only where the block has no perform meaning of its own.
      expect(await inDb(state, 'SIGN_PERFORMED', 'p-disp-clear')).toEqual(['LINE_CLEARANCE_PERFORMED']);
      // Awaiting re-verification: RE_VERIFIED_AFTER_CORRECTION alone, in both.
      const steps = state['steps'] as Record<string, Record<string, unknown>>;
      const reverifying = { ...state, steps: { ...steps, [CLEAR]: { ...steps[CLEAR], reverification: true } } };
      const inst = stored?.steps[CLEAR];
      const clear = run.def.steps.get('p-disp-clear');
      expect(await inDb(reverifying, 'VERIFY', 'p-disp-clear')).toEqual([...engine.checkMeanings(clear, inst ? { ...inst, reverification: true } : undefined, engine.handEntriesWithoutDeclaredEvidence(run.def, stored, inst))]);
      expect(await inDb(reverifying, 'VERIFY', 'p-disp-clear')).toEqual(['RE_VERIFIED_AFTER_CORRECTION']);
      // A step the MBR does not hold accepts no meaning.
      expect(await inDb(state, 'SIGN_PERFORMED', 'p-not-in-this-mbr')).toEqual([]);
      expect(await inDb(state, 'VERIFY', 'p-not-in-this-mbr')).toEqual([]);
    }
  }, 240_000);
});
