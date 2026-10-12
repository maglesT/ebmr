/**
 * Phase 4 slice 6a: the india namespace of the contract (ns/india.ts) and the INDIA_ACT signable action.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES, INDIA_ROUTE_IDS } from '../src/examples.ts';
import { routes, SignableAction } from '../src/index.ts';

describe('the india namespace (Phase 4 slice 6a)', () => {
  it('[IN-30][IN-18][IN-31] every india route lives under /api/india on the GMP installation and has an example that parses', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    expect(INDIA_ROUTE_IDS.length).toBe(Object.keys(routes.india).length);
    for (const route of Object.values(routes.india)) {
      expect(route.path.startsWith('/api/india/')).toBe(true);
      expect(route.installation).toBe('GMP');
      expect(exampled.has(route.id), `${route.id} has an example`).toBe(true);
    }
    for (const [name, e] of Object.entries(EXAMPLES).filter(([n]) => n.startsWith('india-'))) {
      expect(e.schema.safeParse(e.data).success, name).toBe(true);
    }
  });

  it('[IN-30] a licence is recorded with its form, an endorsed product and a validity; free text on a label carries no ; or =', () => {
    const body = { licenceKind: 'MANUFACTURING', form: '25', licenceNumber: 'MH/FDA/25/1', holderName: 'Deccan Pharma Ltd', holderAddress: 'Pune', validFrom: '2020-01-01T00:00:00Z', products: [{ productCode: 'PCM500', strength: '500 mg' }] };
    const schema = routes.india.recordLicence.body!;
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, products: [] }).success).toBe(false);
    expect(schema.safeParse({ ...body, holderName: 'Deccan; Pharma' }).success).toBe(false);
    expect(schema.safeParse({ ...body, form: '26' }).success).toBe(false);
    expect(routes.india.recordExportPermission.body!.safeParse({ productCode: 'PCM500', strength: '500 mg', destination: 'IN', permissionNumber: 'N-1', issuingAuthority: 'SLA', validFrom: '2020-01-01T00:00:00Z', validUntil: '2030-01-01T00:00:00Z' }).success).toBe(false);
  });

  it('[IN-30] INDIA_ACT approves a licence or an export permission by its id, nothing else', () => {
    const id = '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f51';
    expect(SignableAction.safeParse({ kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: id }).success).toBe(true);
    expect(SignableAction.safeParse({ kind: 'INDIA_ACT', act: 'EXPORT_PERMISSION_APPROVE', subjectId: id }).success).toBe(true);
    expect(SignableAction.safeParse({ kind: 'INDIA_ACT', act: 'LICENCE_SUSPEND', subjectId: id }).success).toBe(false);
    expect(SignableAction.safeParse({ kind: 'INDIA_ACT', act: 'LICENCE_APPROVE', subjectId: id, extra: 1 }).success).toBe(false);
  });
});
