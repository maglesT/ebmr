/**
 * Phase 6 slice 6f (builder B): the support and contractGiver namespaces (ns/support.ts), the India DSC routes and
 * members of the esig namespace, and the SUPPORT_ACT signable action.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES, GOVERNANCE_ROUTE_IDS } from '../src/examples.ts';
import { routes, SignableAction } from '../src/index.ts';

describe('the support, contract-giver and DSC routes (Phase 6 slice 6f)', () => {
  it('[DI-08][IN-30][IN-10] every support and contract-giver route is GMP only under its own path, and every one of these routes has an example that parses', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const r of Object.values(routes.support)) expect([r.installation, r.path.startsWith('/api/support/')], r.id).toEqual(['GMP', true]);
    for (const r of Object.values(routes.contractGiver)) expect([r.installation, r.path.startsWith('/api/contract-giver/')], r.id).toEqual(['GMP', true]);
    expect(GOVERNANCE_ROUTE_IDS).toHaveLength(Object.keys(routes.support).length + Object.keys(routes.contractGiver).length + 4);
    for (const id of GOVERNANCE_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const [name, e] of Object.entries(EXAMPLES).filter(([n]) => /^(support|contract-giver|esig-.*dsc)/.test(n))) {
      expect(e.schema.safeParse(e.data).success, name).toBe(true);
    }
  });

  it('[DI-08] a support grant is requested for 1 to 72 hours with its vendor and purpose; SUPPORT_ACT approves by grant id as QA or IT only', () => {
    const body = { accountId: '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f51', vendor: 'Acme', purpose: 'Diagnose', hours: 4 };
    const schema = routes.support.requestGrant.body!;
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, hours: 73 }).success).toBe(false);
    expect(schema.safeParse({ ...body, hours: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...body, purpose: ' ' }).success).toBe(false);
    const id = '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f51';
    expect(SignableAction.safeParse({ kind: 'SUPPORT_ACT', act: 'QA_APPROVE', grantId: id }).success).toBe(true);
    expect(SignableAction.safeParse({ kind: 'SUPPORT_ACT', act: 'IT_APPROVE', grantId: id }).success).toBe(true);
    expect(SignableAction.safeParse({ kind: 'SUPPORT_ACT', act: 'SELF_APPROVE', grantId: id }).success).toBe(false);
  });

  it('[IN-10] a challenge may carry the DSC statement and a sign request the token\'s signature and chain; DSC changes name a change record', () => {
    const sign = routes.esig.sign.body!;
    const base = { challengeId: '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f51', credentials: { kind: 'PIN', pin: '482913' }, proof: { nonce: 'n', signature: 's' }, action: { kind: 'CONFIG_CHANGE_ACT', act: 'APPROVE', number: 'CR-1' } };
    const dsc = { signature: 'A'.repeat(344), chain: ['B'.repeat(1200), 'C'.repeat(1200)] };
    expect(sign.safeParse({ ...base, dsc }).error?.issues.filter((i) => String(i.path[0]) === 'dsc') ?? []).toEqual([]);
    expect(sign.safeParse({ ...base, dsc: { ...dsc, chain: [dsc.chain[0]] } }).success).toBe(false);
    expect(routes.esig.setDscMode.body!.safeParse({ mode: 'TEST_CA', reason: 'demo' }).success).toBe(false);
    expect(routes.esig.setDscMode.body!.safeParse({ mode: 'TEST_CA', reason: 'demo', changeRecord: 'CR-7' }).success).toBe(true);
  });
});
