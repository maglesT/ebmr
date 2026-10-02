/**
 * Shared set-up of the database-guard regression tests (review P22, P24, P25, P29; recipe-core 0270): e-signatures
 * made directly through the kernel (challenge, the signer's authentication for it, esig.sign and seal), so a test
 * can record a signed act the server's ceremony would never produce (another meaning, a signature from an earlier
 * command, an approval of a correction) and show that the database refuses it. The application role
 * (ebmr_sandbox here; ADR 0012) is the attacker: it holds the same database rights as the server.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { vi } from 'vitest';
import { esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { engine, execution } from '@ebmr/recipe-core';
import { terminalOf } from '@ebmr/test-kit';
import { actorOfBrowser } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import { engineActor, engineRoles } from '../../src/features/execution/roles.ts';
import { runContext } from '../../src/features/execution/runs.ts';
import { personaIn, type ExecServer, type RunDriver } from './support.ts';

/** The error code a promise is rejected with (EBMR-XXX-NNN), or 'ok'. */
export async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /\b(EBMR-[A-Z]+-\d{3})\b/.exec(e instanceof Error ? e.message : String(e));
    return m?.[1] ?? (e instanceof Error ? e.message : String(e));
  }
}

/** The message a promise is rejected with, or 'ok'. */
export async function messageOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** A command of `persona` in the browser's own session (a fresh badge tap on a kiosk; the tap limiter's clock moves on first). */
export async function actorOf(sbx: ExecServer, browser: TestBrowser, persona: string, extra: Partial<ActorContext> = {}): Promise<ActorContext> {
  vi.advanceTimersByTime(7_000);
  return actorOfBrowser(sbx, browser, persona, extra);
}

export interface PendingSignature {
  challengeId: string;
  authEventId: string;
  /** esig.sign and seal inside the caller's command (the command must be `persona`'s, in the challenge's session). */
  sign(c: pg.PoolClient): Promise<string>;
  /** The actor of that command: the browser's session, attributed by the signature's own authentication (as the server does). */
  actor(): Promise<ActorContext>;
}

/**
 * Prepares an e-signature of `persona` (signing in `browser`'s session) with `meaning` on the record: the content
 * the kernel's provider gives, a challenge in the persona's command, and the persona's authentication for it on
 * the browser's terminal (badge and PIN on a kiosk, user ID and password elsewhere). Nothing is signed yet.
 */
export async function prepareSignature(sbx: ExecServer, browser: TestBrowser, persona: string, aggregateType: string, aggregateId: string, meaning: string): Promise<PendingSignature> {
  const who = personaIn(sbx, persona);
  const content = await esig.contentForSigning(sbx.db.app, aggregateType, aggregateId);
  if (!content.exists || content.contentVersion === undefined || content.contentHash === undefined) throw new Error(`SETUP: ${aggregateType} ${aggregateId} has no signable content: ${JSON.stringify(content)}`);
  const challenge = await withCommand(sbx.db.app, await actorOf(sbx, browser, persona), (c) =>
    esig.createChallenge(c, { aggregateType, aggregateId, contentVersion: content.contentVersion ?? '', meaning, clientContentHash: content.contentHash ?? '' }),
  );
  const terminal = terminalOf(sbx.seed, browser.terminal);
  const kiosk = terminal.deviceClass === 'SHARED' || terminal.deviceClass === 'GRADE_A_B';
  const ev = await identity.authenticate(sbx.db.authn, {
    ...(kiosk ? { method: 'BADGE_PIN' as const, identifier: who.badgeUid ?? '', secret: who.pin ?? '' } : { method: 'PASSWORD' as const, identifier: who.loginName, secret: who.password }),
    deviceFingerprint: terminal.fingerprint,
    purpose: 'SIGNATURE',
    challengeId: challenge.challengeId,
  });
  const sealKey = sbx.built.ctx.sealKey;
  if (!sealKey) throw new Error('SETUP: the server has no seal key');
  return {
    challengeId: challenge.challengeId,
    authEventId: ev.authEventId,
    sign: async (c) => (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId,
    actor: () => actorOf(sbx, browser, persona, { authEventId: ev.authEventId }),
  };
}

/** A signature made and committed on its own, in a command of its own (never applied to the record). */
export async function signatureAlone(sbx: ExecServer, browser: TestBrowser, persona: string, aggregateType: string, aggregateId: string, meaning: string): Promise<string> {
  const p = await prepareSignature(sbx, browser, persona, aggregateType, aggregateId, meaning);
  return withCommand(sbx.db.app, await p.actor(), (c) => p.sign(c));
}

/** The engine's result of `command` at the transaction's trusted time (it must accept it). */
export function engineResult(tx: execution.ExecutionTx, command: engine.Command): engine.StepResult {
  const r = engine.step(tx.def, tx.state, command, { nowUs: tx.nowUs });
  if (!r.accepted) throw new Error(`SETUP: the engine refused ${command.type}: ${JSON.stringify(r.refusal)}`);
  return r;
}

/**
 * Appends `command` (or the JSON `recorded` in its place) as accepted with the given engine result, bypassing
 * ExecutionTx. By default it stores the signable content that result changes, as the server does: every exception and
 * hold point a row brings in is stored by that row (recipe-core 0299, EBMR-EXE-057), so the guard a test aims at
 * decides, not a missing first content version. `contents` replaces it (a writer that stores less, for a change of an
 * existing record). `evidence` is stored with the row as the server stores it (e.g. the readings a device entry claimed).
 */
export function appendAs(
  tx: execution.ExecutionTx,
  command: engine.Command,
  r: Pick<engine.StepResult, 'state' | 'events'>,
  roles: readonly execution.RoleEvidence[],
  recorded: engine.JsonValue = engine.encodeCommand(command),
  contents: readonly engine.AggregateContent[] = engine.changedContents(tx.def, tx.state, r.state),
  evidence?: engine.JsonValue,
) {
  return execution.appendExecution(tx.client, {
    batchId: tx.locked.batch.id,
    expectedSeq: tx.lastSeq,
    kind: 'COMMAND',
    command: recorded,
    commandId: command.commandId,
    nowUs: tx.nowUs,
    accepted: true,
    state: r.state,
    events: r.events,
    roles,
    contents,
    ...(evidence !== undefined ? { evidence } : {}),
  });
}

/** A stage frame's sign-off as the engine records it (by, signature, at, valid, summary). */
export type StageSignOff = NonNullable<engine.StageFrameState['signOff']>;

/**
 * supervisor1 signs stage `stage` (no frames) of run `d` off through the store (Phase 2 exit review F01; recipe-core
 * 0319, 0320): the kernel's signature on the provider's content, then the SIGN_OFF_STAGE row with the engine's result,
 * its sign-off and summary changed by `forge` (none: the engine's own). 'ok', or the refusal's message.
 */
export async function signOffStageThroughStore(sbx: ExecServer, d: RunDriver, stage: string, forge?: (summary: engine.StageSummary, signOff: StageSignOff) => void): Promise<string> {
  const key = `${stage}@`;
  const run = await runContext(sbx.db.admin, d.runId);
  const who = personaIn(sbx, 'supervisor1');
  const p = await prepareSignature(sbx, d.browser('supervisor1'), 'supervisor1', 'batch_stage', `${d.runId}:${key}`, 'STAGE_SIGNED_OFF');
  return messageOf(
    withCommand(sbx.db.app, await p.actor(), async (c) => {
      const id = await p.sign(c);
      const tx = await execution.ExecutionTx.open(c, run.def, d.runId);
      const roles = await engineRoles(c);
      const command: engine.Command = { type: 'SIGN_OFF_STAGE', commandId: randomUUID(), actor: engineActor(who.personId, roles), stage, context: [], signature: { id, meaning: 'STAGE_SIGNED_OFF', signer: who.personId } };
      const r = engineResult(tx, command);
      const signOff = r.state.stages[key]?.signOff;
      if (!signOff) throw new Error('SETUP: the engine recorded no sign-off');
      forge?.(signOff.summary, signOff);
      return appendAs(tx, command, r, roles);
    }),
  );
}

/** The prior state with its version moved on (a forged next state: the database guard under test decides first). */
export function nextState(tx: execution.ExecutionTx): Pick<engine.StepResult, 'state' | 'events'> {
  return { state: { ...tx.state, version: tx.state.version + 1 }, events: [] };
}

export const newCommandId = (): string => randomUUID();

/** Each outcome against its expectation (a pattern or the exact text): the mismatches, with the outcome itself. */
export function unmatched(outcomes: Readonly<Record<string, string>>, expected: Readonly<Record<string, RegExp | string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of new Set([...Object.keys(outcomes), ...Object.keys(expected)])) {
    const want = expected[k];
    const got = outcomes[k] ?? '(no outcome)';
    if (want instanceof RegExp ? !want.test(got) : want !== got) out[k] = `${got} (expected ${String(want)})`;
  }
  return out;
}

/**
 * Runs `work` in place of ExecutionTx.command for the signed command (real signature) of the next signing of
 * `type`; the placeholder dry run goes through unchanged. Returns what `work` threw, if anything (the database's
 * refusal), and how often it ran.
 */
export async function interceptSigned<T>(type: engine.Command['type'], work: (tx: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[]) => Promise<engine.StepResult>, sign: () => Promise<T>): Promise<{ out: T; calls: number; error: unknown }> {
  const proto = execution.ExecutionTx.prototype;
  const saved = Object.getOwnPropertyDescriptor(proto, 'command');
  if (!saved) throw new Error('SETUP: ExecutionTx.command not found');
  const original = saved.value as (this: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[], evidence?: engine.JsonValue) => Promise<engine.StepResult>;
  let calls = 0;
  let error: unknown;
  const replacement = async function (this: execution.ExecutionTx, command: engine.Command, roles: readonly execution.RoleEvidence[], evidence?: engine.JsonValue): Promise<engine.StepResult> {
    const sig = 'signature' in command ? command.signature : undefined;
    if (command.type !== type || !sig || sig.id === engine.PLACEHOLDER_SIGNATURE_ID) return original.call(this, command, roles, evidence);
    calls += 1;
    try {
      return await work(this, command, roles);
    } catch (e) {
      error = e;
      throw e;
    }
  };
  Object.defineProperty(proto, 'command', { ...saved, value: replacement });
  try {
    return { out: await sign(), calls, error };
  } finally {
    Object.defineProperty(proto, 'command', saved);
  }
}
