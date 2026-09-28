/**
 * Identity, lock and signature components (module C1): secrets never reach the DOM, React props of other
 * components, or storage; the signer sees what is signed, the meaning and the manifestation (DI-36, DI-37, DI-38);
 * content renderers never hide a field; the lock screen and switch flows hand badge and PIN over once.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import type { ChallengeView, ManifestationView, SignableContentView } from '@ebmr/api-contract';
import { BadgePrompt, IdentityBanner, LockOverlay, ManifestationCard, PinPad, SignableContent, SignatureDialog } from '../../src/identity/index.ts';
import type { CeremonyContext } from '../../src/machines/ceremony.ts';

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
const CHALLENGE = (requires: ChallengeView['requires']): ChallengeView => ({
  challengeId: '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e',
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
  meaning: 'PERFORMED',
  expiresAt: { us: '1790586663000000', text: '28-SEP-2026 14:41:03 +05:30 (Asia/Kolkata)' },
  expiresInSeconds: 120,
  requires,
  manifestation: { legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR', meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' },
});
const MANIFESTATION: ManifestationView = {
  signatureId: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c03',
  signer: { personId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e51', legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', role: 'OPERATOR' },
  meaning: 'PERFORMED',
  meaningText: 'Performed by',
  signedAt: { us: '1790586600000000', text: '28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)' },
  zone: 'Asia/Kolkata',
  valid: true,
  aggregateType: 'esig_stub',
  aggregateId: 's-1',
  contentVersion: '1',
  contentHash: CONTENT.contentHash,
};

const ctx = (over: Partial<CeremonyContext> = {}): CeremonyContext => ({
  kiosk: true,
  content: CONTENT,
  challenge: null,
  manifestation: null,
  result: null,
  refusal: null,
  attemptError: null,
  attempts: 0,
  ...over,
});

const noop = () => undefined;
const handlers = {
  onSign: noop,
  onCancel: noop,
  onRestart: noop,
  onClose: noop,
  onTap: noop,
  onTapTimeout: noop,
  onPin: noop,
  onPassword: noop,
  onSwitchPin: noop,
};

async function enterPin(group: HTMLElement, pin: string) {
  for (const d of pin) await userEvent.click(within(group).getByRole('button', { name: d }));
  await userEvent.click(within(group).getByRole('button', { name: 'OK' }));
}

describe('PinPad and BadgePrompt', () => {
  it('[DI-38] the PIN pad shows only the number of digits, hands the PIN over once on OK and forgets it', async () => {
    const got = vi.fn();
    render(<PinPad onSubmit={got} />);
    const pad = screen.getByRole('group', { name: 'Enter your PIN' });
    for (const d of '4829') await userEvent.click(within(pad).getByRole('button', { name: d }));
    expect(document.body.textContent).not.toContain('4829');
    expect(within(pad).getByLabelText('4 digits entered').textContent).toBe('••••');
    await userEvent.click(within(pad).getByRole('button', { name: 'OK' }));
    expect(got).toHaveBeenCalledWith('4829');
    expect(within(pad).getByLabelText('0 digits entered').textContent).toBe('');
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('[INV-40] a keyboard-wedge badge burst plus Enter is read once and the field is cleared; no tap within the time gives up', async () => {
    const onTap = vi.fn();
    render(<BadgePrompt reason="Confirm your entry" onTap={onTap} onCancel={noop} />);
    const field = screen.getByLabelText<HTMLInputElement>('Badge');
    await userEvent.type(field, '04A10000000001{Enter}');
    expect(onTap).toHaveBeenCalledWith('04A10000000001');
    expect(field.value).toBe('');
    const onTimeout = vi.fn();
    render(<BadgePrompt reason="Confirm" onTap={noop} onCancel={noop} onTimeout={onTimeout} timeoutSeconds={1} />);
    await waitFor(() => expect(onTimeout).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });
});

describe('what is signed', () => {
  it('[DI-37] every field of the record is shown, known and unknown, and the exact signed text is available with its hash', () => {
    const view: SignableContentView = {
      ...CONTENT,
      rendering: {
        kind: 'batch_exception',
        batchNumber: 'TEST-B-0001',
        stepNumber: '2.1.4',
        exceptionId: 'EX-1',
        severity: 'MAJOR',
        recorded: { value: '15', unit: '/min' },
        raisedBy: { legalName: 'TEST-Arjun Das', loginName: 'test-operator-2', role: 'OPERATOR' },
        raisedAt: { us: '1790586363000000', text: '28-SEP-2026 14:36:03 +05:30 (Asia/Kolkata)' },
        aFieldC3AddsLater: 'must still be shown',
        nested: { deeper: ['one', 'two'] },
      },
    };
    render(<SignableContent view={view} />);
    for (const text of ['TEST-B-0001', '2.1.4', 'EX-1', 'MAJOR', '15 /min', 'TEST-Arjun Das (test-operator-2), OPERATOR', '28-SEP-2026 14:36:03 +05:30 (Asia/Kolkata)', 'must still be shown', 'one', 'two']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText('A field c3 adds later')).toBeTruthy();
    expect(screen.getByText('Raised by')).toBeTruthy();
  });

  it('[DI-36][DI-38] before the PIN the signer sees the record, the meaning and how the signature will show; nothing is pre-filled', () => {
    render(<SignatureDialog {...handlers} state="awaitingSecret" context={ctx({ challenge: CHALLENGE(['PIN']) })} title="Sign entry as PERFORMED" secondsLeft={95} signerName="TEST-Priya Nair" />);
    expect(screen.getByText('PERFORMED: I performed this step and recorded its data.')).toBeTruthy();
    const preview = screen.getByRole('region', { name: 'Your signature will show' });
    for (const text of ['TEST-Priya Nair', 'test-operator-1', 'OPERATOR', 'Performed by (PERFORMED)']) expect(within(preview).getByText(text)).toBeTruthy();
    expect(within(preview).getByText(/Asia\/Kolkata/)).toBeTruthy();
    expect(screen.getByText('Time left to sign: 95 s')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Enter your PIN to sign' })).toBeTruthy();
    expect(screen.getByText(TEXT)).toBeTruthy();
    expect(screen.getByText(`SHA-256 ${CONTENT.contentHash} (checked on this terminal)`)).toBeTruthy();
  });

  it('[DI-38] an office signature asks for user ID and password, both empty, and hands them over once', async () => {
    const onPassword = vi.fn();
    render(<SignatureDialog {...handlers} onPassword={onPassword} state="awaitingSecret" context={ctx({ kiosk: false, challenge: CHALLENGE(['USER_ID', 'PASSWORD']) })} title="Sign" secondsLeft={100} signerName="Asha Rao" />);
    const id = screen.getByLabelText<HTMLInputElement>('User ID');
    const pw = screen.getByLabelText<HTMLInputElement>('Password');
    expect(id.value).toBe('');
    expect(pw.value).toBe('');
    await userEvent.type(id, 'asha.rao');
    await userEvent.type(pw, 'Secret-Password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(onPassword).toHaveBeenCalledWith('asha.rao', 'Secret-Password-1');
    expect(pw.value).toBe('');
  });

  it('[DI-36] after signing the stored manifestation is shown with date and time, offset and zone; an invalid one says so', () => {
    render(<SignatureDialog {...handlers} state="done" context={ctx({ manifestation: MANIFESTATION })} title="Sign" secondsLeft={null} signerName="x" />);
    expect(screen.getByText('28-SEP-2026 14:40:00 +05:30 (Asia/Kolkata)')).toBeTruthy();
    expect(screen.getByText('Valid')).toBeTruthy();
    render(<ManifestationCard manifestation={{ ...MANIFESTATION, valid: false }} />);
    expect(screen.getByText('Not valid: this element is unsigned; signing again is required')).toBeTruthy();
  });

  it('[DI-37] changed content and expiry offer to start again; a lost answer that found nothing says not confirmed', () => {
    const { rerender } = render(<SignatureDialog {...handlers} state="changed" context={ctx({ refusal: { refusal: { code: 'EBMR-ESIG-013', kind: 'CONTENT_CHANGED', whatHappened: 'The record changed while you were reviewing it. Nothing was signed.', why: '', controls: [], whatYouCanDo: [], whoCanHelp: [] }, correlationId: 'x', retryable: false } })} title="Sign" secondsLeft={null} signerName="x" />);
    expect(screen.getByText('The record changed while you were reviewing it. Nothing was signed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review again' })).toBeTruthy();
    rerender(<SignatureDialog {...handlers} state="notConfirmed" context={ctx()} title="Sign" secondsLeft={null} signerName="x" />);
    expect(screen.getByText('The signature was not confirmed.')).toBeTruthy();
  });
});

describe('lock screen and banner', () => {
  it('[DI-38][DI-14] a kiosk unlock takes the badge, then the PIN, and hands both over once', async () => {
    const onUnlockBadge = vi.fn();
    render(<LockOverlay isOpen legalName="TEST-Priya Nair" loginName="test-operator-1" kiosk busy={false} error={null} offer={null} onUnlockBadge={onUnlockBadge} onUnlockPassword={noop} onSwitch={noop} onSignOut={noop} />);
    expect(screen.getByRole('alertdialog', { name: 'This terminal is locked' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Unlock (TEST-Priya Nair)' }));
    await userEvent.type(screen.getByLabelText('Badge'), '04A10000000001{Enter}');
    await enterPin(screen.getByRole('group', { name: 'Enter your PIN' }), '482913');
    expect(onUnlockBadge).toHaveBeenCalledWith('04A10000000001', '482913');
  });

  it('[INV-40][DI-14] another person\'s badge at the unlock becomes "Switch to <name>?" asking only their PIN', async () => {
    const onUnlockBadge = vi.fn();
    const onSwitch = vi.fn();
    const props = { isOpen: true, legalName: 'TEST-Priya Nair', loginName: 'test-operator-1', kiosk: true, busy: false, error: null, onUnlockBadge, onUnlockPassword: noop, onSwitch, onSignOut: noop };
    const { rerender } = render(<LockOverlay {...props} offer={null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Unlock (TEST-Priya Nair)' }));
    await userEvent.type(screen.getByLabelText('Badge'), '04A10000000011{Enter}');
    await enterPin(screen.getByRole('group', { name: 'Enter your PIN' }), '111111');
    expect(onUnlockBadge).toHaveBeenCalledWith('04A10000000011', '111111');
    rerender(<LockOverlay {...props} offer={{ legalName: 'TEST-Kavya Reddy', loginName: 'test-verifier-1' }} />);
    expect(screen.getByText('Switch to TEST-Kavya Reddy? Their own session opens on this terminal.')).toBeTruthy();
    await enterPin(screen.getByRole('group', { name: 'Enter the PIN of TEST-Kavya Reddy' }), '691357');
    expect(onSwitch).toHaveBeenCalledWith('04A10000000011', '691357');
  });

  it('[DI-14] the banner names the person, user ID, role and terminal, with lock, switch (kiosk) and sign out', async () => {
    const onLock = vi.fn();
    render(<IdentityBanner productName="eBMR Tablets" installation="SANDBOX" installationLabel="Sandbox (test runs)" legalName="TEST-Priya Nair" loginName="test-operator-1" role="OPERATOR" deviceCode="TEST-KIOSK-DISP-1" roomCode="DISP-1" kiosk attribution="TAP" onLock={onLock} onSwitch={noop} onSignOut={noop} />);
    expect(screen.getByTestId('identity').textContent).toBe('Signed in as TEST-Priya Nair (test-operator-1), OPERATOR');
    expect(screen.getByText(/TEST-KIOSK-DISP-1 · room DISP-1 · each entry: badge tap/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Lock' }));
    expect(onLock).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Switch user' })).toBeTruthy();
  });
});
