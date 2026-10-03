/**
 * Roles in the designer (Phase 2 exit review F48, F49; PR-45, INV-26, PR-14): a QA hold point is released by QA only,
 * a role is never shown as another one, and the edit operations refuse a role a master cannot name. The gate and the
 * database refuse such content too (recipe-core validator/roles, apps/tablets-server designer/roles).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ENGINE_ROLES } from '@ebmr/api-contract';
import { flow } from '@ebmr/recipe-core/pure';
import { roleTitle } from '../../src/features/designer/components/common.tsx';
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { StepEditor } from '../../src/features/designer/components/StepEditor.tsx';
import { applyOp, OpError } from '../../src/features/designer/model/ops.ts';
import { fixtureContent, fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

function withHoldRole(role: string): flow.MbrContent {
  const c = fixtureContent();
  let found = false;
  flow.walk(c.procedure.body, (n) => {
    if (n.kind === 'holdPoint' && n.id === 'H-CORES') {
      n.role = role;
      found = true;
    }
  });
  if (!found) throw new Error('fixture has no H-CORES');
  return c;
}

function releasedBy(role: string): { value: string; text: string; options: string[] } {
  render(<StepEditor content={withHoldRole(role)} stepId="H-CORES" number="9" palette={PALETTE} readOnly={false} dispatch={() => undefined} />);
  const select = screen.getByLabelText<HTMLSelectElement>('Released by');
  const out = { value: select.value, text: select.options[select.selectedIndex]?.textContent ?? '', options: [...select.options].map((o) => o.value) };
  cleanup();
  return out;
}

describe('roles in the designer (F48, F49)', () => {
  it('[PR-45] "Released by" of a QA hold point offers QA only', () => {
    const qa = releasedBy('QA');
    expect(qa.options).toEqual(['QA']);
    expect(qa.text).toBe(roleTitle('QA'));
  });

  it('[INV-26][PR-45] a releaser the content holds but no choice offers is shown as it is, marked, never as the first option', () => {
    const kernel = releasedBy('QA_SHOP_FLOOR');
    expect(kernel.value).toBe('QA_SHOP_FLOOR');
    expect(kernel.text).toBe('QA_SHOP_FLOOR: not one of the choices');
    const operator = releasedBy('PRODUCTION_OPERATOR');
    expect(operator.text).toBe('PRODUCTION_OPERATOR: not one of the choices');
  });

  it('[INV-26] a kernel role (QA_SHOP_FLOOR) or any code outside the engine vocabulary never reads like an engine role; engine roles keep their titles', () => {
    expect(roleTitle('QA_SHOP_FLOOR')).not.toBe(roleTitle('QA'));
    expect(roleTitle('QA_SHOP_FLOOR')).toBe('QA_SHOP_FLOOR (not an engine role: no one can act in it)');
    expect(roleTitle('OPERATOR')).toBe('OPERATOR (not an engine role: no one can act in it)');
    for (const r of ENGINE_ROLES) expect(roleTitle(r)).not.toMatch(/not an engine role/);
  });

  it('[INV-26][PR-45] the read-only document marks a hold point released by a role outside the vocabulary', async () => {
    const r = renderRouted(() => (
      <DocumentView content={withHoldRole('QA_SHOP_FLOOR')} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
    ));
    await waitFor(() => expect(r.container.querySelector('[id="mbr-node-H-CORES"]')).not.toBeNull(), { timeout: 10000 });
    expect(within(r.container.querySelector('[id="mbr-node-H-CORES"]') as HTMLElement).getByText('QA_SHOP_FLOOR (not an engine role: no one can act in it)')).toBeTruthy();
  });

  it('[PR-45][INV-26][PR-14] the edit operations refuse a releaser other than QA and a performer or checker outside the engine roles', () => {
    const c = fixtureContent();
    for (const role of ['PRODUCTION_OPERATOR', 'QA_SHOP_FLOOR', 'QA_REVIEWER']) {
      expect(() => applyOp(c, { kind: 'UPDATE_HOLD', nodeId: 'H-CORES', patch: { role } }), role).toThrow(/The releasing role of a QA hold point must be one of QA/);
    }
    expect(() => applyOp(c, { kind: 'UPDATE_PHASE', nodeId: 'p-drymix', patch: { signatures: { perform: { role: 'OPERATOR' } } } })).toThrow(OpError);
    expect(() => applyOp(c, { kind: 'UPDATE_PHASE', nodeId: 'p-drymix', patch: { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'QA_SHOP_FLOOR' } } } })).toThrow(/The checker must be one of/);
    // Control: the engine roles are taken.
    const ok = applyOp(c, { kind: 'UPDATE_PHASE', nodeId: 'p-drymix', patch: { signatures: { perform: { role: 'PRODUCTION_OPERATOR' }, check: { meaning: 'VERIFIED', role: 'PRODUCTION_SUPERVISOR' } } } });
    expect(ok).not.toBe(c);
    expect(() => applyOp(c, { kind: 'UPDATE_HOLD', nodeId: 'H-CORES', patch: { role: 'QA' } })).not.toThrow();
  });
});
