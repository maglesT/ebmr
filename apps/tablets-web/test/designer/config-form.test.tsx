/**
 * The block configuration form records what the author sees (review F52, F53), with the real block schemas of the
 * recipe-core registry (as the palette sends them):
 *  - an optional yes/no member is a choice of the block default (with the value the block applies when the member is
 *    absent), yes or no; an explicit no is recorded as false, never as "absent" (which several blocks read as yes);
 *    the checker's document says which members are left to the block default and what that means;
 *  - a whole number that is not one within the schema's range is refused in words and never left on screen as if it
 *    were the configuration.
 * The review's reproducers (designer-ui-config-form, verify-designer-ui-optional-boolean-default,
 * verify-designer-ui-integer-field-silent-drop) are ported here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { flow } from '@ebmr/recipe-core/pure';
import { blocks } from '@ebmr/recipe-core/pure';
import { ConfigForm } from '../../src/features/designer/components/ConfigForm.tsx';
import { DocumentView } from '../../src/features/designer/components/DocumentView.tsx';
import type { PaletteItem } from '../../src/features/designer/model/types.ts';
import { fixtureContent, fixtureVersion, PALETTE, renderRouted } from './support.tsx';

type Json = flow.JsonValue;

afterEach(() => cleanup());

/** The configuration schema of a registry block as JSON (as the palette route sends it). */
function schemaOf(type: string): Record<string, unknown> {
  const b = blocks.genericBlockRegistry().get(type, '1');
  if (!b?.configSchema) throw new Error(`no schema for ${type}`);
  return JSON.parse(JSON.stringify(b.configSchema)) as Record<string, unknown>;
}

/** A form that holds its configuration, as StepEditor does through update({ config }). */
function Host({ type, initial, seen }: { type: string; initial: Record<string, Json>; seen: Record<string, Json>[] }) {
  const [config, setConfig] = useState(initial);
  return (
    <ConfigForm
      schema={schemaOf(type)}
      value={config}
      readOnly={false}
      sopOptions={[]}
      onChange={(v) => {
        seen.push(v);
        setConfig(v);
      }}
    />
  );
}

const choice = (name: RegExp): HTMLSelectElement => screen.getByRole('combobox', { name });
const selectedText = (s: HTMLSelectElement): string => s.options[s.selectedIndex]?.textContent ?? '';

/** Every optional yes/no member of every registered block configuration. */
const OPTIONAL_BOOLEANS: [string, string][] = blocks
  .genericBlockRegistry()
  .all()
  .flatMap((b) => Object.entries(b.configSchema?.fields ?? {}).filter(([, f]) => f.type === 'boolean' && f.optional === true).map(([k]): [string, string] => [b.type, k]));

describe('optional yes/no members (review F52)', () => {
  it('[PR-02][PR-03] G-05 blockOnUnexpected: an absent member shows the block default (yes); choosing no records false, not "absent" (which the block reads as yes)', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-05" initial={{ blockOnUnexpected: true }} seen={seen} />);
    const field = choice(/blockOnUnexpected/);
    expect(selectedText(field)).toBe('yes');
    await userEvent.selectOptions(field, 'no');
    expect(seen.at(-1)).toEqual({ blockOnUnexpected: false });
    await userEvent.selectOptions(field, '');
    expect(seen.at(-1)).toEqual({});
    expect(selectedText(choice(/blockOnUnexpected/))).toBe('block default (yes)');
  });

  it('[PR-02][PR-03] G-23 witness: the checker reads an absent member as the block default, witnessed (yes), never as "not witnessed"', () => {
    render(<ConfigForm schema={schemaOf('G-23')} value={{}} onChange={() => undefined} readOnly sopOptions={[]} />);
    const field = choice(/witness/);
    expect(field.disabled).toBe(true);
    expect(selectedText(field)).toBe('block default (yes)');
    expect(screen.queryByRole('checkbox', { name: /witness/ })).toBeNull();
  });

  it('[PR-02][PR-03] G-08 chargeAll: the block default says it depends on the sub-lot section; an explicit no allows a partial charge', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-08" initial={{}} seen={seen} />);
    expect(selectedText(choice(/chargeAll/))).toBe('block default (yes outside a sub-lot section, no inside one)');
    await userEvent.selectOptions(choice(/chargeAll/), 'no');
    expect(seen.at(-1)).toEqual({ chargeAll: false });
  });

  for (const [type, field] of OPTIONAL_BOOLEANS) {
    it(`[PR-02][PR-03] ${type} ${field}: absent, yes and no are each recorded as chosen, and shown as recorded`, async () => {
      const seen: Record<string, Json>[] = [];
      render(<Host type={type} initial={{}} seen={seen} />);
      const name = new RegExp(`^${field}`);
      expect(selectedText(choice(name))).toMatch(/^block default \((yes|no|.+ inside one)\)$/);
      await userEvent.selectOptions(choice(name), 'no');
      expect(seen.at(-1)?.[field]).toBe(false);
      expect(selectedText(choice(name))).toBe('no');
      await userEvent.selectOptions(choice(name), 'yes');
      expect(seen.at(-1)?.[field]).toBe(true);
      await userEvent.selectOptions(choice(name), '');
      expect(seen.at(-1)).not.toHaveProperty(field);
    });
  }

  it('[PR-02] a required yes/no member stays a box that records true and false', async () => {
    const onChange = vi.fn<(v: Record<string, Json>) => void>();
    const schema = { type: 'object', description: 'x', fields: { sealed: { type: 'boolean', description: 'Sealed' } } };
    render(<ConfigForm schema={schema} value={{ sealed: true }} onChange={onChange} readOnly={false} sopOptions={[]} />);
    await userEvent.click(screen.getByRole('checkbox', { name: /sealed/ }));
    expect(onChange).toHaveBeenLastCalledWith({ sealed: false });
  });

  it('[PR-02][PR-03][DI-04] the checker\'s document says which yes/no members a step leaves to the block default, and what the block then does', async () => {
    const real = (type: string): PaletteItem => ({ key: `${type}@1`, type, version: '1', title: type, plainName: type, level: 'PHASE', roles: [], significant: true, availability: 'ALL', badge: null, insertable: !type.startsWith('TB-'), configSchema: schemaOf(type), defaultConfig: {}, controls: [] });
    const palette = [...PALETTE, real('G-08'), real('G-23'), real('G-14')];
    const content = fixtureContent();
    const r = renderRouted(() => (
      <DocumentView content={content} version={fixtureVersion({ state: 'IN_VERIFICATION' })} palette={palette} selected={null} onSelect={() => undefined} dispatch={() => false} readOnly findingsByNode={new Map()} />
    ));
    await waitFor(() => expect(r.container.querySelector('#mbr-node-p-comp-rejects')).not.toBeNull(), { timeout: 10000 });
    const text = (id: string): string => (r.container.querySelector(`[id="mbr-node-${id}"]`)?.textContent ?? '').replace(/\s+/g, ' ');
    expect(text('p-comp-rejects')).toContain('witness: yes (block default)');
    expect(text('p-charge')).toContain('chargeAll: yes outside a sub-lot section, no inside one (block default)');
    expect(text('p-potency')).toContain('showFormula: yes (block default)');
  });
});

describe('whole numbers (review F53)', () => {
  it('[PR-03][PR-29] G-12 locations: text the form does not take ("12 ") is refused in words; the content keeps 10 and says so', async () => {
    const onChange = vi.fn<(v: Record<string, Json>) => void>();
    render(<ConfigForm schema={schemaOf('G-12')} value={{ locations: 10, replicates: 3 }} onChange={onChange} readOnly={false} sopOptions={[]} />);
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: /locations/ });
    expect(field.value).toBe('10');
    await userEvent.clear(field);
    await userEvent.type(field, '12 ');
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter a whole number from 1 to 500, in digits only. The configuration keeps 10.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
  });

  for (const typed of ['1.5', '05', '1,000', '0', '501', '-3', '1e2', '99999999999999999999']) {
    it(`[PR-03][PR-29] G-12 locations: "${typed}" is refused with the schema's range, nothing is committed`, async () => {
      const seen: Record<string, Json>[] = [];
      render(<Host type="G-12" initial={{ locations: 10 }} seen={seen} />);
      const field = screen.getByRole<HTMLInputElement>('textbox', { name: /locations/ });
      await userEvent.clear(field);
      await userEvent.type(field, typed);
      fireEvent.blur(field);
      expect(seen).toEqual([]);
      expect(screen.getByRole('alert').textContent).toContain('Enter a whole number from 1 to 500, in digits only.');
    });
  }

  it('[PR-03][PR-29] a whole number within the range is recorded and the message goes; an optional field emptied removes the member', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-12" initial={{ locations: 10, replicates: 3 }} seen={seen} />);
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: /locations/ });
    await userEvent.clear(field);
    await userEvent.type(field, '12 ');
    fireEvent.blur(field);
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, '500{Enter}');
    expect(seen.at(-1)).toEqual({ locations: 500, replicates: 3 });
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.clear(field);
    fireEvent.blur(field);
    expect(seen.at(-1)).toEqual({ replicates: 3 });
  });

  it('[PR-03] a required whole number cannot be emptied', async () => {
    const onChange = vi.fn<(v: Record<string, Json>) => void>();
    const schema = { type: 'object', description: 'x', fields: { units: { type: 'integer', min: 1, max: 100000, description: 'Units' } } };
    render(<ConfigForm schema={schema} value={{ units: 4 }} onChange={onChange} readOnly={false} sopOptions={[]} />);
    const field = screen.getByRole('textbox', { name: /units/ });
    await userEvent.clear(field);
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('A value is required. The configuration keeps 4.');
  });
});

describe('an optional group is removed as a whole (slice 7o, found by the R4 browser run)', () => {
  it('[PR-03] a copied master\'s optional duration (an acid stage) is removed with its own button; a required group has none', async () => {
    const DURATION = { type: 'object', description: 'A duration', fields: { value: { type: 'decimal', min: '0', description: 'Decimal written as text' }, unit: { type: 'string', enum: ['min', 'h'], description: 'Time unit' } } };
    const schema = { type: 'object', fields: { timeLimit: DURATION, acidTime: { ...DURATION, optional: true } } };
    const seen: Record<string, Json>[] = [];
    function OwnHost() {
      const [config, setConfig] = useState<Record<string, Json>>({ timeLimit: { value: '30', unit: 'min' }, acidTime: { value: '1', unit: 'h' } });
      return (
        <ConfigForm
          schema={schema}
          value={config}
          readOnly={false}
          sopOptions={[]}
          onChange={(v) => {
            seen.push(v);
            setConfig(v);
          }}
        />
      );
    }
    render(<OwnHost />);
    expect(screen.queryByRole('button', { name: 'Remove timeLimit' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Remove acidTime' }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ timeLimit: { value: '30', unit: 'min' } }));
    expect(screen.queryByRole('button', { name: 'Remove acidTime' })).toBeNull();
  });
});

describe('the printed items of a G-21 step after create (injectables residual P3c)', () => {
  const ITEMS = [
    { id: 'CARTON', material: 'MAT-CTN-10', artwork: { IN: 'ART-7' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' } },
    { id: 'LEAFLET', material: 'MAT-LFT-1', artwork: { IN: 'ART-9' }, unit: '1', issue: { need: '1000', allowancePercent: '2' }, counting: 'MANUAL_COUNT', limits: { maxUnexplained: '0' } },
  ];

  it('[PR-32][PR-39] on a draft each printed item\'s own values are edited in place: the limit of one item changes, the other item and its artwork stay as they were', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-21" initial={{ items: structuredClone(ITEMS) }} seen={seen} />);
    const leaflet = screen.getByRole('group', { name: 'items 2: LEAFLET' });
    const max = within(leaflet).getByRole('textbox', { name: /maxUnexplained \(optional\)/ });
    await userEvent.clear(max);
    await userEvent.type(max, '5');
    await userEvent.tab();
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.at(-1)?.['items']).toEqual([ITEMS[0], { ...ITEMS[1], limits: { maxUnexplained: '5' } }]);
  });

  it('[PR-32][PR-39] on a draft a printed item is added empty (nothing filled in for the author) and removed; removing the last leaves no items member', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-21" initial={{ items: structuredClone(ITEMS.slice(0, 1)) }} seen={seen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add a printed item' }));
    expect(seen.at(-1)?.['items']).toEqual([ITEMS[0], {}]);
    expect(screen.getByRole('group', { name: 'items 2' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove items 1: CARTON' }));
    expect(seen.at(-1)?.['items']).toEqual([{}]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove items 1' }));
    expect(seen.at(-1)).toEqual({});
    expect(screen.getByRole('button', { name: 'Add a printed item' })).toBeTruthy();
  });

  it('[PR-32][PR-39] on a draft a printed item\'s artwork version per market is edited, a market added by its code and version, and a market removed; nothing is filled in', async () => {
    const seen: Record<string, Json>[] = [];
    render(<Host type="G-21" initial={{ items: structuredClone(ITEMS.slice(0, 1)) }} seen={seen} />);
    const artwork = screen.getByRole('group', { name: 'artwork' });
    const add = within(artwork).getByRole('button', { name: 'Add the market' });
    expect(add.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(artwork).getByLabelText('artwork: new market code'), 'us');
    expect(add.hasAttribute('disabled')).toBe(true);
    await userEvent.type(within(artwork).getByLabelText('artwork: its artwork version'), 'ART-US-3');
    await userEvent.click(add);
    expect((seen.at(-1)?.['items'] as Json[])[0]).toEqual({ ...ITEMS[0], artwork: { IN: 'ART-7', US: 'ART-US-3' } });
    const inVersion = within(artwork).getByRole('textbox', { name: 'artwork: IN' });
    await userEvent.clear(inVersion);
    await userEvent.type(inVersion, 'ART-8');
    await userEvent.tab();
    await waitFor(() => expect(((seen.at(-1)?.['items'] as Json[])[0] as Record<string, Json>)['artwork']).toEqual({ IN: 'ART-8', US: 'ART-US-3' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'artwork' })).getByRole('button', { name: 'Remove market US' }));
    expect(((seen.at(-1)?.['items'] as Json[])[0] as Record<string, Json>)['artwork']).toEqual({ IN: 'ART-8' });
  });

  it('[PR-03][PR-32] on a read-only step the printed items stay shown in full, not as editable fields', () => {
    render(<ConfigForm schema={schemaOf('G-21')} value={{ items: ITEMS }} onChange={() => undefined} readOnly sopOptions={[]} />);
    expect(screen.queryByRole('group', { name: 'items 1: CARTON' })).toBeNull();
    expect(document.body.textContent).toContain('MAT-LFT-1');
  });
});
