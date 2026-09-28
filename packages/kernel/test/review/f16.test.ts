/**
 * Review reproducer F16: a non-canonical spelling of an aggregate id (here the stub's UUID in upper
 * case) is a second identity for the same record. esig.create_challenge stores p_aggregate_id as the
 * caller passed it; esig.stub_content casts it with ::uuid, so the alias resolves to the same row.
 * Everything that relates signatures to the record compares the aggregate_ref text
 * (performers_of, check_independence "already holds" and independent_of, aggregate_lock,
 * content_changed, record_signatures, invariant_violations), and the esig.content_change and
 * performer signature rows carry the canonical lower-case id.
 *
 * Scenario (INV-03: a verifier or witness is never a person who performed, entered data in or
 * corrected the record):
 *   1. op (OPERATOR, also granted VERIFIER) enters a step and signs PERFORMED.
 *   2. Positive control: op, acting as VERIFIER, signs VERIFIED on the canonical id -> EBMR-ESIG-044.
 *   3. The alias resolves to the same record (same content version and content).
 *   4. op, acting as VERIFIER, runs content_for_signing / create_challenge / sign with the id in
 *      upper case and meaning VERIFIED.
 *
 * Safe behaviour asserted: step 4 is refused (either the alias is not accepted as an aggregate id,
 * or INV-03 is evaluated against the record and refuses op), and no VERIFIED signature by the
 * performer exists on the record under any spelling. With the defect the database stores a sealed
 * VERIFIED signature by the performer, esig.record_signatures lists it as VALID under the alias,
 * and esig.invariant_violations() reports no INV-03 row for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { decideRoleGrant, requestRoleGrant } from '../../src/identity/admin.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { createStub, ensureSealKey, expectRefused, signStub, testActor } from '../esig/helpers.ts';
import type { SignatureResult } from '../../src/esig/signing.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
});

afterAll(async () => {
  await db.drop();
});

/** Gives the person's account a second role (requested by the administrator, approved by the process owner). */
async function grantRole(actor: SeededActor, roleCode: string): Promise<void> {
  const { admin, owner } = await seedAdministration(db);
  const grantId = await withCommand(db.app, withReason(admin), (c) => requestRoleGrant(c, { accountId: actor.accountId, roleCode, reason: 'second duty for test' }));
  await withCommand(db.app, withReason(owner), (c) => decideRoleGrant(c, grantId, true, 'approved for test'));
}

const as = (actor: SeededActor, roleCode: string): SeededActor => ({ ...actor, roleCode });

describe('F16: a non-canonical aggregate id is not a second identity for the record', () => {
  it('[INV-03][DI-35][INV-09] the performer cannot verify their own step by spelling its id in upper case', async () => {
    // 1. The performer enters the step and signs PERFORMED.
    const op = await testActor(db, { legalName: 'Alias Dual Role Person' });
    await grantRole(op, 'VERIFIER');
    const id = await createStub(db, op, { title: 'Granulation: binder added (F16)', value: '12.503', unit: 'kg' });
    await signStub(db, op, id, { meaning: 'PERFORMED' });

    // 2. Positive control: on the canonical id INV-03 refuses the performer as verifier.
    await expectRefused(signStub(db, as(op, 'VERIFIER'), id, { meaning: 'VERIFIED' }), 'EBMR-ESIG-044', /INV-03/);

    // 3. The alias names the same record: the provider returns the same version and content.
    const alias = id.toUpperCase();
    expect(alias).not.toBe(id);
    const { rows: prov } = await db.admin.query<{ canon: Record<string, unknown>; aliased: Record<string, unknown> }>(
      "select esig.provide('esig_stub', $1) as canon, esig.provide('esig_stub', $2) as aliased",
      [id, alias],
    );
    expect(prov[0]?.canon['exists']).toBe(true);
    expect(prov[0]?.aliased['content']).toEqual(prov[0]?.canon['content']);
    expect(prov[0]?.aliased['content_version']).toEqual(prov[0]?.canon['content_version']);

    // 4. The same person, as VERIFIER, signs VERIFIED on the alias.
    let accepted: SignatureResult | undefined;
    let refusal: unknown;
    try {
      accepted = await signStub(db, as(op, 'VERIFIER'), alias, { meaning: 'VERIFIED' });
    } catch (error) {
      refusal = error;
    }

    // Evidence gathered from the database (superuser read) whatever the outcome.
    const { rows: verifiedByPerformer } = await db.admin.query<{ id: string; aggregate_id: string }>(
      "select id, aggregate_id from esig.signature where aggregate_type = 'esig_stub' and lower(aggregate_id) = lower($1) and meaning_code = 'VERIFIED' and signer_person = $2",
      [id, op.personId],
    );
    const { rows: listed } = await db.admin.query<{ meaning_code: string; status: string; valid: boolean }>(
      "select meaning_code, status, valid from esig.record_signatures('esig_stub', $1) where meaning_code = 'VERIFIED'",
      [alias],
    );
    const { rows: inv03 } = await db.admin.query<{ signature_id: string }>(
      "select signature_id from esig.invariant_violations() where invariant = 'INV-03'",
    );

    expect(
      {
        acceptedSignatureId: accepted?.signatureId ?? null,
        verifiedByPerformerOnRecord: verifiedByPerformer,
        listedAsValidUnderAlias: listed,
      },
      `INV-03 bypass: VERIFIED by the performer accepted under alias ${alias}; INV-03 invariant rows: ${JSON.stringify(inv03)}`,
    ).toEqual({ acceptedSignatureId: null, verifiedByPerformerOnRecord: [], listedAsValidUnderAlias: [] });

    // The refusal is a database refusal, not an error in the test.
    const message = refusal instanceof Error ? refusal.message : String(refusal);
    expect(message).toMatch(/EBMR-ESIG-/);
  });
});
