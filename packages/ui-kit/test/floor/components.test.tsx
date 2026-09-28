/**
 * Floor kit components (module C4): NumericEntry and Keypad work on text only, never pre-fill and echo the
 * value; checklists pre-select nothing; scans take a keyboard-wedge burst; the action bar keeps unavailable
 * actions visible with the server's reason; glove-sized targets at floor density (computed styles).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { example } from '@ebmr/api-contract/examples';
import { floor } from '../../src/index.ts';
import { cls } from '../../src/primitives/classes.ts';
import { fcls } from '../../src/floor/classes.ts';

const G04 = example('step-g04-parameters');
const blendTime = G04.fields[0]!;

function NumericHarness({ onValue, maxDecimals }: { onValue: (v: unknown) => void; maxDecimals?: number }) {
  const [value, setValue] = useState('');
  return (
    <floor.NumericEntry
      label="Blend time"
      unit="min"
      value={value}
      {...(maxDecimals !== undefined ? { maxDecimals } : {})}
      target={{ value: '15', unit: 'min', source: 'MBR parameter blendTime' }}
      limits={blendTime.limits}
      onChange={(v) => {
        onValue(v);
        setValue(v);
      }}
    />
  );
}

describe('NumericEntry and Keypad', () => {
  it('[DI-28] is never pre-filled (the target is information only), hands out text only and echoes the value with its unit before commit', async () => {
    const seen: unknown[] = [];
    render(<NumericHarness onValue={(v) => seen.push(v)} maxDecimals={1} />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' });
    expect(input.value).toBe('');
    expect(screen.getByText('Target 15 min')).toBeTruthy();
    const pad = screen.getByRole('group', { name: 'Number keypad for Blend time' });
    for (const k of ['1', '5']) await userEvent.click(within(pad).getByRole('button', { name: k }));
    await userEvent.click(within(pad).getByRole('button', { name: 'Decimal point' }));
    await userEvent.click(within(pad).getByRole('button', { name: '5' }));
    expect(input.value).toBe('15.5');
    expect(seen.every((v) => typeof v === 'string')).toBe(true);
    expect(screen.getByText('You entered 15.5 min')).toBeTruthy();
    await userEvent.click(within(pad).getByRole('button', { name: 'Delete last digit' }));
    expect(input.value).toBe('15.');
    await userEvent.click(within(pad).getByRole('button', { name: 'Clear' }));
    expect(input.value).toBe('');
    expect(seen.every((v) => typeof v === 'string')).toBe(true);
  });

  it('[DI-28] shows the limit tiers with their sources but no verdict: the check appears only after the value is saved', async () => {
    render(<NumericHarness onValue={() => undefined} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Blend time' }), '21');
    expect(screen.getByText('Registered limit')).toBeTruthy();
    expect(screen.getByText('10 to 20 min')).toBeTruthy();
    expect(screen.getAllByText(/VR-BLEND-01/).length).toBeGreaterThan(0);
    expect(screen.getByText('The limit check appears after the value is saved.')).toBeTruthy();
    expect(screen.queryByText(/Limit check:/)).toBeNull();
    expect(screen.queryByText(/outside|above|below/i)).toBeNull();
  });

  it('a whole-number entry has no decimal point key, and the keypad cannot type an exponent', async () => {
    const seen: unknown[] = [];
    render(<NumericHarness onValue={(v) => seen.push(v)} maxDecimals={0} />);
    const pad = screen.getByRole('group', { name: 'Number keypad for Blend time' });
    expect(within(pad).getByRole('button', { name: 'Decimal point' }).hasAttribute('disabled')).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Blend time' }), '1e3');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Blend time' }).value).toBe('13');
  });

  it('boundsText words inclusive and exclusive bounds', () => {
    expect(floor.boundsText({ low: { value: '10', inclusive: true }, high: { value: '20', inclusive: true } }, 'min')).toBe('10 to 20 min');
    expect(floor.boundsText({ low: { value: '99.0', inclusive: true }, high: null }, '%')).toBe('at least 99.0 %');
    expect(floor.boundsText({ low: { value: '0', inclusive: false }, high: { value: '5', inclusive: false } }, 'kg')).toBe('more than 0 kg and less than 5 kg');
  });
});

describe('ChecklistEntry, ScanField, ChoiceGroup', () => {
  it('pre-selects nothing, counts unanswered items and reports each answer', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<Record<string, string>>({});
      return (
        <floor.ChecklistEntry
          label="Clearance checklist"
          items={[
            { id: 'A', label: 'No material of the previous product' },
            { id: 'B', label: 'No documents of the previous batch' },
          ]}
          answers={[
            { value: 'CONFIRMED', label: 'Confirmed' },
            { value: 'NOT_CONFIRMED', label: 'Not confirmed' },
          ]}
          value={value}
          onChange={(v) => {
            onChange(v);
            setValue(v);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole('radio').every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText('2 of 2 not answered yet')).toBeTruthy();
    const first = screen.getByRole('radiogroup', { name: 'No material of the previous product' });
    await userEvent.click(within(first).getByRole('radio', { name: 'Not confirmed' }));
    expect(onChange).toHaveBeenLastCalledWith({ A: 'NOT_CONFIRMED' });
    expect(screen.getByText('1 of 2 not answered yet')).toBeTruthy();
    expect(floor.checklistComplete([{ id: 'A', label: '' }], { A: 'CONFIRMED' })).toBe(true);
    expect(floor.checklistComplete([{ id: 'A', label: '' }, { id: 'B', label: '' }], { A: 'CONFIRMED' })).toBe(false);
  });

  it('takes a keyboard-wedge burst ending in Enter as one scan, and offers to scan again', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [code, setCode] = useState<string | null>(null);
      return (
        <floor.ScanField
          label="Lot"
          value={code}
          onChange={(c) => {
            onChange(c);
            setCode(c);
          }}
        />
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Lot' }), 'TEST-L26-0101{Enter}');
    expect(onChange).toHaveBeenCalledWith('TEST-L26-0101');
    expect(screen.getByText('Scanned: TEST-L26-0101')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('textbox', { name: 'Lot' })).toBeTruthy();
  });
});

describe('PrimaryActionBar, RefusalPanel, ExceptionBanner, StatusOutline', () => {
  it('[DI-34] keeps an unavailable action visible, greyed, with the server\'s reason; the More menu lists the rest with their reasons', async () => {
    const onMore = vi.fn();
    render(
      <floor.PrimaryActionBar
        primary={{ id: 'SIGN_PERFORMED|', label: 'Sign as performed', isDisabled: true, reason: 'Record the checklist first' }}
        more={[
          { id: 'RAISE_EXCEPTION|', label: 'Raise an exception', isDisabled: false, reason: null },
          { id: 'HOLD_BATCH|', label: 'Hold the batch', isDisabled: true, reason: 'Only a production supervisor or QA may hold the batch' },
        ]}
        onMore={onMore}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sign as performed' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain('Record the checklist first');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'More actions' });
    const hold = within(menu).getByRole('menuitem', { name: /Hold the batch/ });
    expect(hold.getAttribute('aria-disabled')).toBe('true');
    expect(hold.textContent).toContain('Only a production supervisor or QA may hold the batch');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Raise an exception/ }));
    expect(onMore).toHaveBeenCalledWith('RAISE_EXCEPTION|');
  });

  it('[INV-03] a refusal shows what happened, why, the rule and controls, what you can do and who can help', () => {
    render(
      <floor.RefusalPanel
        refusal={{
          code: 'ENG-VERIFY-INDEPENDENCE',
          kind: 'INDEPENDENCE',
          whatHappened: 'You cannot verify this step.',
          why: 'You performed or recorded data in this step; a different person must verify it.',
          controls: ['INV-03', 'PR-14'],
          whatYouCanDo: ['Ask a verifier to switch user with their badge and verify.'],
          whoCanHelp: ['PRODUCTION_VERIFIER', 'PRODUCTION_SUPERVISOR'],
        }}
        correlationId="c-42"
      />,
    );
    const panel = screen.getByRole('alert');
    expect(panel.textContent).toContain('You cannot verify this step.');
    expect(panel.textContent).toContain('a different person must verify it');
    expect(panel.textContent).toContain('ENG-VERIFY-INDEPENDENCE');
    expect(panel.textContent).toContain('INV-03, PR-14');
    expect(within(screen.getByTestId('who-can-help')).getByText('Production verifier')).toBeTruthy();
    expect(panel.textContent).toContain('c-42');
  });

  it('[PR-08] an exception shows expected against actual, whether it blocks and who it is routed to', () => {
    render(<floor.ExceptionBanner exception={G04.exceptions[0]!} />);
    expect(screen.getByText('Blend speed above the alert limit')).toBeTruthy();
    expect(screen.getByText('10 - 14 rpm')).toBeTruthy();
    expect(screen.getByText('15 rpm')).toBeTruthy();
    expect(screen.getByText('Does not block; it is reviewed later')).toBeTruthy();
    expect(screen.getByText('Production supervisor')).toBeTruthy();
  });

  it('marks the current step and shows every status as a word', async () => {
    const onSelect = vi.fn();
    const run = example('run');
    render(<floor.StatusOutline stages={run.stages} currentStepKey="p-blend@" onSelect={onSelect} />);
    const current = screen.getByTestId('outline-p-blend@');
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.textContent).toContain('Performed, waiting for verification');
    await userEvent.click(screen.getByTestId('outline-H-BLEND@'));
    expect(onSelect).toHaveBeenCalledWith('H-BLEND@');
  });
});

describe('glove-sized targets at floor density (computed styles)', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dirname, '../../src', rel), 'utf8');
  /** A CSS module's text with its class selectors renamed to the hashed names the components use. */
  const hashed = (css: string, name: (c: string) => string) => css.replace(/\.([A-Za-z][A-Za-z0-9_-]*)/g, (m: string, c: string) => (name(c) ? `.${name(c)}` : m));
  let style: HTMLStyleElement | null = null;

  afterEach(() => {
    style?.remove();
    style = null;
    delete document.documentElement.dataset['density'];
  });

  it('keypad keys are 72 px, buttons and choices at least 56 px, the primary bar 80 px', () => {
    style = document.createElement('style');
    style.textContent = [read('tokens/tokens.css'), hashed(read('primitives/ui.module.css'), cls), hashed(read('floor/floor.module.css'), fcls)].join('\n');
    document.head.appendChild(style);
    document.documentElement.dataset['density'] = 'floor';
    render(
      <>
        <floor.Keypad label="Net" value="" onChange={() => undefined} />
        <floor.ChoiceGroup label="Decision" options={[{ value: 'RELEASED', label: 'Released' }]} value={null} onChange={() => undefined} />
        <floor.PrimaryActionBar primary={{ id: 'p', label: 'Verify', isDisabled: false, reason: null }} more={[]} onMore={() => undefined} />
      </>,
    );
    const key = within(screen.getByRole('group', { name: 'Number keypad for Net' })).getByRole('button', { name: '7' });
    expect(getComputedStyle(key).minHeight).toBe('72px');
    expect(getComputedStyle(key).minWidth).toBe('72px');
    const choice = screen.getByText('Released').closest('label');
    expect(choice).not.toBeNull();
    expect(getComputedStyle(choice!).minHeight).toBe('56px');
    expect(getComputedStyle(screen.getByTestId('action-bar')).minHeight).toBe('80px');
    expect(getComputedStyle(screen.getByRole('button', { name: 'Verify' })).minWidth).toBe('56px');
  });
});
