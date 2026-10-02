/**
 * The hold-point decision a QA reviewer signs is part of the signed content and is recorded exactly as signed
 * (module C3; PR-45, DI-35, DI-37; Part 11 signature/record linking; review findings P26, P38; recipe-core 0295).
 *
 * Two decisions of the same class share the signature meaning (APPROVED and APPROVED_WITH_CONDITIONS are both
 * HOLD_POINT_RELEASED; two rejections with different reasons are both HOLD_POINT_NOT_RELEASED). So the decision
 * (disposition and comment) is recorded when the challenge is prepared and the hold point's content carries it
 * (`proposedDecision`): the preview shows and hashes it, the challenge and the signature bind it. A sign request that
 * carries another decision is refused by the server (EBMR-EXE-086) and, if a server path records another decision
 * anyway, by the database (recipe.check_signatures and recipe.check_hold_point_changes, ADR 0012): nothing is signed
 * and the hold point stays undecided. The binding lives in the database, not in a server's memory. The content carries
 * the decision once one is proposed (recipe-core 0302): a hold point nobody has proposed a decision for keeps the
 * content it had before 0295, so the hold-point signatures made before 0295 stay valid (INV-09).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import { esig } from '@ebmr/kernel';
import { engine, execution, lifecycle, type flow } from '@ebmr/recipe-core';
import { engineCommandHandler, NO_DECISION_NOTE } from '../../src/features/execution/signable.ts';
import { signedCommand } from '../../src/features/execution/intents.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { appendAs, engineResult, interceptSigned, signatureAlone } from './db-guards-support.ts';
import { challengeDecision, previewDecision, signChallenge, signDecision, signedDecision, type HoldDecision } from './signed-content-support.ts';
import { dcMiniVariant, importAndIssue, outcomeOf, refusalOf, rowsOf, RunDriver, startExecServer, valueOf, violations, withEarlyHoldPoint, writePackage, type ExecServer } from './support.ts';

let server: ExecServer;
beforeAll(async () => {
  server = await startExecServer();
  vi.useFakeTimers({ toFake: ['performance'] });
}, 180_000);
afterAll(async () => {
  vi.useRealTimers();
  await server?.close();
});

type Json = Record<string, unknown>;

const CLEAR = 'p-disp-clear@';
const HOLD = 'H-TEST@';
const clearance = [
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'CLEARANCE_CHECK' as const, answers: ['NO_PREVIOUS_MATERIAL', 'NO_PREVIOUS_DOCUMENTS', 'EQUIPMENT_CLEAN_LABEL'].map((id) => ({ id, answer: 'CONFIRMED' as const })) } },
  { type: 'RECORD_ENTRY' as const, stepKey: CLEAR, entry: { kind: 'PREVIOUS_BATCH' as const, product: 'TEST-PRODUCT-X', batchNumber: 'TEST-B26-9999' } },
];

/** A QA hold point right after the booth clearance with two releasing decisions (one conditional) and a rejection. */
const withConditionalRelease = (): flow.MbrContent =>
  dcMiniVariant(([clear, ...rest]) => [
    clear as Json,
    { kind: 'holdPoint', id: 'H-TEST', name: 'QA release of the dispensing booth', role: 'QA', dispositions: ['APPROVED', 'APPROVED_WITH_CONDITIONS', 'NOT_APPROVED'] },
    ...rest,
  ]);

const verifyClearance = (d: RunDriver): Promise<unknown> => d.signed('verifier1', { type: 'VERIFY', stepKey: CLEAR, meaning: 'VERIFIED' });

/** A run whose clearance is performed and verified (by `verify`), so the hold point is ENABLED for QA. */
async function atHoldPoint(content: flow.MbrContent, verify = verifyClearance): Promise<RunDriver> {
  const issuer = await server.asPersona('issuer');
  const runId = await importAndIssue(server, issuer, writePackage(server, content));
  const d = new RunDriver(server, runId, { issuer, operator1: await server.asPersona('operator1'), verifier1: await server.asPersona('verifier1'), qa1: await server.asPersona('qa1') });
  d.beforeTap = () => vi.advanceTimersByTime(7_000);
  await d.ok('operator1', { type: 'START_STEP', stepKey: CLEAR });
  for (const c of clearance) await d.ok('operator1', c);
  await d.signed('operator1', { type: 'SIGN_PERFORMED', stepKey: CLEAR });
  await verify(d);
  return d;
}

async function holdPointSignatures(d: RunDriver): Promise<number> {
  const { rows } = await server.db.admin.query<{ n: string }>('select count(*)::text as n from esig.signature where aggregate_id = $1', [`${d.runId}:${HOLD}`]);
  return Number(rows[0]?.n);
}

async function recorded(d: RunDriver): Promise<{ value: string; comment: string | null } | null> {
  const r = (await execution.loadState(server.db.admin, d.runId))?.state.steps[HOLD]?.disposition;
  return r ? { value: r.value, comment: r.comment ?? null } : null;
}

async function proposals(d: RunDriver): Promise<Json[]> {
  const { rows } = await server.db.admin.query<{ proposal: Json }>('select proposal from recipe.execution_decision_proposal where batch_id = $1 order by id', [d.runId]);
  return rows.map((r) => r.proposal);
}

const hold = (disposition: string, comment?: string): HoldDecision => ({ type: 'DISPOSITION_HOLD_POINT', stepKey: HOLD, disposition, ...(comment !== undefined ? { comment } : {}) });

/** Challenges `challenged` and signs with `signed` (same meaning, so C1's describe() check cannot tell them apart). */
async function challengeThenSign(d: RunDriver, challenged: HoldDecision, signed: HoldDecision) {
  expect(engine.holdPointMeaning(signed.disposition)).toBe(engine.holdPointMeaning(challenged.disposition));
  const r = await signDecision(d, 'qa1', challenged, { signAction: signed });
  expect(r.stage, `SETUP: the challenge was refused: ${outcomeOf(r.result)}`).toBe('sign');
  return r;
}

const SAFE = { outcome: '409:EBMR-EXE-086', holdPointSignatures: 0, recorded: null };

describe('the hold-point decision is bound between the challenge and the signature (P26, P38)', () => {
  it('[PR-45][DI-37][DI-35] P26: a conditional release challenged, then signed as an unconditional release without the conditions, is refused; nothing is signed', async () => {
    const d = await atHoldPoint(withConditionalRelease());
    // Both releasing decisions are offered, each signed HOLD_POINT_RELEASED.
    const view = await d.stepView('qa1', HOLD);
    expect(view.actions.filter((a) => a.action === 'DISPOSITION_HOLD_POINT').map((a) => [a.target, a.meaning, a.available])).toEqual([
      ['APPROVED', 'HOLD_POINT_RELEASED', true],
      ['APPROVED_WITH_CONDITIONS', 'HOLD_POINT_RELEASED', true],
      ['NOT_APPROVED', 'HOLD_POINT_NOT_RELEASED', true],
    ]);
    // The review's scenario, as it was reported.
    const c = await challengeDecision(d, 'qa1', hold('APPROVED_WITH_CONDITIONS', 'release only after LOD retest passes'));
    if (!c.challenge?.ok || !c.action) throw new Error(`SETUP: the challenge was refused: ${outcomeOf(c.challenge ?? c.content)}`);
    const rows = await rowsOf(server, d.runId);
    const result = await signChallenge(d, 'qa1', valueOf(c.challenge).challengeId, { ...c.action, intent: hold('APPROVED') });
    expect({ outcome: outcomeOf(result), holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual(SAFE);
    expect(refusalOf(result).kind).toBe('CONTENT_CHANGED');
    expect(refusalOf(result).controls).toEqual(['DI-37', 'PR-45']);
    expect(refusalOf(result).why).toMatch(/disposition and comment of the decision on hold point H-TEST@ differs/);
    // Refused before anything is written (no PREPARE without its COMMAND row); the attempt is a signing failure.
    expect(await rowsOf(server, d.runId)).toEqual(rows);
    const { rows: failures } = await server.db.admin.query<{ code: string }>('select code from esig.signing_failure where challenge_id = $1', [valueOf(c.challenge).challengeId]);
    expect(failures.map((f) => f.code)).toEqual(['EBMR-EXE-086']);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[PR-45][DI-37] P38: a rejection whose reason differs, a comment added at signing or differing by a trailing space, and two challenges signed crosswise are refused; nothing is signed', async () => {
    const d = await atHoldPoint(withEarlyHoldPoint());
    const swapped = await challengeThenSign(d, hold('NOT_APPROVED', 'Residue of the previous product found behind the booth grille'), hold('NOT_APPROVED', 'Paperwork incomplete'));
    expect({ outcome: outcomeOf(swapped.result), holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual(SAFE);
    const added = await challengeThenSign(d, hold('NOT_APPROVED'), hold('NOT_APPROVED', 'Paperwork incomplete'));
    expect({ outcome: outcomeOf(added.result), holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual(SAFE);
    const spaced = await challengeThenSign(d, hold('NOT_APPROVED', 'Residue found'), hold('NOT_APPROVED', 'Residue found '));
    expect({ outcome: outcomeOf(spaced.result), holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual(SAFE);
    // Two challenges of one reviewer (a challenge is signed once: its badge tap is used by the attempt): the second
    // decision is now the one in the content, so the first challenge signs neither its own decision nor, crosswise,
    // the second challenge the first decision.
    const first = hold('NOT_APPROVED', 'Residue found behind the booth grille');
    const second = hold('NOT_APPROVED', 'Residue found behind the booth grille and on the scoop');
    const a = await challengeDecision(d, 'qa1', first);
    const b = await challengeDecision(d, 'qa1', second);
    if (!a.challenge?.ok || !b.challenge?.ok || !a.action || !b.action) throw new Error('SETUP: a challenge was refused');
    expect(outcomeOf(await signChallenge(d, 'qa1', valueOf(a.challenge).challengeId, a.action))).toBe('409:EBMR-EXE-086');
    expect(outcomeOf(await signChallenge(d, 'qa1', valueOf(b.challenge).challengeId, a.action))).toBe('409:EBMR-EXE-086');
    expect({ holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual({ holdPointSignatures: 0, recorded: null });
    // Challenged again, the decision reviewed last is signed as reviewed.
    await signedDecision(d, 'qa1', second);
    expect(await recorded(d)).toEqual({ value: 'NOT_APPROVED', comment: 'Residue found behind the booth grille and on the scoop' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-37][PR-45] P26/P38: the decision is signed content: the preview shows and hashes it, the challenge and the signature bind it; a preview without it cannot be signed', async () => {
    const d = await atHoldPoint(withConditionalRelease());
    const decision = hold('APPROVED_WITH_CONDITIONS', 'Release only after the hardness retest passes');
    // Without the decision the preview shows none and says so; its hash is not the one the challenge binds. With no
    // decision proposed the content has no proposedDecision member at all, as before 0295 (recipe-core 0302).
    const bare = valueOf(await previewDecision(d, 'qa1', decision, 'HOLD_POINT_RELEASED'));
    expect((JSON.parse(bare.canonicalText) as { content: Json }).content).not.toHaveProperty('proposedDecision');
    expect(bare.rendering['decision']).toEqual({ proposed: null, note: NO_DECISION_NOTE });
    const unsigned = await challengeDecision(d, 'qa1', decision, { previewIntent: 'HOLD_POINT_RELEASED' });
    expect(outcomeOf(unsigned.challenge ?? unsigned.content)).toMatch(/^4\d\d:/);
    expect(await proposals(d)).toEqual([]);
    // A decision previewed under the other class's meaning is not a decision of that class.
    expect(outcomeOf(await previewDecision(d, 'qa1', decision, `HOLD_POINT_NOT_RELEASED|${Buffer.from(JSON.stringify({ disposition: 'APPROVED_WITH_CONDITIONS', comment: null })).toString('base64url')}`))).toBe('400:SCHEMA');
    // With the decision: shown as the decision to be signed, and in the canonical text.
    const r = await signDecision(d, 'qa1', decision);
    if (!r.content.ok) throw new Error('no preview');
    const view = r.content.value;
    expect(view.rendering['decision']).toEqual({ proposed: { disposition: 'APPROVED_WITH_CONDITIONS', comment: 'Release only after the hardness retest passes' } });
    const envelope = JSON.parse(view.canonicalText) as { content: Json };
    expect(envelope.content['proposedDecision']).toEqual({ disposition: 'APPROVED_WITH_CONDITIONS', comment: 'Release only after the hardness retest passes' });
    const signed = valueOf(r.result);
    expect(signed.manifestation).toMatchObject({ meaning: 'HOLD_POINT_RELEASED', aggregateType: 'batch_step', aggregateId: `${d.runId}:${HOLD}`, valid: true, contentHash: view.contentHash });
    // The kernel's content of the record carries the decision exactly as signed, and the signature stays valid.
    const k = await esig.contentForSigning(server.db.admin, 'batch_step', `${d.runId}:${HOLD}`);
    expect(k.contentHash).toBe(signed.manifestation.contentHash);
    expect((JSON.parse(k.canonical ?? '{}') as { content: Json }).content['proposedDecision']).toEqual(envelope.content['proposedDecision']);
    expect(sha256Hex(canonicalJson(JSON.parse(k.canonical ?? '{}')))).toBe(k.contentHash);
    expect(await recorded(d)).toEqual({ value: 'APPROVED_WITH_CONDITIONS', comment: 'Release only after the hardness retest passes' });
    // Proposing is not a change of the step's data: the reviewer is not an enterer (esig content_change).
    const qa = server.seed.personas.find((p) => p.key === 'qa1')?.personId;
    const { rows: changes } = await server.db.admin.query('select 1 from esig.content_change where aggregate_ref = $1 and person_id = $2', [`batch_step:${d.runId}:${HOLD}`, qa]);
    expect(changes).toHaveLength(0);
    // A decided hold point takes no other decision: none can be proposed, and the signed one stays valid.
    const again = await signDecision(d, 'qa1', hold('APPROVED'));
    expect(outcomeOf(again.result)).toBe('422:EBMR-EXE-084');
    expect(await proposals(d)).toHaveLength(1);
    const { rows: state } = await server.db.admin.query<{ s: { valid: boolean } }>('select esig.signature_state($1::uuid) as s', [signed.manifestation.signatureId]);
    expect(state[0]?.s.valid).toBe(true);
    expect(await holdPointSignatures(d)).toBe(1);
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-37][PR-45] the binding is in the database, not in a server\'s memory: a signing prepared on one server instance is signed on another', async () => {
    const d = await atHoldPoint(withEarlyHoldPoint());
    const decision = hold('NOT_APPROVED', 'Residue found behind the booth grille');
    const c = await challengeDecision(d, 'qa1', decision);
    if (!c.challenge?.ok || !c.action) throw new Error('SETUP: the challenge was refused');
    // Another instance (a restart, a second server): a fresh handler with nothing of the preparation in memory.
    const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
    if (!handler) throw new Error('ENGINE_COMMAND is not registered');
    const fresh = engineCommandHandler(server.built.ctx);
    const saved = { dryRun: handler.dryRun.bind(handler), apply: handler.apply.bind(handler) };
    Object.assign(handler, { dryRun: fresh.dryRun.bind(fresh), apply: fresh.apply.bind(fresh) });
    try {
      const signed = valueOf(await signChallenge(d, 'qa1', valueOf(c.challenge).challengeId, c.action));
      expect(signed.manifestation.meaning).toBe('HOLD_POINT_NOT_RELEASED');
    } finally {
      Object.assign(handler, saved);
    }
    expect(await recorded(d)).toEqual({ value: 'NOT_APPROVED', comment: 'Residue found behind the booth grille' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

describe('the database records a hold-point decision only as signed (P26, P38; ADR 0012)', () => {
  it('[PR-45][DI-37][INV-10] P26: a server path that records another decision with the signature sealed for the challenged one is refused by the database; nothing is signed', async () => {
    const d = await atHoldPoint(withConditionalRelease());
    const handler = server.built.ctx.signables.forKind('ENGINE_COMMAND');
    if (!handler) throw new Error('ENGINE_COMMAND is not registered');
    const original = handler.apply.bind(handler);
    let refused: unknown = null;
    // The review's bypass: apply() builds the command from another decision (APPROVED, no conditions) and writes it
    // as the application role through the execution store, with the real signature sealed for the conditional release.
    handler.apply = async (client, ctx, a, sig) => {
      if (a.kind !== 'ENGINE_COMMAND') throw new Error('SETUP: not an engine command');
      const run = await runContext(client, a.runId);
      const tx = await execution.ExecutionTx.open(client, run.def, a.runId);
      const roles = await engineRoles(client);
      const cmd = signedCommand(tx.state, hold('APPROVED'), engineActor(ctx.actor.personId, roles), { id: sig.signatureId, meaning: sig.meaning, signer: sig.signer }, `ESIG:${sig.signatureId}`, a.expectedVersion);
      try {
        await tx.command(cmd, roles, { signatureId: sig.signatureId });
      } catch (e) {
        refused = e;
        throw e;
      }
      return null;
    };
    let r;
    try {
      r = await signDecision(d, 'qa1', hold('APPROVED_WITH_CONDITIONS', 'only after retest'));
    } finally {
      handler.apply = original;
    }
    expect(r.stage).toBe('sign');
    expect(String(refused)).toMatch(/is not the decision its signature covers.*\[EBMR-EXE-086\]/);
    expect({ ok: r.result.ok, holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual({ ok: false, holdPointSignatures: 0, recorded: null });
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[PR-45][DI-37] P38: the state must record the decision as signed: a row whose state keeps another comment than the signed command is refused', async () => {
    const d = await atHoldPoint(withEarlyHoldPoint());
    const signedDecisionIntent = hold('NOT_APPROVED', 'Residue of the previous product found behind the booth grille');
    const r = await interceptSigned(
      'DISPOSITION_HOLD_POINT',
      async (tx, command, roles) => {
        if (command.type !== 'DISPOSITION_HOLD_POINT') throw new Error('SETUP: not a hold point');
        // The command recorded is the one signed; the state it leaves records QA's reason as something else.
        const forged = engineResult(tx, { ...command, comment: 'Paperwork incomplete' });
        await appendAs(tx, command, forged, roles);
        return forged;
      },
      () => signDecision(d, 'qa1', signedDecisionIntent),
    );
    expect(r.calls).toBe(1);
    expect(String(r.error)).toMatch(/records another decision on hold point H-TEST@ than the signed one.*\[EBMR-EXE-086\]/);
    expect({ ok: r.out.result.ok, holdPointSignatures: await holdPointSignatures(d), recorded: await recorded(d) }).toEqual({ ok: false, holdPointSignatures: 0, recorded: null });
    // Signed and recorded as reviewed, it is accepted.
    await signedDecision(d, 'qa1', signedDecisionIntent);
    expect(await recorded(d)).toEqual({ value: 'NOT_APPROVED', comment: 'Residue of the previous product found behind the booth grille' });
    expect(await violations(server)).toEqual([]);
  }, 240_000);
});

/** recipe.execution_content_of as recipe-core 0210 released it: the batch_step provider before 0295 (no decision in a hold point's content). */
const PROVIDER_0210 = ((): string => {
  const text = readFileSync(join(lifecycle.RECIPE_SQL_DIR, '0210_execution_writers.sql'), 'utf8');
  const found = /create function recipe\.execution_content_of\(p_type text, p_id text\)[\s\S]*?\n\$\$;/.exec(text);
  if (!found) throw new Error('recipe.execution_content_of not found in recipe-core 0210');
  return found[0].replace('create function', 'create or replace function');
})();

/** Runs `sql` as the schema owner in a superuser transaction, as a migration does (the function keeps its owner and privileges). */
async function asOwner(sql: string): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role ebmr_owner');
    await c.query(sql);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    c.release();
  }
}

/**
 * Runs `work` on the database as it was before 0295 (the content provider of 0210), then the upgrade: the provider in
 * force after every migration (0295, 0302) is installed again, whatever `work` did.
 */
async function before0295<T>(work: () => Promise<T>): Promise<T> {
  const { rows } = await server.db.admin.query<{ def: string }>("select pg_get_functiondef('recipe.execution_content_of(text, text)'::regprocedure) as def");
  const current = rows[0]?.def;
  if (!current) throw new Error('SETUP: recipe.execution_content_of is not defined');
  await asOwner(PROVIDER_0210);
  try {
    return await work();
  } finally {
    await asOwner(current);
  }
}

async function signatureStatus(signatureId: string): Promise<{ status: string; contentHash: string | null }> {
  const state = await esig.signatureState(server.db.admin, signatureId);
  const { rows } = await server.db.admin.query<{ h: string }>('select content_hash as h from esig.signature where id = $1', [signatureId]);
  return { status: state.status, contentHash: rows[0]?.h ?? null };
}

describe('hold-point signatures made before 0295 keep the content they signed (recipe-core 0302)', () => {
  it('[INV-09][DI-37][PR-45] a hold-point signature made before any decision was proposed stays VALID after 0295, and no decision is proposed on the content version it covers (0309)', async () => {
    const d = await atHoldPoint(withEarlyHoldPoint());
    const id = `${d.runId}:${HOLD}`;
    // The installation as it was before 0295: the content provider as 0210 released it. QA's signature is made
    // there through the kernel on the content that provider gives, and no decision is proposed (there was no
    // proposal before 0295). The decision row itself is not replayed: since 0295 the database records a decision
    // only with its proposal, and the status of a signature depends only on the content it covers.
    const legacy = await before0295(async () => {
      const before = await esig.contentForSigning(server.db.admin, 'batch_step', id);
      if (!before.contentHash || !before.canonical) throw new Error('SETUP: the hold point has no content');
      expect((JSON.parse(before.canonical) as { content: Json }).content).not.toHaveProperty('proposedDecision');
      const signatureId = await signatureAlone(server, d.browser('qa1'), 'qa1', 'batch_step', id, 'HOLD_POINT_RELEASED');
      expect(await signatureStatus(signatureId)).toEqual({ status: 'VALID', contentHash: before.contentHash });
      return { signatureId, contentHash: before.contentHash };
    });
    expect(await proposals(d)).toEqual([]);

    // After the upgrade the hold point, with no decision proposed, has the content that signature covers: still VALID.
    expect(await signatureStatus(legacy.signatureId)).toEqual({ status: 'VALID', contentHash: legacy.contentHash });
    expect((await esig.contentForSigning(server.db.admin, 'batch_step', id)).contentHash).toBe(legacy.contentHash);
    // The server previews a hold point without a decision as that same content.
    expect(valueOf(await previewDecision(d, 'qa1', hold('APPROVED'), 'HOLD_POINT_RELEASED')).contentHash).toBe(legacy.contentHash);

    // A decision proposed now would be part of that content version's signed content and change what the earlier
    // signature covers. Since recipe-core 0309 (Phase 2 exit review F37; INV-09) no decision is proposed on a content
    // version a hold-point decision was already signed on: the challenge is refused, nothing is proposed, and the
    // signature keeps covering the content it signed.
    const c = await challengeDecision(d, 'qa1', hold('NOT_APPROVED', 'Residue found behind the booth grille'));
    expect(outcomeOf(c.challenge ?? c.content)).toMatch(/EBMR-EXE-084/);
    expect(await proposals(d)).toEqual([]);
    expect(await signatureStatus(legacy.signatureId)).toEqual({ status: 'VALID', contentHash: legacy.contentHash });
    expect(await recorded(d)).toBeNull();
    expect(await violations(server)).toEqual([]);
  }, 240_000);

  it('[DI-37][PR-45] a hold point\'s stored content cannot stand for a proposed decision: without a proposal the content provider gives the member as null, never as stored', async () => {
    // The application role (ADR 0012) stores the new hold point's first content with a decision in it.
    const forged = { disposition: 'APPROVED', comment: 'Released as stored' };
    const d = await atHoldPoint(withEarlyHoldPoint(), async (run) => {
      const r = await interceptSigned(
        'VERIFY',
        async (tx, command, roles) => {
          const result = engineResult(tx, command);
          const contents = engine.changedContents(tx.def, tx.state, result.state).map((c) => {
            if (c.type !== 'batch_step' || c.key !== HOLD) return c;
            const content = { ...c.content, proposedDecision: forged };
            return { ...c, content, contentHash: sha256Hex(canonicalJson(content)) };
          });
          await appendAs(tx, command, result, roles, engine.encodeCommand(command), contents);
          return result;
        },
        () => verifyClearance(run),
      );
      if (r.calls !== 1 || r.error) throw new Error(`SETUP: the verification was not recorded: ${String(r.error)}`);
    });
    const id = `${d.runId}:${HOLD}`;
    const { rows } = await server.db.admin.query<{ content: Json }>('select content from recipe.execution_step_content where aggregate_id = $1 order by content_version desc limit 1', [id]);
    expect(rows[0]?.content['proposedDecision'], 'SETUP: the stored content names a decision').toEqual(forged);
    expect(await proposals(d)).toEqual([]);
    // The member is the database's own: no decision was proposed.
    const k = await esig.contentForSigning(server.db.admin, 'batch_step', id);
    expect((JSON.parse(k.canonical ?? '{}') as { content: Json }).content['proposedDecision']).toBeNull();
  }, 240_000);
});
