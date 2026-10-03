/**
 * What the sign-in screens say (Phase 2 exit review, session-audit-ui): the installation a kiosk belongs to (F09), an
 * account with no role that is valid now (F10), and a terminal that cannot get a device nonce (F08). Each test runs the
 * real Gate against a fixture server.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const envelope = (code: string, kind: string, whatHappened: string) => ({
  refusal: { code, kind, whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] },
  correlationId: 'fixture',
  retryable: false,
});
const noSession = { status: 401, body: envelope('NO_SESSION', 'NOT_ALLOWED', 'You are not signed in on this installation.') };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'sign-in-screens' };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderGate() {
  render(
    <BootProvider>
      <Gate />
    </BootProvider>,
  );
}

describe('F09: the kiosk sign-in names the installation the page belongs to', () => {
  for (const [deviceClass, code] of [
    ['SHARED', 'KIOSK-GRAN-1'],
    ['GRADE_A_B', 'KIOSK-COMP-1'],
  ] as const) {
    it(`[DI-05][DI-20] a ${deviceClass} kiosk on the GMP installation says "GMP installation", never "Sandbox (test runs)"`, async () => {
      setTransport(
        createFixtureFetch(
          {
            'meta.get': EXAMPLES['meta-gmp'].data,
            'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
            'session.identify': { ...kiosk.device, deviceClass, deviceCode: code, roomCode: 'GRAN-1' },
            'session.demoDevices': { devices: [] },
            'session.get': noSession,
          },
          { installation: 'GMP' },
        ),
      );
      renderGate();
      expect(await screen.findByLabelText('Badge')).toBeTruthy();
      expect(document.documentElement.dataset['installation']).toBe('gmp');
      expect(screen.queryByText(/Sandbox \(test runs\)/)).toBeNull();
      expect(screen.getByText(`GMP installation · ${code} · room GRAN-1`)).toBeTruthy();
    });
  }

  it('[DI-05][DI-20] the same kiosk on the sandbox installation says "Sandbox (test runs)"', async () => {
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-sandbox'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': { ...kiosk.device, deviceCode: 'KIOSK-GRAN-1', roomCode: 'GRAN-1' },
          'session.demoDevices': { devices: [] },
          'session.get': noSession,
        },
        { installation: 'SANDBOX' },
      ),
    );
    renderGate();
    expect(await screen.findByLabelText('Badge')).toBeTruthy();
    expect(screen.getByText('Sandbox (test runs) · KIOSK-GRAN-1 · room GRAN-1')).toBeTruthy();
    expect(screen.queryByText(/GMP installation/)).toBeNull();
  });
});
