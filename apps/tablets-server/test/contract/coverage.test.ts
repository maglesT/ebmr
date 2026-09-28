/**
 * Contract coverage (plan section 4, "Server binding"): every route id of the frozen contract is registered
 * exactly once, in the right installation, and answers there (stubs answer 501 until their module lands);
 * routes of the other installation are absent (404).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allRoutes, buildPath, routes, type AnyRoute } from '@ebmr/api-contract';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sbx: TestServer;

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startServer('GMP'), startServer('SANDBOX')]);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

const EXAMPLE_PARAMS: Record<string, string> = {
  versionId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  runId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  stepKey: 'p-blend@',
  packageId: 'pkg-1',
  code: 'TEST-BAL-01',
  chainKey: 'batch:x',
};

function samplePath(route: AnyRoute): string {
  return buildPath(route.path, EXAMPLE_PARAMS);
}

describe('contract coverage', () => {
  it('[DI-05] every route id is registered exactly once, on the installations it names', () => {
    const all = allRoutes(routes);
    const onGmp = [...gmp.built.ctx.boundRoutes.keys()].sort();
    const onSbx = [...sbx.built.ctx.boundRoutes.keys()].sort();
    expect(onGmp).toEqual(all.filter((r) => r.installation !== 'SANDBOX').map((r) => r.id).sort());
    expect(onSbx).toEqual(all.filter((r) => r.installation !== 'GMP').map((r) => r.id).sort());
    const union = new Set([...onGmp, ...onSbx]);
    expect([...union].sort()).toEqual(all.map((r) => r.id).sort());
  });

  it('[DI-05] a route of the other installation does not exist there: designer routes are absent on the sandbox, execution and device routes on GMP', async () => {
    for (const route of Object.values(routes.designer)) {
      const res = await sbx.app.inject({ method: route.method, url: samplePath(route), headers: { origin: sbx.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });
      expect(res.statusCode, route.id).toBe(404);
    }
    for (const route of [...Object.values(routes.execution), ...Object.values(routes.devices)]) {
      const res = await gmp.app.inject({ method: route.method, url: samplePath(route), headers: { origin: gmp.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });
      expect(res.statusCode, route.id).toBe(404);
    }
  });

  it('every registered route answers (stubbed routes 501 once past the platform gates)', async () => {
    const b = await gmp.asPersona('author');
    for (const route of Object.values(routes.designer)) {
      if (route.method !== 'GET') continue;
      const res = await b.inject({ method: 'GET', url: samplePath(route) });
      expect(res.statusCode, route.id).toBe(501);
      expect((JSON.parse(res.body) as { refusal: { code: string; kind: string } }).refusal).toMatchObject({ code: 'NOT_IMPLEMENTED', kind: 'NOT_ENABLED' });
    }
    const s = await sbx.asPersona('issuer');
    const res = await s.inject({ method: 'GET', url: '/api/test-runs' });
    expect(res.statusCode).toBe(501);
  });
});
