/**
 * D-8 (owner's items 13 and 21): a master with the author's own names, formula, yield limits and their source is saved
 * as a DRAFT revision and approved by QA like any other content; once approved, no content change is saved (a new
 * version is the way to change it). 21 CFR 211.160(b) asks for scientifically sound specifications, so each limit range
 * records its source.
 *
 * Controls: PR-03 (the master's content judged by the validator gate), PR-31 (the yield and its limits), DI-35 (QA's
 * approval signature).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type VersionView } from '@ebmr/api-contract';
import type { flow } from '@ebmr/recipe-core/pure';
import { startSigningServer, valueOf } from '../esig/support.ts';
import type { TestServer } from '../support/harness.ts';
import { gmpContent, gmpLifecycleWorld } from '../support/gmp-world.ts';
import { refusalOf } from './support.ts';

let gmp: TestServer;
beforeAll(async () => {
  gmp = await startSigningServer('GMP', { stub: false });
}, 600_000);
afterAll(async () => {
  await gmp?.close();
});

/** The edits the designer's D-8 ops make: names, a formula's name, the yield's limits and their source. */
function authorsOwn(m: flow.MbrContent): void {
  const calc = m.calculations.find((c) => c.id === 'blendYield');
  const y = m.yieldCheckpoints.find((k) => k.id === 'Y-BLEND');
  const range = y?.limits?.ranges.find((r) => r.tier === 'VALIDATED');
  const param = m.parameters.find((p) => p.id === 'blendNet');
  if (!calc || !y || !range || !param) throw new Error('SETUP: dc-mini has no blend yield');
  calc.name = 'Lubricated blend yield';
  y.name = 'Lubricated blend yield (bilayer core)';
  param.name = 'Lubricated blend discharged';
  range.low = { value: '97.0', inclusive: true };
  range.high = { value: '101.0', inclusive: true };
  range.source = { kind: 'COMPANY_STANDARD', ref: 'SOP-BLEND-002' };
}

describe('the author\'s own calculations, names and yield limits (D-8)', () => {
  it('[PR-03][PR-31][DI-35] the edited master is approved by QA; once approved its content is not changed (EBMR-RCP-021)', async () => {
    const content = gmpContent();
    authorsOwn(content);
    const world = await gmpLifecycleWorld(gmp);
    const v = await world.approvedVersion(content);
    expect((await world.state(v.versionId)).state).toBe('APPROVED');
    const author = await gmp.asPersona('author');
    const view: VersionView = valueOf(await author.call(routes.designer.version, { params: { versionId: v.versionId } }));
    expect((view.content as unknown as flow.MbrContent).yieldCheckpoints.find((k) => k.id === 'Y-BLEND')?.name).toBe('Lubricated blend yield (bilayer core)');
    // Each of the five D-8 ops' changes (the editor is read-only there; the server refuses the save whoever sends it).
    const changes: Record<string, (m: flow.MbrContent) => void> = {
      UPDATE_CALCULATION: (m) => void Object.assign(m.calculations.find((c) => c.id === 'blendYield') ?? {}, { expression: 'yield(blendNet, blendInput)' }),
      UPDATE_PARAMETER_NAME: (m) => void Object.assign(m.parameters.find((p) => p.id === 'blendNet') ?? {}, { name: 'Renamed after approval' }),
      UPDATE_YIELD: (m) => void Object.assign(m.yieldCheckpoints.find((k) => k.id === 'Y-BLEND') ?? {}, { theoretical: 'pcmTarget' }),
      SET_LIMIT_SOURCE: (m) => void Object.assign(m.yieldCheckpoints.find((k) => k.id === 'Y-BLEND')?.limits?.ranges[0] ?? {}, { source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }),
      ADD_LIMIT_RANGE: (m) => m.yieldCheckpoints.find((k) => k.id === 'Y-BLEND')?.limits?.ranges.push({ tier: 'ALERT', rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR-BLEND-01' } }),
    };
    for (const [op, change] of Object.entries(changes)) {
      const changed = structuredClone(view.content) as unknown as flow.MbrContent;
      change(changed);
      const r = await author.call(routes.designer.saveContent, { params: { versionId: v.versionId }, body: { baseRevision: view.revision, content: changed as unknown as VersionView['content'], note: `after approval: ${op}` } });
      expect([op, refusalOf(r).code]).toEqual([op, 'EBMR-RCP-021']);
    }
  }, 300_000);
});
