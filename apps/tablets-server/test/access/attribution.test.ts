/**
 * Per-entry attribution on shared terminals (module C1; plan section 5; INV-40, DI-14, DI-19, DI-20; decision
 * D1 and D8). The route under test is esig.createChallenge, a FRESH_ON_SHARED route of this module: on a kiosk
 * every call carries a badge tap of the signed-in person, proven by the terminal's key over the exact request.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { withCommand } from '@ebmr/kernel';
import { routes, type Attribution } from '@ebmr/api-contract';
import { freshTap, passwordActor } from '@ebmr/test-kit';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { TAP_LIMIT } from '../../src/platform/auth/attribution.ts';
import { actorOfBrowser, createStub, outcome, personaIn, refusalOf, startSigningServer, tapFor, valueOf } from '../esig/support.ts';

let sbx: TestServer;
let op: TestBrowser;

beforeAll(async () => {
  sbx = await startSigningServer('SANDBOX');
  op = await sbx.asPersona('operator1');
});
afterAll(async () => {
  await sbx?.close();
});

const PATH = '/api/esig/challenges';

async function challengeBody(browser: TestBrowser, stubId: string, meaning = 'PERFORMED') {
  const content = valueOf(await browser.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stubId, intent: meaning } }));
  return {
    aggregateType: 'esig_stub',
    aggregateId: stubId,
    contentVersion: content.contentVersion,
    meaning,
    clientContentHash: sha256Hex(content.canonicalText),
    action: { kind: 'ESIG_STUB' as const, stubId },
  };
}

const challenges = async (stubId: string): Promise<number> =>
  Number((await sbx.db.admin.query<{ n: string }>("select count(*) as n from esig.challenge where aggregate_ref = 'esig_stub:' || $1", [stubId])).rows[0]?.n);

describe('attribution on a kiosk', () => {
  it('[INV-40][DI-14] a kiosk command without a badge tap is refused with 428 and nothing is recorded', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const r = await op.call(routes.esig.createChallenge, { body });
    expect(refusalOf(r)).toMatchObject({ status: 428, code: 'TAP_REQUIRED', kind: 'NOT_ALLOWED', whatHappened: 'Tap your badge to confirm it is you.' });
    expect(await challenges(stub)).toBe(0);
  });

  it('[INV-40][DI-14] a tap of the signed-in person attributes the command; the audit entry names the person, the terminal and the tap', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const me = personaIn(sbx, 'operator1');
    const r = await op.call(routes.esig.createChallenge, { body, attribution: await tapFor(op, me, 'POST', PATH, body) });
    const ch = valueOf(r);
    expect(ch).toMatchObject({ aggregateType: 'esig_stub', aggregateId: stub, meaning: 'PERFORMED', requires: ['PIN'] });
    const { rows } = await sbx.db.admin.query<{ payload: { actor: Record<string, string> } }>(
      "select payload from kernel.audit_event where chain_key = 'esig_challenge:esig_stub:' || $1 order by id desc limit 1",
      [stub],
    );
    const actor = rows[0]?.payload.actor ?? {};
    expect(actor['person_id']).toBe(me.personId);
    expect(actor['auth_event_id']).toMatch(/^[0-9a-f-]{36}$/);
    const ev = await sbx.db.admin.query<{ method: string; purpose: string; person_id: string }>('select method, purpose, person_id from iam.auth_event where id = $1', [actor['auth_event_id']]);
    expect(ev.rows[0]).toEqual({ method: 'BADGE_TAP', purpose: 'COMMAND', person_id: me.personId });
  });

  it('[INV-40][DI-14] a tap by another person answers 409 SWITCH_USER with that person\'s name and records nothing', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const other = personaIn(sbx, 'verifier1');
    const r = refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: await tapFor(op, other, 'POST', PATH, body) }));
    expect(r).toMatchObject({ status: 409, code: 'SWITCH_USER', kind: 'SWITCH_USER', details: { switchToLegalName: other.legalName, switchToLoginName: other.loginName } });
    expect(r.whatHappened).toContain(other.legalName);
    expect(await challenges(stub)).toBe(0);
  });

  it('[INV-40][DI-14][DI-20] a reused tap is refused: the same attribution sent again fails its single-use device proof', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const tap = await tapFor(op, personaIn(sbx, 'operator1'), 'POST', PATH, body);
    expect(outcome(await op.call(routes.esig.createChallenge, { body, attribution: tap }))).toBe('ok');
    const again = refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: tap }));
    expect(again).toMatchObject({ status: 403, code: 'DEVICE_PROOF', details: { reason: 'NONCE' } });
    expect(await challenges(stub)).toBe(1);
  });

  it('[INV-40][DI-14] a reused authentication event cannot attribute a second command', async () => {
    const ev = await freshTap(sbx.db, sbx.seed, 'operator1', op.terminal);
    const base = await actorOfBrowser(sbx, op, 'operator1');
    const first = { ...base, authEventId: ev, correlationId: randomUUID() };
    await withActorCommand(sbx.db.app, first, (c) => c.query('select iam.assert_validated_actor()'));
    await expect(withActorCommand(sbx.db.app, { ...base, authEventId: ev, correlationId: randomUUID() }, (c) => c.query('select 1'))).rejects.toThrow(/EBMR-IAM-126/);
  });

  it('[INV-40][DI-14] a stale tap is refused: a device proof older than 60 s, and an authentication event older than the freshness window', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const tap = await tapFor(op, personaIn(sbx, 'operator1'), 'POST', PATH, body);
    await sbx.db.admin.query("update tab.device_nonce set expires_at = clock_timestamp() - interval '1 second' where used_at is null");
    expect(refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: tap }))).toMatchObject({ status: 403, code: 'DEVICE_PROOF', details: { reason: 'NONCE' } });
    // The event itself is bounded by the kernel (60 s by default on SHARED terminals).
    const ev = await freshTap(sbx.db, sbx.seed, 'operator1', op.terminal);
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update iam.auth_event set recorded_at = clock_timestamp() - interval '61 seconds' where id = $1", [ev]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const base = await actorOfBrowser(sbx, op, 'operator1');
    await expect(withActorCommand(sbx.db.app, { ...base, authEventId: ev, correlationId: randomUUID() }, (x) => x.query('select 1'))).rejects.toThrow(/EBMR-IAM-125/);
    expect(await challenges(stub)).toBe(0);
  });

  it('[DI-20][INV-40] a tap proven by another terminal\'s key is refused', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const elsewhere = sbx.browser('TEST-KIOSK-BLEND-1');
    const me = personaIn(sbx, 'operator1');
    const tap: Attribution = { method: 'BADGE_TAP', badgeUid: me.badgeUid ?? '', proof: await elsewhere.proof('POST', PATH, body) };
    expect(refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: tap }))).toMatchObject({ status: 403, code: 'DEVICE_PROOF', details: { reason: 'OTHER_TERMINAL' } });
  });

  it('[DI-20][INV-40] a tap whose proof covers another body is refused (the proof binds the exact request)', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const tap = await tapFor(op, personaIn(sbx, 'operator1'), 'POST', PATH, { ...body, meaning: 'VERIFIED' });
    expect(refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: tap }))).toMatchObject({ status: 403, code: 'DEVICE_PROOF', details: { reason: 'SIGNATURE' } });
  });

  it('[INV-40] a resend with the same idempotency key and a fresh tap of the same person replays the stored result (decision D1)', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const me = personaIn(sbx, 'operator1');
    const key = randomUUID();
    const first = valueOf(await op.call(routes.esig.createChallenge, { body, idempotencyKey: key, attribution: await tapFor(op, me, 'POST', PATH, body) }));
    const again = valueOf(await op.call(routes.esig.createChallenge, { body, idempotencyKey: key, attribution: await tapFor(op, me, 'POST', PATH, body) }));
    expect(again.challengeId).toBe(first.challengeId);
    expect(await challenges(stub)).toBe(1);
    // Without a fresh tap the resend is refused; a tap by another person never replays someone else's entry.
    expect(outcome(await op.call(routes.esig.createChallenge, { body, idempotencyKey: key }))).toBe('428:TAP_REQUIRED');
    expect(outcome(await op.call(routes.esig.createChallenge, { body, idempotencyKey: key, attribution: await tapFor(op, personaIn(sbx, 'verifier1'), 'POST', PATH, body) }))).toBe('409:SWITCH_USER');
  });

  it('[DI-14] an unknown badge is refused in plain language without saying why', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const body = await challengeBody(op, stub);
    const tap: Attribution = { method: 'BADGE_TAP', badgeUid: '04FFFFFFFFFFFF', proof: await op.proof('POST', PATH, body) };
    expect(refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: tap }))).toMatchObject({ status: 401, code: 'EBMR-IAM-140', kind: 'AUTH_FAILED', whatHappened: 'The badge was not accepted.' });
  });

  it('[DI-19][INV-40] taps are limited per minute per terminal and badge (TAP_LIMIT)', async () => {
    const qa = await sbx.asPersona('qa1');
    const me = personaIn(sbx, 'qa1');
    const stub = await createStub(sbx, qa, 'qa1');
    const body = await challengeBody(qa, stub);
    const seen: string[] = [];
    for (let i = 0; i <= TAP_LIMIT.max; i += 1) seen.push(outcome(await qa.call(routes.esig.createChallenge, { body, attribution: await tapFor(qa, me, 'POST', PATH, body) })));
    expect(seen.slice(0, TAP_LIMIT.max).every((s) => s === 'ok')).toBe(true);
    expect(seen[TAP_LIMIT.max]).toBe('429:RATE_LIMITED');
  });
});

describe('TAP_PIN terminal classes (decision D8)', () => {
  it('[INV-40][DI-14][DI-19] on a TAP_PIN class an entry needs badge and PIN; a wrong PIN counts toward lockout; the setting is audited', async () => {
    const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint, { correlationId: randomUUID() });
    await withCommand(sbx.db.app, admin, (c) => c.query("select tab.set_attribution_method('SHARED', 'TAP_PIN', 'CC-TEST-1: badge and PIN per entry on kiosks')"));
    try {
      const b = await sbx.asPersona('verifier2');
      const me = personaIn(sbx, 'verifier2');
      expect(valueOf(await b.call(routes.session.get)).attribution).toBe('TAP_PIN');
      const stub = await createStub(sbx, b, 'verifier2');
      const body = await challengeBody(b, stub);
      expect(outcome(await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, me, 'POST', PATH, body) }))).toBe('428:TAP_PIN_REQUIRED');
      expect(outcome(await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, me, 'POST', PATH, body, '000000') }))).toBe('401:EBMR-IAM-140');
      const failures = await sbx.db.admin.query<{ n: string }>('select iam.consecutive_failures($1)::text as n', [me.accountId]);
      expect(Number(failures.rows[0]?.n)).toBe(1);
      expect(outcome(await b.call(routes.esig.createChallenge, { body, attribution: await tapFor(b, me, 'POST', PATH, body, me.pin ?? '') }))).toBe('ok');
      const ev = await sbx.db.admin.query<{ method: string }>(
        "select e.method from kernel.audit_event a join iam.auth_event e on e.id::text = a.payload -> 'actor' ->> 'auth_event_id' where a.chain_key = 'esig_challenge:esig_stub:' || $1",
        [stub],
      );
      expect(ev.rows.map((r) => r.method)).toContain('BADGE_PIN');
      const audit = await sbx.db.admin.query<{ action: string }>("select action from kernel.audit_event where chain_key = 'attribution_method:SHARED' order by seq");
      expect(audit.rows.map((r) => r.action)).toEqual(['INSERT', 'BUSINESS']);
    } finally {
      await withCommand(sbx.db.app, { ...admin, correlationId: randomUUID() }, (c) => c.query("select tab.set_attribution_method('SHARED', 'TAP', 'CC-TEST-1: back to the default')"));
    }
  });

  it('[INV-40] only a person holding the identity-policy permission can change the method, and the table is append-only', async () => {
    const actor = await actorOfBrowser(sbx, op, 'operator1');
    await expect(withCommand(sbx.db.app, actor, (c) => c.query("select tab.set_attribution_method('SHARED', 'TAP', 'x')"))).rejects.toThrow(/EBMR-IAM-040/);
    await expect(sbx.db.app.query("insert into tab.attribution_method (device_class, method, reason, set_by_person, set_by_account) values ('SHARED', 'TAP', 'x', gen_random_uuid(), gen_random_uuid())")).rejects.toThrow(/permission denied/);
    await expect(sbx.db.admin.query("update tab.attribution_method set method = 'TAP'")).rejects.toThrow(/EBMR-AUDIT-004/);
  });
});
