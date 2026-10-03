/**
 * BadgePrompt and DemoBadgeReader (module C1; plan sections 5 and 9): a badge reader behind a kiosk types the badge
 * UID as a fast burst of keys followed by Enter (keyboard wedge). The prompt keeps focus on one masked SecretInput
 * (native, uncontrolled), reads the UID once on Enter, clears the input in the same step and hands the UID to the
 * caller; it never enters React state, props, the input's value attribute or storage. After `timeoutSeconds`
 * (default 30) without a tap the prompt gives up.
 *
 * DemoBadgeReader (DEMO-ONLY, demo installations only) offers one button per demo person of this terminal instead
 * of a physical reader.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Button } from '../primitives/Button.tsx';
import { SecretInput, takeSecret } from '../primitives/SecretInput.tsx';
import { icls } from './classes.ts';
import { RefusalNotice } from './RefusalNotice.tsx';

export interface DemoBadge {
  legalName: string;
  badgeUid: string;
}

export interface BadgePromptProps {
  /** What the tap confirms, e.g. "Confirm your entry" or "Sign as performed". */
  reason: string;
  onTap: (badgeUid: string) => void;
  onCancel: () => void;
  onTimeout?: () => void;
  timeoutSeconds?: number;
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
  const [left, setLeft] = useState(timeoutSeconds);
  const done = useRef(false);

  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (left === 0 && !done.current) {
      done.current = true;
      if (input.current) input.current.value = '';
      (onTimeout ?? onCancel)();
    }
  }, [left, onTimeout, onCancel]);

  const tap = (uid: string) => {
    if (done.current || busy) return;
    done.current = true;
    onTap(uid);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const uid = takeSecret(input).trim();
    if (uid) tap(uid);
  };

  return (
    <div className={icls('badgePrompt')}>
      {refusal ? <RefusalNotice envelope={refusal} tone="warning" /> : null}
      <p>{reason}</p>
      <form onSubmit={submit} aria-label="Tap your badge">
        <SecretInput label="Badge" name="badge" inputRef={input} autoFocus description="Tap your badge on the reader" isDisabled={busy} />
        <p className={icls('muted')} aria-live="off">
          {`Waiting for a badge: ${left} s`}
        </p>
        <div className={icls('row')}>
          <Button type="submit" variant="primary" isDisabled={busy}>
            Continue
          </Button>
          <Button
            onPress={() => {
              done.current = true;
              if (input.current) input.current.value = '';
              onCancel();
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
      <DemoBadgeReader badges={demoBadges} onTap={tap} />
    </div>
  );
}
