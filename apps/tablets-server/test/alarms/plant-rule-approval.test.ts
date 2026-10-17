/**
 * The penicillin facility rule and the beta-lactam classification over HTTP (recipe-core 1210, tablets 1410; Phase 7
 * slice 7a, 6jc-R10; PR-27): the master-data steward's request is a proposal (PROPOSED, with its id); it is in force
 * once a QA person other than the proposer approves it through the signing ceremony (INDIA_ACT FACILITY_RULE_APPROVE or
 * BETA_LACTAM_APPROVE, meaning QA_APPROVED). The database decides; the routes carry its codes.
 */
import { randomUUID } from 'node:crypto';
import { routes } from '@ebmr/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 300_000);
afterAll(async () => {
  await gmp?.close();
});

const P = routes.plantRules;

describe('plant rule proposals and their QA approval over HTTP (PR-27)', () => {
  it('[PR-27] a facility rule or beta-lactam classification proposed by the steward is in force only after another QA person signs QA_APPROVED in the ceremony', async () => {
    const steward = await gmp.asPersona('steward');
    const qa = await gmp.asPersona('approver');
    const site = `PEN-${randomUUID().slice(0, 6).toUpperCase()}`;
    const proposed = valueOf(await steward.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: true, justification: 'Dedicated penicillin block, separate air handling' } }));
    expect(proposed).toMatchObject({ version: '1', state: 'PROPOSED' });
    const inForce = async () => (await gmp.db.app.query<{ p: boolean }>('select penicillin_facility as p from plant.facility_rule_in_force where site_code = $1', [site])).rows[0]?.p ?? null;
    expect(await inForce()).toBeNull();
    // QA alone may not propose; the steward may not approve (no PLANT_RULE.APPROVE: nothing is signed).
    expect(refusalOf(await qa.call(P.setFacilityRule, { params: { site }, body: { penicillinFacility: false, justification: 'x' } })).code).toMatch(/EBMR-IAM/);
    expect((await signAction(gmp, steward, 'steward', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: proposed.proposalId })).ok).toBe(false);
    expect(await inForce()).toBeNull();
    valueOf(await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: proposed.proposalId }));
    expect(await inForce()).toBe(true);
    // Approved once: a second approval is refused.
    expect((await signAction(gmp, qa, 'approver', { kind: 'INDIA_ACT', act: 'FACILITY_RULE_APPROVE', subjectId: proposed.proposalId })).ok).toBe(false);

    const material = `AMOX-${randomUUID().slice(0, 6).toUpperCase()}`;
    const cls = valueOf(await steward.call(P.classifyBetaLactam, { body: { kind: 'MATERIAL', code: material, betaLactam: true, reason: 'Amoxicillin trihydrate: a penicillin' } }));
    expect(cls).toMatchObject({ version: '1', state: 'PROPOSED' });
    const classified = async () => (await gmp.db.app.query<{ r: boolean }>("select plant.classified_beta_lactam('MATERIAL', $1) as r", [material])).rows[0]?.r;
    expect(await classified()).toBe(false);
    const qa2 = await gmp.asPersona('qaInvestigator');
    valueOf(await signAction(gmp, qa2, 'qaInvestigator', { kind: 'INDIA_ACT', act: 'BETA_LACTAM_APPROVE', subjectId: cls.proposalId }));
    expect(await classified()).toBe(true);
  });
});
