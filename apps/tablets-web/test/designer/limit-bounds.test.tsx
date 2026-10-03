/**
 * Limit bounds in the designer document (review F47): whether a bound value itself passes ("at most 3.5 %") or fails
 * ("less than 3.5 %") is said in words in every mode, the author sets it next to the value, and clearing an exclusive
 * bound and typing it again never makes it inclusive (a wider limit) by default.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import { applyOp, OpError, type Op } from '../../src/features/designer/model/ops.ts';
import { fixtureContent, fixtureVersion, PALETTE, renderRouted } from './support.tsx';

afterEach(() => cleanup());

const TABLE = 'Limits of Loss on drying of granules';
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function lodValidated(c: flow.MbrContent): flow.LimitSpec['ranges'][number] {
  const r = c.parameters.find((p) => p.id === 'lod')?.limits?.ranges.find((x) => x.tier === 'VALIDATED');
  if (!r) throw new Error('fixture changed: lod has no validated range');
  return r;
}

function exclusiveLod(): flow.MbrContent {
  const c = fixtureContent();
  const high = lodValidated(c).high;
  if (!high?.inclusive) throw new Error('fixture changed: the validated upper limit of lod is not "at most"');
  high.inclusive = false;
  return c;
}

async function readOnlyTable(content: flow.MbrContent): Promise<HTMLElement> {
  const r = renderRouted(() => (
    <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
  ));
  await waitFor(() => expect(r.container.querySelector(`table[aria-label="${TABLE}"]`)).not.toBeNull(), { timeout: 10000 });
  return r.container.querySelector(`table[aria-label="${TABLE}"]`) as HTMLElement;
}

/** The document in DRAFT, editing its own content with the real operations; `seen` collects every dispatched op. */
function Editable({ initial, seen, onContent }: { initial: flow.MbrContent; seen: Op[]; onContent: (c: flow.MbrContent) => void }) {
  const [content, setContent] = useState(initial);
  const dispatch = (op: Op): boolean => {
    seen.push(op);
    try {
      const next = applyOp(content, op);
      setContent(next);
      onContent(next);
      return true;
    } catch (e) {
      if (e instanceof OpError) return false;
      throw e;
    }
  };
  return <DocumentView content={content} version={fixtureVersion({ state: 'DRAFT' })} palette={PALETTE} selected={null} onSelect={() => undefined} dispatch={dispatch} readOnly={false} findingsByNode={new Map()} />;
}

describe('limit bounds in the designer document (review F47)', () => {
  it('[PR-08][PR-02] the read-only document (IN_VERIFICATION) says in words whether each bound value passes: "less than 3.5 %" reads differently from "at most 3.5 %"', async () => {
    const inclusive = text(await readOnlyTable(fixtureContent()));
    cleanup();
    const exclusive = text(await readOnlyTable(exclusiveLod()));
    expect(inclusive).toContain('at least 2.0 %');
    expect(inclusive).toContain('at most 3.5 %');
    expect(exclusive).toContain('less than 3.5 %');
    expect(exclusive).not.toContain('at most 3.5 %');
    expect(exclusive).not.toBe(inclusive);
  });

  it('[PR-08] clearing an exclusive bound and typing it again keeps it exclusive; a bound is created only with its comparison stated', () => {
    const cleared = applyOp(exclusiveLod(), { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', value: null });
    expect(lodValidated(fixtureContent()).high).toBeDefined();
    expect(cleared.parameters.find((p) => p.id === 'lod')?.limits?.ranges.find((r) => r.tier === 'VALIDATED')?.high).toBeUndefined();
    // Without a stated comparison the bound is not created at all: no silent default to "the value passes".
    expect(() => applyOp(cleared, { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', value: '3.5' })).toThrow(/passes \(at most\) or fails \(less than\)/);
    const again = applyOp(cleared, { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', value: '3.5', inclusive: false });
    expect(lodValidated(again).high).toEqual({ value: '3.5', inclusive: false });
    // A bound that exists keeps its comparison when only its value changes.
    const moved = applyOp(exclusiveLod(), { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', value: '3.4' });
    expect(lodValidated(moved).high).toEqual({ value: '3.4', inclusive: false });
  });

  it('[PR-08] the comparison of an existing bound is set with its own operation; a bound that does not exist cannot be given one', () => {
    const strict = applyOp(fixtureContent(), { kind: 'SET_LIMIT_INCLUSIVE', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'low', inclusive: false });
    expect(lodValidated(strict).low).toEqual({ value: lodValidated(fixtureContent()).low?.value, inclusive: false });
    const cleared = applyOp(fixtureContent(), { kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'low', value: null });
    expect(() => applyOp(cleared, { kind: 'SET_LIMIT_INCLUSIVE', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'low', inclusive: true })).toThrow(OpError);
  });

  it('[PR-08][PR-02] while editing, the author sees and sets the comparison next to the value; a cleared exclusive bound typed again stays exclusive', async () => {
    const seen: Op[] = [];
    let latest = fixtureContent();
    renderRouted(() => <Editable initial={fixtureContent()} seen={seen} onContent={(c) => (latest = c)} />);
    const table = await screen.findByRole('table', { name: TABLE }, { timeout: 10000 });
    const comparison = within(table).getByRole<HTMLSelectElement>('combobox', { name: 'Loss on drying of granules, validated, upper limit: the value itself' });
    expect(comparison.options[comparison.selectedIndex]?.textContent).toBe('at most (the value itself passes)');
    await userEvent.selectOptions(comparison, 'EXCLUSIVE');
    expect(seen.at(-1)).toEqual({ kind: 'SET_LIMIT_INCLUSIVE', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', inclusive: false });
    expect(lodValidated(latest).high).toEqual({ value: '3.5', inclusive: false });
    await waitFor(() => expect(text(table)).toContain('less than 3.5 %'));

    const field = within(table).getByRole('textbox', { name: 'Loss on drying of granules, validated, upper limit' });
    await userEvent.clear(field);
    fireEvent.blur(field);
    await waitFor(() => expect(lodValidated(latest).high).toBeUndefined());
    expect(within(table).getByRole<HTMLSelectElement>('combobox', { name: 'Loss on drying of granules, validated, upper limit: the value itself' }).value).toBe('EXCLUSIVE');
    await userEvent.type(field, '3.5');
    fireEvent.blur(field);
    await waitFor(() => expect(lodValidated(latest).high).toEqual({ value: '3.5', inclusive: false }));
    expect(seen.at(-1)).toEqual({ kind: 'SET_LIMIT_BOUND', owner: 'parameter', id: 'lod', tier: 'VALIDATED', side: 'high', value: '3.5', inclusive: false });
  });
});
