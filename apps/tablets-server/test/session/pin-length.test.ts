/**
 * Review F05 (DI-19, DI-15): every kiosk PIN pad takes at most 12 digits (the sign-in pad and the ui-kit PinPad of
 * unlock, switch and signing), but the change of a PIN accepted any length: a person who chose a longer PIN was told it
 * was set and could never type it; each try sent the first 12 digits and counted toward the lockout. Now the kernel
 * refuses a new PIN longer than MAX_PIN_LENGTH where the plaintext is judged (EBMR-IAM-055, before hashing; the
 * database only ever sees an argon2id verifier), and the pads and the contract use the same number.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PIN_MAX_LENGTH, routes, type Result } from '@ebmr/api-contract';
import { identity } from '@ebmr/kernel';
import { personaOf } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';

let sbx: TestServer;

beforeAll(async () => {
  sbx = await startServer('SANDBOX');
});
afterAll(async () => {
  await sbx?.close();
});

const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);

async function changePin(key: string, currentSecret: string, newSecret: string) {
  const p = personaOf(sbx.seed, key);
  const b = sbx.browser(p.homeTerminal);
  const body = { method: 'BADGE_PIN' as const, identifier: p.badgeUid ?? '', currentSecret, newSecret, kind: 'PIN' as const };
  return { b, p, r: await b.call(routes.session.changeSecret, { body: { ...body, proof: await b.proof('POST', '/api/session/change-secret', body) } }) };
}

describe('F05: a new PIN is never longer than the kiosk PIN pads take', () => {
  it('[DI-19][DI-15] the pads, the contract and the kernel use one maximum: 12 digits', () => {
    expect(PIN_MAX_LENGTH).toBe(12);
    expect(identity.MAX_PIN_LENGTH).toBe(PIN_MAX_LENGTH);
  });

  it('[DI-19][DI-15] a 13- or 14-digit new PIN is refused at the change (EBMR-IAM-055) and the current PIN still signs in; 12 digits are accepted', async () => {
    const op = personaOf(sbx.seed, 'operator1');
    for (const long of ['7391462850391', '73914628503917']) {
      const { r } = await changePin('operator1', op.pin ?? '', long);
      expect(outcome(r), long).toBe('422:EBMR-IAM-055');
      expect(!r.ok && r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.whatHappened + r.error.envelope.refusal.why : '').toMatch(/longer than 12 digits/);
    }
    // Nothing changed: the current PIN still signs in on the kiosk.
    const b = sbx.browser(op.homeTerminal);
    const login = { method: 'BADGE_PIN' as const, identifier: op.badgeUid ?? '', secret: op.pin ?? '' };
    expect(outcome(await b.call(routes.session.login, { body: { ...login, proof: await b.proof('POST', '/api/session/login', login) } }))).toBe('ok');
    // Control: 12 digits, all a pad takes, are accepted and then sign in.
    const twelve = '739146285039';
    const { r } = await changePin('operator1', op.pin ?? '', twelve);
    expect(outcome(r)).toBe('ok');
    const b2 = sbx.browser(op.homeTerminal);
    const again = { ...login, secret: twelve };
    expect(outcome(await b2.call(routes.session.login, { body: { ...again, proof: await b2.proof('POST', '/api/session/login', again) } }))).toBe('ok');
  });
});
