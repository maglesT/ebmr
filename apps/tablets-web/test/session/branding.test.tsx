/**
 * Branding (decision 0020, slice 7e): the sign-in pages show the Batchwright Tablets lockup and "by Medhanta" with the
 * Medhanta logo; the header shows the product with the maker and links to the about page, which names the product,
 * edition, version (from /api/meta, as the server reports it), maker and installation. The page's title and icons come
 * from index.html and the web app manifest (public/). Each test runs the real Gate against a fixture server.
 */
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { SessionView } from '@ebmr/api-contract';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { BootProvider } = await import('../../src/app/boot.tsx');
const { Gate } = await import('../../src/app/App.tsx');

const office = EXAMPLES['session-office'].data as SessionView;
const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const noSession = {
  status: 401,
  body: { refusal: { code: 'NO_SESSION', kind: 'NOT_ALLOWED', whatHappened: 'You are not signed in on this installation.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fixture', retryable: false },
};
const meta = { ...(EXAMPLES['meta-gmp'].data as Record<string, unknown>), version: '1.0.0-rc.1' };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'branding' };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function serve(device: SessionView['device'], session: unknown) {
  setTransport(
    createFixtureFetch(
      { 'meta.get': meta, 'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 }, 'session.identify': device, 'session.demoDevices': { devices: [] }, 'session.get': session },
      { installation: 'GMP' },
    ),
  );
  render(
    // Declutter D3: the home's work cards read through TanStack Query.
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <BootProvider>
        <Gate />
      </BootProvider>
    </QueryClientProvider>,
  );
}

function expectSignInBrand() {
  const block = screen.getByTestId('sign-in-brand');
  // Declutter D3 (decision 0020 as amended): the sign-in page says just "Batchwright"; the header names the edition.
  expect(within(block).getByRole('img', { name: 'Batchwright' })).toBeTruthy();
  expect(within(block).queryByRole('img', { name: 'Batchwright Tablets' })).toBeNull();
  const maker = within(block).getByTestId('maker-mark');
  expect(within(maker).getByRole('img', { name: 'Medhanta' }).getAttribute('src')).toMatch(/medhanta-logo-278x148/);
  expect(maker.textContent).toBe('by');
}

describe('branding (decision 0020)', () => {
  it('the office sign-in shows the Batchwright name and "by Medhanta" with the Medhanta logo', async () => {
    serve(office.device, noSession);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expectSignInBrand();
  });

  it('the kiosk sign-in shows the same name and maker above the badge prompt', async () => {
    serve(kiosk.device, noSession);
    expect(await screen.findByLabelText('Badge')).toBeTruthy();
    expectSignInBrand();
  });

  it('signed in, the header names Batchwright Tablets with the maker and links to the about page, which shows product, edition, version, maker and installation', async () => {
    serve(office.device, office);
    const header = await screen.findByTestId('header-brand');
    expect(within(header).getByRole('img', { name: 'Medhanta' })).toBeTruthy();
    const link = within(header).getByRole('link', { name: 'Batchwright Tablets' });
    expect(link.getAttribute('href')).toBe('/about');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'About Batchwright Tablets' })).toBeTruthy();
    const facts = screen.getByTestId('about-facts');
    const pairs = [...facts.querySelectorAll('div')].map((d) => `${d.querySelector('dt')?.textContent ?? ''}: ${d.querySelector('dd')?.textContent ?? ''}`);
    expect(pairs).toEqual(['Product: Batchwright', 'Edition: Tablets', 'Version: 1.0.0-rc.1', 'Made by: Medhanta Digipartner', 'Installation: GMP installation', 'Site: SITE-1']);
    expect(screen.getByText(/never carry the Batchwright name or the Medhanta logo/)).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });
});

describe('the page title, icons and web app manifest', () => {
  const root = `${import.meta.dirname}/../..`;
  const html = readFileSync(`${root}/index.html`, 'utf8');
  const png = (path: string): [number, number] => {
    const b = readFileSync(`${root}/public${path}`);
    expect(b.subarray(1, 4).toString('latin1'), path).toBe('PNG');
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };

  it('the title is "Batchwright" and the tab icon is the Batchwright icon (decision 0020 as amended)', () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe('Batchwright');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(readFileSync(`${root}/public/favicon.svg`, 'utf8')).toBe(readFileSync(`${root}/../../docs/brand/batchwright-icon.svg`, 'utf8'));
    expect(png('/icon-32.png')).toEqual([32, 32]);
    expect(png('/apple-touch-icon.png')).toEqual([180, 180]);
  });

  it('the manifest names Batchwright and lists icons of the sizes an installed app needs, each file of its stated size', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const manifest = JSON.parse(readFileSync(`${root}/public/manifest.webmanifest`, 'utf8')) as { name: string; short_name: string; icons: { src: string; sizes: string; type: string }[] };
    expect([manifest.name, manifest.short_name]).toEqual(['Batchwright', 'Batchwright']);
    const sizes = manifest.icons.filter((i) => i.type === 'image/png').map((i) => [i.sizes, png(i.src).join('x')]);
    expect(sizes).toEqual([
      ['192x192', '192x192'],
      ['512x512', '512x512'],
    ]);
    expect(manifest.icons.some((i) => i.src === '/favicon.svg' && i.sizes === 'any')).toBe(true);
  });
});
