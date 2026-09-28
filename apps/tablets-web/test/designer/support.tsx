/**
 * Web designer test support (module C2): a VersionView and palette built from the shared tablet fixture, the fixture
 * transport, and rendering inside a memory router with TanStack Query.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FindingView, VersionView } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import granulation from '../../../../packages/recipe-core/test/fixtures/tablet-granulation-compression.mbr.json' with { type: 'json' };
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import type { PaletteItem, ValidationData } from '../../src/features/designer/model/types.ts';

export const VERSION_ID = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';

const person = { personId: '7a1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e11', legalName: 'Asha Rao', loginName: 'asha.rao', role: 'MBR_AUTHOR' };
const at = { us: '1790580603000000', text: '28-SEP-2026 13:00:03 +05:30 (Asia/Kolkata)' };

export function fixtureContent(): flow.MbrContent {
  const r = flow.parseMbr(structuredClone(granulation));
  if (!r.ok) throw new Error('fixture does not parse');
  return r.mbr;
}

export function fixtureVersion(over: Partial<VersionView> = {}): VersionView {
  const content = fixtureContent();
  return {
    versionId: VERSION_ID,
    familyId: 'd4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f7a',
    familyCode: content.header.family,
    product: { code: content.header.product.code, name: content.header.product.name, strength: content.header.product.strength },
    number: '1',
    revision: 3,
    state: 'DRAFT',
    contentHash: flow.mbrContentHash(content),
    content: content as unknown as VersionView['content'],
    markets: content.header.marketSet,
    evidence: [],
    justifications: [],
    savedAt: at,
    savedBy: person,
    auditChain: `mbr_version:${VERSION_ID}`,
    ...over,
  };
}

export const PALETTE: PaletteItem[] = [
  { key: 'G-03@1', type: 'G-03', version: '1', title: 'Instruction and acknowledgement', plainName: 'Instruction to read or confirm', level: 'PHASE', roles: ['INSTRUCTION'], significant: false, availability: 'ALL', badge: null, configSchema: { type: 'object', description: 'x', fields: { text: { type: 'string', optional: true, description: 'Instruction text' }, acknowledgement: { type: 'string', enum: ['READ', 'CONFIRM_PERFORMED'], optional: true, description: 'Read or confirm' }, sop: { type: 'string', optional: true, description: 'SOP' } } }, defaultConfig: {}, controls: ['PR-03'] },
  { key: 'G-07@1', type: 'G-07', version: '1', title: 'Weighing and dispensing', plainName: 'Weigh and dispense', level: 'PHASE', roles: ['DISPENSING'], significant: true, availability: 'ALL', badge: null, configSchema: { type: 'object', description: 'x', fields: { tolerance: { type: 'object', optional: true, description: 'Tolerance', fields: { percent: { type: 'decimal', optional: true, description: 'Percent' } } } } }, defaultConfig: {}, controls: ['PR-19'] },
  { key: 'G-10@1', type: 'G-10', version: '1', title: 'Clearance checklist', plainName: 'Clear the room or line', level: 'PHASE', roles: ['CLEARANCE'], significant: true, availability: 'SANDBOX_ONLY', badge: 'sandbox only until Phase 3', configSchema: { type: 'object', description: 'x', fields: {} }, defaultConfig: {}, controls: ['PR-03'] },
  { key: 'G-17@1', type: 'G-17', version: '1', title: 'QA hold point', plainName: 'QA hold point', level: 'HOLD_POINT', roles: [], significant: false, availability: 'ALL', badge: null, configSchema: { type: 'object', description: 'x', fields: {} }, defaultConfig: {}, controls: ['PR-45'] },
];

export function finding(over: Partial<FindingView>): FindingView {
  return { key: 'GMP-STAGE-CLEARANCE@S-DISP', rule: 'GMP-STAGE-CLEARANCE', severity: 'ERROR', controls: ['PR-03'], section: '8', subjectPath: ['procedure', 'S-DISP'], nodeId: null, message: 'm', justification: null, ...over };
}

export function report(findings: FindingView[], hash = 'a'.repeat(64)): ValidationData {
  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;
  const unjustified = findings.filter((f) => f.severity === 'WARNING' && !f.justification).length;
  return { contentHash: hash, validatedAt: at, gate: { passed: errors === 0 && unjustified === 0, errors, warnings, unjustifiedWarnings: unjustified }, findings };
}

export function installFixtures(map: FixtureMap): void {
  setTransport(createFixtureFetch(map, { installation: 'GMP' }));
}

/** Renders `ui` as the only route of a memory router, with a fresh query client. */
export function renderRouted(ui: () => ReactNode) {
  const root = createRootRoute({ component: () => <>{ui()}</> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
