/**
 * The "not an enrolled terminal" screen shows this browser's key fingerprint, the value the administrator registers
 * (on the device screens, or for a platform installation's first terminal with `ebmr first-terminal`); a browser
 * without a key creates one there. DI-20: only registered devices act, and the register holds the key's fingerprint.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLES } from '@ebmr/api-contract/examples';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string }, saved: 0 }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => {
    holder.saved += 1;
    return Promise.resolve();
  },
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
  generateDeviceKey: async (label: string) => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    return { privateKey: pair.privateKey, publicKeySpki: Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64'), label };
  },
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { BootProvider } = await import('../../src/app/boot.tsx');
const { Gate } = await import('../../src/app/App.tsx');

const unregistered = {
  status: 401,
  body: { refusal: { code: 'DEVICE_PROOF_REJECTED', kind: 'AUTH_FAILED', whatHappened: 'This browser is not an enrolled terminal.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'fixture', retryable: false },
};

function serve(): void {
  setTransport(createFixtureFetch({
    'meta.get': { ...EXAMPLES['meta-gmp'].data, demo: false },
    'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
    'session.identify': unregistered,
  }, { installation: 'GMP' }));
}

afterEach(() => {
  cleanup();
  holder.key = null;
  holder.saved = 0;
});

describe('the "not an enrolled terminal" screen (DI-20)', () => {
  it('[DI-20] shows this browser\'s key fingerprint, the SHA-256 of its public key as the device register holds it', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey));
    holder.key = { privateKey: pair.privateKey, publicKeySpki: spki.toString('base64'), label: 'unregistered' };
    serve();
    render(<BootProvider><Gate /></BootProvider>);
    const shown = await screen.findByTestId('terminal-fingerprint');
    expect(shown.textContent).toContain(createHash('sha256').update(spki).digest('hex'));
  });

  it('[DI-20] a browser without a key creates one there (the private key never leaves the browser)', async () => {
    serve();
    const reload = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });
    render(<BootProvider><Gate /></BootProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /create this browser's terminal key/i }));
    await waitFor(() => expect(holder.saved).toBe(1));
    expect(reload).toHaveBeenCalled();
  });
});
