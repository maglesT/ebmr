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
import { DISCONNECTED, DISCONNECTED_NAMESPACES, DISCONNECTED_ROUTES, isDisconnectedRoute, routes, type AnyRoute, type NamespaceName } from '@ebmr/api-contract';
import { startServer, type TestServer } from '../support/harness.ts';
import { valueOf } from '../esig/support.ts';

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

/** Every namespace that stays connected: the kept batch-record path, the admin minimum and the reads kept screens need. */
const CONNECTED: readonly string[] = [
  'access', 'accessGovernance', 'alarms', 'archive', 'audit', 'batches', 'containers', 'designer', 'deviceRegistry', 'devices',
  'erpShipping', 'esig', 'execution', 'india', 'integrations', 'labels', 'library', 'marketConfig', 'masterData', 'meta',
  'operations', 'people', 'planning', 'plant', 'quality', 'records', 'release', 'review', 'samples', 'session',
  'specifications', 'transfers',
];

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

  it('[DI-17] meta tells the SPA whether the disconnected functions are refused here (declutter D2)', async () => {
    expect(valueOf(await gmp.browser().call(routes.meta.get)).disconnected).toBe(true);
    expect(valueOf(await sandbox.browser().call(routes.meta.get)).disconnected).toBe(true);
    expect(valueOf(await solo.browser().call(routes.meta.get)).disconnected).toBe(false);
  });

  it('[DI-17] the kept path stays connected: exactly the expected namespaces are connected, and a standalone server without the switch serves the listed ones', async () => {
    const connected = (Object.keys(routes) as NamespaceName[]).filter((ns) => DISCONNECTED[ns] === undefined);
    expect([...connected].sort()).toEqual(CONNECTED);
    // Slice D4: inside a connected namespace only the single routes of DISCONNECTED_ROUTES are refused.
    for (const r of connected.flatMap((ns) => Object.values(routes[ns]) as AnyRoute[])) expect(isDisconnectedRoute(r.id), r.id).toBe(DISCONNECTED_ROUTES[r.id] !== undefined);
    const b = await gmp.asPersona('qaInvestigator');
    const kept = await b.call(routes.library.list, {});
    expect(kept.ok).toBe(true);
    const route = routes.capa.register;
    const served = await (await solo.asPersona('qaInvestigator')).inject({ method: route.method, url: route.path });
    expect(served.statusCode).not.toBe(410);
  });
});

/** Every route of the contract by its id. */
const byId = new Map((Object.values(routes) as Record<string, AnyRoute>[]).flatMap((ns) => Object.values(ns)).map((r) => [r.id, r]));
/** Did the server refuse the call as disconnected? */
const gone = (r: { ok: boolean; error?: unknown }): boolean => !r.ok && JSON.stringify(r.error).includes('"DISCONNECTED"');

describe('[DI-17] the full deviation routes answer 410 DISCONNECTED; the batch path keeps its deviation references (declutter D4)', () => {
  it('[DI-17] the disconnected deviation routes are exactly the full-record ones, all owned by Deviations', () => {
    expect(Object.entries(DISCONNECTED_ROUTES).sort()).toEqual(
      [
        'quality.cancelDeviation', 'quality.reclassifyDeviation',
      ].sort().map((id) => [id, 'Deviations']),
    );
  });

  it.each(Object.keys(DISCONNECTED_ROUTES).sort())('[DI-17] %s is refused with EBMR_DISCONNECT=1, signed in or not, and served on a standalone server without the switch', async (id) => {
    const route = byId.get(id);
    expect(route, id).toBeDefined();
    if (!route) return;
    const anonymous = await gmp.browser().inject({ method: route.method, url: urlOf(route) });
    expect([anonymous.statusCode, anonymous.json<{ refusal: { code: string } }>().refusal.code]).toEqual([410, 'DISCONNECTED']);
    const signedIn = await (await gmp.asPersona('qaInvestigator')).inject({ method: route.method, url: urlOf(route) });
    expect([signedIn.statusCode, signedIn.json<{ refusal: { code: string } }>().refusal.code]).toEqual([410, 'DISCONNECTED']);
    const served = await (await solo.asPersona('qaInvestigator')).inject({ method: route.method, url: urlOf(route) });
    expect(served.statusCode).not.toBe(410);
  });

  it('[DI-17] the deviation routes the kept path needs stay served with EBMR_DISCONNECT=1: raise and link (exception and OOS references), the batch list, the release checklist', async () => {
    const qa = await gmp.asPersona('qaInvestigator');
    const raised = valueOf(
      await qa.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: 'Declutter D4: a reference for an exception', classification: 'MINOR', riskRationale: 'Raised to check the kept route' } }),
    );
    expect(raised.ref).toMatch(/\S/);
    expect(gone(await qa.call(routes.quality.linkDeviation, { params: { deviationId: raised.deviationId }, body: { subjectKind: 'BATCH', subjectId: randomUUID() } }))).toBe(false);
    expect(valueOf(await qa.call(routes.quality.deviations, { query: {} })).deviations.map((d) => d.ref)).toContain(raised.ref);
    expect(gone(await qa.call(routes.quality.deviationRelease, { query: { subjectKind: 'BATCH', subjectId: randomUUID() } }))).toBe(false);
    // D4-R5 (lead, option A) and D4b: the investigation, its finding, the impact and the closure basis QA's conclusion
    // needs (site.conclude_deviation), and the record's detail, stay for invalidation and reprocessing.
    const oosPath = [routes.quality.deviation, routes.quality.startInvestigation, routes.quality.recordFinding, routes.quality.deviationDetail, routes.quality.recordDeviationImpact, routes.quality.recordDeviationClosureBasis] as AnyRoute[];
    for (const route of oosPath) expect(isDisconnectedRoute(route.id), route.id).toBe(false);
    for (const route of oosPath) {
      const res = await qa.inject({ method: route.method, url: urlOf(route) });
      expect(res.statusCode, route.id).not.toBe(410);
    }
  });
});
