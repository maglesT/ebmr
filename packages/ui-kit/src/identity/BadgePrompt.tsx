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
 * A tap is text that reached the field as one burst of keys (Phase 2 exit follow-up BADGE-AUTOFILL): the field is
 * marked for browsers and password managers as a one-time code they should neither fill nor save (SecretInput
 * `noAutofill`), and text that did not arrive key by key in the current burst (a saved secret filled in by the browser
 * or a password manager, a paste, a drop: the field saw an insertion that was not typed, or holds more characters than
 * the burst brought keys) is not sent, even when it reads as a badge UID: the prompt says the badge was not tapped and
 * waits. The first key of a burst empties the field, so a reader's tap after such text still counts.
 *
 * DemoBadgeReader (DEMO-ONLY, demo installations only) offers one button per demo person of this terminal instead
 * of a physical reader.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { badgeUidOf, type RefusalEnvelope } from '@ebmr/api-contract';
import { Banner } from '../primitives/Banner.tsx';
import { Button } from '../primitives/Button.tsx';
import { clearSecret, SecretInput, takeSecret, wasFilled } from '../primitives/SecretInput.tsx';
import { icls } from './classes.ts';
import { RefusalNotice } from './RefusalNotice.tsx';

/**
 * The longest pause between two keys of one badge tap. A keyboard-wedge reader types its burst a few milliseconds
 * apart; a person typing is far slower, so each of their keys starts the field afresh.
 */
export const BURST_GAP_MS = 100;

/** What the prompt says when the text entered cannot be a badge UID (nothing is sent). */
export const NOT_A_BADGE = 'That is not a badge. Nothing was sent: tap your badge on the reader.';

/** What the prompt says when the text did not come from the reader key by key: filled in, pasted or dropped (nothing is sent). */
export const NOT_TAPPED = 'That was not a tap of the reader: it was filled in or pasted. Nothing was sent: tap your badge on the reader.';

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
  const [notABadge, setNotABadge] = useState<'NOT_A_BADGE' | 'NOT_TAPPED' | null>(null);
  const done = useRef(false);
  /** When the last printable key reached the field (the event's own time stamp: no clock is read). */
  const lastKeyAt = useRef<number | null>(null);
  /**
   * How many printable keys the current burst brought, compared with what the field holds when it is read
   * (BADGE-AUTOFILL). A count only: the keys themselves are a badge UID, which never enters React.
   */
  const keyed = useRef(0);

  useEffect(() => {
    if (timeoutSeconds === null) return;
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [timeoutSeconds]);
  useEffect(() => {
    if (timeoutSeconds !== null && left === 0 && !done.current) {
      done.current = true;
      clearSecret(input);
      (onTimeout ?? onCancel)?.();
    }
  }, [left, timeoutSeconds, onTimeout, onCancel]);

  const tap = (text: string) => {
    if (done.current || busy) return;
    const uid = badgeUidOf(text);
    if (!uid) {
      setNotABadge('NOT_A_BADGE');
      return;
    }
    done.current = true;
    setNotABadge(null);
    onTap(uid);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const filled = wasFilled(input);
    const burst = keyed.current;
    lastKeyAt.current = null;
    keyed.current = 0;
    const text = takeSecret(input);
    if (!text.trim()) return;
    // Only what the reader typed in this burst is a tap: text filled in, pasted or dropped is never sent.
    if (filled || [...text].length !== burst) {
      if (!done.current && !busy) setNotABadge('NOT_TAPPED');
      return;
    }
    tap(text);
  };
  // The first printable key, or one long after the previous one, starts a burst: the field starts again with it.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    const last = lastKeyAt.current;
    lastKeyAt.current = e.timeStamp;
    if (last === null || e.timeStamp - last > BURST_GAP_MS) {
      clearSecret(input);
      keyed.current = 0;
    }
    keyed.current += 1;
  };

  return (
    <div className={icls('badgePrompt')}>
      {refusal ? <RefusalNotice envelope={refusal} tone="warning" /> : null}
      {notABadge ? <Banner tone="warning" title={notABadge === 'NOT_TAPPED' ? NOT_TAPPED : NOT_A_BADGE} /> : null}
      <p>{reason}</p>
      <form onSubmit={submit} onKeyDownCapture={onKeyDown} aria-label="Tap your badge">
        <SecretInput label="Badge" name="badge" inputRef={input} autoFocus noAutofill description="Tap your badge on the reader" isDisabled={busy} />
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
                keyed.current = 0;
                clearSecret(input);
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
