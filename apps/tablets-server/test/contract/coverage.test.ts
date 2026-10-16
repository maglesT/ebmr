/**
 * Contract coverage (plan section 4, "Server binding"): every route id of the frozen contract is registered
 * exactly once, in the right installation, and is implemented there (no stub answers 501);
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
  deviationId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  lotId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  batchId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  formulaId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  exportId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  extractId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  id: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  adapterCode: 'ERP-MAIN',
  capaId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  checkId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  alarmId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  mockRecallId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
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

  it('[DI-05][INV-18] a route of the other installation does not exist there: designer routes and the GMP batch plan are absent on the sandbox, test packages and test batches on GMP', async () => {
    const sandboxOnly = [routes.execution.testPackages, routes.execution.importPackage, routes.execution.issueForm, routes.execution.issue];
    for (const route of [...Object.values(routes.designer), routes.execution.planBatch]) {
      const res = await sbx.app.inject({ method: route.method, url: samplePath(route), headers: { origin: sbx.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });
      expect(res.statusCode, route.id).toBe(404);
    }
    for (const route of sandboxOnly) {
      const res = await gmp.app.inject({ method: route.method, url: samplePath(route), headers: { origin: gmp.config.publicOrigin, 'sec-fetch-site': 'same-origin' } });
      expect(res.statusCode, route.id).toBe(404);
    }
    // GMP batches run under /api/batches/* (D-S6-1); the scales serve both installations (each its own gateways).
    expect(gmp.built.ctx.boundRoutes.has(routes.batches.command.id)).toBe(true);
    expect(gmp.built.ctx.boundRoutes.has(routes.devices.scales.id)).toBe(true);
  });

  it('every GET route of the contract is implemented on its installation (no stub answers 501, none is missing)', async () => {
    const office = { GMP: await gmp.asPersona('author'), SANDBOX: await sbx.asPersona('issuer') } as const;
    for (const route of allRoutes(routes)) {
      if (route.method !== 'GET' || route.stream) continue;
      for (const kind of ['GMP', 'SANDBOX'] as const) {
        if (route.installation !== 'ANY' && route.installation !== kind) continue;
        const res = await office[kind].inject({ method: 'GET', url: samplePath(route) });
        const code = res.statusCode === 200 ? null : (JSON.parse(res.body) as { refusal?: { code?: string } }).refusal?.code;
        // A sample id may name nothing (a 404 of the route itself is fine); the platform's "not a route" is not.
        expect({ route: route.id, kind, status: res.statusCode, code }, route.id).not.toMatchObject({ status: 501 });
        expect(code === 'NOT_FOUND' && /is not a route/.test(res.body), `${route.id} on ${kind}`).toBe(false);
      }
    }
  });
});
