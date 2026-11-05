/**
 * Declutter slice D4b (plan.md, D4-R5): one lot's OOS record opens from its lot page only, with the investigation, the
 * finding, the impact on the lot, the closure basis and QA's signed impact assessment and conclusion: what invalidating
 * a result for a laboratory error needs (a QA-concluded OOS record, IN-20). No classification change, no cancel, no
 * closure, and no call to a disconnected route. A record that is not an OOS record of the lot is not shown.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DISCONNECTED_ROUTES, routes, type AnyRoute } from '@ebmr/api-contract';
import { example } from '@ebmr/api-contract/examples';
import { apiState } from '../../src/api/client.ts';
import { renderOffice } from '../office/support.tsx';

afterEach(() => {
  cleanup();
  apiState.installation = undefined;
});

const LOT = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const base = example('deviation-detail');
const link = base.links[0];
if (!link) throw new Error('the detail example has a link');
const oos = {
  ...base,
  kind: 'OOS' as const,
  state: 'UNDER_INVESTIGATION' as const,
  finding: null,
  closureBasis: null,
  links: [{ ...link, subjectKind: 'LOT' as const, subjectId: LOT, subjectRef: 'LOT-0001', batchNumber: null, impacts: [] }],
};
const path = `/quality/lots/${LOT}/oos/${oos.deviationId}`;

/** The paths of the disconnected routes, as patterns. */
const offPaths = (Object.values(routes) as Record<string, AnyRoute>[])
  .flatMap((ns) => Object.values(ns))
  .filter((r) => DISCONNECTED_ROUTES[r.id] !== undefined)
  .map((r) => new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`));

describe('[DI-17] a lot opens only its own OOS record, with the parts a laboratory-error conclusion needs (declutter D4b)', () => {
  it('[DI-17][IN-20] the OOS record of the lot shows the finding, the impact, the closure basis and QA\'s signed acts; no reclassify, cancel or close, and no disconnected route is called', async () => {
    const ui = renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': oos } });
    expect((await screen.findByTestId('deviation-state')).textContent).toContain('UNDER_INVESTIGATION');
    expect(screen.getByTestId('finding')).toBeTruthy();
    expect(within(screen.getByTestId('deviation-impacts')).getByTestId('impact-form')).toBeTruthy();
    expect(within(screen.getByTestId('deviation-closure')).getByTestId('closure-form')).toBeTruthy();
    expect(within(screen.getByTestId('qa-decision')).getByRole('button', { name: 'Sign the impact assessment (QA signature)' })).toBeTruthy();
    expect(screen.queryByText('Reclassify')).toBeNull();
    expect(screen.queryByTestId('cancel-deviation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close (QA signature)' })).toBeNull();
    expect(screen.queryByTestId('link-form')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the lot' }).getAttribute('href')).toBe(`/quality/lots/${LOT}`);
    const off = ui.requests.filter((r) => offPaths.some((p) => p.test(r.path)));
    expect(off).toEqual([]);
  });

  it('[DI-17][IN-20] each state offers its next step to the conclusion: OPEN the investigation, IMPACT_ASSESSED the conclusion with the closure basis, PENDING_CLOSURE no closure', async () => {
    renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': { ...oos, state: 'OPEN' } } });
    expect(await screen.findByTestId('investigation')).toBeTruthy();
    expect(screen.queryByTestId('finding')).toBeNull();
    cleanup();
    renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': { ...oos, state: 'IMPACT_ASSESSED' } } });
    expect(await within(await screen.findByTestId('qa-decision')).findByRole('button', { name: 'Conclude (QA signature)' })).toBeTruthy();
    expect(screen.getByTestId('closure-form')).toBeTruthy();
    expect(screen.queryByTestId('investigation')).toBeNull();
    cleanup();
    renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': { ...oos, state: 'PENDING_CLOSURE', closureBasis: example('deviation-closure-basis').closureBasis } } });
    expect(await screen.findByTestId('closure-summary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close (QA signature)' })).toBeNull();
    expect(screen.queryByTestId('closure-form')).toBeNull();
  });

  it('[DI-17] a record that is not an OOS record linked to this lot is not shown', async () => {
    renderOffice(path, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': { ...oos, kind: 'DEVIATION' } } });
    expect(await screen.findByTestId('lot-oos-not-this-lot')).toBeTruthy();
    expect(screen.queryByTestId('finding')).toBeNull();
    cleanup();
    renderOffice(`/quality/lots/a0a0a0a0-b1b1-4c2c-8d3d-e4e4e4e4e4e4/oos/${oos.deviationId}`, { role: 'QA_REVIEWER', fixtures: { 'quality.deviationDetail': oos } });
    expect(await screen.findByTestId('lot-oos-not-this-lot')).toBeTruthy();
    expect(screen.queryByTestId('closure-form')).toBeNull();
  });

  it('[DI-17] the lot\'s release checklist links its OOS record to the lot\'s record page and no other record', async () => {
    const release = example('deviation-release');
    const item = release.items[0];
    if (!item) throw new Error('the release example has an item');
    renderOffice(`/quality/lots/${LOT}`, {
      role: 'QA_REVIEWER',
      fixtures: { 'quality.deviationRelease': { ...release, items: [{ ...item, kind: 'OOS' }, { ...item, deviationId: 'e5e5e5e5-f6f6-4a7a-8b8b-c9c9c9c9c9c9', ref: 'DEV-OTHER', kind: 'DEVIATION' }] } },
    });
    const box = await screen.findByTestId('deviation-release');
    expect((await within(box).findByRole('link', { name: item.ref })).getAttribute('href')).toBe(`/quality/lots/${LOT}/oos/${item.deviationId}`);
    expect(within(box).queryByRole('link', { name: 'DEV-OTHER' })).toBeNull();
  });
});
