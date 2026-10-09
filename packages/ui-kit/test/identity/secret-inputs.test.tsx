/**
 * Secret inputs (review P1; plan section 6 step 3; DI-38, DI-19, decision D7): a password, PIN or badge UID typed
 * into the office signature form, the office unlock form or the badge prompt is handed over once and is then gone:
 * not in the input's value, not in its value attribute, not anywhere in the document, not in browser storage, not in
 * any React state or props, and not written back by the next render of the form (the ceremony moving to 'signing',
 * the lock screen turning busy, the badge countdown ticking). A refused attempt leaves an empty field, so pressing
 * Sign again sends nothing.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import type { ChallengeView, RefusalEnvelope, SignableContentView } from '@ebmr/api-contract';
import { BadgePrompt, LockOverlay, SignatureDialog, type LockOverlayProps, type SignatureDialogProps } from '../../src/identity/index.ts';
import type { CeremonyContext } from '../../src/machines/ceremony.ts';
import { Field } from '../../src/primitives/index.ts';
import { SecretInput, takeSecret } from '../../src/primitives/SecretInput.tsx';
import { domTraces, reactTraces, storageTraces } from '../support/secret-traces.ts';

const TEXT = '{"aggregate_id":"s-1","aggregate_type":"esig_stub","content":{"title":"Binder added","value":"12.503"},"content_version":1}';
const CONTENT: SignableContentView = {
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  canonicalText: TEXT,
  contentHash: sha256Hex(TEXT),
  meaning: 'PERFORMED',
  meaningText: 'I performed this step and recorded its data.',
  title: 'Performed: Binder added',
  preview: false,
  rendering: { kind: 'fallback', state: 'OPEN', content: { title: 'Binder added', value: '12.503', unit: 'kg' } },
};
const CHALLENGE: ChallengeView = {
  challengeId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
  meaning: 'PERFORMED',
  expiresAt: { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' },
  expiresInSeconds: 120,
  requires: ['USER_ID', 'PASSWORD'],
  manifestation: { legalName: 'Asha Rao', loginName: 'asha.rao', role: 'OPERATOR', meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' },
};
const ctx = (over: Partial<CeremonyContext> = {}): CeremonyContext => ({
  kiosk: false,
  content: CONTENT,
  challenge: CHALLENGE,
  manifestation: null,
  result: null,
  refusal: null,
  attemptError: null,
  attempts: 0,
  ...over,
});
const REFUSED: RefusalEnvelope = {
  refusal: { code: 'EBMR-AUTH-001', kind: 'AUTH_FAILED', whatHappened: 'The user ID or password is wrong. Nothing was signed.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] },
  correlationId: 'x',
  retryable: true,
} as unknown as RefusalEnvelope;
const noop = () => undefined;

/** The secret is gone from the input, the document and React (and the input is a native password input). */
function expectGone(input: HTMLInputElement, secret: string) {
  expect(domTraces(input, secret), 'DOM').toEqual([]);
  expect(storageTraces(secret), 'browser storage (D7)').toEqual([]);
  expect(reactTraces(secret), 'React state and props').toEqual([]);
  expect(input.value, 'the field after clearing').toBe('');
  expect(input.getAttribute('value'), 'value attribute').toBeNull();
}

describe('the trace probes are not vacuous', () => {
  it('[meta] reactTraces finds a secret held in useState and in a controlled Field; domTraces finds the value attribute', async () => {
    function Holder() {
      const [held] = useState('Probe-Secret-0');
      return <p data-testid="holder">{held.length}</p>;
    }
    render(<Holder />);
    expect(reactTraces('Probe-Secret-0').length).toBeGreaterThan(0);
    function Controlled() {
      const [v, setV] = useState('');
      return <Field label="Controlled" name="controlled" value={v} onChange={setV} />;
    }
    render(<Controlled />);
    const input = screen.getByLabelText<HTMLInputElement>('Controlled');
    await userEvent.type(input, 'Probe-Secret-1');
    expect(reactTraces('Probe-Secret-1').length).toBeGreaterThan(0);
    expect(domTraces(input, 'Probe-Secret-1')).toContain('input[value] attribute');
  });
});

describe('SecretInput', () => {
  it('[DI-38] is a native masked input that React never fills: typing, clearing and re-rendering leave no copy', async () => {
    function Host({ disabled }: { disabled: boolean }) {
      return <SecretInput label="Password" name="pw" inputRef={noop} isDisabled={disabled} isRequired description="Your password" />;
    }
    const { rerender } = render(<Host disabled={false} />);
    const input = screen.getByLabelText<HTMLInputElement>('Password');
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.required).toBe(true);
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Your password').id).toBe(input.getAttribute('aria-describedby'));
    await userEvent.type(input, 'Typed-Secret-9');
    expect(input.value).toBe('Typed-Secret-9');
    expect(input.getAttribute('value')).toBeNull();
    expect(reactTraces('Typed-Secret-9')).toEqual([]);
    input.value = '';
    rerender(<Host disabled />);
    expect(input.disabled).toBe(true);
    expectGone(input, 'Typed-Secret-9');
    rerender(<Host disabled={false} />);
    expectGone(input, 'Typed-Secret-9');
  });
});

describe('Field of type password', () => {
  it('[DI-38] renders a SecretInput (the public path for secrets): cleared once read, nothing written back on the next render', async () => {
    const ref = { current: null as HTMLInputElement | null };
    function Host({ busy }: { busy: boolean }) {
      return (
        <form aria-label="Sign in">
          <Field label="Password" name="password" type="password" inputRef={ref} isRequired isDisabled={busy} />
        </form>
      );
    }
    const { rerender } = render(<Host busy={false} />);
    const input = screen.getByLabelText<HTMLInputElement>('Password');
    expect(ref.current).toBe(input);
    expect(input.closest('[data-secret="true"]')).toBeTruthy();
    await userEvent.type(input, 'Field-Secret-8');
    expect(reactTraces('Field-Secret-8')).toEqual([]);
    expect(takeSecret(ref)).toBe('Field-Secret-8');
    expectGone(input, 'Field-Secret-8');
    rerender(<Host busy />);
    expectGone(input, 'Field-Secret-8');
    expect(takeSecret(ref)).toBe('');
  });

  it('[DI-38] a SecretInput that unmounts wipes what is left in it', async () => {
    const ref = { current: null as HTMLInputElement | null };
    const { rerender } = render(<SecretInput label="Badge" name="badge" inputRef={ref} />);
    const input = screen.getByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(input, 'Left-Behind-9');
    rerender(<p>gone</p>);
    expect(ref.current).toBeNull();
    expect(input.isConnected).toBe(false);
    expect(input.value).toBe('');
  });
});

describe('review P1: handed-over secrets stay cleared', () => {
  it('[DI-38][DI-19] office signature: the password is gone after Sign, while signing, and after a refused attempt; Sign again sends nothing', async () => {
    const SECRET = 'Secret-Password-1';
    const onPassword = vi.fn();
    const props: Omit<SignatureDialogProps, 'state' | 'context'> = { onSign: noop, onCancel: noop, onRestart: noop, onClose: noop, onTap: noop, onTapTimeout: noop, onPin: noop, onSwitchPin: noop, onPassword, title: 'Sign', secondsLeft: 100, signerName: 'Asha Rao' };
    const { rerender } = render(<SignatureDialog {...props} state="awaitingSecret" context={ctx()} />);
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
    await userEvent.type(pw, SECRET);
    // While typing, the secret is only in the native input's value (never in React or the value attribute).
    expect(reactTraces(SECRET)).toEqual([]);
    expect(pw.getAttribute('value')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(onPassword).toHaveBeenCalledWith('asha.rao', SECRET);
    expectGone(pw, SECRET);
    // The ceremony moves to 'signing' (the form is disabled), then a wrong password brings it back to awaitingSecret.
    rerender(<SignatureDialog {...props} state="signing" context={ctx()} />);
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
    rerender(<SignatureDialog {...props} state="awaitingSecret" context={ctx({ attemptError: REFUSED, attempts: 1 })} />);
    expect(screen.getByText('The user ID or password is wrong. Nothing was signed.')).toBeTruthy();
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
    // Pressing Sign again must not re-send the rejected password (it would count toward the lockout again), also
    // when the submit skips the browser's required-field check.
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Sign with your user ID and password' }));
    expect(onPassword).toHaveBeenCalledTimes(1);
  });

  it('[DI-38][DI-19] office unlock: the password is gone after Unlock, while busy and after a failed unlock', async () => {
    const SECRET = 'Unlock-Password-2';
    const onUnlockPassword = vi.fn();
    const props: Omit<LockOverlayProps, 'busy' | 'error'> = { isOpen: true, legalName: 'Asha Rao', loginName: 'asha.rao', kiosk: false, offer: null, onUnlockBadge: noop, onUnlockPassword, onSwitch: noop, onSignOut: noop };
    const { rerender } = render(<LockOverlay {...props} busy={false} error={null} />);
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    await userEvent.type(screen.getByLabelText<HTMLInputElement>('User ID'), 'asha.rao');
    await userEvent.type(pw, SECRET);
    expect(reactTraces(SECRET)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(onUnlockPassword).toHaveBeenCalledWith('asha.rao', SECRET);
    expectGone(pw, SECRET);
    rerender(<LockOverlay {...props} busy error={null} />);
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
    rerender(<LockOverlay {...props} busy={false} error={REFUSED} />);
    expectGone(screen.getByLabelText<HTMLInputElement>('Password'), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    fireEvent.submit(screen.getByRole('form', { name: 'Unlock with your user ID and password' }));
    expect(onUnlockPassword).toHaveBeenCalledTimes(1);
  });

  it('[INV-40][DI-38] kiosk unlock: the badge waits for its PIN in a ref only, and is wiped as soon as the lock screen closes (not 30 s later)', async () => {
    const UID = '04A1000000F00D';
    const onUnlockBadge = vi.fn();
    const onSwitch = vi.fn();
    const props = { legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', kiosk: true, busy: false, error: null, onUnlockBadge, onUnlockPassword: noop, onSwitch, onSignOut: noop };
    const { rerender } = render(<LockOverlay {...props} isOpen offer={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock (TEST-Priya Nair)' }));
    await userEvent.type(screen.getByLabelText('Badge'), `${UID}{Enter}`);
    const pad = await screen.findByRole('group', { name: 'Enter your PIN' });
    // Between the badge and its PIN the UID waits in a ref only: not in React state or props, not in the document.
    expect(reactTraces(UID, { allowRefs: true }), 'React state and props').toEqual([]);
    expect(document.documentElement.outerHTML.includes(UID)).toBe(false);
    for (const d of '482913') await userEvent.click(within(pad).getByRole('button', { name: d }));
    await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
    expect(onUnlockBadge).toHaveBeenCalledWith(UID, '482913');

    // The unlock succeeded and the lock screen closes: the badge is gone at once, from refs too.
    rerender(<LockOverlay {...props} isOpen={false} offer={null} />);
    expect(reactTraces(UID), 'anywhere in React, refs included').toEqual([]);
    // A later lock that offers a switch asks for a new tap: the earlier badge is never reused.
    rerender(<LockOverlay {...props} isOpen offer={{ legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1' }} />);
    expect(await screen.findByText('Tap your badge again to switch.')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Enter the PIN of TEST-Kavya Reddy' })).toBeNull();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('[INV-40][DI-38] badge prompt: the badge UID is gone after Enter, also after the countdown re-renders the prompt', async () => {
    const UID = '04A1000000BEEF';
    const onTap = vi.fn();
    render(<BadgePrompt reason="Confirm your entry" onTap={onTap} onCancel={noop} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(field, UID);
    expect(reactTraces(UID)).toEqual([]);
    await userEvent.type(field, '{Enter}');
    expect(onTap).toHaveBeenCalledWith(UID);
    expectGone(field, UID);
    await waitFor(() => expect(screen.getByText(/Waiting for a badge: 2[0-9] s/)).toBeTruthy(), { timeout: 3000 });
    expectGone(screen.getByLabelText<HTMLInputElement>('Badge'), UID);
  });

  it('[INV-40][DI-38] badge prompt: a badge UID typed and then cancelled is cleared and never handed over', async () => {
    const UID = '04A1000000CAFE';
    const onTap = vi.fn();
    const onCancel = vi.fn();
    render(<BadgePrompt reason="Confirm your entry" onTap={onTap} onCancel={onCancel} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(field, UID);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
    expectGone(field, UID);
  });
});
