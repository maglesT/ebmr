/**
 * The receipt routes of the quality namespace (Phase 6 slice 6a, builder A; additive): GMP only, every route with an
 * example that parses; the commands are FRESH_ON_SHARED; the QA approval of a manufacturer is the signable action
 * MATERIAL_SOURCE_ACT.
 */
import { describe, expect, it } from 'vitest';
import { allRoutes, routes, SignableAction } from '../src/index.ts';
import { EXAMPLES } from '../src/examples.ts';
import { RECEIPT_ROUTE_IDS } from '../src/ns/receipt.ts';

describe('receipt routes (PR-17)', () => {
  it('[PR-17][DI-31] every receipt route is a GMP quality route with an example; the commands are FRESH_ON_SHARED; the manufacturer approval is a signable action', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    const all = allRoutes(routes);
    expect(RECEIPT_ROUTE_IDS).toHaveLength(8);
    for (const id of RECEIPT_ROUTE_IDS) {
      const r = all.find((x) => x.id === id);
      expect(exampled.has(id), `${id} has an example`).toBe(true);
      expect(r?.installation, id).toBe('GMP');
      expect(r?.id.startsWith('quality.'), id).toBe(true);
      if (r?.mutating) expect(r.attribution, id).toBe('FRESH_ON_SHARED');
    }
    expect(SignableAction.safeParse({ kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_APPROVE', approvedManufacturerId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }).success).toBe(true);
    expect(SignableAction.safeParse({ kind: 'MATERIAL_SOURCE_ACT', act: 'MANUFACTURER_WITHDRAW', approvedManufacturerId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }).success).toBe(false);
  });
});
