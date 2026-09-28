/**
 * UI kit primitives: DecimalField never produces a number, is never pre-filled and echoes the value with its
 * unit; state colours keep 4.5:1 contrast; floor density sizes (plan sections 3 and 9).
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { contrast, DecimalField, decimalProblem, acceptTyping, DENSITY, PALETTE, StatusChip, t, WatermarkBand } from '../src/index.ts';

function Harness({ onValue }: { onValue: (v: unknown) => void }) {
  const [value, setValue] = useState('');
  return (
    <DecimalField
      label="Net weight"
      unit="kg"
      value={value}
      maxDecimals={3}
      onChange={(v) => {
        onValue(v);
        setValue(v);
      }}
    />
  );
}

describe('DecimalField', () => {
  it('[DI-30] is never pre-filled, hands out text only (never a number) and echoes the value with its unit', async () => {
    const seen: unknown[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Net weight');
    expect((input as HTMLInputElement).value).toBe('');
    await userEvent.type(input, '12.503');
    expect(seen.every((v) => typeof v === 'string')).toBe(true);
    expect(seen.at(-1)).toBe('12.503');
    expect(screen.getByText('You entered 12.503 kg')).toBeTruthy();
  });

  it('[DI-30] refuses exponents, commas, letters and more decimals than the precision', async () => {
    const seen: unknown[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Net weight') as HTMLInputElement;
    await userEvent.type(input, '1e3');
    expect(input.value).toBe('13');
    await userEvent.clear(input);
    await userEvent.type(input, '1,5');
    expect(input.value).toBe('15');
    await userEvent.clear(input);
    await userEvent.type(input, '1.2345');
    expect(screen.getByText('At most 3 decimals.')).toBeTruthy();
    expect(decimalProblem('1e3')).not.toBeNull();
    expect(decimalProblem('.5')).not.toBeNull();
    expect(decimalProblem('-1')).not.toBeNull();
    expect(decimalProblem('-1', { allowNegative: true })).toBeNull();
    expect(acceptTyping('1', '1x')).toBe('1');
  });
});

describe('tokens', () => {
  it('every state colour keeps at least 4.5:1 contrast against its background and white', () => {
    for (const [tone, pair] of Object.entries(PALETTE)) {
      expect(contrast(pair.fg, pair.bg), tone).toBeGreaterThanOrEqual(4.5);
      if (tone !== 'test') expect(contrast(pair.fg, '#ffffff'), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('floor density meets the kiosk minimums (targets 56 px, primary bar 80 px, keys 72 px, base font 20 px, values 32 px)', () => {
    expect(DENSITY.floor).toEqual({ target: 56, primaryBar: 80, keypadKey: 72, fontBase: 20, valueFont: 32 });
  });

  it('status is shown with an icon and a word, not colour alone; the sandbox band reads TEST, NOT GMP', () => {
    render(
      <>
        <StatusChip tone="warning" label="Alert limit" />
        <WatermarkBand text="TEST, NOT GMP" />
      </>,
    );
    expect(screen.getByText('Alert limit')).toBeTruthy();
    expect(screen.getByRole('note', { name: 'TEST, NOT GMP' })).toBeTruthy();
    expect(t('decimal.echo', { value: '1.0', unit: 'kg' })).toBe('You entered 1.0 kg');
  });
});
