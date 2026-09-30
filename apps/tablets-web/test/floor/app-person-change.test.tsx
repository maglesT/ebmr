/**
 * The whole application, not the floor harness (module C4 with C0 and C1; INV-40; DI-34; review P44): when the
 * person signed in on a kiosk changes, the step screen on show is read again for the new person at once, so the
 * run header's "You" line and the step's actions are never the previous person's. The floor's own tests mount the
 * reset of the reads themselves (as the app does); this one proves the app mounts it (App.tsx SessionScopedReads).
 *
 * The change of person arrives the way C1's session poll brings it (GET /api/session every 15 s names another
 * person, e.g. after a switch of user the server made); the 15 s poll timer is driven by the test, and so every
 * other interval (the step's own 30 s refetch included) stays still, so only the app's reaction can read again.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionView, StepScreenView } from '@ebmr/api-contract';
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
const { SESSION_POLL_MS } = await import('../../src/features/access/controller.tsx');

const RUN_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const kiosk = EXAMPLES['session-kiosk'].data as SessionView;
const verifier: SessionView = {
  ...kiosk,
  person: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e61', legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1', role: 'VERIFIER' },
  roles: ['VERIFIER'],
  role: 'VERIFIER',
};
const INV03_REASON = 'A different person must verify: you signed this step as performed (INV-03)';

/** The server's step view for the person signed in (identity and actions are computed per viewer). */
function stepFor(s: SessionView): StepScreenView {
  const v = structuredClone(EXAMPLES['step-g04-parameters'].data) as StepScreenView;
  v.run.identity = { personId: s.person.personId, legalName: s.person.legalName, loginName: s.person.loginName, role: s.role ?? '' };
  const verify = v.actions.find((a) => a.action === 'VERIFY');
  if (!verify) throw new Error('fixture has no VERIFY action');
  verify.available = s.person.personId !== kiosk.person.personId;
  verify.reason = verify.available ? null : INV03_REASON;
  return v;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64');
  holder.key = { privateKey: pair.privateKey, publicKeySpki: spki, label: 'TEST-KIOSK-DISP-1' };
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('the application after the signed-in person changes', () => {
  it('[INV-40][DI-34] the step screen is read again for the new person at once: the run header names them and the actions are theirs (the app resets its reads; no 30 s poll)', async () => {
    const server = { session: kiosk };
    let stepReads = 0;
    setTransport(
      createFixtureFetch(
        {
          ...fixturesFromExamples('SANDBOX'),
          'session.demoDevices': { devices: [] },
          'session.deviceNonce': { nonce: 'fixture-nonce-0123456789', expiresInSeconds: 60 },
          'session.identify': kiosk.device,
          'session.get': () => server.session,
          'execution.step': () => {
            stepReads += 1;
            return stepFor(server.session);
          },
        },
        { installation: 'SANDBOX' },
      ),
    );
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    window.history.replaceState(null, '', `/runs/${RUN_ID}/steps/${encodeURIComponent('p-blend@')}`);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId('run-identity').textContent).toContain('TEST-Priya Nair'), { timeout: 5000 });
    expect(screen.getByTestId('primary-action').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('primary-reason').textContent).toContain(INV03_REASON);
    const readsBefore = stepReads;

    // The server now has the verifier signed in on this kiosk; C1's session poll brings the change to the app.
    server.session = verifier;
    await act(async () => {
      vi.advanceTimersByTime(SESSION_POLL_MS);
      await Promise.resolve();
    });

    await waitFor(
      () => {
        const you = screen.getByTestId('run-identity').textContent ?? '';
        expect(you).toContain('TEST-Kavya Reddy');
        expect(you).not.toContain('TEST-Priya Nair');
        expect(screen.getByTestId('primary-action').hasAttribute('disabled')).toBe(false);
      },
      { timeout: 5000 },
    );
    expect(stepReads).toBeGreaterThan(readsBefore);
    expect(screen.queryByText(INV03_REASON)).toBeNull();
    expect(within(screen.getByTestId('step-card')).queryByText(INV03_REASON)).toBeNull();
  });
});
