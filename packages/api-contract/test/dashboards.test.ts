/**
 * Contract of slice 6g (ns/dashboards.ts): the dashboards and the change impact are GMP and read-only, training is
 * SANDBOX only (DI-05), every route has an example, and the dashboards always say they are not for GMP decisions.
 */
import { describe, expect, it } from 'vitest';
import { EXAMPLES, SLICE_6G_ROUTE_IDS } from '../src/examples.ts';
import { routes } from '../src/routes.ts';

describe('slice 6g contract', () => {
  it('[DI-05] the dashboards and change impact are GMP and read-only, training is SANDBOX only; each route has an example', () => {
    const exampled = new Set(Object.values(EXAMPLES).map((e) => ('routeId' in e ? e.routeId : undefined)));
    for (const id of SLICE_6G_ROUTE_IDS) expect(exampled.has(id), `${id} has an example`).toBe(true);
    for (const r of [...Object.values(routes.dashboards), ...Object.values(routes.changeImpact)]) {
      expect(r.installation, r.id).toBe('GMP');
      expect(r.mutating, r.id).toBe(false);
      expect(r.method, r.id).toBe('GET');
    }
    for (const r of Object.values(routes.training)) expect(r.installation, r.id).toBe('SANDBOX');
    expect(SLICE_6G_ROUTE_IDS).toHaveLength(14);
  });

  it('a dashboard says it is not for GMP decisions and carries its data age; ratios travel as decimal text', () => {
    const view = routes.dashboards.pressOee.response;
    const ok = EXAMPLES['dashboards-press-oee'].data;
    expect(view.safeParse(ok).success).toBe(true);
    expect(view.safeParse({ ...ok, notForGmpDecisions: false }).success).toBe(false);
    const { dataAgeSeconds: _age, ...noAge } = ok;
    void _age;
    expect(view.safeParse(noAge).success).toBe(false);
    expect(view.safeParse({ ...ok, presses: [{ ...ok.presses[0], oee: 0.83 }] }).success).toBe(false);
    const period = routes.dashboards.alarmTrend.query;
    expect(period?.safeParse({ from: '2026-07-01', to: '2026-10-01' }).success).toBe(true);
    expect(period?.safeParse({ from: '2026-07-01T00:00:00Z' }).success).toBe(false);
    expect(routes.dashboards.export.query?.safeParse({ view: 'alarm_v1' }).success).toBe(true);
    expect(routes.dashboards.export.query?.safeParse({ view: 'recipe.batch_execution' }).success).toBe(false);
  });

  it('a change impact names one of the six kinds; its hash is SHA-256 hex', () => {
    const q = routes.changeImpact.query.query;
    expect(q?.safeParse({ kind: 'MATERIAL', ref: 'EXC-MCC-102' }).success).toBe(true);
    expect(q?.safeParse({ kind: 'PROCESS', ref: 'x' }).success).toBe(false);
    expect(q?.safeParse({ kind: 'MATERIAL', ref: ' ' }).success).toBe(false);
    const res = routes.changeImpact.query.response;
    expect(res.safeParse({ ...EXAMPLES['change-impact-material'].data, contentHash: 'abc' }).success).toBe(false);
  });

  it('[DI-05] the training overview carries the TEST, NOT GMP watermark of the training source', () => {
    const view = routes.training.overview.response;
    const ok = EXAMPLES['training-overview'].data;
    expect(view.safeParse(ok).success).toBe(true);
    expect(view.safeParse({ ...ok, watermark: null }).success).toBe(false);
    expect(view.safeParse({ ...ok, watermark: { ...ok.watermark, text: 'TRAINING' } }).success).toBe(false);
    expect(routes.training.completeStep.body?.safeParse({ step: 0 }).success).toBe(false);
  });
});
