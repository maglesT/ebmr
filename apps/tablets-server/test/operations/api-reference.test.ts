/**
 * The developers' API reference page reads the contract's OpenAPI document from the server (Phase 7 slice 7g-4;
 * decision 0025 point 2; meta.openapi, platform/openapi.ts): signed in only, and every route of the contract is in it.
 */
import { allRoutes, routes } from '@ebmr/api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalOf, valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let server: TestServer;
beforeAll(async () => {
  server = await startServer('SANDBOX');
});
afterAll(async () => {
  await server?.close();
});

describe('the API reference (decision 0025)', () => {
  it('the OpenAPI document of the contract is answered to a session only, and names every route with its method', async () => {
    expect(refusalOf(await server.browser().call(routes.meta.openapi)).status).toBe(401);
    const qa = await server.asPersona('qareviewer1');
    const doc = valueOf(await qa.call(routes.meta.openapi)) as { openapi?: string; info?: { version?: string }; paths?: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toMatch(/^3\./);
    const paths = doc.paths ?? {};
    const missing = allRoutes(routes).filter((r) => !paths[r.path.replace(/:([A-Za-z0-9]+)/g, '{$1}')]?.[r.method.toLowerCase()]).map((r) => r.id);
    expect(missing).toEqual([]);
    expect(valueOf(await server.browser().call(routes.meta.get)).setupRequired).toBe(false);
  });
});
