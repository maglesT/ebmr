/**
 * IdleWarning (module C1; outline 7.4; WCAG 2.2 success criterion 2.2.1; DI-14, DI-38; slice 7d finding A11Y-1).
 *
 * Shown before the kernel locks an idle session, and before the absolute timeout ends a session:
 *  - IDLE on an office PC: "Keep working" extends the session with one press (the server's keep-alive);
 *  - IDLE on a shop-floor kiosk: a badge tap of the session's own person extends it (the keep-alive takes a badge tap
 *    there, DI-14); "Lock now" locks at once;
 *  - END: nothing extends the absolute lifetime (a security limit); the person is told to finish and sign in again.
 * The dialog is an alert dialog, so a screen reader announces its title and text when it opens; the countdown itself is
 * not a live region (a reading every second would drown the screen reader).
 */
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Button } from '../primitives/Button.tsx';
import { Dialog } from '../primitives/Dialog.tsx';
import { BadgePrompt, type DemoBadge } from './BadgePrompt.tsx';
import { icls } from './classes.ts';
import { RefusalNotice } from './RefusalNotice.tsx';

export interface IdleWarningProps {
  isOpen: boolean;
  /** IDLE: the inactivity lock is near; END: the absolute timeout is near. */
  kind: 'IDLE' | 'END';
  /** Whole seconds left, as the page estimates them from the server's last answer. */
  secondsLeft: number;
  kiosk: boolean;
  busy?: boolean;
  error?: RefusalEnvelope | null;
  demoBadges?: readonly DemoBadge[];
  /** Office, IDLE: keep the session open. */
  onKeepWorking: () => void;
  /** Kiosk, IDLE: the badge tapped to keep the session open. */
  onTap: (badgeUid: string) => void;
  /** Kiosk, IDLE: lock the terminal now. */
  onLockNow: () => void;
  /** END: the person has read the warning. */
  onDismiss: () => void;
  /** A new value mounts a new badge prompt (one tap per prompt). */
  promptKey?: number;
}

/** "4 min 05 s", "45 s". */
export function timeLeft(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${String(s)} s`;
  return `${String(Math.floor(s / 60))} min ${String(s % 60).padStart(2, '0')} s`;
}

export function IdleWarning(p: IdleWarningProps) {
  const left = timeLeft(p.secondsLeft);
  if (p.kind === 'END') {
    return (
      <Dialog title="Your session ends soon" isOpen={p.isOpen} isDismissable={false} role="alertdialog">
        <div className={icls('lock')}>
          <p>{`Your session ends in ${left}: a session lasts at most a set time, whatever you do. Finish or save what you are doing; then sign in again.`}</p>
          <Button variant="primary" onPress={p.onDismiss}>
            OK
          </Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Are you still working?" isOpen={p.isOpen} isDismissable={false} role="alertdialog">
      <div className={icls('lock')}>
        <p>{`Nothing was done on this terminal for a while. It locks in ${left}.`}</p>
        {p.error ? <RefusalNotice envelope={p.error} tone="warning" /> : null}
        {p.kiosk ? (
          <>
            <BadgePrompt key={p.promptKey ?? 0} reason="Tap your badge to keep working." demoBadges={p.demoBadges ?? []} onTap={p.onTap} timeoutSeconds={null} busy={p.busy ?? false} />
            <Button onPress={p.onLockNow} isDisabled={p.busy ?? false}>
              Lock now
            </Button>
          </>
        ) : (
          <Button variant="primary" onPress={p.onKeepWorking} isDisabled={p.busy ?? false}>
            Keep working
          </Button>
        )}
      </div>
    </Dialog>
  );
}
