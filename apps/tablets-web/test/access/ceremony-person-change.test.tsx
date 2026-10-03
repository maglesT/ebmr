/**
 * A signing belongs to the person who started it (Phase 2 exit review F39; INV-40, DI-38, DI-14). The request and any
 * decision in it (here Priya's release of a hold point, with her comment) are hers: when another person is signed in on
 * the kiosk, whatever the path, the open signing ends with nothing signed (CANCELLED) and nothing of it reaches the
 * server under the new person. ports.test.tsx proves the ceremony's own "Switch to <name>?" path; this file the paths
 * the ceremony does not drive: "Switch user" on the lock screen after the lock button or an idle lock the session poll
 * sees, and a switch the poll finds. A poll that finds the same person keeps her signing open.
 *
 * Real BootProvider and access Provider against a fixture server (as the exit review's reproducers did).
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { EXAMPLES } from '@ebmr/api-contract/examples';
import type { ChallengeView, SessionView, SignableContentView } from '@ebmr/api-contract';

const holder = vi.hoisted(() => ({ key: null as null | { privateKey: CryptoKey; publicKeySpki: string; label: string } }));
vi.mock('../../src/device/keystore.ts', () => ({
  loadDeviceKey: () => Promise.resolve(holder.key),
  saveDeviceKey: () => Promise.resolve(),
  forgetDeviceKey: () => Promise.resolve(),
  importDemoKey: () => Promise.reject(new Error('not used in this test')),
}));

const { setTransport } = await import('../../src/api/client.ts');
const { createFixtureFetch } = await import('../../src/api/fixture-fetch.ts');
const { BootProvider, useBoot } = await import('../../src/app/boot.tsx');
const { Provider } = await import('../../src/features/access/index.tsx');
const { useAccess } = await import('../../src/features/access/controller.tsx');
const { useSignatureCeremony } = await import('../../src/app/ports.tsx');
type SignOutcome = Awaited<ReturnType<ReturnType<typeof useSignatureCeremony>['sign']>>;

const PRIYA = EXAMPLES['session-kiosk'].data as SessionView;
const KAVYA: SessionView = { ...PRIYA, person: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'QA_SHOP_FLOOR' }, role: 'QA_SHOP_FLOOR', roles: ['QA_SHOP_FLOOR'] };
const KAVYA_BADGE = '04A10000000011';
const KAVYA_PIN = '691357';

const RUN = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const AGG = `${RUN}:H-BLEND@`;
const TEXT = JSON.stringify({ aggregate_id: AGG, aggregate_type: 'batch_step', content: { proposedDecision: { comment: 'Blend uniformity within limits (Priya)', disposition: 'APPROVED' } }, content_version: 3 });
const CONTENT: SignableContentView = {
  aggregateType: 'batch_step',
  aggregateId: AGG,
  contentVersion: '3',
  canonicalText: TEXT,
  contentHash: sha256Hex(TEXT),
  meaning: 'HOLD_POINT_RELEASED',
  meaningText: 'I released this hold point.',
  title: 'Hold point released: H-BLEND',
  preview: true,
  rendering: { kind: 'fallback', state: 'OPEN', content: { decision: 'APPROVED', comment: 'Blend uniformity within limits (Priya)' } },
};
const challengeFor = (who: SessionView): ChallengeView => ({
  challengeId: 'f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f7a8b92',
  aggregateType: 'batch_step',
  aggregateId: AGG,
  contentVersion: '3',
  contentHash: CONTENT.contentHash,
  meaning: 'HOLD_POINT_RELEASED',
  expiresAt: { us: '99999999999999999', text: 'far away' },
  expiresInSeconds: 120,
  requires: ['PIN'],
  manifestation: { legalName: who.person.legalName, loginName: who.person.loginName, role: who.person.role, meaning: 'HOLD_POINT_RELEASED', meaningText: 'Released by', zone: 'Asia/Kolkata' },
});

/** Priya's decision on a hold point, with her comment: hers alone to sign. */
const PRIYAS_DECISION = {
  aggregateType: 'batch_step',
  aggregateId: AGG,
  meaning: 'HOLD_POINT_RELEASED',
  action: { kind: 'ENGINE_COMMAND' as const, runId: RUN, expectedVersion: 7, intent: { type: 'DISPOSITION_HOLD_POINT' as const, stepKey: 'H-BLEND@', disposition: 'APPROVED', comment: 'Blend uniformity within limits (Priya)' } },
  title: 'Release hold point H-BLEND',
};

function fixtureServer() {
  const state = { who: PRIYA, locked: false, challenges: [] as Record<string, unknown>[], signs: [] as Record<string, unknown>[], switches: 0 };
  const fetch = createFixtureFetch(
    {
      'meta.get': EXAMPLES['meta-sandbox'].data,
      'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
      'session.identify': PRIYA.device,
      'session.demoDevices': { devices: [] },
      'session.get': () => ({ ...state.who, locked: state.locked }),
      'access.lock': () => {
        state.locked = true;
        return { ...state.who, locked: true };
      },
      'access.unlock': () => {
        state.locked = false;
        return { ...state.who, locked: false };
      },
      'access.switchUser': () => {
        state.switches += 1;
        state.who = KAVYA;
        state.locked = false;
        return KAVYA;
      },
      'esig.content': CONTENT,
      'esig.createChallenge': ({ body }: { body: unknown }) => {
        state.challenges.push(body as Record<string, unknown>);
        return challengeFor(state.who);
      },
      'esig.sign': ({ body }: { body: unknown }) => {
        state.signs.push(body as Record<string, unknown>);
        return { status: 409, body: { refusal: { code: 'NOT_IN_THIS_TEST', kind: 'STALE', whatHappened: 'x', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'f', retryable: false } };
      },
    },
    { installation: 'SANDBOX' },
  );
  return { state, fetch };
}

function renderPage() {
  const seen: { access: ReturnType<typeof useAccess> | null; ceremony: ReturnType<typeof useSignatureCeremony> | null } = { access: null, ceremony: null };
  function Page() {
    const boot = useBoot();
    return <p>{boot.phase === 'ready' ? `Signed in as ${boot.session?.person.legalName ?? ''}` : `Page: ${boot.phase}`}</p>;
  }
  function Controls() {
    seen.access = useAccess();
    seen.ceremony = useSignatureCeremony();
    return null;
  }
  render(
    <BootProvider>
      <Provider>
        <Page />
        <Controls />
      </Provider>
    </BootProvider>,
  );
  return seen;
}

async function tapBadge(uid: string) {
  const field = await screen.findByLabelText('Badge');
  await userEvent.type(field, `${uid}{Enter}`);
}

async function enterPin(name: string, pin: string) {
  const pad = await screen.findByRole('group', { name });
  for (const d of pin) await userEvent.click(within(pad).getByRole('button', { name: d }));
  await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: PRIYA.device.deviceCode };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});


/** Priya opens the signing of her decision and reviews it; returns how the signing settles. */
async function priyaOpensHerSigning(seen: ReturnType<typeof renderPage>): Promise<{ settled: () => SignOutcome | null }> {
  let settled: SignOutcome | null = null;
  act(() => {
    void seen.ceremony?.sign(PRIYAS_DECISION).then((o) => {
      settled = o;
    });
  });
  expect(await screen.findByRole('button', { name: 'Sign' })).toBeTruthy();
  return { settled: () => settled };
}

/** Kavya switches in from the lock screen with her own badge and PIN. */
async function kavyaSwitchesIn(server: ReturnType<typeof fixtureServer>): Promise<void> {
  const locked = await screen.findByRole('alertdialog', { name: 'This terminal is locked' });
  await userEvent.click(within(locked).getByRole('button', { name: 'Switch user' }));
  await tapBadge(KAVYA_BADGE);
  await enterPin('Enter your PIN', KAVYA_PIN);
  expect(await screen.findByText('Signed in as TEST-Kavya Reddy')).toBeTruthy();
  expect(server.state.switches).toBe(1);
  await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'This terminal is locked' })).toBeNull());
}

describe('F39: a signing ends when another person is signed in, whatever the path (INV-40, DI-38, DI-14)', () => {
  it('[INV-40][DI-38][DI-14] the lock button, then "Switch user" on the lock screen: Priya\'s signing ends with nothing signed; her decision is never challenged or signed under Kavya', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const seen = renderPage();
    expect(await screen.findByText('Signed in as TEST-Priya Nair')).toBeTruthy();
    const signing = await priyaOpensHerSigning(seen);
    act(() => {
      seen.access?.lock();
    });
    await kavyaSwitchesIn(server);
    await waitFor(() => expect(signing.settled()).toEqual({ status: 'CANCELLED' }));
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
    expect(screen.queryByText(/Tap your badge to sign as/)).toBeNull();
    expect(server.state.challenges).toEqual([]);
    expect(server.state.signs).toEqual([]);
    // Kavya can start her own signing (the service is free again).
    let second: SignOutcome | null = null;
    act(() => {
      void seen.ceremony?.sign({ ...PRIYAS_DECISION, title: 'Kavya decides' }).then((o) => {
        second = o;
      });
    });
    expect(await screen.findByRole('button', { name: 'Sign' })).toBeTruthy();
    expect(second).toBeNull();
  });

  it('[INV-40][DI-38][DI-14] an idle lock the session poll sees, then "Switch user" on the lock screen: the same', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const seen = renderPage();
    expect(await screen.findByText('Signed in as TEST-Priya Nair')).toBeTruthy();
    const signing = await priyaOpensHerSigning(seen);
    // Priya walks away; the kernel idle-locks the session; the next session poll (15 s) sees it.
    server.state.locked = true;
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    await kavyaSwitchesIn(server);
    await waitFor(() => expect(signing.settled()).toEqual({ status: 'CANCELLED' }));
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
    expect(server.state.challenges).toEqual([]);
    expect(server.state.signs).toEqual([]);
  });

  it('[INV-40][DI-38] a switch the session poll finds (another tab switched) ends the signing; a poll that finds the same person keeps it open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const server = fixtureServer();
    setTransport(server.fetch);
    const seen = renderPage();
    expect(await screen.findByText('Signed in as TEST-Priya Nair')).toBeTruthy();
    const signing = await priyaOpensHerSigning(seen);
    // A poll that finds Priya still signed in changes nothing.
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Sign' })).toBeTruthy();
    expect(signing.settled()).toBeNull();
    // Kavya switched in on another tab of this terminal: the next poll finds her.
    server.state.who = KAVYA;
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(await screen.findByText('Signed in as TEST-Kavya Reddy')).toBeTruthy();
    await waitFor(() => expect(signing.settled()).toEqual({ status: 'CANCELLED' }));
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
    expect(server.state.challenges).toEqual([]);
  });

  it('[INV-40][DI-38] a signing asked for the moment the page shows the person opens for that person; it is never refused as "no session"', async () => {
    // The page shows Priya's session; a signing asked for at that moment (a DOM observer, as a screen effect or a test
    // reacting to the page would) must find her session. Before, the ceremony learnt the session in a passive effect
    // that ran later, so this call was refused at once with "no session" and no dialog opened (CI on c30950a).
    const server = fixtureServer();
    setTransport(server.fetch);
    const page: { seen: ReturnType<typeof renderPage> | null } = { seen: null };
    let early: SignOutcome | 'PENDING' | null = null;
    const observer = new MutationObserver(() => {
      if (early !== null || !document.body.textContent?.includes('Signed in as TEST-Priya Nair')) return;
      const ceremony = page.seen?.ceremony;
      if (!ceremony) return;
      early = 'PENDING';
      void ceremony.sign(PRIYAS_DECISION).then((o) => {
        early = o;
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    page.seen = renderPage();
    try {
      expect(await screen.findByRole('button', { name: 'Sign' })).toBeTruthy();
      expect(early).toBe('PENDING');
    } finally {
      observer.disconnect();
    }
  });
});
