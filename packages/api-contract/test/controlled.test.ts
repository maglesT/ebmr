/**
 * Phase 6 slice 6e: the controlled namespace (ns/controlled.ts) and the CONTROLLED_ACT signable action (draft IN-53).
 * Additive: GMP only, each route under its own path with an example that parses; every quantity is decimal text.
 */
import { describe, expect, it } from 'vitest';
import { CONTROLLED_ROUTE_IDS, EXAMPLES } from '../src/examples.ts';
import { CONTROLLED_DRAFT_BANNER, routes, SignableAction } from '../src/index.ts';

const id = '3c4d5e6f-0000-4000-8000-000000000001';

describe('the controlled routes (Phase 6 slice 6e, IN-53 draft)', () => {
  it('[IN-53] every controlled route is GMP only under /api/controlled/, and every one has an example that parses and shows the draft banner', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const r of Object.values(routes.controlled)) expect([r.installation, r.path.startsWith('/api/controlled/')], r.id).toEqual(['GMP', true]);
    expect(CONTROLLED_ROUTE_IDS).toHaveLength(Object.keys(routes.controlled).length);
    for (const rid of CONTROLLED_ROUTE_IDS) expect(exampled.has(rid), `${rid} has an example`).toBe(true);
    for (const [name, e] of Object.entries(EXAMPLES).filter(([n]) => n.startsWith('controlled-'))) {
      expect(e.schema.safeParse(e.data).success, name).toBe(true);
      const banner = (e.data as { banner?: string }).banner;
      if (banner !== undefined) expect(banner, name).toBe(CONTROLLED_DRAFT_BANNER);
    }
  });

  it('[IN-53] quantities travel as decimal text: a JSON number, an exponent or a negative quantity is refused; a flag change names its change record', () => {
    const propose = routes.controlled.proposeCustody.body!;
    const base = { kind: 'DISPENSE', lotId: id, quantity: '1.250', batchId: id };
    expect(propose.safeParse(base).success).toBe(true);
    for (const quantity of [1.25, '1e3', '-1', '1.2345678', '']) expect(propose.safeParse({ ...base, quantity }).success, String(quantity)).toBe(false);
    expect(propose.safeParse({ ...base, kind: 'GIFT' }).success).toBe(false);
    const checkpoint = routes.controlled.recordCheckpoint.body!;
    expect(checkpoint.safeParse({ batchId: id, stageKey: 'S-BLEND@', materialCode: 'API-1', consumed: '1.9', inProcess: '0' }).success).toBe(true);
    expect(checkpoint.safeParse({ batchId: id, stageKey: 'S-BLEND@', materialCode: 'API-1', consumed: 1.9, inProcess: '0' }).success).toBe(false);
    const flag = routes.controlled.recordProduct.body!;
    const f = { productCode: 'TRM-50', controlled: true, materialCodes: ['API-1'], basisRef: 'NDPS licence', changeRecord: 'CR-17' };
    expect(flag.safeParse(f).success).toBe(true);
    const { changeRecord: _c, ...noRecord } = f;
    void _c;
    expect(flag.safeParse(noRecord).success).toBe(false);
  });

  it('[IN-53] CONTROLLED_ACT signs a flag, the first or second custodian\'s place, or a checkpoint, by its record id only', () => {
    for (const act of ['FLAG_APPROVE', 'CUSTODY_FIRST', 'CUSTODY_SECOND', 'BALANCE_SIGN']) {
      expect(SignableAction.safeParse({ kind: 'CONTROLLED_ACT', act, subjectId: id }).success, act).toBe(true);
    }
    expect(SignableAction.safeParse({ kind: 'CONTROLLED_ACT', act: 'CUSTODY_BOTH', subjectId: id }).success).toBe(false);
    expect(SignableAction.safeParse({ kind: 'CONTROLLED_ACT', act: 'CUSTODY_FIRST', subjectId: id, person: id }).success).toBe(false);
  });
});
