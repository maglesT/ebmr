/**
 * The plant-rule screen's read (Phase 7 slice 7g-2, decision 0025; plantRules.proposals; recipe-core 0973, 1210;
 * PR-27): per site, material or product the value in force and whether a proposal waits for QA, and every version with
 * its state, its effect (a tightening in force at once, a loosening only once approved), its proposer and its approver.
 * The proposer (the steward) is refused the approval, and so is an administrator, both for the proposal and the approval.
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
  [steward, qa] = await Promise.all([gmp.asPersona('steward'), gmp.asPersona('approver')]);
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

const P = routes.plantRules;
const read = async () => valueOf(await qa.call(P.proposals, {}));

describe('plant-rule proposals and what is in force (PR-27)', () => {
  it('[PR-27] a loosening facility rule is pending and not in force until another QA person approves it; the proposer is refused the approval', async () => {
    const site = `PEN-${randomUUID().slice(0, 6).toUpperCase()}`;
    const p = valueOf(await steward.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: true, justification: 'Dedicated penicillin block' } }));
    let f = (await read()).facilityRules.find((x) => x.site === site);
    expect(f).toMatchObject({ inForce: false, pending: true, approvedVersion: null });
    expect(f?.versions[0]).toMatchObject({ proposalId: p.proposalId, version: '1', state: 'PROPOSED', effect: 'LOOSENS', value: true, approvedBy: null });
    expect(f?.versions[0]?.proposedBy.loginName).toBe('neha.joshi');
    // The proposer may not approve their own proposal: refused, nothing changes.
    expect((await signAction(gmp, steward, 'steward', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: p.proposalId })).ok).toBe(false);
    expect((await read()).facilityRules.find((x) => x.site === site)).toMatchObject({ inForce: false, pending: true });
    valueOf(await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: p.proposalId }));
    f = (await read()).facilityRules.find((x) => x.site === site);
    expect(f).toMatchObject({ inForce: true, pending: false, approvedVersion: '1' });
    expect(f?.versions[0]).toMatchObject({ state: 'APPROVED' });
    expect(f?.versions[0]?.approvedBy?.loginName).toBe('meera.iyer');
    // Withdrawing the facility status tightens: in force at once, still pending QA's approval.
    valueOf(await steward.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: false, justification: 'Penicillin block closed' } }));
    f = (await read()).facilityRules.find((x) => x.site === site);
    expect(f).toMatchObject({ inForce: false, pending: true, approvedVersion: '1' });
    expect(f?.versions.map((v) => [v.version, v.state, v.effect])).toEqual([['2', 'PROPOSED', 'TIGHTENS'], ['1', 'APPROVED', 'LOOSENS']]);
  });

  it('[PR-27] a beta-lactam classification tightens at once; a later declassification loosens and waits for QA', async () => {
    const code = `AMOX-${randomUUID().slice(0, 6).toUpperCase()}`;
    const first = valueOf(await steward.call(P.classifyBetaLactam, { body: { kind: 'MATERIAL', code, betaLactam: true, reason: 'Amoxicillin: a penicillin' } }));
    let b = (await read()).betaLactam.find((x) => x.kind === 'MATERIAL' && x.code === code);
    expect(b).toMatchObject({ inForce: true, pending: true });
    expect(b?.versions[0]).toMatchObject({ effect: 'TIGHTENS', state: 'PROPOSED' });
    valueOf(await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'BETA_LACTAM_APPROVE', subjectId: first.proposalId }));
    valueOf(await steward.call(P.classifyBetaLactam, { body: { kind: 'MATERIAL', code, betaLactam: false, reason: 'Recorded in error' } }));
    b = (await read()).betaLactam.find((x) => x.kind === 'MATERIAL' && x.code === code);
    expect(b).toMatchObject({ inForce: true, pending: true, approvedVersion: '1' });
    expect(b?.versions.map((v) => [v.state, v.effect])).toEqual([['PROPOSED', 'LOOSENS'], ['APPROVED', 'TIGHTENS']]);
  });

  it('[DI-18][PR-27] an administrator may neither propose a plant rule nor approve one', async () => {
    const person = await grantedPerson(gmp, 'SYSTEM_ADMINISTRATOR', 'Ada Administrator');
    const admin = await loginOf(gmp, person);
    const site = `PEN-${randomUUID().slice(0, 6).toUpperCase()}`;
    expect(refusalOf(await admin.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: true, justification: 'x' } })).code).toMatch(/^EBMR-IAM-/);
    const p = valueOf(await steward.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: true, justification: 'Dedicated block' } }));
    expect((await signAction(gmp, admin, 'steward', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: p.proposalId }, { credentials: { kind: 'PASSWORD', loginName: person.loginName, password: person.password } })).ok).toBe(false);
    expect((await read()).facilityRules.find((x) => x.site === site)).toMatchObject({ inForce: false, pending: true });
  });
});
