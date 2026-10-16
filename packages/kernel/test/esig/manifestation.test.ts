/**
 * DI-36 signature manifestation: every human-readable form (screen, print, PDF, export) shows the
 * printed name as at signing, the user ID, the role, the date and time with UTC offset and site
 * zone, and the meaning. The manifestation is stored with the signature when it is applied and is
 * never re-derived from the user tables, so a later rename leaves historic signatures unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { getManifestation, manifestationExport, renderManifestation } from '../../src/esig/manifestation.ts';
import { renamePerson, setPolicy as setIamPolicy } from '../../src/identity/admin.ts';
import { seedAdministration, withReason } from '../identity/seed.ts';
import { ensureFixtureChangeRecord, underChange } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  asSuperuserTransaction,
  correctStub,
  createStub,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  signStub,
  testActor,
} from './helpers.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await ensureSealKey(db);
  await ensureFixtureChangeRecord(db);
});

afterAll(async () => {
  await db.drop();
});

describe('manifestation elements (DI-36)', () => {
  it('[DI-36] sign a step, then view it on screen, in the print and PDF rendering and in the export: every element appears', async () => {
    const op = await testActor(db, { legalName: 'Ravi Kumar Sharma' });
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    const stored = await getManifestation(db.app, sig.signatureId);
    const m = stored.manifestation;
    const expected = (await db.admin.query<{ local: string; utc: string }>(
      `select to_char(recorded_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') as local,
              to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as utc
         from esig.signature where id = $1`, [sig.signatureId])).rows[0];
    expect(m).toMatchObject({
      printedName: 'Ravi Kumar Sharma', userId: op.seed.loginName, roleCode: 'OPERATOR', roleName: 'Production operator',
      meaningCode: 'PERFORMED', meaningTitle: 'Performed', meaningText: 'I performed this step and recorded its data.',
      utcOffset: '+05:30', siteZone: 'Asia/Kolkata', signedAtLocal: expected?.local, signedAtUtc: expected?.utc,
    });
    const elements = ['Ravi Kumar Sharma', op.seed.loginName, 'Production operator', 'Performed', 'I performed this step and recorded its data.',
      `${m.signedAtLocal} UTC+05:30 (Asia/Kolkata)`];
    for (const medium of ['SCREEN', 'PRINT', 'PDF'] as const) {
      const text = renderManifestation(stored, medium).join('\n');
      for (const e of elements) expect(text, `${medium} shows ${e}`).toContain(e);
    }
    expect(manifestationExport(stored)).toMatchObject({
      printed_name: 'Ravi Kumar Sharma', user_id: op.seed.loginName, role_name: 'Production operator', meaning_title: 'Performed',
      meaning_text: 'I performed this step and recorded its data.', signed_at_local: m.signedAtLocal, utc_offset: '+05:30',
      site_zone: 'Asia/Kolkata', signed_at_utc: expected?.utc, status: 'VALID', valid: true,
    });
    for (const e of elements.slice(0, 5)) expect(stored.text).toContain(e);
    expect(sig.manifestationText).toBe(stored.text);
  });

  it('[DI-36] rename the user: historic signatures keep the original name, new signatures show the new one', async () => {
    const { admin } = await seedAdministration(db);
    const op = await testActor(db, { legalName: 'Priya Nair' });
    const id = await createStub(db, op);
    const before = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await withCommand(db.app, withReason(admin, 'NAME_CHANGE', 'marriage certificate MC-7'), (c) => renamePerson(c, op.personId, 'Priya Menon'));
    const renamed = { ...op, legalName: 'Priya Menon' };
    const historic = await getManifestation(db.app, before.signatureId);
    expect(historic.manifestation.printedName).toBe('Priya Nair');
    expect(historic.text).toContain('Priya Nair');
    expect(renderManifestation(historic, 'PDF').join('\n')).toContain('Signed by: Priya Nair');
    const id2 = await createStub(db, renamed);
    const after = await signStub(db, renamed, id2, { meaning: 'PERFORMED' });
    expect((await getManifestation(db.app, after.signatureId)).manifestation.printedName).toBe('Priya Menon');
  });

  it('[DI-36] a superseded signature is never rendered as a valid one', async () => {
    const op = await testActor(db);
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await correctStub(db, op, id, '12.999');
    const stored = await getManifestation(db.app, sig.signatureId);
    expect(stored.status).toBe('SUPERSEDED_BY_CHANGE');
    expect(renderManifestation(stored, 'SCREEN').join('\n')).toMatch(/SUPERSEDED BY CHANGE - this element is unsigned/);
    expect(renderManifestation(stored, 'PRINT').join('\n')).toMatch(/Status: SUPERSEDED BY CHANGE/);
    expect(manifestationExport(stored)).toMatchObject({ status: 'SUPERSEDED_BY_CHANGE', valid: false });
  });

  it('[DI-36] a co-signature shows the co-signer, never the owner of the terminal session', async () => {
    const performer = await testActor(db, { deviceClass: 'SHARED', withPin: true, legalName: 'Session Owner' });
    const verifier = await testActor(db, { roleCode: 'VERIFIER', deviceClass: 'SHARED', withPin: true, legalName: 'Second Person' });
    const id = await createStub(db, performer);
    const sig = await signStub(db, performer, id, { meaning: 'VERIFIED', signer: verifier, method: 'BADGE_PIN' });
    const stored = await getManifestation(db.app, sig.signatureId);
    expect(stored.manifestation).toMatchObject({ printedName: 'Second Person', userId: verifier.seed.loginName, roleCode: 'VERIFIER', cosignature: true });
  });

  it('[DI-36] the date and time use the configured site zone and its offset; a command declaring another zone cannot sign', async () => {
    const { admin } = await seedAdministration(db);
    // Everything that runs commands in the Indian site zone happens before the switch.
    const op = await testActor(db);
    const id = await createStub(db, op);
    try {
      await withCommand(db.app, underChange(withReason({ ...admin, siteZone: 'Asia/Kolkata' })), (c) => setIamPolicy(c, 'site.zone', 'Europe/Berlin', 'test: site in the EU'));
      // A command still declaring the old zone is refused when it starts (DI-27), so it cannot sign.
      await expectRefused(signStub(db, op, id, { meaning: 'PERFORMED' }), 'EBMR-IAM-118', /declares the time zone Asia\/Kolkata/);
      const berlin = { ...op, siteZone: 'Europe/Berlin' };
      const sig = await signStub(db, berlin, id, { meaning: 'PERFORMED' });
      const expected = (await db.admin.query<{ local: string }>(
        `select to_char(recorded_at at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as local from esig.signature where id = $1`,
        [sig.signatureId])).rows[0];
      expect(sig.manifestation.siteZone).toBe('Europe/Berlin');
      expect(['+01:00', '+02:00']).toContain(sig.manifestation.utcOffset);
      expect(sig.manifestation.signedAtLocal).toBe(expected?.local);
    } finally {
      // Back to the Indian site, declaring whatever zone is in force now, so a failure above never
      // leaves the policy switched for the tests that follow.
      const zone = (await db.admin.query<{ z: string }>("select iam.policy_text('site.zone') as z")).rows[0]?.z ?? 'Asia/Kolkata';
      if (zone !== 'Asia/Kolkata') {
        await withCommand(db.app, underChange(withReason({ ...admin, siteZone: zone })), (c) => setIamPolicy(c, 'site.zone', 'Asia/Kolkata', 'test: back to the Indian site'));
      }
    }
  });
});

describe('the manifestation is stored immutably (DI-36)', () => {
  it('[DI-36] nobody can change a stored manifestation, and a change made by a superuser is detected', async () => {
    const op = await testActor(db, { legalName: 'Original Name' });
    const id = await createStub(db, op);
    const sig = await signStub(db, op, id, { meaning: 'PERFORMED' });
    await expectPermissionDenied(db.app.query("update esig.signature set signer_legal_name = 'Forged' where id = $1", [sig.signatureId]));
    await asSuperuserTransaction(db, async (c) => {
      await c.query('set local role ebmr_owner');
      await expectRefused(c.query("update esig.signature set manifestation_text = 'Forged' where id = $1", [sig.signatureId]), 'EBMR-AUDIT-004');
    });
    const c = await db.admin.connect();
    try {
      await c.query('set session_replication_role = replica');
      await c.query(
        `update esig.signature set signer_legal_name = 'Forged Name', manifestation = jsonb_set(manifestation, '{printed_name}', '"Forged Name"'),
                                   manifestation_text = replace(manifestation_text, 'Original Name', 'Forged Name') where id = $1`, [sig.signatureId]);
    } finally {
      await c.query('set session_replication_role = origin');
      c.release();
    }
    const { rows } = await db.app.query<{ problem: string }>('select p as problem from esig.signature_problems($1) p', [sig.signatureId]);
    expect(rows.map((r) => r.problem.split(':')[0])).toContain('SEAL_PAYLOAD_MISMATCH');
  });
});
