/**
 * Design tokens (outline 7.4; plan section 7 "ui-kit tokens"): the state palette (colour + icon + word, never
 * colour alone) and the two densities. Every state colour pair keeps a contrast ratio of at least 4.5:1
 * (WCAG 2.2 AA for normal text); test/tokens.test.ts proves it. tokens.css mirrors these values.
 */
export type StateTone = 'ok' | 'warning' | 'error' | 'info' | 'neutral' | 'pending' | 'test';

export interface TonePair {
  fg: string;
  bg: string;
  border: string;
}

export const PALETTE: Readonly<Record<StateTone, TonePair>> = {
  ok: { fg: '#0b5d1e', bg: '#e6f4ea', border: '#1e8e3e' },
  warning: { fg: '#7a4100', bg: '#fff4e0', border: '#c26400' },
  error: { fg: '#a50e0e', bg: '#fce8e6', border: '#d93025' },
  info: { fg: '#0b4f9c', bg: '#e8f0fe', border: '#1a73e8' },
  neutral: { fg: '#3c4043', bg: '#f1f3f4', border: '#80868b' },
  pending: { fg: '#4a3a8c', bg: '#efeafd', border: '#6f58c9' },
  test: { fg: '#1f1300', bg: '#ffc107', border: '#a16d00' },
};

export const SURFACE = { text: '#202124', background: '#ffffff', muted: '#5f6368', focus: '#1a73e8' } as const;

/**
 * The Batchwright brand colours (decision 0020: sampled from the Medhanta logo, approximate until a brand guide gives the
 * exact codes). They mark the product's own identity only (the sign-in page, the header, the about page), never a state
 * and never a GMP record. Use: `grey` for text (at least 4.5:1 on white); `redOrange` for non-text marks such as the
 * header's rule (at least 3:1 on white, WCAG 1.4.11); `amber` only inside the gradient beside red-orange, never alone
 * as a mark or for text (about 2.2:1 on white). tokens.css mirrors these values (--ebmr-brand-*).
 */
export const BRAND_COLOURS = { redOrange: '#D4553A', amber: '#EF9E45', grey: '#6C6C6C' } as const;

export type Density = 'office' | 'floor';

/** Minimum sizes per density (plan section 9: floor targets >= 56 px, primary bar 80 px, keypad keys 72 px, base font 20 px, values 32 px). */
export const DENSITY: Readonly<Record<Density, { target: number; primaryBar: number; keypadKey: number; fontBase: number; valueFont: number }>> = {
  office: { target: 44, primaryBar: 56, keypadKey: 56, fontBase: 16, valueFont: 20 },
  floor: { target: 56, primaryBar: 80, keypadKey: 72, fontBase: 20, valueFont: 32 },
};

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
