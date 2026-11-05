/**
 * Capsules edition C2 (decision 0020 amended, 4 November 2026): the header reads "Batchwright Capsules" while a master or
 * batch with a capsule dosage form is on screen, and "Batchwright Tablets" otherwise (no dosage form means a tablet).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppHeaderBrand, useScreenDosageForm } from '../../src/app/brand.tsx';

afterEach(() => {
  cleanup();
});

function Screen({ form }: { form: string | null }) {
  useScreenDosageForm(form);
  return null;
}

/** The header, and a master or batch screen naming `form` (none on screen when `form` is undefined). */
function App({ form }: { form?: string | null }) {
  return (
    <>
      <AppHeaderBrand />
      {form === undefined ? null : <Screen form={form} />}
    </>
  );
}

const header = (): string => screen.getByTestId('header-brand').textContent ?? '';

describe('the header name follows the dosage form on screen (Capsules edition C2)', () => {
  it('[PR-01] Capsules while a capsule master or batch is on screen; Tablets for a tablet, no dosage form, a bare Softgel, or nothing on screen', () => {
    const { rerender } = render(<App />);
    expect(header()).toContain('Batchwright Tablets');
    for (const [form, shown] of [
      ['Hard gelatin capsule', 'Batchwright Capsules'],
      ['Film-coated tablet', 'Batchwright Tablets'],
      ['soft gelatin CAPSULE', 'Batchwright Capsules'],
      [null, 'Batchwright Tablets'],
      ['Softgel', 'Batchwright Tablets'],
      ['Soft gelatin capsule', 'Batchwright Capsules'],
    ] as const) {
      rerender(<App form={form} />);
      expect(header()).toContain(shown);
    }
    rerender(<App />);
    expect(header()).toContain('Batchwright Tablets');
  });
});
