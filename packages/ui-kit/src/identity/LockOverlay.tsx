/**
 * LockOverlay and SwitchUserDialog (module C1; plan section 5 and screen 16; DI-14, DI-38).
 *
 * A locked session covers the whole screen. Kiosk: "Unlock" (the session's person: badge, then PIN) or "Switch
 * user" (another person: badge, then PIN; their own session opens). Office: user ID and password of the session's
 * person. A badge of another person at the unlock turns into "Switch to <name>?" and asks only for that person's PIN
 * (the badge just tapped is kept here for at most 30 s, never in state or storage).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Button } from '../primitives/Button.tsx';
import { Dialog } from '../primitives/Dialog.tsx';
import type { SwitchOffer } from '../machines/kiosk-lock.ts';
import { BadgePrompt, type DemoBadge } from './BadgePrompt.tsx';
import { icls } from './classes.ts';
import { PinPad } from './PinPad.tsx';
import { RefusalNotice } from './SignatureDialog.tsx';
import { Field } from '../primitives/Field.tsx';

const KEEP_BADGE_MS = 30_000;

/**
 * A badge UID kept in a ref for a short time (a PIN step follows), then wiped. Only whether one is kept is state;
 * the UID itself never is.
 */
function useKeptBadge() {
  const badge = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [has, setHas] = useState(false);
  const api = useMemo(() => {
    const clear = () => {
      badge.current = null;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setHas(false);
    };
    const keep = (uid: string) => {
      clear();
      badge.current = uid;
      setHas(true);
      timer.current = setTimeout(clear, KEEP_BADGE_MS);
    };
    /** The kept UID, handed over once and wiped. */
    const take = (): string | null => {
      const uid = badge.current;
      clear();
      return uid;
    };
    /** The kept UID without wiping it (an unlock may turn into a switch offer that reuses the same tap). */
    const peek = (): string | null => badge.current;
    return { keep, clear, take, peek };
  }, []);
  useEffect(() => api.clear, [api]);
  return { ...api, has };
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

export function LockOverlay(p: LockOverlayProps) {
  const [step, setStep] = useState<Step>('choose');
  const kept = useKeptBadge();
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (p.offer) setStep('offerPin');
  }, [p.offer]);
  useEffect(() => {
    if (p.isOpen && p.switchFirst && p.kiosk) setStep('switchTap');
  }, [p.isOpen, p.switchFirst, p.kiosk]);
  const { clear: clearBadge } = kept;
  useEffect(() => {
    if (!p.isOpen) {
      clearBadge();
      setStep('choose');
    }
  }, [p.isOpen, clearBadge]);

  const pinFor = (then: (uid: string, pin: string) => void, keepBadge = false) => (pin: string) => {
    const uid = keepBadge ? kept.peek() : kept.take();
    setStep('choose');
    if (uid) then(uid, pin);
  };

  const body = (() => {
    if (!p.kiosk) {
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const id = idRef.current?.value.trim() ?? '';
            const pw = pwRef.current?.value ?? '';
            if (pwRef.current) pwRef.current.value = '';
            if (id && pw) p.onUnlockPassword(id, pw);
          }}
          aria-label="Unlock with your user ID and password"
        >
          <Field label="User ID" name="unlockUserId" inputRef={idRef} autoComplete="off" isRequired autoFocus isDisabled={p.busy} />
          <Field label="Password" name="unlockPassword" type="password" inputRef={pwRef} autoComplete="off" isRequired isDisabled={p.busy} />
          <div className={icls('row')}>
            <Button type="submit" variant="primary" isDisabled={p.busy}>
              Unlock
            </Button>
            <Button onPress={p.onSignOut}>Sign out</Button>
          </div>
        </form>
      );
    }
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
              kept.keep(uid);
              setStep(step === 'unlockTap' ? 'unlockPin' : 'switchPin');
            }}
            onCancel={() => setStep('choose')}
          />
        );
      case 'unlockPin':
        return (
          <>
            <PinPad onSubmit={pinFor((uid, pin) => p.onUnlockBadge(uid, pin), true)} disabled={p.busy} />
            <Button onPress={() => { kept.clear(); setStep('choose'); }}>Cancel</Button>
          </>
        );
      case 'switchPin':
        return (
          <>
            <PinPad onSubmit={pinFor((uid, pin) => p.onSwitch(uid, pin))} disabled={p.busy} />
            <Button onPress={() => { kept.clear(); setStep('choose'); }}>Cancel</Button>
          </>
        );
      case 'offerPin':
        return (
          <>
            <p>{`Switch to ${p.offer?.legalName ?? 'the person who tapped'}? Their own session opens on this terminal.`}</p>
            {kept.has ? (
              <PinPad label={`Enter the PIN of ${p.offer?.legalName ?? 'the person who tapped'}`} onSubmit={pinFor((uid, pin) => p.onSwitch(uid, pin))} disabled={p.busy} />
            ) : (
              <BadgePrompt reason="Tap your badge again to switch." demoBadges={p.demoBadges ?? []} onTap={(uid) => kept.keep(uid)} onCancel={() => setStep('choose')} />
            )}
            <Button onPress={() => { kept.clear(); setStep('choose'); }}>Cancel</Button>
          </>
        );
    }
  })();

  return (
    <Dialog title="This terminal is locked" isOpen={p.isOpen} isDismissable={false} role="alertdialog">
      <div className={icls('lock')}>
        <p>{`Signed in: ${p.legalName} (${p.loginName}). Work is paused until the session is unlocked.`}</p>
        {p.error && step !== 'offerPin' ? <RefusalNotice envelope={p.error} tone="warning" /> : null}
        {body}
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
