/**
 * Review F04 (DI-15, DI-19, DI-38): a first-login PIN change left open on a shared kiosk stayed usable by the next
 * person for the two minutes the server kept the change ticket, bound only to the badge UID and the terminal, so they
 * could choose the absent person's PIN. Now:
 *  - the refusal that asks for a new PIN names whose PIN it is (details.legalName), and says the badge confirms it;
 *  - the ticket counts only for the badge it was issued to (another badge is refused, CHANGE_TICKET) and, on a shared
 *    terminal, for one minute (SHOP_FLOOR_CHANGE_TICKET_TTL_MS);
 *  - the database refuses the change once the authentication behind it is older than the terminal class's attribution
 *    window (kernel 0990, EBMR-IAM-092), and the server answers that as an expired change (CHANGE_TICKET).
 * The web kiosk keeps no badge UID for the change, wipes it after KEEP_BADGE_MS without input and asks for the badge
 * again to confirm the new PIN (apps/tablets-web/test/session/secret-inputs.test.tsx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { identity, withCommand } from '@ebmr/kernel';
import { passwordActor, personaOf } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';

let sbx: TestServer;

beforeAll(async () => {
  sbx = await startServer('SANDBOX');
});
afterAll(async () => {
  await sbx?.close();
});

const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);

/** The administrator resets the persona's PIN: an initial PIN, single use, to be changed at the first sign-in. */
async function resetPin(key: string): Promise<string> {
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST', reasonText: 'review F04 test set-up' });
  return withCommand(sbx.db.app, admin, async (c) => (await identity.issueInitialSecret(c, personaOf(sbx.seed, key).accountId, 'PIN')).secret);
}

/** A badge-and-PIN sign-in at the persona's kiosk with its initial PIN: the change ticket and the refusal. */
async function firstSignIn(key: string) {
  const p = personaOf(sbx.seed, key);
  const pin = await resetPin(key);
  const b = sbx.browser(p.homeTerminal);
  const body = { method: 'BADGE_PIN' as const, identifier: p.badgeUid ?? '', secret: pin };
  const r = await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } });
  expect(outcome(r)).toBe('409:MUST_CHANGE_SECRET');
  const refusal = !r.ok && r.error.kind === 'REFUSAL' ? r.error.envelope.refusal : null;
  return { b, p, refusal, ticket: refusal?.details?.['changeTicket'] ?? '' };
}

async function change(s: Awaited<ReturnType<typeof firstSignIn>>, badgeUid: string, newSecret: string) {
  const body = { method: 'BADGE_PIN' as const, identifier: badgeUid, changeTicket: s.ticket, newSecret, kind: 'PIN' as const };
  return s.b.call(routes.session.changeSecret, { body: { ...body, proof: await s.b.proof('POST', '/api/session/change-secret', body) } });
}

async function signsIn(key: string, pin: string): Promise<string> {
  const p = personaOf(sbx.seed, key);
  const b = sbx.browser(p.homeTerminal);
  const body = { method: 'BADGE_PIN' as const, identifier: p.badgeUid ?? '', secret: pin };
  return outcome(await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }));
}

describe('F04: a first-login PIN change on a shared kiosk', () => {
  it('[DI-15][DI-38] the request for a new PIN names whose PIN it is and says the badge confirms it', async () => {
    const s = await firstSignIn('operator2');
    expect(s.refusal?.details).toMatchObject({ kind: 'PIN', legalName: 'TEST-Arjun Das' });
    expect(s.refusal?.whatYouCanDo.join(' ')).toMatch(/tap your badge to confirm it/);
  });

  it('[DI-15][DI-38][DI-19] another person\'s badge cannot complete it (CHANGE_TICKET); the person\'s own badge does', async () => {
    const s = await firstSignIn('operator2');
    const other = personaOf(sbx.seed, 'verifier2');
    expect(outcome(await change(s, other.badgeUid ?? '', '730519'))).toBe('409:CHANGE_TICKET');
    expect(await signsIn('verifier2', '730519')).toBe('401:EBMR-IAM-140');
    expect(outcome(await change(s, s.p.badgeUid ?? '', '730519'))).toBe('ok');
    expect(await signsIn('operator2', '730519')).toBe('ok');
  });

  it('[DI-15][DI-38] the database refuses it once the authentication is older than the kiosk\'s attribution window (kernel 0990); the server says the change took too long', async () => {
    const s = await firstSignIn('operator2');
    // The authentication of the first sign-in, 61 s old: inside the event window (120 s), past the SHARED window (60 s).
    const { rows } = await sbx.db.admin.query<{ id: string }>(
      "select id from iam.auth_event where account_id = $1 and purpose = 'CREDENTIAL_CHANGE' order by recorded_at desc limit 1",
      [s.p.accountId],
    );
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update iam.auth_event set recorded_at = clock_timestamp() - interval '61 seconds' where id = $1", [rows[0]?.id]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const late = await change(s, s.p.badgeUid ?? '', '730519');
    expect(outcome(late)).toBe('409:CHANGE_TICKET');
    expect(!late.ok && late.error.kind === 'REFUSAL' ? late.error.envelope.refusal.whatHappened : '').toBe('The secret change took too long or was started elsewhere.');
    // Nothing changed, and the ticket is spent.
    expect(await signsIn('operator2', '730519')).not.toBe('ok');
    expect(outcome(await change(s, s.p.badgeUid ?? '', '730519'))).toBe('409:CHANGE_TICKET');
  });
});
