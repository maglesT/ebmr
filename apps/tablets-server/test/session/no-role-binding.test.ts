/**
 * Review F10 (DI-16, DI-38): an account that holds no role that is valid now (a grant waiting for approval, expired or
 * revoked) opens no browser session. The server refuses its login (403 NO_ROLE, F36); since tablets 0480 the database
 * also refuses to bind such a session to a cookie when no role is named (EBMR-TAB-021), so the rule holds when the
 * application's own database credentials are used directly. A role named that the account does not hold stays
 * EBMR-TAB-013; an account that holds a role still binds with none named (its role choice follows).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'review F10 test set-up', correlationId: randomUUID() });

/** The bootstrap administrator revokes every approved grant of the account (iam.revoke_role_grant). */
async function revokeAll(server: TestServer, accountId: string): Promise<void> {
  const { rows } = await server.db.app.query<{ id: string }>("select id from iam.role_grant where account_id = $1 and status = 'APPROVED' and revoked_at is null", [accountId]);
  expect(rows.length).toBeGreaterThan(0);
  const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
  for (const r of rows) await withCommand(server.db.app, reason(admin), (c) => identity.revokeRoleGrant(c, r.id, 'review F10: no role left'));
}

/** A kernel session of the persona on its home terminal, opened now (as the login opens it, before the binding). */
async function openSession(server: TestServer, key: string): Promise<string> {
  const p = personaOf(server.seed, key);
  const t = terminalOf(server.seed, p.homeTerminal);
  const ev = await identity.authenticate(server.db.authn, { method: 'PASSWORD', identifier: p.loginName, secret: p.password, deviceFingerprint: t.fingerprint, purpose: 'LOGIN' });
  return (await identity.openSession(server.db.app, ev.authEventId, t.fingerprint)).sessionId;
}

const token = (): string => randomUUID().replaceAll('-', '').padEnd(64, '0');

describe('F10: no browser session for an account that holds no role now (tablets 0480)', () => {
  for (const [installation, key, role] of [
    ['GMP', 'checker', 'MBR_CHECKER'],
    ['SANDBOX', 'issuer', 'BATCH_ISSUER'],
  ] as const) {
    it(`[DI-16][DI-38] ${installation}: the database refuses to bind such a session with no role named (EBMR-TAB-021) or with its former role (EBMR-TAB-013)`, async () => {
      const server = installation === 'GMP' ? gmp : sbx;
      const p = personaOf(server.seed, key);
      // Control: while the account holds its role, a session binds with no role named (the role choice follows).
      const held = await openSession(server, key);
      await server.db.app.query('select tab.bind_session($1, $2, null)', [held, token()]);

      await revokeAll(server, p.accountId);

      const none = await openSession(server, key);
      await expect(server.db.app.query('select tab.bind_session($1, $2, null)', [none, token()])).rejects.toThrow(/EBMR-TAB-021/);
      await expect(server.db.app.query('select tab.bind_session($1, $2, $3)', [none, token(), role])).rejects.toThrow(/EBMR-TAB-013/);
      const { rows } = await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.session_binding where session_id = $1', [none]);
      expect(rows[0]?.n).toBe(0);
    });
  }
});
