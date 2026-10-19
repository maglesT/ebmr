/**
 * The master-record acts that had no screen, over HTTP (Phase 7 slice 7g-2, decision 0025):
 *  - the life-cycle signatures of a version (MBR_TRANSITION): Prepared by the author, Independently checked by a checker
 *    who is not the author, the regulatory confirmation, and Quality-unit approved by QA, never the author or checker;
 *  - the market authorisation (designer.proposeMarketAuthorisation, MBR_MARKET_ACT; recipe-core 0160, 0290; ADR 0014):
 *    QA proposes, the regulatory signer confirms, QA (another person) authorises and the record is ACTIVE; QA withdraws it
 *    with its own reason;
 *  - the labelling specimen (designer.specimens, SPECIMEN_ACT; tablets 1479): QA approves a specimen recorded by the
 *    steward, once; the person who recorded it is refused, even when they also hold QA's role.
 * Each refusal is the database's; an administrator is refused each command.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { identity, withCommand } from '@ebmr/kernel';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import type { World } from '../../../../packages/recipe-core/test/lifecycle/support.ts';
import { referenceContent, referenceHash } from '../../src/features/designer/reference-catalogue.ts';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import { gmpContent, gmpLifecycleWorld, LINE, SITE, BATCH_SIZE } from '../support/gmp-world.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { stewardActor } from './support.ts';

const D = routes.designer;
let server: TestServer;
let world: World;
let author: TestBrowser;
let checker: TestBrowser;
let regulatory: TestBrowser;
let qa: TestBrowser;
let admin: { b: TestBrowser; p: GrantedPerson };

beforeAll(async () => {
  server = await startSigningServer('GMP', { stub: false });
  world = await gmpLifecycleWorld(server);
  [author, checker, regulatory, qa] = await Promise.all([server.asPersona('author'), server.asPersona('checker'), server.asPersona('regulatory'), server.asPersona('approver')]);
  const p = await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ada Administrator');
  admin = { b: await loginOf(server, p), p };
}, 300_000);
afterAll(async () => {
  await server?.close();
});

const credsOf = (p: GrantedPerson) => ({ credentials: { kind: 'PASSWORD' as const, loginName: p.loginName, password: p.password } });

/** A version prepared and in verification, ready to be signed as prepared. */
async function inVerification(): Promise<{ versionId: string; familyId: string }> {
  const content = gmpContent();
  const v = await world.newVersion(content);
  await world.prepare(v.versionId, content);
  await world.startVerification(v.versionId);
  return { versionId: v.versionId, familyId: v.familyId };
}

const transition = async (versionId: string, t: 'SUBMIT' | 'CHECK' | 'APPROVE' | 'REGULATORY_CONFIRM'): Promise<SignableAction> => ({
  kind: 'MBR_TRANSITION', versionId, transition: t, baseRevision: valueOf(await author.call(D.version, { params: { versionId } })).revision,
});

describe('the life-cycle signatures of an MBR version (MBR_TRANSITION)', () => {
  it('[INV-04][DI-35] prepared by the author, checked by another person, confirmed and approved by QA; the author may not check, nor QA approve before the check', async () => {
    const { versionId } = await inVerification();
    const state = async () => valueOf(await qa.call(D.version, { params: { versionId } })).state;
    valueOf(await signAction(server, author, 'author', await transition(versionId, 'SUBMIT')));
    expect(await state()).toBe('SUBMITTED');
    // QA's approval before the check is refused (the version is not CHECKED); nothing is signed.
    expect((await signAction(server, qa, 'approver', await transition(versionId, 'APPROVE'))).ok).toBe(false);
    // The author may not sign the check of their own version.
    expect(refusalOf(await signAction(server, author, 'author', await transition(versionId, 'CHECK'))).why).toMatch(/MBR_AUTHOR may not sign CHECKED/);
    valueOf(await signAction(server, checker, 'checker', await transition(versionId, 'CHECK')));
    expect(await state()).toBe('CHECKED');
    valueOf(await signAction(server, regulatory, 'regulatory', await transition(versionId, 'REGULATORY_CONFIRM')));
    // The checker may not approve.
    expect((await signAction(server, checker, 'checker', await transition(versionId, 'APPROVE'))).ok).toBe(false);
    valueOf(await signAction(server, qa, 'approver', await transition(versionId, 'APPROVE')));
    expect(await state()).toBe('APPROVED');
    const sigs = valueOf(await qa.call(routes.esig.signatures, { query: { aggregateType: 'mbr_version', aggregateId: versionId } })).signatures;
    expect(sigs.filter((s) => s.valid).map((s) => [s.meaning, s.signer.loginName])).toEqual([
      ['PREPARED', 'asha.rao'], ['CHECKED', 'vikram.shah'], ['REGULATORY_CONFIRMED', 'rahul.menon'], ['APPROVED', 'meera.iyer'],
    ]);
  });
});

describe('market authorisations (ADR 0014)', () => {
  it('[PR-04][PR-05] QA proposes, the regulatory signer confirms, QA authorises (ACTIVE) and withdraws it with its own reason; the wrong person is refused at each step', async () => {
    const { versionId } = await inVerification();
    for (const [b, k, t] of [[author, 'author', 'SUBMIT'], [checker, 'checker', 'CHECK'], [regulatory, 'regulatory', 'REGULATORY_CONFIRM'], [qa, 'approver', 'APPROVE']] as const) {
      valueOf(await signAction(server, b, k, await transition(versionId, t)));
    }
    const body = { market: 'IN', kind: 'CURRENT' as const, cells: [{ site: SITE, line: LINE, batchSize: BATCH_SIZE }], regulatoryBasis: 'IN: registration on file' };
    // The author may not propose an authorisation (MBR.APPROVE), and an administrator may not either.
    expect(refusalOf(await author.call(D.proposeMarketAuthorisation, { params: { versionId }, body })).code).toMatch(/^EBMR-IAM-/);
    expect(refusalOf(await admin.b.call(D.proposeMarketAuthorisation, { params: { versionId }, body })).code).toMatch(/^EBMR-IAM-/);
    const ma = valueOf(await qa.call(D.proposeMarketAuthorisation, { params: { versionId }, body }));
    expect(ma).toMatchObject({ market: 'IN', state: 'PROPOSED', regulatoryConfirmedBy: null, qaAuthorisedBy: null });
    expect(ma.proposedBy.loginName).toBe('meera.iyer');
    const act = (a: 'REGULATORY_CONFIRM' | 'AUTHORISE', reason = true): SignableAction => ({
      kind: 'MBR_MARKET_ACT', act: a, authorisationId: ma.authorisationId, ...(a === 'AUTHORISE' && reason ? { reason: { code: 'MARKET_AUTHORISED', text: 'IN registration confirmed; SITE-1 L1' } } : {}),
    });
    // QA's authorisation without the regulatory confirmation is refused by the database; nothing is signed.
    expect(refusalOf(await signAction(server, qa, 'approver', act('AUTHORISE'))).why).toMatch(/confirmed its registration/);
    // An authorisation without QA's own reason is refused before anything is signed.
    expect(refusalOf(await signAction(server, qa, 'approver', act('AUTHORISE', false))).code).toBe('EBMR-AUDIT-002');
    // QA may not confirm the registration (MBR.REGULATORY_CONFIRM), nor an administrator.
    expect((await signAction(server, qa, 'approver', act('REGULATORY_CONFIRM'))).ok).toBe(false);
    expect((await signAction(server, admin.b, 'approver', act('REGULATORY_CONFIRM'), credsOf(admin.p))).ok).toBe(false);
    valueOf(await signAction(server, regulatory, 'regulatory', act('REGULATORY_CONFIRM')));
    let list = valueOf(await qa.call(D.marketAuthorisations, { params: { versionId } })).authorisations;
    expect(list[0]?.regulatoryConfirmedBy?.by.loginName).toBe('rahul.menon');
    expect(list[0]?.state).toBe('PROPOSED');
    // The regulatory signer may not authorise (MBR.APPROVE).
    expect((await signAction(server, regulatory, 'regulatory', act('AUTHORISE'))).ok).toBe(false);
    valueOf(await signAction(server, qa, 'approver', act('AUTHORISE')));
    list = valueOf(await qa.call(D.marketAuthorisations, { params: { versionId } })).authorisations;
    expect(list[0]).toMatchObject({ state: 'ACTIVE' });
    expect(list[0]?.qaAuthorisedBy?.by.loginName).toBe('meera.iyer');
    expect(list[0]?.activatedAt).not.toBeNull();
    // The withdrawal carries QA's own reason; the author and an administrator are refused it.
    const withdraw = { params: { authorisationId: ma.authorisationId }, body: { reason: { code: 'MARKET_EXIT', text: 'Product withdrawn from the IN market' } } };
    expect(refusalOf(await author.call(D.withdrawMarketAuthorisation, withdraw)).code).toMatch(/^EBMR-IAM-/);
    expect(refusalOf(await admin.b.call(D.withdrawMarketAuthorisation, withdraw)).code).toMatch(/^EBMR-IAM-/);
    const w = valueOf(await qa.call(D.withdrawMarketAuthorisation, withdraw));
    expect(w).toMatchObject({ state: 'WITHDRAWN', withdrawal: { reason: 'Product withdrawn from the IN market' } });
  });
});

describe('labelling specimens (tablets 1479, DI-35)', () => {
  const recordSpecimen = async (actor: Parameters<typeof withCommand>[1], code = `SPC-${randomUUID().slice(0, 6).toUpperCase()}`): Promise<string> => {
    const content = referenceContent({ kind: 'SPECIMEN', code, version: '1', title: `Carton specimen ${code}`, effectiveFrom: '2026-01-01', summary: 'Carton artwork as approved for print.' });
    return withCommand(server.db.app, actor, async (c) => (await c.query<{ id: string }>('select tab.record_reference_document($1::jsonb, $2) as id', [JSON.stringify(content), referenceHash(content)])).rows[0]?.id as string);
  };

  it('[DI-35] a specimen the steward recorded waits for approval; the steward is refused, QA approves it once', async () => {
    const id = await recordSpecimen(await stewardActor(server));
    const steward = await server.asPersona('steward');
    const one = async () => valueOf(await qa.call(D.specimens, {})).specimens.find((s) => s.documentId === id);
    expect(await one()).toMatchObject({ state: 'RECORDED', approvedBy: null });
    expect((await one())?.recordedBy.loginName).toBe('neha.joshi');
    const approve: SignableAction = { kind: 'SPECIMEN_ACT', act: 'APPROVE', documentId: id };
    expect(refusalOf(await signAction(server, steward, 'steward', approve)).why).toMatch(/MASTER_DATA_STEWARD may not sign SPECIMEN_APPROVED/);
    expect((await signAction(server, admin.b, 'steward', approve, credsOf(admin.p))).ok).toBe(false);
    valueOf(await signAction(server, qa, 'approver', approve));
    expect(await one()).toMatchObject({ state: 'APPROVED' });
    expect((await one())?.approvedBy?.loginName).toBe('meera.iyer');
    expect(refusalOf(await signAction(server, qa, 'approver', approve)).why).toMatch(/APPROVED|EBMR-TAB-471/);
  });

  it('[DI-35] the person who recorded a specimen may not approve it, even holding the QA MBR approver role', async () => {
    const dual = await grantedPerson(server, 'MASTER_DATA_STEWARD', 'Dev Dual');
    const b = server.seed.bootstrap;
    const adm = await passwordActor(server.db, b.admin, b.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'also a QA MBR approver', correlationId: randomUUID() });
    const owner = await passwordActor(server.db, b.owner, b.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'also a QA MBR approver', correlationId: randomUUID() });
    const grant = await withCommand(server.db.app, adm, (c) => identity.requestRoleGrant(c, { accountId: dual.accountId, roleCode: 'QA_MBR_APPROVER', reason: 'also a QA MBR approver' }));
    await withCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, grant, true, 'approved'));
    const fp = terminalOf(server.seed, 'PC-QA-01').fingerprint;
    const asSteward = await passwordActor(server.db, { ...dual, roleCode: 'MASTER_DATA_STEWARD' }, fp, { reasonCode: 'TEST_SETUP', reasonText: 'specimen', correlationId: randomUUID() });
    // The person acknowledges the e-signature policy, so a refusal is about the specimen, not the account (DI-35).
    await withCommand(server.db.app, asSteward, (c) => identity.acknowledgeEsigPolicy(c));
    const id = await recordSpecimen({ ...asSteward, correlationId: randomUUID() });
    const asQa = server.browser('PC-QA-01');
    const login = { method: 'PASSWORD' as const, identifier: dual.loginName, secret: dual.password, roleCode: 'QA_MBR_APPROVER' };
    valueOf(await asQa.call(routes.session.login, { body: { ...login, proof: await asQa.proof('POST', '/api/session/login', login) } }));
    expect(refusalOf(await signAction(server, asQa, 'approver', { kind: 'SPECIMEN_ACT', act: 'APPROVE', documentId: id }, credsOf(dual))).why).toMatch(/EBMR-TAB-472|performer|entered|recorded/i);
    expect(valueOf(await qa.call(D.specimens, {})).specimens.find((s) => s.documentId === id)?.state).toBe('RECORDED');
  });

  it('[DI-35] the database approves only a recorded specimen, by an approver who neither recorded it nor lacks the signature, and states and provides each specimen on its own', async () => {
    // The act called directly (a writer that bypasses the signing screen), so each refusal is the act's own.
    const messageOf = async (p: Promise<unknown>): Promise<string> => p.then(() => 'no error', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    const provided = async (id: string) => (await server.db.admin.query<{ p: { exists: boolean; state?: string } }>("select esig.provide('labelling_specimen', $1) as p", [id])).rows[0]!.p;
    const approveAs = (actor: Parameters<typeof withCommand>[1], doc: string, sig: string) =>
      withCommand(server.db.app, { ...actor, correlationId: randomUUID() }, (c) => c.query('select tab.approve_labelling_specimen($1, $2)', [doc, sig]));
    const qaApprove = (doc: string, sig: string) => world.run(world.cast.qa, (c) => c.query('select tab.approve_labelling_specimen($1, $2)', [doc, sig]));
    // A person who records specimens as the steward and also holds the QA MBR approver role.
    const dual = await grantedPerson(server, 'MASTER_DATA_STEWARD', 'Dina Dual');
    const b = server.seed.bootstrap;
    const adm = await passwordActor(server.db, b.admin, b.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'also a QA MBR approver', correlationId: randomUUID() });
    const owner = await passwordActor(server.db, b.owner, b.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'also a QA MBR approver', correlationId: randomUUID() });
    const grant = await withCommand(server.db.app, adm, (c) => identity.requestRoleGrant(c, { accountId: dual.accountId, roleCode: 'QA_MBR_APPROVER', reason: 'also a QA MBR approver' }));
    await withCommand(server.db.app, owner, (c) => identity.decideRoleGrant(c, grant, true, 'approved'));
    const fp = terminalOf(server.seed, 'PC-QA-01').fingerprint;
    const ctx = { reasonCode: 'TEST_SETUP', reasonText: 'specimen', correlationId: randomUUID() };
    const dualSteward = await passwordActor(server.db, { ...dual, roleCode: 'MASTER_DATA_STEWARD' }, fp, ctx);
    const dualQa = await passwordActor(server.db, { ...dual, roleCode: 'QA_MBR_APPROVER' }, fp, ctx);
    const own = await recordSpecimen({ ...dualSteward, correlationId: randomUUID() });
    const theirs = await recordSpecimen(await stewardActor(server));
    const sopCode = `SOP-${randomUUID().slice(0, 6).toUpperCase()}`;
    const sopContent = referenceContent({ kind: 'SOP', code: sopCode, version: '1', title: `Procedure ${sopCode}`, effectiveFrom: '2026-01-01', summary: 'A procedure, not a specimen.' });
    const sop = await withCommand(server.db.app, await stewardActor(server), async (c) =>
      (await c.query<{ id: string }>('select tab.record_reference_document($1::jsonb, $2) as id', [JSON.stringify(sopContent), referenceHash(sopContent)])).rows[0]?.id as string);

    // Another document retired: no specimen takes its retirement as its own state.
    await withCommand(server.db.app, await stewardActor(server), (c) => c.query("select tab.retire_reference_document($1, 'RETIRED', '2026-01-02', 'superseded by a later procedure')", [sop]));
    expect(await provided(own)).toMatchObject({ exists: true, state: 'RECORDED' });
    // Only a SPECIMEN document is approved or provided as one.
    expect(await messageOf(qaApprove(randomUUID(), randomUUID()))).toMatch(/EBMR-TAB-470/);
    expect(await messageOf(qaApprove(sop, randomUUID()))).toMatch(/EBMR-TAB-470/);
    expect(await provided(sop)).toMatchObject({ exists: false });
    // The recorder is refused before any signature is looked at, even holding the approver role.
    expect(await messageOf(approveAs(dualQa, own, randomUUID()))).toMatch(/EBMR-TAB-472/);
    // QA's signature authorises QA's act only: another approver presenting it is refused.
    const sig = await world.sign(world.cast.qa, 'labelling_specimen', theirs, 'SPECIMEN_APPROVED', 'RECORDED');
    expect(await messageOf(approveAs(dualQa, theirs, sig))).toMatch(/EBMR-TAB-474/);
    expect(await provided(theirs)).toMatchObject({ exists: true, state: 'RECORDED' });
    await qaApprove(theirs, sig);
    // Each specimen's state is its own: the other specimen stays recorded.
    expect(await provided(theirs)).toMatchObject({ state: 'APPROVED' });
    expect(await provided(own)).toMatchObject({ exists: true, state: 'RECORDED' });
    // Approved once: a second approval is refused on the state, before any signature.
    expect(await messageOf(qaApprove(theirs, randomUUID()))).toMatch(/EBMR-TAB-471/);
  });
});
