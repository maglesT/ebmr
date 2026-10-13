/**
 * Qualification register stand-in, stored authority evaluations, signing readiness, signature
 * register and delegation (INV-26, DI-21, DI-17).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { acknowledgeEsigPolicy, decideRoleGrant, recordQualification, renamePerson, requestRoleGrant, revokeRoleGrant } from '../../src/identity/admin.ts';
import { evaluateAuthority, requirePermission } from '../../src/identity/authority.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asSuperuserTransaction, asTimeTraveller, dbNow, expectPermissionDenied, expectRefused, pause } from './helpers.ts';
import { seedActor, seedAdministration, withReason, type SeedAdministration, type SeededActor } from './seed.ts';

let db: TestDatabase;
let adm: SeedAdministration;
let tc: SeededActor;
beforeAll(async () => {
  db = await createTestDatabase();
  adm = await seedAdministration(db);
  tc = await seedActor(db, { roleCode: 'TRAINING_COORDINATOR', acknowledgeEsig: false });
});
afterAll(async () => {
  await db.drop();
});

type Work<T> = Parameters<typeof withCommand<T>>[2];
const asAdmin = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.admin), work);
const asOwner = <T>(work: Work<T>) => withCommand(db.app, withReason(adm.owner), work);
const asTraining = <T>(work: Work<T>) => withCommand(db.app, withReason(tc), work);

/** A qualification type required, at one site only, for the given permissions. */
async function requirement(site: string, permissions: string[]): Promise<string> {
  const code = `SOP-${randomBytes(3).toString('hex').toUpperCase()}`;
  await asTraining(async (c) => {
    await c.query("select iam.create_qualification_type($1, 'Production SOP', 'current version of the production SOP')", [code]);
    for (const p of permissions) {
      await c.query("select iam.add_qualification_requirement($1, null, $2, $3::jsonb, 'SOP training before acting')", [code, p, JSON.stringify({ site })]);
    }
  });
  return code;
}

async function grant(account: string, role: string, scope: object): Promise<void> {
  const id = await asAdmin((c) => requestRoleGrant(c, { accountId: account, roleCode: role, scope, reason: 'test' }));
  await asOwner((c) => decideRoleGrant(c, id, true, 'approved'));
}

const plusSeconds = (iso: string, s: number): string => new Date(new Date(iso).getTime() + s * 1000).toISOString();

describe('qualification at the moment of action (DI-21, INV-26)', () => {
  it('[DI-21][INV-26][PR-15] expiring a user\'s SOP training blocks both execution and verification and names the missing item', async () => {
    const site = `SITE-Q${randomBytes(2).toString('hex')}`;
    const code = await requirement(site, ['STEP.EXECUTE', 'STEP.VERIFY']);
    const op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
    await grant(op.accountId, 'VERIFIER', { site });
    const check = (permission: string) => evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission, scope: { site } });
    expect(await check('STEP.EXECUTE')).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });
    const now = await dbNow(db);
    await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: plusSeconds(now, -86400), validTo: plusSeconds(now, 2) }));
    expect(await check('STEP.EXECUTE')).toMatchObject({ allowed: true });
    expect(await check('STEP.VERIFY')).toMatchObject({ allowed: true });
    await pause(2100);
    expect(await check('STEP.EXECUTE')).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });
    expect(await check('STEP.VERIFY')).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });
    await expectRefused(withCommand(db.app, op, (c) => requirePermission(c, 'STEP.EXECUTE', { site })), 'EBMR-IAM-040', new RegExp(`MISSING_QUALIFICATION:${code}`));
    // Elsewhere (no requirement at that site) the same person may still act.
    await grant(op.accountId, 'OPERATOR', { site: 'SITE-1' });
    expect((await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site: 'SITE-1' } })).allowed).toBe(true);
  });

  it('[INV-26] every evaluation is stored with the instant, the grant and the qualification evidence it used', async () => {
    const site = `SITE-Q${randomBytes(2).toString('hex')}`;
    const code = await requirement(site, ['STEP.EXECUTE']);
    const op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
    const now = await dbNow(db);
    const pq = await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: plusSeconds(now, -3600) }));
    const d = await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site } });
    const { rows } = await db.app.query('select * from iam.authority_evaluation where id = $1', [d.evaluationId]);
    const row = rows[0] as { allowed: boolean; role_code: string; grant_id: string; scope: object; inputs: { grants: { grant_id: string }[]; qualifications: Record<string, unknown>[] } };
    expect(row).toMatchObject({ allowed: true, role_code: 'OPERATOR', grant_id: op.seed.grantId, scope: { site } });
    expect(row.inputs.grants.map((g) => g.grant_id)).toEqual([op.seed.grantId]);
    expect(row.inputs.qualifications).toEqual([
      expect.objectContaining({ qualification_code: code, person_qualification_id: pq, satisfied: true, source: 'INTERNAL', source_fresh: true }),
    ]);
  });

  it('[INV-26] bypass: a qualification recorded late does not make an earlier instant authorised', async () => {
    const site = `SITE-Q${randomBytes(2).toString('hex')}`;
    const code = await requirement(site, ['STEP.EXECUTE']);
    const op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
    const before = await dbNow(db);
    await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: '2026-01-01T00:00:00Z' }));
    const at = (t?: string) => evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site }, ...(t ? { at: t } : {}) });
    expect(await at(before)).toMatchObject({ allowed: false, reasons: [`MISSING_QUALIFICATION:${code}`] });
    expect(await at()).toMatchObject({ allowed: true });
  });

  it('[INV-26] mirrored qualification data outside its freshness bound fails closed', async () => {
    const site = `SITE-Q${randomBytes(2).toString('hex')}`;
    const code = await requirement(site, ['STEP.EXECUTE']);
    const op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
    await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: '2026-01-01T00:00:00Z', source: 'LMS', sourceRef: 'LMS-778' }));
    const check = () => evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site } });
    expect(await check()).toMatchObject({ allowed: false, reasons: [`STALE_QUALIFICATION_SOURCE:${code}`] });
    await asTraining((c) => c.query("select iam.record_mirror_heartbeat('LMS')"));
    expect(await check()).toMatchObject({ allowed: true });
    await asTimeTraveller(db, "update iam.mirror_heartbeat set last_synced_at = clock_timestamp() - interval '2 days' where source_code = 'LMS'");
    expect(await check()).toMatchObject({ allowed: false, reasons: [`STALE_QUALIFICATION_SOURCE:${code}`] });
  });

  it('[INV-26] a withdrawn qualification stops counting at the withdrawal instant, not before', async () => {
    const site = `SITE-Q${randomBytes(2).toString('hex')}`;
    const code = await requirement(site, ['STEP.EXECUTE']);
    const op = await seedActor(db, { scope: { site }, acknowledgeEsig: false });
    const pq = await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: '2026-01-01T00:00:00Z' }));
    const before = await dbNow(db);
    await asTraining((c) => c.query("select iam.withdraw_qualification($1, 'failed requalification')", [pq]));
    const at = (t?: string) => evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'STEP.EXECUTE', scope: { site }, ...(t ? { at: t } : {}) });
    expect(await at(before)).toMatchObject({ allowed: true });
    expect(await at()).toMatchObject({ allowed: false });
  });

  it('[INV-26] bypass: qualifications and stored evaluations cannot be forged or altered', async () => {
    const op = await seedActor(db, { acknowledgeEsig: false });
    await expectPermissionDenied(
      db.app.query("insert into iam.person_qualification (person_id, qualification_code, source_code, valid_from, recorded_by_person, recorded_by_account) values ($1, 'X', 'INTERNAL', now(), gen_random_uuid(), gen_random_uuid())", [op.personId]),
    );
    await expectPermissionDenied(
      db.app.query("insert into iam.authority_evaluation (at_instant, person_id, account_id, permission_code, scope, allowed, reasons, inputs) values (now(), $1, $2, 'RELEASE.MANUFACTURER', '{}', true, '{}', '{}')", [op.personId, op.accountId]),
    );
    const d = await evaluateAuthority(db.app, { personId: op.personId, accountId: op.accountId, permission: 'RELEASE.MANUFACTURER' });
    await expectPermissionDenied(db.app.query('update iam.authority_evaluation set allowed = true where id = $1', [d.evaluationId]));
    await expect(db.admin.query('update iam.authority_evaluation set allowed = true where id = $1', [d.evaluationId])).rejects.toThrow('EBMR-IAM-006');
    await expect(db.admin.query('delete from iam.authority_evaluation where id = $1', [d.evaluationId])).rejects.toThrow('EBMR-IAM-006');
    await expectRefused(asTraining((c) => recordQualification(c, { personId: tc.personId, qualification: 'X', validFrom: '2026-01-01T00:00:00Z' })), 'EBMR-IAM-003');
    const code = await requirement('SITE-Z', ['STEP.EXECUTE']);
    const pq = await asTraining((c) => recordQualification(c, { personId: op.personId, qualification: code, validFrom: '2026-01-01T00:00:00Z', validTo: '2026-02-01T00:00:00Z' }));
    await expectPermissionDenied(db.app.query("update iam.person_qualification set valid_to = null where id = $1", [pq]));
    await expect(
      asSuperuserTransaction(db, async (c) => {
        await c.query("select set_config('ebmr.ctx', $1, true)", [JSON.stringify({ person_id: randomUUID(), correlation_id: randomUUID(), reason_code: 'X' })]);
        await c.query('update iam.person_qualification set valid_to = null where id = $1', [pq]);
      }),
    ).rejects.toThrow('EBMR-IAM-160');
  });
});

describe('signing readiness and the signature register (DI-21)', () => {
  it('[DI-21] a new user cannot sign before acknowledging the e-signature accountability policy', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER', acknowledgeEsig: false });
    const can = async () => (await db.app.query<{ r: { can_sign: boolean; reasons: string[] } }>('select iam.can_sign($1) as r', [op.accountId])).rows[0]?.r;
    expect(await can()).toEqual(expect.objectContaining({ can_sign: false, reasons: ['ESIG_POLICY_NOT_ACKNOWLEDGED'] }));
    await expectRefused(db.app.query('select iam.assert_can_sign($1)', [op.accountId]), 'EBMR-IAM-054', /ESIG_POLICY_NOT_ACKNOWLEDGED/);
    await withCommand(db.app, op, (c) => acknowledgeEsigPolicy(c, 'T.V.'));
    expect(await can()).toEqual(expect.objectContaining({ can_sign: true, reasons: [] }));
    const ack = await db.app.query('select manifestation_name, initials, handwritten_equivalence, policy_version from iam.esig_acknowledgement where account_id = $1', [op.accountId]);
    expect(ack.rows).toEqual([{ manifestation_name: op.legalName, initials: 'T.V.', handwritten_equivalence: true, policy_version: 1 }]);
    const policy = await db.app.query<{ ok: boolean }>("select content_sha256 = encode(sha256(convert_to(statement, 'UTF8')), 'hex') as ok from iam.esig_policy");
    expect(policy.rows).toEqual([{ ok: true }]);
  });

  it('[DI-21] an archived signer resolves to the name and role valid on the signing date', async () => {
    const op = await seedActor(db, { roleCode: 'VERIFIER', acknowledgeEsig: false, legalName: 'Asha Verma' });
    await withCommand(db.app, op, (c) => acknowledgeEsigPolicy(c, 'A.V.'));
    const signedAt = await dbNow(db);
    await withCommand(db.app, withReason(adm.admin, 'NAME_CHANGE', 'marriage certificate'), (c) => renamePerson(c, op.personId, 'Asha Rao'));
    await asAdmin((c) => revokeRoleGrant(c, op.seed.grantId, 'moved to QC'));
    await asAdmin((c) => c.query("select iam.deactivate_account($1, 'left the company')", [op.accountId]));
    const at = async (t: string | null) => (await db.app.query<{ r: Record<string, unknown> }>('select iam.resolve_signer($1, $2) as r', [op.accountId, t ?? (await dbNow(db))])).rows[0]?.r;
    const then = await at(signedAt);
    expect(then).toMatchObject({ legal_name: 'Asha Verma', account_status: 'ACTIVE', roles: ['VERIFIER'] });
    expect(then?.['signing_permissions']).toEqual(expect.arrayContaining(['STEP.VERIFY', 'STEP.WITNESS']));
    expect(then?.['acknowledgement']).toMatchObject({ manifestation_name: 'Asha Verma', initials: 'A.V.', handwritten_equivalence: true });
    expect(await at(null)).toMatchObject({ legal_name: 'Asha Rao', account_status: 'DISABLED', roles: [], signing_permissions: [] });
    const register = await db.app.query('select legal_name, manifestation_name, roles from iam.signature_register($1) where account_id = $2', [signedAt, op.accountId]);
    expect(register.rows).toEqual([{ legal_name: 'Asha Verma', manifestation_name: 'Asha Verma', roles: ['VERIFIER'] }]);
  });
});

describe('delegation (DI-17: authority checked at the moment of action)', () => {
  it('[DI-17] a named delegate holds a delegation only as approved by someone else, within its window, meanings, scope and markets', async () => {
    const ap = await seedActor(db, { roleCode: 'AUTHORISED_PERSON', acknowledgeEsig: false });
    const deputy = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    const qaHead = await seedActor(db, { roleCode: 'QA_MBR_APPROVER', acknowledgeEsig: false });
    const now = await dbNow(db);
    const request = (by: ActorContext, delegate: string, meanings: string[]) =>
      withCommand(db.app, by, async (c) =>
        (await c.query<{ id: string }>("select iam.request_delegation($1, $2::jsonb, array['IN'], $3, $4::timestamptz, $5::timestamptz, 'SOP-QA-017', 'annual leave') as id", [
          delegate, JSON.stringify({ site: 'SITE-1' }), meanings, plusSeconds(now, -60), plusSeconds(now, 7 * 86400),
        ])).rows[0]?.id ?? '');
    const d = await request(ap, deputy.personId, ['MANUFACTURER_RELEASE']);
    const valid = async (overrides: { person?: string; meaning?: string; scope?: object; market?: string; at?: string } = {}) =>
      (await db.app.query<{ r: { valid: boolean; reasons: string[] } }>('select iam.delegation_valid($1, $2, $3, $4::jsonb, $5, $6::timestamptz) as r', [
        d, overrides.person ?? deputy.personId, overrides.meaning ?? 'MANUFACTURER_RELEASE', JSON.stringify(overrides.scope ?? { site: 'SITE-1' }),
        overrides.market ?? 'IN', overrides.at ?? null,
      ])).rows[0]?.r;
    expect(await valid()).toMatchObject({ valid: false, reasons: ['NOT_APPROVED'] });
    await expectRefused(withCommand(db.app, withReason(deputy), (c) => c.query("select iam.decide_delegation($1, true, 'ok')", [d])), 'EBMR-IAM-040');
    await withCommand(db.app, withReason(qaHead), (c) => c.query("select iam.decide_delegation($1, true, 'per SOP-QA-017')", [d]));
    expect(await valid()).toMatchObject({ valid: true, reasons: [] });
    expect(await valid({ meaning: 'MARKET_DISPOSITION_US' })).toMatchObject({ valid: false, reasons: ['MEANING_NOT_DELEGATED'] });
    expect(await valid({ scope: { site: 'SITE-2' } })).toMatchObject({ valid: false, reasons: ['SCOPE_NOT_COVERED'] });
    expect(await valid({ market: 'US' })).toMatchObject({ valid: false, reasons: ['MARKET_NOT_COVERED'] });
    expect(await valid({ person: qaHead.personId })).toMatchObject({ valid: false, reasons: ['NOT_THE_DELEGATE'] });
    expect(await valid({ at: plusSeconds(now, 8 * 86400) })).toMatchObject({ valid: false, reasons: ['OUTSIDE_VALIDITY_WINDOW'] });

    // No re-delegation, and the approver is never the delegator or the delegate.
    const third = await seedActor(db, { roleCode: 'QA_REVIEWER', acknowledgeEsig: false });
    await expectRefused(request(deputy, third.personId, ['MANUFACTURER_RELEASE']), 'EBMR-IAM-181');
    const own = await request(qaHead, third.personId, ['MBR_APPROVED']);
    await expectRefused(withCommand(db.app, withReason(qaHead), (c) => c.query("select iam.decide_delegation($1, true, 'mine')", [own])), 'EBMR-IAM-182');

    await withCommand(db.app, withReason(ap), (c) => c.query("select iam.revoke_delegation($1, 'back from leave')", [d]));
    expect(await valid()).toMatchObject({ valid: false, reasons: ['REVOKED'] });
  });
});
