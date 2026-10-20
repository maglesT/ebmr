/**
 * Phase 7 slice 7i (G1, hosted demo of 20 October 2026): on a demo installation the kiosk's demo badge reader offers
 * those who work here first, then every other badge holder of the installation, so a presenter can sign anyone in on
 * any kiosk. The tap sends that person's badge UID like a reader's tap; the server decides.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { DemoDeviceView, SessionView } from '@ebmr/api-contract';

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
const { demoBadgesOf } = await import('../../src/features/session/demo-badges.ts');

const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const envelope = (code: string, kind: string, whatHappened: string) => ({
  refusal: { code, kind, whatHappened, why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] },
  correlationId: 'fixture',
  retryable: false,
});

const device: DemoDeviceView = {
  deviceCode: kiosk.device.deviceCode,
  deviceClass: 'SHARED',
  roomCode: null,
  description: 'kiosk',
  privateKeyPkcs8: 'AAAA',
  publicKeySpki: 'AAAA',
  personas: [{ legalName: 'Priya Nair', loginName: 'priya.nair', role: 'OPERATOR', badgeUid: '04B10000000001' }],
  otherPersonas: [
    { legalName: 'Arjun Das', loginName: 'arjun.das', role: 'OPERATOR', badgeUid: '04B10000000002' },
    { legalName: 'Sanjay Kulkarni', loginName: 'sanjay.kulkarni', role: 'SHIFT_SUPERVISOR', badgeUid: '04B10000000004' },
  ],
};

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: kiosk.device.deviceCode };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('G1 (slice 7i): the demo badge reader offers every badge holder on a kiosk', () => {
  it('lists those who work here first, then the other people; without other people the list is as before', () => {
    expect(demoBadgesOf(device).map((b) => [b.legalName, b.worksHere])).toEqual([
      ['Priya Nair', true],
      ['Arjun Das', false],
      ['Sanjay Kulkarni', false],
    ]);
    expect(demoBadgesOf({ ...device, otherPersonas: undefined }).map((b) => b.legalName)).toEqual(['Priya Nair']);
    expect(demoBadgesOf(null)).toEqual([]);
  });

  it('a person whose home kiosk is another one signs in by pressing their Tap button under "Other people"', async () => {
    const logins: Record<string, unknown>[] = [];
    setTransport(
      createFixtureFetch(
        {
          'meta.get': EXAMPLES['meta-sandbox'].data,
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': kiosk.device,
          'session.demoDevices': { devices: [device] },
          'session.get': { status: 401, body: envelope('NO_SESSION', 'NOT_ALLOWED', 'You are not signed in on this installation.') },
          'session.login': ({ body }: { body: unknown }) => {
            logins.push(body as Record<string, unknown>);
            return { status: 401, body: envelope('AUTH_FAILED', 'NOT_ALLOWED', 'The sign-in could not be completed.') };
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    render(
      <BootProvider>
        <Gate />
      </BootProvider>,
    );
    const reader = await screen.findByRole('region', { name: 'Demo badge reader' });
    const here = within(reader).getByRole('region', { name: 'Works here' });
    const others = within(reader).getByRole('region', { name: 'Other people' });
    expect(within(here).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tap Priya Nair']);
    expect(within(others).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tap Arjun Das', 'Tap Sanjay Kulkarni']);
    await userEvent.click(within(others).getByRole('button', { name: 'Tap Arjun Das' }));
    await screen.findByRole('group', { name: 'Enter your PIN' });
    for (const d of '573106') await userEvent.click(screen.getByRole('button', { name: d }));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await vi.waitFor(() => expect(logins).toHaveLength(1));
    expect(logins[0]).toMatchObject({ method: 'BADGE_PIN', identifier: '04B10000000002', secret: '573106' });
  });
});
