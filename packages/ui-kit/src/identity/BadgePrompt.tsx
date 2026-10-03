/**
 * BadgePrompt and DemoBadgeReader (module C1; plan sections 5 and 9): a badge reader behind a kiosk types the badge
 * UID as a fast burst of keys followed by Enter (keyboard wedge). The prompt keeps focus on one masked SecretInput
 * (native, uncontrolled), reads the UID once on Enter, clears the input in the same step and hands the UID to the
 * caller; it never enters React state, props, the input's value attribute or storage. After `timeoutSeconds`
 * (default 30; null: no limit, as on the sign-in screen) without a tap the prompt gives up.
 *
 * Only a reader's tap counts (review F56, the owner's refused first signing tap, EBMR-IAM-140): a key typed more than
 * BURST_GAP_MS after the previous one starts the field afresh, so a stray keystroke before the reader's burst is never
 * sent as part of the badge, and text that cannot be a badge UID (the kernel's rule: 8 to 64 hexadecimal digits, as
 * badgeUidOf reads it; a PIN keyed into the field, a secret the browser filled in) is not sent at all: the prompt says
 * so and waits for the badge. What happened to the previous tap of the same request (`refusal`, e.g. "The badge was
 * not accepted") is shown above the field.
 *
 * DemoBadgeReader (DEMO-ONLY, demo installations only) offers one button per demo person of this terminal instead
 * of a physical reader.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { badgeUidOf, type RefusalEnvelope } from '@ebmr/api-contract';
import { Banner } from '../primitives/Banner.tsx';
import { Button } from '../primitives/Button.tsx';
import { SecretInput, takeSecret } from '../primitives/SecretInput.tsx';
import { icls } from './classes.ts';
import { RefusalNotice } from './RefusalNotice.tsx';

/**
 * The longest pause between two keys of one badge tap. A keyboard-wedge reader types its burst a few milliseconds
 * apart; a person typing is far slower, so each of their keys starts the field afresh.
 */
export const BURST_GAP_MS = 100;

/** What the prompt says when the text entered cannot be a badge UID (nothing is sent). */
export const NOT_A_BADGE = 'That is not a badge. Nothing was sent: tap your badge on the reader.';

export interface DemoBadge {
  legalName: string;
  badgeUid: string;
}

export interface BadgePromptProps {
  /** What the tap confirms, e.g. "Confirm your entry" or "Sign as performed". */
  reason: string;
  onTap: (badgeUid: string) => void;
  /** Without it the prompt offers no Cancel (the sign-in screen). */
  onCancel?: () => void;
  onTimeout?: () => void;
  /** Seconds to wait for a tap (default 30); null waits without a limit. */
  timeoutSeconds?: number | null;
  /** DEMO-ONLY badges of this terminal (demo installations only). */
  demoBadges?: readonly DemoBadge[];
  busy?: boolean;
  /**
   * What happened to the previous tap of this request (refused, or never sent), shown above the field. A prompt takes
   * one tap: the caller mounts a new prompt (a new key) for the next attempt.
   */
  refusal?: RefusalEnvelope | null;
}

export function DemoBadgeReader({ badges, onTap }: { badges: readonly DemoBadge[]; onTap: (badgeUid: string) => void }) {
  if (badges.length === 0) return null;
  return (
    <section className={icls('drawer')} aria-label="Demo badge reader">
      <h3 className={icls('drawerTitle')}>Demo badge reader (DEMO-ONLY)</h3>
      <div className={icls('row')}>
        {badges.map((b) => (
          <Button key={b.badgeUid} onPress={() => onTap(b.badgeUid)}>
            {`Tap ${b.legalName}`}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function BadgePrompt({ reason, onTap, onCancel, onTimeout, timeoutSeconds = 30, demoBadges = [], busy = false, refusal = null }: BadgePromptProps) {
  const input = useRef<HTMLInputElement>(null);
  const [left, setLeft] = useState(timeoutSeconds ?? 0);
  const [notABadge, setNotABadge] = useState(false);
  const done = useRef(false);
  /** When the last printable key reached the field (the event's own time stamp: no clock is read). */
  const lastKeyAt = useRef<number | null>(null);

  useEffect(() => {
    if (timeoutSeconds === null) return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [timeoutSeconds]);
  useEffect(() => {
    if (timeoutSeconds !== null && left === 0 && !done.current) {
      done.current = true;
      if (input.current) input.current.value = '';
      (onTimeout ?? onCancel)?.();
    }
  }, [left, timeoutSeconds, onTimeout, onCancel]);

  const tap = (text: string) => {
    if (done.current || busy) return;
    const uid = badgeUidOf(text);
    if (!uid) {
      setNotABadge(true);
      return;
    }
    done.current = true;
    setNotABadge(false);
    onTap(uid);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    lastKeyAt.current = null;
    const text = takeSecret(input);
    if (text.trim()) tap(text);
  };
  // A printable key long after the previous one is not part of a reader's burst: the field starts again with it.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    const last = lastKeyAt.current;
    lastKeyAt.current = e.timeStamp;
    if (last !== null && e.timeStamp - last > BURST_GAP_MS && input.current) input.current.value = '';
  };

  return (
    <div className={icls('badgePrompt')}>
      {refusal ? <RefusalNotice envelope={refusal} tone="warning" /> : null}
      {notABadge ? <Banner tone="warning" title={NOT_A_BADGE} /> : null}
      <p>{reason}</p>
      <form onSubmit={submit} onKeyDownCapture={onKeyDown} aria-label="Tap your badge">
        <SecretInput label="Badge" name="badge" inputRef={input} autoFocus description="Tap your badge on the reader" isDisabled={busy} />
        {timeoutSeconds !== null ? (
          <p className={icls('muted')} aria-live="off">
            {`Waiting for a badge: ${left} s`}
          </p>
        ) : null}
        <div className={icls('row')}>
          <Button type="submit" variant="primary" isDisabled={busy}>
            Continue
          </Button>
          {onCancel ? (
            <Button
              onPress={() => {
                done.current = true;
                if (input.current) input.current.value = '';
                onCancel();
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
      <DemoBadgeReader badges={demoBadges} onTap={tap} />
    </div>
  );
}
