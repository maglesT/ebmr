/**
 * The signing ceremony of a hold-point decision now that the decision is part of the signed content (recipe-core
 * 0295; review findings P26, P38; DI-37, PR-45): the content preview names the decision being signed
 * (`<meaning>|<base64url of the UTF-8 JSON {disposition, comment}>`, as for an exception disposition's proposal), so
 * the signer previews and hashes exactly what the challenge binds; then the challenge (a badge tap on a kiosk) and
 * the signature. `signDecision` returns the same shape as RunDriver.sign.
 */
import { sha256Hex } from '@ebmr/expr';
import { engine } from '@ebmr/recipe-core';
import { routes, type Result, type SignedIntent } from '@ebmr/api-contract';
import { personaIn, tapFor } from '../esig/support.ts';
import { passwordOf, pinOf, valueOf, type RunDriver } from './support.ts';

export type HoldDecision = Extract<SignedIntent, { type: 'DISPOSITION_HOLD_POINT' }>;

type EngineAction = { kind: 'ENGINE_COMMAND'; runId: string; expectedVersion: number; intent: SignedIntent };

const b64 = (x: unknown): string => Buffer.from(JSON.stringify(x), 'utf8').toString('base64url');

/** The preview intent of a decision: the meaning of its class and the decision {disposition, comment}. */
export function decisionPreviewIntent(i: HoldDecision, meaning = engine.holdPointMeaning(i.disposition)): string {
  return `${meaning}|${b64({ disposition: i.disposition, comment: i.comment ?? null })}`;
}

/** GET /api/esig/content of hold point `i.stepKey` with the preview intent `intent` (the decision's by default). */
export function previewDecision(d: RunDriver, persona: string, i: HoldDecision, intent = decisionPreviewIntent(i)) {
  return d.browser(persona).call(routes.esig.content, { query: { aggregateType: 'batch_step', aggregateId: `${d.runId}:${i.stepKey}`, intent } });
}

/** Preview and challenge of decision `i` (the challenge meaning is the decision's class unless `meaning` is given). */
export async function challengeDecision(d: RunDriver, persona: string, i: HoldDecision, opts: { meaning?: string; previewIntent?: string } = {}) {
  const b = d.browser(persona);
  const kiosk = b.terminal.includes('KIOSK');
  const content = await previewDecision(d, persona, i, opts.previewIntent);
  if (!content.ok) return { content, action: undefined, challenge: undefined };
  const action: EngineAction = { kind: 'ENGINE_COMMAND', runId: d.runId, expectedVersion: await d.version(persona), intent: i };
  const body = { aggregateType: 'batch_step', aggregateId: `${d.runId}:${i.stepKey}`, contentVersion: content.value.contentVersion, meaning: opts.meaning ?? engine.holdPointMeaning(i.disposition), clientContentHash: sha256Hex(content.value.canonicalText), action };
  d.beforeTap();
  const challenge = await b.call(routes.esig.createChallenge, { body, ...(kiosk ? { attribution: await tapFor(b, personaIn(d.server, persona), 'POST', '/api/esig/challenges', body) } : {}) });
  return { content, action, challenge };
}

/** POST /api/esig/sign for challenge `challengeId` with `action`. */
export async function signChallenge(d: RunDriver, persona: string, challengeId: string, action: EngineAction) {
  const b = d.browser(persona);
  const kiosk = b.terminal.includes('KIOSK');
  const signBody = { challengeId, credentials: kiosk ? pinOf(d.server, persona) : passwordOf(d.server, persona), action };
  const proof = await b.proof('POST', '/api/esig/sign', signBody);
  return b.call(routes.esig.sign, { body: { ...signBody, proof } });
}

/** The whole ceremony for decision `i`; the sign request carries `signAction` when given (another decision than the one challenged). */
export async function signDecision(d: RunDriver, persona: string, i: HoldDecision, opts: { meaning?: string; signAction?: HoldDecision } = {}) {
  const c = await challengeDecision(d, persona, i, opts);
  if (!c.content.ok) return { stage: 'content' as const, content: c.content, challenge: undefined, result: c.content as Result<never> };
  if (!c.challenge?.ok || !c.action) return { stage: 'challenge' as const, content: c.content, challenge: c.challenge, result: (c.challenge ?? c.content) as Result<never> };
  const result = await signChallenge(d, persona, valueOf(c.challenge).challengeId, opts.signAction ? { ...c.action, intent: opts.signAction } : c.action);
  return { stage: 'sign' as const, content: c.content, challenge: c.challenge, result };
}

/** The ceremony for decision `i`, which must be signed: the sign result. */
export async function signedDecision(d: RunDriver, persona: string, i: HoldDecision) {
  const r = await signDecision(d, persona, i);
  if (!r.result.ok) throw new Error(`${persona} ${i.disposition} on ${i.stepKey} (${r.stage}) was refused: ${JSON.stringify(r.result.error.kind === 'REFUSAL' ? r.result.error.envelope.refusal : r.result.error)}`);
  return r.result.value;
}
