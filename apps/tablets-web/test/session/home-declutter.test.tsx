/**
 * Declutter slice D2 (docs/build-plan/declutter/plan.md sections 1 and 3): where the server refuses the disconnected
 * functions (meta.disconnected), the home offers exactly the kept screens, even under "Show all screens", and a deep link
 * to a screen that is off shows a short page; on the platform build the people and grant screens are off too (core keeps
 * them). Without the switch every screen is as before.
 *
 * Control: DI-17.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { fixturesFromExamples } = await import('../../src/api/examples.ts');
const { App } = await import('../../src/app/App.tsx');
const { screenOff } = await import('../../src/app/disconnected.tsx');
const { WEB_FEATURES } = await import('../../src/app/features.ts');

const office = { ...(EXAMPLES['session-office'].data as SessionView), role: 'QA_REVIEWER', roles: ['QA_REVIEWER'] };

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'TEST-PC-QA-1' };
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

/** The whole application at `path`, signed in as QA on an office PC, with meta.disconnected as given. */
function open(path: string, disconnected: boolean, platform = false) {
  setTransport(
    createFixtureFetch(
      {
        ...fixturesFromExamples('GMP'),
        'meta.get': { ...(EXAMPLES['meta-gmp'].data as object), disconnected },
        'session.demoDevices': { devices: [] },
        'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
        'session.identify': platform ? { ...office.device, loginMethods: ['PLATFORM'] } : office.device,
        'session.get': office,
      },
      { installation: 'GMP' },
    ),
  );
  window.history.replaceState(null, '', path);
  render(<App />);
}

const tiles = WEB_FEATURES.flatMap(([, f]) => f.homeTiles ?? []);
const kept = (inst: 'GMP' | 'SANDBOX', platform: boolean) =>
  tiles.filter((t) => t.installations.includes(inst) && !screenOff(t.to, true, platform)).map((t) => t.id).sort();

const KEPT_GMP = [
  'admin-device-configuration', 'admin-devices', 'admin-security-alerts', 'audit-trail', 'batch-numbers', 'batches', 'block-library',
  'gmp-runs', 'india', 'india-register', 'label-store', 'label-templates', 'master-data', 'master-records', 'mbr-change-records', 'operations',
  'packaging-orders', 'plant', 'planning', 'quality', 'records', 'release', 'review', 'site-values',
].sort();
const KEPT_SANDBOX = [
  'admin-device-configuration', 'admin-devices', 'admin-security-alerts', 'audit-trail', 'cockpit', 'operations', 'packages', 'plant',
  'plant-master-data', 'runs', 'scales', 'test-lots',
].sort();
const PEOPLE = ['admin-break-glass', 'admin-delegations', 'admin-grants', 'admin-people', 'admin-recertification', 'admin-role-permissions'];

describe('[DI-17] only the kept screens are offered where the functions are disconnected (declutter D2)', () => {
  it('[DI-17] the platform build offers exactly the kept tiles; a standalone server with the switch keeps the people screens', () => {
    expect(kept('GMP', true)).toEqual(KEPT_GMP);
    expect(kept('SANDBOX', true)).toEqual(KEPT_SANDBOX);
    expect(kept('GMP', false)).toEqual([...KEPT_GMP, ...PEOPLE].sort());
    // The licences screen stays: a GMP batch needs the product endorsed on the manufacturing licence (library-dc E2E).
    expect(screenOff('/india', true, true)).toBe(false);
    expect(screenOff('/india/register', true, true)).toBe(false);
    expect(screenOff('/india/product-rules', true, true)).toBe(true);
    expect(screenOff('/qp', true, false)).toBe(true);
    expect(screenOff('/qp-register', true, false)).toBe(true);
    expect(screenOff('/release', true, false)).toBe(false);
    // Without the switch nothing is off.
    expect(tiles.filter((t) => screenOff(t.to, false, false))).toEqual([]);
  });

  it('[DI-17] the home shows no disconnected tile, not even under "Show all screens"', async () => {
    open('/', true);
    await userEvent.click(await screen.findByRole('link', { name: 'All screens' }));
    expect(await screen.findByRole('link', { name: /Batch record review/i })).toBeTruthy();
    const all = screen.queryByTestId('home-show-all');
    if (all) all.click();
    expect(screen.queryByRole('link', { name: /CAPA register/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Product quality review/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Penicillin/i })).toBeNull();
  });

  it('[DI-17] a deep link to a disconnected screen shows "Not part of Batchwright"; without the switch the screen opens', async () => {
    open('/capa', true);
    expect(await screen.findByTestId('not-part-of-batchwright')).toBeTruthy();
    cleanup();
    open('/capa', false);
    expect(await screen.findByRole('heading', { level: 1, name: /CAPA/i })).toBeTruthy();
    expect(screen.queryByTestId('not-part-of-batchwright')).toBeNull();
  });

  it('[DI-17] on the platform build a deep link to a people screen shows the page too (core keeps people); a standalone server with the switch keeps it', async () => {
    open('/admin/people', true, true);
    expect(await screen.findByTestId('not-part-of-batchwright')).toBeTruthy();
    cleanup();
    open('/admin/people', true, false);
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.queryByTestId('not-part-of-batchwright')).toBeNull();
  });

  it('[DI-17] a kept page leaves out its link to a disconnected screen (packaging completion: serial pools)', async () => {
    const BATCH = '0d6f7a52-3e1b-4c8d-9a2f-5b6c7d8e9f01';
    open(`/labels/packaging/${BATCH}`, true);
    expect(await screen.findByRole('link', { name: 'The packaging order and its bulk' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Serial pools/ })).toBeNull();
    cleanup();
    open(`/labels/packaging/${BATCH}`, false);
    expect(await screen.findByRole('link', { name: /^Serial pools/ })).toBeTruthy();
  });
});
