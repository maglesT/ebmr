/**
 * Each screen has its own title (WCAG 2.4.2 Page Titled; slice 7d finding A11Y-2): "<the screen's heading> - <product>",
 * following the heading when the screen changes; the product title alone when a screen has no heading.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { pageTitle, usePageTitle } from '../../src/app/shell.tsx';

afterEach(() => {
  cleanup();
});

describe('page titles (A11Y-2)', () => {
  it('the title is the heading and the product; blank headings leave the product alone', () => {
    expect(pageTitle('Review queue', 'eBMR Tablets')).toBe('Review queue - eBMR Tablets');
    expect(pageTitle('  Exception register\n of batch  B-1 ', 'eBMR Tablets')).toBe('Exception register of batch B-1 - eBMR Tablets');
    expect(pageTitle('', 'eBMR Tablets')).toBe('eBMR Tablets');
    expect(pageTitle(null, 'eBMR Tablets')).toBe('eBMR Tablets');
    expect(pageTitle('Review queue', '')).toBe('Review queue');
  });

  it('the shell titles the page by the heading on show, and follows it when the screen changes', async () => {
    let go: (h: string | null) => void = () => undefined;
    function Screen() {
      usePageTitle();
      const [heading, setHeading] = useState<string | null>('Review queue');
      go = setHeading;
      return <main>{heading ? <h1>{heading}</h1> : <p>Loading</p>}</main>;
    }
    render(<Screen />);
    await waitFor(() => expect(document.title).toBe(pageTitle('Review queue')));
    act(() => go('Exception register of batch B-1'));
    await waitFor(() => expect(document.title).toBe(pageTitle('Exception register of batch B-1')));
    act(() => go(null));
    await waitFor(() => expect(document.title).toBe(pageTitle(null)));
  });
});
