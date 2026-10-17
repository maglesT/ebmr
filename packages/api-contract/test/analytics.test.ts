/**
 * Contract of Phase 6A (slice 6A-0; interfaces slice-6A-0-interfaces.md section 5): the analytics namespaces are GMP
 * only under /api/analytics/, read-only but for the disposition, each route has an example that parses, every
 * response carries the advisory envelope, statistics are StatNumber (only in the analytics* files) and a GMP value
 * echoed is the source's decimal text (DI-51).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYTICS_EXAMPLES } from '../src/examples.ts';
import { ANALYTICS_NAMESPACES, ANALYTICS_NAMESPACE_SLICES, allRoutes, routes, StatNumber, type AnyRoute } from '../src/index.ts';

const nsDir = new URL('../src/ns/', import.meta.url);
const routesOf = (ns: object): AnyRoute[] => Object.values(ns as Record<string, AnyRoute>);
const analyticsRoutes: AnyRoute[] = Object.values(ANALYTICS_NAMESPACES).flatMap(routesOf);

describe('the analytics contract (Phase 6A slice 6A-0)', () => {
  it('[DI-51] every analytics route is GMP only under /api/analytics/, read-only but for the disposition, and has an example that parses with the advisory envelope', () => {
    expect(Object.keys(ANALYTICS_NAMESPACE_SLICES).sort()).toEqual(Object.keys(ANALYTICS_NAMESPACES).sort());
    const exampled = new Map<string, unknown[]>();
    for (const [name, e] of Object.entries(ANALYTICS_EXAMPLES)) {
      const parsed = e.schema.safeParse(e.data);
      expect(parsed.success, `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
      exampled.set(e.routeId, [...(exampled.get(e.routeId) ?? []), e.data]);
    }
    for (const [nsName, ns] of Object.entries(ANALYTICS_NAMESPACES)) {
      for (const r of routesOf(ns)) {
        expect(r.id.startsWith(`${nsName}.`), r.id).toBe(true);
        expect(r.installation, r.id).toBe('GMP');
        expect(r.auth, r.id).toBe('SESSION');
        expect(r.path.startsWith('/api/analytics/'), r.id).toBe(true);
        expect(r.mutating, r.id).toBe(r.id === 'analytics.dispose');
        expect(r.method, r.id).toBe(r.id === 'analytics.dispose' ? 'POST' : 'GET');
        const examples = exampled.get(r.id) ?? [];
        expect(examples.length, `${r.id} has an example`).toBeGreaterThan(0);
        for (const data of examples) {
          expect(data, r.id).toMatchObject({ advisory: true, notForGmpDecisions: true });
          expect(r.response.safeParse({ ...(data as object), advisory: false }).success, r.id).toBe(false);
          expect(r.response.safeParse({ ...(data as object), notForGmpDecisions: false }).success, r.id).toBe(false);
          const { dataAgeSeconds: _age, ...noAge } = data as Record<string, unknown>;
          void _age;
          expect(r.response.safeParse(noAge).success, r.id).toBe(false);
        }
      }
    }
    expect(analyticsRoutes).toHaveLength(17);
    // Ids, and method with path, are unique among themselves and against the route table (which the namespaces join as
    // the slices that serve them bind them: analytics in 6A-1, D-6A-0-4; each joins with the same route objects).
    const table = new Map(allRoutes(routes).map((r) => [r.id, r]));
    for (const r of analyticsRoutes) if (table.has(r.id)) expect(table.get(r.id), r.id).toBe(r);
    expect(Object.keys(ANALYTICS_NAMESPACE_SLICES).filter((n) => n in routes)).toEqual(['analytics']);
    const all = [...table.values(), ...analyticsRoutes.filter((r) => !table.has(r.id))];
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(new Set(all.map((r) => `${r.method} ${r.path}`)).size).toBe(all.length);
  });

  it('[DI-51] statistics are finite numbers typed StatNumber, declared only in the analytics files; the GMP values a response repeats travel as decimal text', () => {
    expect(StatNumber.safeParse(1.25).success).toBe(true);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '1.25', null]) expect(StatNumber.safeParse(bad).success, String(bad)).toBe(false);
    const files = readdirSync(nsDir).filter((f) => f.endsWith('.ts'));
    const using = files.filter((f) => /\bStatNumber\b/.test(readFileSync(new URL(f, nsDir), 'utf8')));
    expect(using.length).toBeGreaterThanOrEqual(5);
    expect(using.filter((f) => !/^analytics(-[a-z]+)?\.ts$/.test(f))).toEqual([]);
    // The SPC chart echoes the master's limits and each recorded value as decimal text, never as a number.
    const chart = ANALYTICS_NAMESPACES.analyticsSpc.chart.response;
    const ok = ANALYTICS_EXAMPLES['analytics-spc-chart'].data;
    expect(chart.safeParse({ ...ok, specification: { ...ok.specification, upper: 8.2 } }).success).toBe(false);
    expect(chart.safeParse({ ...ok, points: [{ ...ok.points[0], value: 7.42 }] }).success).toBe(false);
    expect(chart.safeParse({ ...ok, centre: '7.49' }).success).toBe(false);
    const batch = ANALYTICS_NAMESPACES.analyticsMspc.batch.response;
    const b = ANALYTICS_EXAMPLES['analytics-mspc-batch'].data;
    expect(batch.safeParse({ ...b, contributions: [{ ...b.contributions[0], value: 98 }] }).success).toBe(false);
    // The catalogue states that no method changes GMP data (PR-60).
    const catalog = ANALYTICS_NAMESPACES.analytics.catalog.response;
    const c = ANALYTICS_EXAMPLES['analytics-catalog'].data;
    expect(catalog.safeParse({ ...c, methods: [{ ...c.methods[0], changesGmpData: true }] }).success).toBe(false);
  });

  it('[DI-52] a disposition names its verdict and a cause of at least 10 characters; a flag shows at least one reason', () => {
    const body = ANALYTICS_NAMESPACES.analytics.dispose.body;
    expect(body?.safeParse({ verdict: 'FALSE_ALARM', cause: 'Sensor recalibrated before the batch' }).success).toBe(true);
    expect(body?.safeParse({ verdict: 'FALSE_ALARM', cause: 'too short' }).success).toBe(false);
    expect(body?.safeParse({ verdict: 'IGNORED', cause: 'Sensor recalibrated before the batch' }).success).toBe(false);
    expect(body?.safeParse({ verdict: 'TRUE_SIGNAL', cause: 'Seen again on batch 25', supersedes: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e', reason: 'new evidence' }).success).toBe(true);
    const flags = ANALYTICS_NAMESPACES.analytics.flags.response;
    const f = ANALYTICS_EXAMPLES['analytics-flags'].data;
    expect(flags.safeParse({ ...f, flags: [{ ...f.flags[0], reasons: [] }] }).success).toBe(false);
    expect(ANALYTICS_NAMESPACES.analytics.flags.query.safeParse({ kind: 'PERSON' }).success).toBe(true);
    expect(ANALYTICS_NAMESPACES.analytics.flags.query.safeParse({ kind: 'OPERATOR' }).success).toBe(false);
  });
});
