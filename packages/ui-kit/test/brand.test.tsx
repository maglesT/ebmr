/**
 * The brand (decision 0020, slice 7e): the kit's copies of the owner's files equal docs/brand; the colour tokens are the
 * decision's sampled colours, mirrored in tokens.css, each used only where its contrast allows; the marks carry their
 * text alternatives ("Batchwright Tablets", "by Medhanta"); the identity banner shows the brand in place of the name.
 */
import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { brand, BRAND_COLOURS, contrast, identity } from '../src/index.ts';

const kit = `${import.meta.dirname}/../src`;
const docs = `${import.meta.dirname}/../../../docs/brand`;

describe('brand (decision 0020)', () => {
  it('the kit\'s brand files are the owner\'s files in docs/brand, byte for byte', () => {
    for (const f of ['batchwright-tablets.svg', 'batchwright-injectables.svg', 'batchwright-icon.svg', 'medhanta-logo-278x148.png']) {
      expect(readFileSync(`${kit}/brand/assets/${f}`).equals(readFileSync(`${docs}/${f}`)), f).toBe(true);
    }
  });

  it('the brand colour tokens are the colours sampled in decision 0020, mirrored in tokens.css', () => {
    const decision = readFileSync(`${import.meta.dirname}/../../../docs/decisions/0020-product-name-batchwright.md`, 'utf8');
    for (const [name, hex] of [['red-orange', BRAND_COLOURS.redOrange], ['amber', BRAND_COLOURS.amber], ['grey', BRAND_COLOURS.grey]] as const) {
      expect(decision, name).toContain(`about ${hex}`);
      expect(readFileSync(`${kit}/tokens/tokens.css`, 'utf8'), name).toContain(`--ebmr-brand-${name}: ${hex};`);
    }
  });

  it('each brand colour is used only where its contrast on white allows: grey for text (4.5:1), red-orange for marks (3:1), amber never alone', () => {
    expect(contrast(BRAND_COLOURS.grey, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BRAND_COLOURS.redOrange, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(BRAND_COLOURS.amber, '#ffffff')).toBeLessThan(3);
    // The kit's stylesheets: amber is never used, red-orange only for a border (a mark), grey for the maker's text.
    const css = ['brand/brand.module.css', 'identity/identity.module.css', 'primitives/ui.module.css'].map((f) => readFileSync(`${kit}/${f}`, 'utf8')).join('\n');
    expect(css).not.toContain('--ebmr-brand-amber');
    for (const m of css.matchAll(/^\s*([a-z-]+):[^;]*--ebmr-brand-red-orange/gm)) expect(m[1]).toMatch(/^border/);
  });

  it('the product title is "Batchwright <edition>" and the maker is Medhanta', () => {
    expect([brand.productTitle('TABLETS'), brand.productTitle('INJECTABLES')]).toEqual(['Batchwright Tablets', 'Batchwright Injectables']);
    // Decision 0020 amended (4 November 2026): Capsules is a header name only, shown by the Tablets build.
    expect([brand.productTitle('CAPSULES'), brand.editionWord('CAPSULES')]).toEqual(['Batchwright Capsules', 'Capsules']);
    const shown = render(<brand.HeaderBrand edition="CAPSULES" />);
    expect(within(shown.container).getByTestId('header-brand').textContent).toContain('Batchwright Capsules');
    shown.unmount();
    expect([brand.PRODUCT.name, brand.PRODUCT.maker]).toEqual(['Batchwright', 'Medhanta']);
  });

  it('the sign-in brand reads as the edition lockup and "by Medhanta"', () => {
    render(<brand.SignInBrand edition="TABLETS" />);
    const block = screen.getByTestId('sign-in-brand');
    expect(within(block).getByRole('img', { name: 'Batchwright Tablets' })).toBeTruthy();
    expect(within(block).getByRole('img', { name: 'Medhanta' })).toBeTruthy();
    expect(within(block).getByTestId('maker-mark').textContent).toBe('by');
  });

  it('the identity banner shows the brand given to it in place of the plain product name', () => {
    const noop = () => undefined;
    render(
      <identity.IdentityBanner productName="Batchwright Tablets" brand={<brand.HeaderBrand edition="TABLETS" />} installation="GMP" installationLabel="GMP installation" legalName="Asha Rao" loginName="asha.rao" role="QA_REVIEWER" deviceCode="PC-QA-1" roomCode={null} kiosk={false} onLock={noop} onSignOut={noop} />,
    );
    const header = screen.getByTestId('header-brand');
    expect(header.textContent).toContain('Batchwright Tablets');
    expect(within(header).getByRole('img', { name: 'Medhanta' })).toBeTruthy();
    // The icon beside the name is decorative: it adds no second name.
    expect(within(header).getAllByRole('img').map((i) => i.getAttribute('alt'))).toEqual(['Medhanta']);
  });
});
