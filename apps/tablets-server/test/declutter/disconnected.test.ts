/**
 * Declutter slice D1 (docs/build-plan/declutter/plan.md section 3): every disconnected namespace answers 410 DISCONNECTED
 * on a server started with EBMR_DISCONNECT=1 (the platform build always does: test/medhanta/platform-signon.test.ts),
 * one route each, generated from the contract's list; a signed-in person is refused the same. The kept path's
 * namespaces stay connected, and a standalone server without the switch serves every route as before.
 *
 * Control: DI-17 (the system offers only the functions an authorised person may use; nothing on the batch path is lost).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISCONNECTED, DISCONNECTED_NAMESPACES, isDisconnectedRoute, routes, type AnyRoute, type NamespaceName } from '@ebmr/api-contract';
import { startServer, type TestServer } from '../support/harness.ts';

let gmp: TestServer;
let sandbox: TestServer;
let solo: TestServer;

beforeAll(async () => {
  [gmp, sandbox, solo] = await Promise.all([
    startServer('GMP', { env: { EBMR_DISCONNECT: '1' } }),
    startServer('SANDBOX', { env: { EBMR_DISCONNECT: '1' } }),
    startServer('GMP'),
  ]);
}, 300_000);
afterAll(async () => {
  await Promise.all([gmp?.close(), sandbox?.close(), solo?.close()]);
});

const urlOf = (r: AnyRoute): string => r.path.replace(/:[A-Za-z]+/g, () => randomUUID());

/** The first route of the namespace served by that installation, if any. */
function firstRoute(ns: NamespaceName, kind: 'GMP' | 'SANDBOX'): AnyRoute | undefined {
  return (Object.values(routes[ns]) as AnyRoute[]).find((r) => r.installation === 'ANY' || r.installation === kind);
}

const KEPT: readonly NamespaceName[] = ['library', 'designer', 'planning', 'batches', 'execution', 'review', 'release', 'labels', 'records', 'plantRules', 'audit', 'quality'];

describe('[DI-17] the disconnected namespaces answer 410 DISCONNECTED (declutter D1)', () => {
  it.each(DISCONNECTED_NAMESPACES.map((ns) => [ns, DISCONNECTED[ns]]))('[DI-17] %s (%s) is refused, signed in or not', async (ns) => {
    const kind = firstRoute(ns, 'GMP') ? 'GMP' : 'SANDBOX';
    const server = kind === 'GMP' ? gmp : sandbox;
    const route = firstRoute(ns, kind);
    expect(route, `${ns} has a route on ${kind}`).toBeDefined();
    if (!route) return;
    const anonymous = await server.browser().inject({ method: route.method, url: urlOf(route) });
    expect([anonymous.statusCode, anonymous.json<{ refusal: { code: string } }>().refusal.code]).toEqual([410, 'DISCONNECTED']);
    const b = await server.asPersona(kind === 'GMP' ? 'qaInvestigator' : 'issuer');
    const signedIn = await b.inject({ method: route.method, url: urlOf(route) });
    expect([signedIn.statusCode, signedIn.json<{ refusal: { code: string } }>().refusal.code]).toEqual([410, 'DISCONNECTED']);
  });

  it('[DI-17] the kept path stays connected: no kept namespace is listed, and a standalone server without the switch serves the listed ones', async () => {
    for (const ns of KEPT) expect(DISCONNECTED[ns], ns).toBeUndefined();
    for (const r of KEPT.flatMap((ns) => Object.values(routes[ns]) as AnyRoute[])) expect(isDisconnectedRoute(r.id), r.id).toBe(false);
    const b = await gmp.asPersona('qaInvestigator');
    const kept = await b.call(routes.library.list, {});
    expect(kept.ok).toBe(true);
    const route = routes.capa.register;
    const served = await (await solo.asPersona('qaInvestigator')).inject({ method: route.method, url: route.path });
    expect(served.statusCode).not.toBe(410);
  });
});
