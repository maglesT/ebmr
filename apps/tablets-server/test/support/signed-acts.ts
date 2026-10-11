/**
 * The e-signature ceremony of a signable action as a screen runs it (Phase 3 slice 6a): describe (what it signs, from the
 * server), preview the content, challenge on the hash of the text shown, sign with the person's own credentials and the
 * terminal's proof. `tamper` changes the content hash the browser sends (a screen showing other content than the record's).
 */
import { sha256Hex } from '@ebmr/expr';
import { routes, type SignableAction, type SignatureCredentials } from '@ebmr/api-contract';
import type { Result } from '@ebmr/api-contract';
import { personaIn, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from './harness.ts';

export function credentialsOf(server: TestServer, key: string): SignatureCredentials {
  const p = personaIn(server, key);
  return p.kiosk && p.pin !== null ? { kind: 'PIN', pin: p.pin } : { kind: 'PASSWORD', loginName: p.loginName, password: p.password };
}

export async function describeAction(b: TestBrowser, action: SignableAction) {
  return valueOf(await b.call(routes.esig.describe, { body: { action } }));
}

/** Runs the ceremony; the result of the sign call (a refusal when the server or the database refuses). */
export async function signAction(
  server: TestServer,
  b: TestBrowser,
  personaKey: string,
  action: SignableAction,
  opts: { meaning?: string; tamper?: boolean } = {},
): Promise<Result<unknown>> {
  const d = await describeAction(b, action);
  const meaning = opts.meaning ?? d.meaning ?? '';
  const preview = await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: meaning } });
  if (!preview.ok) return preview;
  const hash = opts.tamper ? sha256Hex(`${preview.value.canonicalText} `) : sha256Hex(preview.value.canonicalText);
  const challenge = await b.call(routes.esig.createChallenge, {
    body: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.value.contentVersion, meaning, clientContentHash: hash, action },
  });
  if (!challenge.ok) return challenge;
  const body = { challengeId: challenge.value.challengeId, credentials: credentialsOf(server, personaKey), action };
  return b.call(routes.esig.sign, { body: { ...body, proof: await b.proof('POST', '/api/esig/sign', body) } });
}
