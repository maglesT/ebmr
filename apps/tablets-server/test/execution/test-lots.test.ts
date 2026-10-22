/**
 * The sandbox's test lots on screen (Phase 7 slice 7j, R4; D-7j-9): the master-data steward registers a released,
 * identity-tested TEST- lot of a material for test runs; a lot is never changed; a person without MASTERDATA.CHANGE is
 * refused by the database; the GMP installation has no such route (DI-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { refusalOf, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let sbx: TestServer;
let gmp: TestServer;

beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startServer('SANDBOX'), startServer('GMP')]);
}, 300_000);
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

describe('sandbox test lots (slice 7j)', () => {
  it('[DI-05][DI-17] the steward registers a TEST- lot of a new material; it is listed and resolvable; twice, by another role or on GMP it is refused', async () => {
    const steward = await sbx.asPersona('steward');
    const lot = valueOf(await steward.call(routes.execution.registerTestLot, { body: { lotCode: 'TEST-L26-7J01', materialCode: 'RM-DMT-API', materialName: 'Demotab active', expiresInDays: 365 } }));
    expect(lot).toMatchObject({ lotCode: 'TEST-L26-7J01', material: { code: 'RM-DMT-API', name: 'Demotab active' }, status: 'RELEASED', identityTested: true });
    expect(lot.expiry).not.toBeNull();
    expect(valueOf(await steward.call(routes.execution.testLots)).lots.map((l) => l.lotCode)).toContain('TEST-L26-7J01');
    expect(valueOf(await steward.call(routes.execution.lot, { params: { code: 'TEST-L26-7J01' } })).material.code).toBe('RM-DMT-API');

    const again = await steward.call(routes.execution.registerTestLot, { body: { lotCode: 'TEST-L26-7J01', materialCode: 'RM-DMT-API', materialName: 'Demotab active', expiresInDays: 30 } });
    expect(JSON.stringify(refusalOf(again))).toMatch(/EBMR-EXE-071/);
    const issuer = await sbx.asPersona('issuer');
    const other = await issuer.call(routes.execution.registerTestLot, { body: { lotCode: 'TEST-L26-7J02', materialCode: 'RM-DMT-API', materialName: 'Demotab active', expiresInDays: 30 } });
    expect(JSON.stringify(refusalOf(other))).toMatch(/MASTERDATA\.CHANGE/);
    const onGmp = await (await gmp.asPersona('steward')).call(routes.execution.registerTestLot, { body: { lotCode: 'TEST-L26-7J03', materialCode: 'RM-DMT-API', materialName: 'Demotab active', expiresInDays: 30 } });
    expect(onGmp.ok).toBe(false);
  });
});
