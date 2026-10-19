/**
 * The first-run set-up (Phase 7 slice 7g-4; decision 0025 point 2): while the server says the installation awaits it,
 * the shell shows the set-up instead of the sign-in; the kind is shown, not chosen; the zone in force is shown and sent
 * as it is; the token and the first passwords are read from their fields only when sent; two different entries of a
 * password send nothing; this browser's new key is the administrator's console; a refusal is shown in the database's
 * words.
 */
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike, MetaView } from '@ebmr/api-contract';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import { setTransport } from '../../src/api/client.ts';
import { createFixtureFetch, type FixtureMap } from '../../src/api/fixture-fetch.ts';
import { fixturesFromExamples } from '../../src/api/examples.ts';
import { App } from '../../src/app/App.tsx';
import type * as Keystore from '../../src/device/keystore.ts';
import { refusalAnswer } from './support.tsx';

vi.mock('../../src/device/keystore.ts', async (original) => ({
  ...(await original<typeof Keystore>()),
  loadDeviceKey: vi.fn(() => Promise.resolve(null)),
  generateDeviceKey: vi.fn((label: string) => Promise.resolve({ privateKey: {} as CryptoKey, publicKeySpki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-test-console-key', label })),
}));

afterEach(() => cleanup());

const state = { required: true, installation: 'GMP', demo: false, tokenIssued: true, siteZone: 'Asia/Kolkata', site: null, sealKey: 'GENERATE' } as const;

function start(installation: 'GMP' | 'SANDBOX', fixtures: FixtureMap = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const meta = { ...(EXAMPLES[installation === 'GMP' ? 'meta-gmp' : 'meta-sandbox'].data as MetaView), setupRequired: true, demo: false };
  const fetch = createFixtureFetch({ ...fixturesFromExamples(installation), 'meta.get': meta, 'operations.setupState': { ...state, installation }, ...fixtures }, { installation });
  const transport: FetchLike = async (url, init) => {
    if (init.method === 'POST') posts.push({ path: new URL(url, 'http://x').pathname, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
    return fetch(url, init);
  };
  setTransport(transport);
  render(<App />);
  return posts;
}

async function fill(over: { adminPassword2?: string } = {}) {
  await screen.findByTestId('setup-wizard');
  await userEvent.type(screen.getByLabelText('Set-up token (printed by the installer)'), 'k'.repeat(43));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Site code' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Site code' }), 'blr-1');
  await userEvent.type(screen.getByRole('textbox', { name: 'Site name' }), 'Bengaluru tablets plant');
  await userEvent.type(screen.getByRole('textbox', { name: "Administrator's legal name" }), 'Kavya Iyer');
  await userEvent.type(screen.getByRole('textbox', { name: "Administrator's user ID" }), 'kavya.iyer');
  await userEvent.type(screen.getByLabelText("Administrator's first password"), 'First-Admin-Password-1');
  await userEvent.type(screen.getByLabelText("Administrator's first password again"), over.adminPassword2 ?? 'First-Admin-Password-1');
  await userEvent.type(screen.getByRole('textbox', { name: "Process owner's legal name" }), 'Rahul Menon');
  await userEvent.type(screen.getByRole('textbox', { name: "Process owner's user ID" }), 'rahul.menon');
  await userEvent.type(screen.getByLabelText("Process owner's first password"), 'First-Owner-Password-1');
  await userEvent.type(screen.getByLabelText("Process owner's first password again"), 'First-Owner-Password-1');
}

describe('the first-run set-up (decision 0025)', () => {
  it('[DI-18][DI-20] the shell shows the set-up instead of the sign-in; the set-up sends the site, the zone in force, the two persons with their first passwords and this browser\'s new key, and asks for the seal key', async () => {
    const posts = start('GMP', {
      'operations.setup': { siteCode: 'BLR-1', siteZone: 'Asia/Kolkata', administratorLogin: 'kavya.iyer', processOwnerLogin: 'rahul.menon', consoleDeviceCode: 'BOOTSTRAP-CONSOLE-1', sealKeyId: 'seal-0123456789ab' },
    });
    expect(await screen.findByRole('heading', { name: 'Set up this installation' })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('setup-zone').textContent).toContain('Asia/Kolkata'));
    expect(screen.queryByRole('textbox', { name: /time zone/i })).toBeNull();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Set up the installation' }));
    await waitFor(() => expect(posts.filter((p) => p.path === '/api/setup')).toHaveLength(1));
    expect(posts.find((p) => p.path === '/api/setup')?.body).toEqual({
      token: 'k'.repeat(43),
      site: { code: 'BLR-1', name: 'Bengaluru tablets plant', zone: 'Asia/Kolkata' },
      administrator: { legalName: 'Kavya Iyer', loginName: 'kavya.iyer', password: 'First-Admin-Password-1' },
      processOwner: { legalName: 'Rahul Menon', loginName: 'rahul.menon', password: 'First-Owner-Password-1' },
      consoleSpki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-test-console-key',
      generateSealKey: true,
    });
    const done = await screen.findByTestId('setup-done');
    expect(done.textContent).toContain('kavya.iyer');
    expect(done.textContent).toContain('seal-0123456789ab');
    // The secrets left their fields when they were sent.
    expect(screen.queryByLabelText("Administrator's first password")).toBeNull();
  });

  it('[DI-19] two different entries of a first password send nothing', async () => {
    const posts = start('GMP');
    await fill({ adminPassword2: 'Another-Password-22' });
    await userEvent.click(screen.getByRole('button', { name: 'Set up the installation' }));
    expect(await screen.findByText("The two entries of the administrator's first password differ.")).toBeTruthy();
    expect(posts.filter((p) => p.path === '/api/setup')).toEqual([]);
  });

  it('[DI-18] a refusal of the database is shown in its words (a token that is not valid); the sandbox says its names are test labels', async () => {
    start('SANDBOX', { 'operations.setup': refusalAnswer(403, 'EBMR-SETUP-002', 'The set-up was not done: the set-up token is not valid.') });
    expect(await screen.findByText(/In the sandbox every name is a test label/)).toBeTruthy();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Set up the installation' }));
    expect(await screen.findByText('The set-up was not done: the set-up token is not valid.')).toBeTruthy();
    expect(screen.queryByTestId('setup-done')).toBeNull();
  });
});
