/**
 * Decision D-P7R-18 (gap F1): the signed-in home screen shows each role the tiles of the screens it can use, and "Show
 * all screens" lists the others (display only; the server answers every screen with its own decision). The real Gate
 * runs against a fixture server, as the branding test does.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const { FeaturesContext } = await import('../../src/app/feature-context.ts');
const { WEB_FEATURES } = await import('../../src/app/features.ts');

const office = EXAMPLES['session-office'].data as SessionView;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'home' };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function signedInAs(role: string) {
  const session = { ...office, role, roles: [role] };
  setTransport(
    createFixtureFetch(
      { 'meta.get': EXAMPLES['meta-gmp'].data, 'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 }, 'session.identify': office.device, 'session.demoDevices': { devices: [] }, 'session.get': session },
      { installation: 'GMP' },
    ),
  );
  render(
    // Declutter D3: the home's work cards read through TanStack Query.
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeaturesContext.Provider value={WEB_FEATURES}>
        <BootProvider>
          <Gate />
        </BootProvider>
      </FeaturesContext.Provider>
    </QueryClientProvider>,
  );
}

const tileNames = (nav: HTMLElement): string[] => within(nav).queryAllByRole('link').map((l) => l.querySelector('p')?.textContent ?? '');

describe('the home screen by role (D-P7R-18)', () => {
  it('[DI-17] a QA reviewer sees record review but not the administration of people; "Show all screens" lists the hidden ones', async () => {
    signedInAs('QA_REVIEWER');
    const nav = await screen.findByRole('navigation', { name: 'Functions' });
    await waitFor(() => expect(tileNames(nav)).toContain('Batch record review'));
    expect(tileNames(nav)).not.toContain('People and accounts');
    await userEvent.click(screen.getByTestId('home-show-all'));
    expect(tileNames(nav)).toContain('People and accounts');
  });

  it('[DI-17] the system administrator sees the administration of people', async () => {
    signedInAs('SYSTEM_ADMINISTRATOR');
    const nav = await screen.findByRole('navigation', { name: 'Functions' });
    await waitFor(() => expect(tileNames(nav)).toContain('People and accounts'));
  });
});
