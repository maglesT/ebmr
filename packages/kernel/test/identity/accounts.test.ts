/**
 * Persons, identity verification, accounts and the permanent identifier register
 * (DI-15, INV-11 account rules, INV-27 user IDs never reused).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import {
  activateAccount,
  createAccount,
  createPerson,
  deactivateAccount,
  issueInitialSecret,
  processLeaver,
  recordIdentityVerification,
} from '../../src/identity/admin.ts';
import { authenticate } from '../../src/identity/authentication.ts';
import { AuthenticationFailedError } from '../../src/identity/errors.ts';
import { hashSecret } from '../../src/identity/secrets.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asDefinerCommand, asSuperuserTransaction, expectPermissionDenied, expectRefused } from './helpers.ts';
import { freshAuthEvent, seedActor, seedAdministration, seedAuthn, withReason, type SeedAdministration } from './seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;
beforeAll(async () => {
  db = await createTestDatabase();
  adm = await seedAdministration(db);
});
afterAll(async () => {
  await db.drop();
});

const login = (p = 'u'): string => `${p}-${randomBytes(4).toString('hex')}`;
const asAdmin = <T>(work: Parameters<typeof withCommand<T>>[2]) => withCommand(db.app, withReason(adm.admin), work);
const verify = (c: Parameters<typeof recordIdentityVerification>[0], personId: string, purpose: 'INITIAL' | 'REHIRE' = 'INITIAL') =>
  recordIdentityVerification(c, { personId, purpose, method: 'IN_PERSON_DOCUMENT', documentType: 'Passport', evidenceRef: `HR-${randomUUID()}`, occurredAt: '2026-01-05T09:00:00Z' });

describe('identity verification before credentials (DI-15)', () => {
  it('[DI-15] an account without an identity-verification record cannot be activated or given a secret', async () => {
    const accountId = await asAdmin(async (c) => {
      const personId = await createPerson(c, 'NATURAL', 'Unverified Person');
      return createAccount(c, { personId, loginName: login(), kind: 'HUMAN' });
    });
    await expectRefused(asAdmin((c) => activateAccount(c, accountId)), 'EBMR-IAM-013', /identity-verification/);
    await expectRefused(asAdmin((c) => issueInitialSecret(c, accountId, 'PASSWORD')), 'EBMR-IAM-013');
    const { rows } = await db.app.query<{ status: string }>('select status from iam.account where id = $1', [accountId]);
    expect(rows[0]?.status).toBe('PENDING_ACTIVATION');
  });

  it('[DI-15] the verification records who verified, the method, document type, evidence and when', async () => {
    const { personId, ivId } = await asAdmin(async (c) => {
      const p = await createPerson(c, 'NATURAL', 'Verified Person');
      return { personId: p, ivId: await verify(c, p) };
    });
    const { rows } = await db.app.query<Record<string, unknown>>('select * from iam.identity_verification where id = $1', [ivId]);
    expect(rows[0]).toMatchObject({ person_id: personId, verified_by_person: adm.admin.personId, method: 'IN_PERSON_DOCUMENT', document_type: 'Passport' });
    expect(rows[0]?.['evidence_ref']).toMatch(/^HR-/);
    expect(rows[0]?.['recorded_at']).toBeInstanceOf(Date);
    const audit = await db.app.query("select 1 from kernel.audit_event where chain_key = $1 and table_name = 'iam.identity_verification'", [`person:${personId}`]);
    expect(audit.rowCount).toBe(1);
  });

  it('[DI-15] nobody verifies their own identity, and a check cannot be dated in the future', async () => {
    await expectRefused(asAdmin((c) => verify(c, adm.admin.personId)), 'EBMR-IAM-012');
    await expectRefused(
      asAdmin(async (c) => {
        const p = await createPerson(c, 'NATURAL', 'Future Check');
        return recordIdentityVerification(c, { personId: p, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Passport', evidenceRef: 'X', occurredAt: '2999-01-01T00:00:00Z' });
      }),
      'EBMR-IAM-012',
    );
  });
});

describe('user IDs are never reused (DI-15, INV-27)', () => {
  it('[DI-15][INV-27] creating an account with a deactivated user\'s ID is refused, whatever the letter case', async () => {
    const name = login('leaver');
    const accountId = await asAdmin(async (c) => {
      const p = await createPerson(c, 'NATURAL', 'Former Employee');
      await verify(c, p);
      const a = await createAccount(c, { personId: p, loginName: name, kind: 'HUMAN' });
      await activateAccount(c, a);
      return a;
    });
    await asAdmin((c) => deactivateAccount(c, accountId, 'left the company'));
    const other = await asAdmin((c) => createPerson(c, 'NATURAL', 'New Joiner'));
    await expectRefused(asAdmin((c) => createAccount(c, { personId: other, loginName: name, kind: 'HUMAN' })), 'EBMR-IAM-021', /never issued again/);
    await expectRefused(asAdmin((c) => createAccount(c, { personId: other, loginName: name.toUpperCase(), kind: 'HUMAN' })), 'EBMR-IAM-021');
  });

  it('[INV-27][DI-16] a rehired person keeps the same person record, needs a new identity check and gets a new login name', async () => {
    const name = login('rehire');
    const { personId, accountId } = await asAdmin(async (c) => {
      const p = await createPerson(c, 'NATURAL', 'Returning Contractor', `EMP-${randomUUID()}`);
      await verify(c, p);
      const a = await createAccount(c, { personId: p, loginName: name, kind: 'HUMAN' });
      await activateAccount(c, a);
      return { personId: p, accountId: a };
    });
    await asAdmin((c) => processLeaver(c, personId, 'contract ended'));
    await asAdmin((c) => c.query("select iam.rehire_person($1, 'new contract')", [personId]));
    await expectRefused(asAdmin((c) => createAccount(c, { personId, loginName: name, kind: 'HUMAN' })), 'EBMR-IAM-021');
    const second = await asAdmin((c) => createAccount(c, { personId, loginName: `${name}-2`, kind: 'HUMAN' }));
    await expectRefused(asAdmin((c) => activateAccount(c, second)), 'EBMR-IAM-013');
    await asAdmin(async (c) => {
      await verify(c, personId, 'REHIRE');
      await activateAccount(c, second);
    });
    const { rows } = await db.app.query<{ id: string; status: string }>('select id, status from iam.account where person_id = $1 order by created_at', [personId]);
    expect(rows).toEqual([{ id: accountId, status: 'DISABLED' }, { id: second, status: 'ACTIVE' }]);
  });

  it('[INV-27] bypass: the identifier register cannot be changed or emptied, even by the table owner', async () => {
    await expectPermissionDenied(db.app.query("insert into iam.issued_identifier (identifier, account_id) values ('free-name', gen_random_uuid())"));
    await expectPermissionDenied(db.app.query('delete from iam.issued_identifier'));
    await expectPermissionDenied(db.app.query("update iam.issued_identifier set identifier = 'x' || identifier"));
    await expect(db.admin.query('delete from iam.issued_identifier')).rejects.toThrow('EBMR-AUDIT-004');
    await expect(db.admin.query('truncate iam.issued_identifier cascade')).rejects.toThrow(/EBMR-AUDIT-004|EBMR-IAM-005/);
  });
});

describe('accounts are personal, unique and never deleted (INV-11)', () => {
  it('[INV-11] a person has at most one live GMP-capable account', async () => {
    const op = await seedActor(db);
    await expectRefused(asAdmin((c) => createAccount(c, { personId: op.personId, loginName: login(), kind: 'HUMAN' })), 'EBMR-IAM-024');
    // A read-only display account for the same person is not GMP-capable and is allowed.
    await asAdmin((c) => createAccount(c, { personId: op.personId, loginName: login('display'), kind: 'READONLY_DISPLAY' }));
  });

  it('[INV-11] bypass: the unique index holds even for a raw insert by the table owner with the guard trigger off', async () => {
    const op = await seedActor(db);
    const id = randomUUID();
    const name = login('raw');
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify({ person_id: randomUUID(), correlation_id: randomUUID() })]);
        await c.query('insert into iam.issued_identifier (identifier, account_id) values ($1, $2)', [name, id]);
        await c.query('alter table iam.account disable trigger aa_account_guard');
        await c.query("insert into iam.account (id, person_id, login_name, kind) values ($1, $2, $3, 'HUMAN')", [id, op.personId, name]);
      }),
    ).rejects.toThrow(/account_one_gmp_account_per_person/);
  });

  it('[INV-11] bypass: accounts and persons are never deleted, by the application or by the table owner', async () => {
    const op = await seedActor(db);
    await expectPermissionDenied(db.app.query('delete from iam.account where id = $1', [op.accountId]));
    await expectPermissionDenied(db.app.query('delete from iam.person where id = $1', [op.personId]));
    await expectPermissionDenied(db.app.query("update iam.account set status = 'ACTIVE'"));
    await expect(db.admin.query('delete from iam.account where id = $1', [op.accountId])).rejects.toThrow('EBMR-IAM-005');
    await expect(db.admin.query('delete from iam.person where id = $1', [op.personId])).rejects.toThrow('EBMR-IAM-005');
    await expect(db.admin.query('truncate iam.account cascade')).rejects.toThrow('EBMR-IAM-005');
  });

  it('[INV-11][DI-18] nobody creates or administers their own account', async () => {
    await expectRefused(asAdmin((c) => createAccount(c, { personId: adm.admin.personId, loginName: login('self'), kind: 'READONLY_DISPLAY' })), 'EBMR-IAM-003');
    await expectRefused(asAdmin((c) => c.query("select iam.suspend_account($1, 'x')", [adm.admin.accountId])), 'EBMR-IAM-003');
    await expectRefused(asAdmin((c) => issueInitialSecret(c, adm.admin.accountId, 'PASSWORD')), 'EBMR-IAM-003');
  });

  it('[DI-14] service and integration accounts belong to system identities, people\'s accounts to natural persons', async () => {
    await expectRefused(
      asAdmin(async (c) => {
        const p = await createPerson(c, 'NATURAL', 'Person With Service Account');
        return createAccount(c, { personId: p, loginName: login('svc'), kind: 'SERVICE' });
      }),
      'EBMR-IAM-027',
    );
  });
});

describe('initial and reset secrets (DI-15)', () => {
  it('[DI-15] signing with an admin-reset password before changing it is refused', async () => {
    const op = await seedActor(db);
    const { secret: reset } = await asAdmin((c) => issueInitialSecret(c, op.accountId, 'PASSWORD'));
    const authn = seedAuthn(db);
    const challenge = randomUUID();
    const ev = await authenticate(authn, { method: 'PASSWORD', identifier: op.seed.loginName, secret: reset, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'SIGNATURE', challengeId: challenge });
    expect(ev).toMatchObject({ restricted: true, purpose: 'CREDENTIAL_CHANGE' });
    await expectRefused(asDefinerCommand(db, op, (c) => c.query('select iam.assert_can_sign($1)', [op.accountId])), 'EBMR-IAM-054', /SECRET_MUST_BE_CHANGED/);
    await expectRefused(
      asDefinerCommand(db, op, (c) => c.query("select iam.consume_auth_event($1, $2, $3, interval '120 seconds')", [ev.authEventId, op.personId, challenge])),
      'EBMR-IAM-096',
    );
    // The old password no longer works at all, and the reset one opens no session.
    await expect(authenticate(authn, { method: 'PASSWORD', identifier: op.seed.loginName, secret: op.seed.password, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' })).rejects.toThrow(AuthenticationFailedError);
    await expectRefused(db.app.query('select iam.open_session($1, $2)', [ev.authEventId, op.seed.deviceFingerprint]), 'EBMR-IAM-052');
  });

  it('[DI-15] an initial secret is single-use: a second use fails and alerts the security unit', async () => {
    const op = await seedActor(db);
    const { secret } = await asAdmin((c) => issueInitialSecret(c, op.accountId, 'PASSWORD'));
    const authn = seedAuthn(db);
    const req = { method: 'PASSWORD' as const, identifier: op.seed.loginName, secret, deviceFingerprint: op.seed.deviceFingerprint, purpose: 'LOGIN' as const };
    await authenticate(authn, req);
    const second = authenticate(authn, req);
    await expect(second).rejects.toMatchObject({ reason: 'INITIAL_SECRET_ALREADY_USED' });
    const { rows } = await db.app.query("select 1 from iam.security_alert where account_id = $1 and kind = 'INITIAL_SECRET_REUSE'", [op.accountId]);
    expect(rows).toHaveLength(1);
  });

  it('[DI-15] after changing the secret the account can sign, with its own authentication only (no proxy signing)', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER' });
    const other = await seedActor(db, { roleCode: 'VERIFIER' });
    await asDefinerCommand(db, op, (c) => c.query('select iam.assert_can_sign($1)', [op.accountId]));
    const challenge = randomUUID();
    const ev = await freshAuthEvent(db, op, 'SIGNATURE', challenge);
    await expectRefused(
      asDefinerCommand(db, other, (c) => c.query("select iam.consume_auth_event($1, $2, $3, interval '120 seconds')", [ev, other.personId, challenge])),
      'EBMR-IAM-093',
      /no proxy signing/,
    );
    const used = await asDefinerCommand(db, op, async (c) => {
      const { rows } = await c.query<{ r: { person_id: string; components: string[] } }>("select iam.consume_auth_event($1, $2, $3, interval '120 seconds') as r", [ev, op.personId, challenge]);
      return rows[0]?.r;
    });
    expect(used).toMatchObject({ person_id: op.personId, components: ['USER_ID', 'PASSWORD'] });
  });

  it('[DI-15] a missing 21 CFR 11.100(c) certification blocks US-market issue in BLOCK mode and only flags it in FLAG mode', async () => {
    const entity = `ENTITY-${randomBytes(3).toString('hex')}`;
    await expectRefused(db.app.query('select iam.assert_us_esig_certification($1)', [entity]), 'EBMR-IAM-170');
    await withCommand(db.app, withReason(adm.owner), (c) => c.query("select iam.record_us_esig_certification($1, 'LTR-2026-01', date '2026-03-01')", [entity]));
    const on = await db.app.query<{ r: { on_file: boolean; blocking: boolean } }>('select iam.assert_us_esig_certification($1) as r', [entity]);
    expect(on.rows[0]?.r).toMatchObject({ on_file: true, blocking: false });
    await withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => c.query("select iam.set_policy('esig.us_certification_mode', 'FLAG', 'expert chose the catalog position')"));
    const flagged = await db.app.query<{ r: { on_file: boolean; blocking: boolean; mode: string } }>("select iam.assert_us_esig_certification('OTHER-ENTITY') as r");
    expect(flagged.rows[0]?.r).toMatchObject({ on_file: false, blocking: false, mode: 'FLAG' });
    await withCommand(db.app, withReason(adm.admin, 'POLICY_CHANGE'), (c) => c.query("select iam.set_policy('esig.us_certification_mode', 'BLOCK', 'restore outline default')"));
  });

  it('[DI-15] verifiers are argon2id with at least baseline parameters; plaintext or weak hashes are refused', async () => {
    const op = await seedActor(db);
    await expectRefused(asAdmin((c) => c.query("select iam.issue_credential($1, 'PASSWORD', 'Secret123!')", [op.accountId])), 'EBMR-IAM-050');
    const weak = (await hashSecret('whatever-secret')).replace('m=19456', 'm=4096');
    await expectRefused(asAdmin((c) => c.query("select iam.issue_credential($1, 'PASSWORD', $2)", [op.accountId, weak])), 'EBMR-IAM-050');
  });
});
