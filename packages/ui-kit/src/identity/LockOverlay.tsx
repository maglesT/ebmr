/**
 * LockOverlay and SwitchUserDialog (module C1; plan section 5 and screen 16; DI-14, DI-38).
 *
 * A locked session covers the whole screen. Kiosk: "Unlock" (the session's person: badge, then PIN) or "Switch
 * user" (another person: badge, then PIN; their own session opens). Office: user ID and password of the session's
 * person. A badge of another person at the unlock turns into "Switch to <name>?" and asks only for that person's PIN:
 * the badge just tapped waits in a KeptBadge held by a ref (never in React state or storage) for at most 30 s, and is
 * wiped as soon as the overlay closes (the session was unlocked or switched) or unmounts. The office password is typed
 * into a SecretInput (native, uncontrolled), read and cleared in one step, and never enters React state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Button } from '../primitives/Button.tsx';
import { Dialog } from '../primitives/Dialog.tsx';
import { Field } from '../primitives/Field.tsx';
import { SecretInput, takeSecret } from '../primitives/SecretInput.tsx';
import type { SwitchOffer } from '../machines/kiosk-lock.ts';
import { BadgePrompt, type DemoBadge } from './BadgePrompt.tsx';
import { icls } from './classes.ts';
import { PinPad } from './PinPad.tsx';
import { RefusalNotice } from './RefusalNotice.tsx';

export const KEEP_BADGE_MS = 30_000;

/**
 * A badge UID kept for a short time (a PIN step follows), then wiped. Only whether one is kept is visible to
 * React (through `onChange`); the UID itself stays inside this object, which a component holds in a ref (see
 * useKeptBadge), never in React state.
 */
export class KeptBadge {
  private uid: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChange: (kept: boolean) => void;
  private readonly ms: number;

  constructor(onChange: (kept: boolean) => void = () => undefined, ms: number = KEEP_BADGE_MS) {
    this.onChange = onChange;
    this.ms = ms;
  }

  keep(uid: string): void {
    this.clear();
    this.uid = uid;
    this.onChange(true);
    this.timer = setTimeout(() => this.clear(), this.ms);
  }

  /** The kept UID without wiping it (an unlock may turn into a switch offer that reuses the same tap). */
  peek(): string | null {
    return this.uid;
  }

  /** The kept UID, handed over once and wiped. */
  take(): string | null {
    const uid = this.uid;
    this.clear();
    return uid;
  }

  clear(): void {
    const had = this.uid !== null;
    this.uid = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (had) this.onChange(false);
  }
}

/**
 * A KeptBadge held by a ref, never in React state. The getter creates it on first use and is meant for event handlers
 * and effects only (a ref is not read during render).
 */
export function useKeptBadge(onChange: (kept: boolean) => void, ms: number = KEEP_BADGE_MS): () => KeptBadge {
  const ref = useRef<KeptBadge | null>(null);
  return useCallback(() => (ref.current ??= new KeptBadge(onChange, ms)), [onChange, ms]);
}

export interface LockOverlayProps {
  isOpen: boolean;
  legalName: string;
  loginName: string;
  kiosk: boolean;
  busy: boolean;
  error: RefusalEnvelope | null;
  /** Another person's badge was tapped at the unlock: offer to switch to them. */
  offer: SwitchOffer | null;
  demoBadges?: readonly DemoBadge[];
  /** Kiosk: open straight at "Switch user" (the banner's Switch user locks first, then asks the next badge). */
  switchFirst?: boolean;
  onUnlockBadge: (badgeUid: string, pin: string) => void;
  onUnlockPassword: (loginName: string, password: string) => void;
  onSwitch: (badgeUid: string, pin: string) => void;
  onSignOut: () => void;
}

type Step = 'choose' | 'unlockTap' | 'unlockPin' | 'switchTap' | 'switchPin' | 'offerPin';

function OfficeUnlock(p: LockOverlayProps) {
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const id = idRef.current?.value.trim() ?? '';
        // Read and cleared in one step: the password never enters React state or the DOM value attribute.
        const pw = takeSecret(pwRef);
        if (id && pw) p.onUnlockPassword(id, pw);
      }}
      aria-label="Unlock with your user ID and password"
    >
      <Field label="User ID" name="unlockUserId" inputRef={idRef} autoComplete="off" isRequired autoFocus isDisabled={p.busy} />
      <SecretInput label="Password" name="unlockPassword" inputRef={pwRef} isRequired isDisabled={p.busy} />
      <div className={icls('row')}>
        <Button type="submit" variant="primary" isDisabled={p.busy}>
          Unlock
        </Button>
        <Button onPress={p.onSignOut}>Sign out</Button>
      </div>
    </form>
  );
}

/** The kiosk steps; remounted (fresh step) whenever the overlay opens or a switch offer arrives. */
function KioskUnlock({ p, kept, hasBadge }: { p: LockOverlayProps; kept: () => KeptBadge; hasBadge: boolean }) {
  const [step, setStep] = useState<Step>(p.offer ? 'offerPin' : p.switchFirst ? 'switchTap' : 'choose');
  const cancel = () => {
    kept().clear();
    setStep('choose');
  };
  const pinFor = (then: (uid: string, pin: string) => void, keepBadge = false) => (pin: string) => {
    const uid = keepBadge ? kept().peek() : kept().take();
    setStep('choose');
    if (uid) then(uid, pin);
  };
  switch (step) {
    case 'choose':
      return (
        <div className={icls('row')}>
          <Button variant="primary" onPress={() => setStep('unlockTap')} isDisabled={p.busy}>
            {`Unlock (${p.legalName})`}
          </Button>
          <Button onPress={() => setStep('switchTap')} isDisabled={p.busy}>
            Switch user
          </Button>
          <Button onPress={p.onSignOut} isDisabled={p.busy}>
            Sign out
          </Button>
        </div>
      );
    case 'unlockTap':
    case 'switchTap':
      return (
        <BadgePrompt
          reason={step === 'unlockTap' ? `Tap your badge to unlock (${p.legalName}).` : 'Tap your badge to sign in on this terminal.'}
          demoBadges={p.demoBadges ?? []}
          onTap={(uid) => {
            kept().keep(uid);
            setStep(step === 'unlockTap' ? 'unlockPin' : 'switchPin');
          }}
          onCancel={cancel}
        />
      );
    case 'unlockPin':
      return (
        <>
          <PinPad onSubmit={pinFor((uid, pin) => p.onUnlockBadge(uid, pin), true)} disabled={p.busy} />
          <Button onPress={cancel}>Cancel</Button>
        </>
      );
    case 'switchPin':
      return (
        <>
          <PinPad onSubmit={pinFor((uid, pin) => p.onSwitch(uid, pin))} disabled={p.busy} />
          <Button onPress={cancel}>Cancel</Button>
        </>
      );
    case 'offerPin':
      return (
        <>
          <p>{`Switch to ${p.offer?.legalName ?? 'the person who tapped'}? Their own session opens on this terminal.`}</p>
          {hasBadge ? (
            <PinPad label={`Enter the PIN of ${p.offer?.legalName ?? 'the person who tapped'}`} onSubmit={pinFor((uid, pin) => p.onSwitch(uid, pin))} disabled={p.busy} />
          ) : (
            <BadgePrompt reason="Tap your badge again to switch." demoBadges={p.demoBadges ?? []} onTap={(uid) => kept().keep(uid)} onCancel={cancel} />
          )}
          <Button onPress={cancel}>Cancel</Button>
        </>
      );
  }
}

export function LockOverlay(p: LockOverlayProps) {
  const [hasBadge, setHasBadge] = useState(false);
  const kept = useKeptBadge(setHasBadge);
  // Kept only while the overlay is open: once it closes (unlocked or switched) the badge is not needed any more.
  useEffect(() => {
    if (!p.isOpen) kept().clear();
  }, [p.isOpen, kept]);
  useEffect(() => () => kept().clear(), [kept]);
  return (
    <Dialog title="This terminal is locked" isOpen={p.isOpen} isDismissable={false} role="alertdialog">
      <div className={icls('lock')}>
        <p>{`Signed in: ${p.legalName} (${p.loginName}). Work is paused until the session is unlocked.`}</p>
        {p.error && !p.offer ? <RefusalNotice envelope={p.error} tone="warning" /> : null}
        {p.kiosk ? <KioskUnlock key={p.offer ? `offer-${p.offer.loginName}` : 'plain'} p={p} kept={kept} hasBadge={hasBadge} /> : <OfficeUnlock {...p} />}
      </div>
    </Dialog>
  );
}

export interface SwitchUserDialogProps {
  isOpen: boolean;
  offer: SwitchOffer;
  /** True when no badge of that person is kept: they tap again first. */
  needsTap: boolean;
  busy: boolean;
  error: RefusalEnvelope | null;
  demoBadges?: readonly DemoBadge[];
  onTap: (badgeUid: string) => void;
  onPin: (pin: string) => void;
  onCancel: () => void;
}

/** "Switch to <name>?" after a tap by another person on a kiosk (the entry that was tapped is not sent). */
export function SwitchUserDialog(p: SwitchUserDialogProps) {
  return (
    <Dialog title={`Switch to ${p.offer.legalName}?`} isOpen={p.isOpen} isDismissable={false}>
      <div className={icls('lock')}>
        <p>{`The badge tapped belongs to ${p.offer.legalName}. To work as ${p.offer.legalName}, enter their PIN: their own session opens on this terminal. The entry that was tapped is not saved.`}</p>
        {p.error ? <RefusalNotice envelope={p.error} tone="warning" /> : null}
        {p.needsTap ? (
          <BadgePrompt reason={`${p.offer.legalName}: tap your badge.`} demoBadges={p.demoBadges ?? []} onTap={p.onTap} onCancel={p.onCancel} busy={p.busy} />
        ) : (
          <PinPad label={`Enter the PIN of ${p.offer.legalName}`} onSubmit={p.onPin} disabled={p.busy} />
        )}
        <Button onPress={p.onCancel} isDisabled={p.busy}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
