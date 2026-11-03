/**
 * SignatureDialog (module C1; plan section 6; screens 17 and 16): renders one state of the ceremony machine. The
 * host (the web app's ceremony provider) runs the machine, holds the secrets in refs and passes callbacks here.
 *
 * What the signer sees, in order: what is signed (the record, then a disclosure with the exact canonical text and
 * its SHA-256), the meaning statement, how the signature will show (name, user ID, role, meaning, zone), a
 * countdown of the 120 s challenge, then the PIN pad (kiosk) or user ID and password (office). Secrets are typed
 * into a SecretInput (native, uncontrolled) or the PIN pad, handed over once and cleared; nothing is pre-filled or
 * remembered, and no secret enters React state or the input's value attribute.
 */
import { useRef, type FormEvent } from 'react';
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Banner } from '../primitives/Banner.tsx';
import { Button } from '../primitives/Button.tsx';
import { Dialog } from '../primitives/Dialog.tsx';
import { Field } from '../primitives/Field.tsx';
import { SecretInput, takeSecret } from '../primitives/SecretInput.tsx';
import type { CeremonyContext, CeremonyState } from '../machines/ceremony.ts';
import { BadgePrompt, type DemoBadge } from './BadgePrompt.tsx';
import { icls } from './classes.ts';
import { ManifestationCard, ManifestationPreview } from './Manifestation.tsx';
import { PinPad } from './PinPad.tsx';
import { RefusalNotice } from './RefusalNotice.tsx';
import { SignableContent } from './SignableContent.tsx';

/** A spoken countdown only at a few thresholds, so screen readers are not flooded every second. */
function Countdown({ seconds }: { seconds: number | null }) {
  if (seconds === null) return null;
  const spoken = seconds <= 10 ? `${seconds} seconds left to sign` : seconds <= 30 ? 'Less than 30 seconds left to sign' : seconds <= 60 ? 'Less than a minute left to sign' : 'Two minutes to sign';
  return (
    <p>
      <span className={icls('countdown')} data-urgent={seconds <= 30 ? 'true' : 'false'} aria-hidden="true">
        {`Time left to sign: ${seconds} s`}
      </span>
      <span className={icls('srOnly')} aria-live="polite">
        {spoken}
      </span>
    </p>
  );
}

function PasswordForm({ onSubmit, disabled }: { onSubmit: (loginName: string, password: string) => void; disabled: boolean }) {
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const loginName = idRef.current?.value.trim() ?? '';
    // Read and cleared in one step: the password is handed over once and never enters React state or the DOM value.
    const password = takeSecret(pwRef);
    if (!loginName || !password) return;
    onSubmit(loginName, password);
  };
  return (
    <form onSubmit={submit} aria-label="Sign with your user ID and password">
      <Field label="User ID" name="signUserId" inputRef={idRef} autoComplete="off" isRequired autoFocus isDisabled={disabled} />
      <SecretInput label="Password" name="signPassword" inputRef={pwRef} isRequired isDisabled={disabled} />
      <Button type="submit" variant="primary" isDisabled={disabled}>
        Sign
      </Button>
    </form>
  );
}

/**
 * Phase B slice 2, the platform build: the signer re-authenticates at the platform's core in a window of its own (user
 * ID and password asked again there); the dialog waits for that window's answer.
 */
function PlatformReauth({ onStart, disabled, note }: { onStart: () => void; disabled: boolean; note: string | null }) {
  return (
    <div aria-label="Sign by confirming your user ID and password at the platform">
      <p>A platform window asks for your user ID and password again. The signature is applied once you have confirmed there.</p>
      {note ? <Banner tone="warning" title={note} /> : null}
      <Button variant="primary" onPress={onStart} isDisabled={disabled}>
        Confirm at the platform and sign
      </Button>
    </div>
  );
}

export interface SignatureDialogProps {
  state: CeremonyState;
  context: CeremonyContext;
  /** What the caller says is signed, e.g. "Sign step 2.1.4 Blend as performed". */
  title: string;
  /** Seconds left on the challenge (host display clock); null before a challenge. */
  secondsLeft: number | null;
  signerName: string;
  demoBadges?: readonly DemoBadge[];
  /** TAP_PIN terminal classes: after the badge, the PIN confirms the signing request too. */
  tapStage?: 'badge' | 'pin';
  /** A failed switch in switchOffered (e.g. a wrong PIN). */
  switchError?: RefusalEnvelope | null;
  onSign: () => void;
  onCancel: () => void;
  onRestart: () => void;
  onClose: () => void;
  onTap: (badgeUid: string) => void;
  onTapPin?: (pin: string) => void;
  onTapTimeout: () => void;
  onPin: (pin: string) => void;
  onPassword: (loginName: string, password: string) => void;
  /** The platform build: re-authentication at core instead of the password form (no PIN pad either). */
  onPlatform?: () => void;
  /** Why the last platform re-authentication brought nothing back (closed window, blocked pop-up), or null. */
  platformNote?: string | null;
  /** switchOffered: the PIN of the person whose badge was tapped. */
  onSwitchPin: (pin: string) => void;
}

export function SignatureDialog(p: SignatureDialogProps) {
  const c = p.context;
  const busy = p.state === 'loadingContent' || p.state === 'challenging' || p.state === 'signing' || p.state === 'reconciling';
  const body = (() => {
    switch (p.state) {
      case 'loadingContent':
        return <p aria-busy="true">Loading what you are asked to sign…</p>;
      case 'reviewing':
      case 'awaitingTap':
      case 'challenging':
      case 'awaitingSecret':
      case 'signing':
        return (
          <>
            {c.content ? (
              <>
                <SignableContent view={c.content} />
                <details>
                  <summary>Show the exact text that is signed</summary>
                  <pre className={icls('canonical')}>{c.content.canonicalText}</pre>
                  <p className={icls('hash')}>{`SHA-256 ${c.content.contentHash} (checked on this terminal)`}</p>
                </details>
                <p className={icls('meaning')}>{`${c.content.meaning}: ${c.content.meaningText}`}</p>
              </>
            ) : null}
            {p.state === 'reviewing' ? (
              <div className={icls('row')}>
                <Button variant="primary" onPress={p.onSign}>
                  Sign
                </Button>
                <Button onPress={p.onCancel}>Cancel</Button>
              </div>
            ) : null}
            {p.state === 'awaitingTap' && p.tapStage !== 'pin' ? (
              <BadgePrompt
                key={`tap-${c.attempts}`}
                reason={`Tap your badge to sign as ${p.signerName}.`}
                refusal={c.attemptError}
                onTap={p.onTap}
                onCancel={p.onCancel}
                onTimeout={p.onTapTimeout}
                demoBadges={p.demoBadges ?? []}
              />
            ) : null}
            {p.state === 'awaitingTap' && p.tapStage === 'pin' && p.onTapPin ? <PinPad label="Enter your PIN to confirm the signing request" onSubmit={p.onTapPin} /> : null}
            {p.state === 'challenging' ? <p aria-busy="true">Preparing the signature…</p> : null}
            {(p.state === 'awaitingSecret' || p.state === 'signing') && c.challenge ? (
              <>
                <ManifestationPreview preview={c.challenge.manifestation} />
                {c.challenge.dsc ? (
                  // IN-10: the India DSC second signature; while the anchor is a test CA the banner says it is not legally valid.
                  <Banner tone={c.challenge.dsc.banner ? 'test' : 'info'} title={c.challenge.dsc.banner ?? 'Digital signature certificate needed'}>
                    <p data-testid="dsc-step">This signature also needs your Class 3 digital signature certificate: keep your token connected; it signs the same content when you confirm.</p>
                  </Banner>
                ) : null}
                <Countdown seconds={p.secondsLeft} />
                {c.attemptError ? <RefusalNotice envelope={c.attemptError} tone="warning" /> : null}
                {p.onPlatform ? (
                  <PlatformReauth onStart={p.onPlatform} disabled={p.state === 'signing'} note={p.platformNote ?? null} />
                ) : c.challenge.requires.includes('PIN') ? (
                  <PinPad label="Enter your PIN to sign" onSubmit={p.onPin} disabled={p.state === 'signing'} />
                ) : (
                  <PasswordForm onSubmit={p.onPassword} disabled={p.state === 'signing'} />
                )}
                {p.state === 'signing' ? <p aria-busy="true">Signing…</p> : <Button onPress={p.onCancel}>Cancel</Button>}
              </>
            ) : null}
          </>
        );
      case 'reconciling':
        return <p aria-busy="true">The answer was lost. Checking whether the signature was recorded…</p>;
      case 'done':
        return (
          <>
            <Banner tone="ok" title="Signed." />
            {c.manifestation ? <ManifestationCard manifestation={c.manifestation} /> : null}
            <Button variant="primary" onPress={p.onClose}>
              Close
            </Button>
          </>
        );
      case 'switchOffered':
        return (
          <>
            {c.refusal ? <RefusalNotice envelope={c.refusal} tone="warning" /> : null}
            {p.switchError ? <RefusalNotice envelope={p.switchError} /> : null}
            <p>{`Switch to ${c.refusal?.refusal.details?.['switchToLegalName'] ?? 'this person'}? Their own session opens on this terminal. Nothing is signed now: they start their own signing, with their own decision.`}</p>
            <PinPad label={`Enter the PIN of ${c.refusal?.refusal.details?.['switchToLegalName'] ?? 'the person who tapped'}`} onSubmit={p.onSwitchPin} />
            <Button onPress={p.onCancel}>Cancel</Button>
          </>
        );
      case 'expired':
      case 'changed':
        return (
          <>
            {c.refusal ? <RefusalNotice envelope={c.refusal} tone="warning" /> : null}
            <div className={icls('row')}>
              <Button variant="primary" onPress={p.onRestart}>
                {p.state === 'expired' ? 'Start again' : 'Review again'}
              </Button>
              <Button onPress={p.onClose}>Close</Button>
            </div>
          </>
        );
      case 'notConfirmed':
        return (
          <>
            <Banner tone="warning" title="The signature was not confirmed.">
              <p>The server did not answer, and no signature was found for this signing. Nothing is shown as signed. Reload the record and sign again if it is still needed.</p>
            </Banner>
            <Button variant="primary" onPress={p.onClose}>
              Close
            </Button>
          </>
        );
      case 'refused':
      case 'closed':
        return (
          <>
            {c.refusal ? <RefusalNotice envelope={c.refusal} /> : null}
            <Button variant="primary" onPress={p.onClose}>
              Close
            </Button>
          </>
        );
      case 'cancelled':
        return null;
    }
  })();
  return (
    <Dialog title={p.title} isOpen={p.state !== 'cancelled'} isDismissable={false}>
      <div className={icls('signature')} aria-busy={busy}>
        {body}
      </div>
    </Dialog>
  );
}
