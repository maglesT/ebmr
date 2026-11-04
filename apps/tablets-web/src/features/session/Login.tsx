/**
 * Sign-in (plan section 5): user ID and password on office PCs; badge (keyboard-wedge reader, or the demo
 * badge drawer) and PIN on the keypad at kiosks; the first-login secret change; the role choice. The kiosk uses the
 * ui-kit BadgePrompt and PinPad, the same tested components as unlock, switch and signing (review T1, F56): only a
 * reader's burst that can be a badge UID is taken, and the pad stops at PIN_MAX_LENGTH digits.
 *
 * Secrets stay in uncontrolled inputs or refs, are cleared after sending, and never enter React state, caches
 * or storage. Every call carries a device proof. A password, PIN or badge field is a ui-kit Field of type
 * 'password', which renders a native uncontrolled SecretInput (never a react-aria TextField, whose state would
 * keep the typed secret and write it back into the field and its value attribute on the next render).
 * The first-login change keeps the server's change ticket (and, at the office, the user ID) in a ref until the change
 * ends; React state holds only which kind of secret is changed and whose. At the kiosk, the badge tapped waits for its
 * PIN in a KeptBadge held by a ref for at most KEEP_BADGE_MS: a person who walks away at the PIN step leaves nothing
 * behind, and the screen asks for a badge again. The same holds for the kiosk's first-login change (review F04): the
 * badge UID is not kept for it, the change is wiped after KEEP_BADGE_MS without input, the form names the person
 * whose PIN it changes, and the new PIN is confirmed by tapping the badge again, so the next person at the kiosk cannot
 * choose the absent person's PIN (the kernel also refuses a change on a shared terminal past its attribution window).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react';
import { badgeUidOf, PIN_MAX_LENGTH, routes, type CallError, type DemoDeviceView, type LocalLoginMethod } from '@ebmr/api-contract';
import { Banner, brand, Button, Field, identity, t, takeSecret, wasFilled } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { EDITION } from '../../app/brand.tsx';
import { installationLabel } from '../../app/installation.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { sessionEndNotice, setSessionEndNotice } from '../../app/session-end-notice.ts';
import { startPlatformSignIn, takePendingLogin } from '../../app/platform-signon.ts';
import { demoBadgesOf } from './demo-badges.ts';

/** What the screen shows during a first-login change (no secret). */
interface ChangeState {
  method: LocalLoginMethod;
  kind: 'PASSWORD' | 'PIN';
  /** Whose secret is changed (the server names the person who proved the current secret). */
  legalName: string | null;
  /** Kiosk: the new PIN is confirmed by tapping the badge again (F04). */
  confirmTap: boolean;
}

/**
 * The server's change ticket and, at the office, the user ID: kept in a ref, never in React state; wiped when the
 * change ends. At the kiosk the identifier is the badge tapped to confirm the new PIN, never one kept from the sign-in.
 */
interface ChangeCredentials {
  identifier: string | null;
  ticket: string;
}

/** The kiosk change closed after KEEP_BADGE_MS without input (F04). */
const CHANGE_CLOSED: CallError = {
  kind: 'REFUSAL',
  status: 0,
  envelope: {
    refusal: {
      code: 'CHANGE_CLOSED',
      kind: 'STALE',
      whatHappened: 'The PIN change was closed because nothing was entered for a while. Nothing was changed.',
      why: 'The next person at this terminal must not find it open.',
      controls: ['DI-15', 'DI-38'],
      whatYouCanDo: ['Tap your badge and sign in again. If your initial PIN no longer works, ask for it to be reset.'],
      whoCanHelp: ['The system administrator (PIN resets)'],
    },
    correlationId: 'client',
    retryable: true,
  },
};

/** `changeIdleMs`: how long a first-login change waits for input before it is wiped (kiosk), or null (office). */
function useLogin(changeIdleMs: number | null = null) {
  const boot = useBoot();
  const [error, setError] = useState<CallError | null>(null);
  const [change, setChangeState] = useState<ChangeState | null>(null);
  const credentials = useRef<ChangeCredentials | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = idle;
    return () => {
      credentials.current = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const disarm = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
  };

  /** Ends a first-login change (done or cancelled): the identifier and the ticket are wiped with it. */
  const endChange = () => {
    disarm();
    credentials.current = null;
    setChangeState(null);
  };

  /** Restarts the change's idle limit (each input of the person); when it runs out the change is wiped (F04). */
  const touchChange = () => {
    if (changeIdleMs === null || !credentials.current) return;
    disarm();
    idle.current = setTimeout(() => {
      idle.current = null;
      credentials.current = null;
      setChangeState(null);
      setNotice(null);
      setError(CHANGE_CLOSED);
    }, changeIdleMs);
  };

  const login = async (method: LocalLoginMethod, identifier: string, secret: string) => {
    if (!boot.deviceKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = { method, identifier, secret };
      const proof = await deviceProof(boot.deviceKey, 'POST', '/api/session/login', body);
      // No device proof: nothing was sent, and the screen says so (F08: it used to say nothing at all).
      if (!proof.ok) {
        setError(proof.error);
        return;
      }
      const r = await api.call(routes.session.login, { body: { ...body, proof: proof.proof } });
      if (r.ok) {
        boot.setSession(r.value);
        return;
      }
      const details = r.error.kind === 'REFUSAL' ? r.error.envelope.refusal.details : undefined;
      if (r.error.kind === 'REFUSAL' && r.error.envelope.refusal.code === 'MUST_CHANGE_SECRET' && details?.['changeTicket']) {
        // A badge sign-in keeps no UID for the change: the badge is tapped again to confirm the new PIN (F04).
        const kiosk = method === 'BADGE_PIN';
        credentials.current = { identifier: kiosk ? null : identifier, ticket: details['changeTicket'] };
        setChangeState({ method, kind: details['kind'] === 'PIN' ? 'PIN' : 'PASSWORD', legalName: details['legalName'] ?? null, confirmTap: kiosk });
        touchChange();
        return;
      }
      setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  return { boot, error, setError, change, endChange, touchChange, credentials, notice, setNotice, busy, login };
}

interface ChangeSecretFormProps {
  change: ChangeState;
  credentials: RefObject<ChangeCredentials | null>;
  onDone: (message: string | null) => void;
  /** Each input of the person (the kiosk's idle limit restarts). */
  onActivity?: () => void;
  /** DEMO-ONLY badges of this terminal, for the confirming tap. */
  demoBadges?: readonly identity.DemoBadge[];
}

function ChangeSecretForm({ change, credentials, onDone, onActivity, demoBadges = [] }: ChangeSecretFormProps) {
  const boot = useBoot();
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  /** Kiosk: the new PIN waiting for the confirming tap (a ref only; wiped when sent, cancelled or unmounted). */
  const pending = useRef<string | null>(null);
  const [stage, setStage] = useState<'enter' | 'tap'>('enter');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [notAPin, setNotAPin] = useState(false);
  /** Kiosk: the new PIN reached a field otherwise than typed (filled in by a password manager, pasted): BADGE-AUTOFILL. */
  const [notTyped, setNotTyped] = useState(false);
  const kindWord = change.kind === 'PIN' ? 'PIN' : 'password';
  const pin = change.kind === 'PIN';
  useEffect(
    () => () => {
      pending.current = null;
    },
    [],
  );

  const send = async (identifier: string, newSecret: string) => {
    const held = credentials.current;
    if (!boot.deviceKey || !held || !identifier || !newSecret) {
      setStage('enter');
      return;
    }
    const body = { method: change.method, identifier, changeTicket: held.ticket, newSecret, kind: change.kind };
    setError(null);
    setSending(true);
    try {
      const proof = await deviceProof(boot.deviceKey, 'POST', '/api/session/change-secret', body);
      if (!proof.ok) {
        setError(proof.error);
        setStage('enter');
        return;
      }
      const r = await api.call(routes.session.changeSecret, { body: { ...body, proof: proof.proof } });
      if (r.ok) {
        onDone(`Your new ${kindWord} is set. Sign in with it now.`);
        return;
      }
      setError(r.error);
      setStage('enter');
    } finally {
      setSending(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // A kiosk PIN filled in by the browser or a password manager, or pasted, is one its owner may not know and the shared
    // browser may keep: nothing is sent (BADGE-AUTOFILL).
    const filled = pin && (wasFilled(first) || wasFilled(second));
    const a = takeSecret(first);
    const b = takeSecret(second);
    setNotTyped(filled);
    if (filled) {
      setMismatch(false);
      setNotAPin(false);
      return;
    }
    if (a !== b) {
      setMismatch(true);
      setNotAPin(false);
      return;
    }
    setMismatch(false);
    // A PIN is typed on pads that stop at PIN_MAX_LENGTH digits: a longer one, or one with other characters, could never
    // be entered there and is not sent (the kernel refuses it too: F05).
    if (pin && !new RegExp(`^[0-9]{1,${PIN_MAX_LENGTH}}$`).test(a)) {
      setNotAPin(true);
      return;
    }
    setNotAPin(false);
    if (!a) return;
    if (change.confirmTap) {
      // Kiosk: only the person whose badge it is completes the change (F04).
      pending.current = a;
      setError(null);
      setStage('tap');
      onActivity?.();
      return;
    }
    void send(credentials.current?.identifier ?? '', a);
  };

  const title = t('session.changeSecret', { kind: kindWord });
  const whose = change.legalName ? <p>{t('session.changeFor', { kind: kindWord, name: change.legalName })}</p> : null;
  if (stage === 'tap') {
    return (
      <section aria-label={title}>
        <h2>{title}</h2>
        {whose}
        {error ? <RefusalMessage error={error} /> : null}
        <identity.BadgePrompt
          reason={t('session.confirmNewPin')}
          demoBadges={demoBadges}
          busy={sending}
          timeoutSeconds={identity.KEEP_BADGE_MS / 1000}
          onTap={(uid) => {
            const secret = pending.current;
            pending.current = null;
            void send(uid, secret ?? '');
          }}
          onCancel={() => {
            pending.current = null;
            setStage('enter');
            onActivity?.();
          }}
          onTimeout={() => {
            pending.current = null;
            setStage('enter');
          }}
        />
      </section>
    );
  }

  return (
    <form onSubmit={submit} onInput={() => onActivity?.()} aria-label={title}>
      <h2>{title}</h2>
      {whose}
      {error ? <RefusalMessage error={error} /> : null}
      {mismatch ? <Banner tone="warning" title={t('session.secretsDiffer')} /> : null}
      {notAPin ? <Banner tone="warning" title={t('session.pinDigits', { max: String(PIN_MAX_LENGTH) })} /> : null}
      {notTyped ? <Banner tone="warning" title={t('session.pinTyped')} /> : null}
      <Field
        label={t('session.newSecret', { kind: kindWord })}
        name="newSecret"
        type="password"
        inputRef={first}
        autoComplete="new-password"
        noAutofill={pin}
        isRequired
        inputMode={pin ? 'numeric' : 'text'}
        {...(pin ? { maxLength: PIN_MAX_LENGTH, description: t('session.pinDigits', { max: String(PIN_MAX_LENGTH) }) } : {})}
      />
      <Field
        label={t('session.repeatSecret', { kind: kindWord })}
        name="repeatSecret"
        type="password"
        inputRef={second}
        autoComplete="new-password"
        noAutofill={pin}
        isRequired
        inputMode={pin ? 'numeric' : 'text'}
        {...(pin ? { maxLength: PIN_MAX_LENGTH } : {})}
      />
      <div className={cls('row')}>
        <Button type="submit" variant="primary" isDisabled={sending}>
          {t('common.continue')}
        </Button>
        <Button onPress={() => onDone(null)}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}

export function OfficeLogin() {
  const { boot, error, change, endChange, credentials, notice, setNotice, busy, login } = useLogin();
  const idRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const identifier = idRef.current?.value.trim() ?? '';
    const secret = pwRef.current?.value ?? '';
    if (pwRef.current) pwRef.current.value = '';
    // An empty field is never sent (after a refusal the password field is empty: pressing again sends nothing).
    if (!identifier || !secret) return;
    void login('PASSWORD', identifier, secret);
  };

  return (
    <div className={cls('center')}>
      <brand.SignInBrand edition={EDITION} />
      <h1>{t('session.signIn')}</h1>
      <p className={cls('muted')}>
        {installationLabel(boot.meta?.installation)} · {boot.device?.deviceCode}
      </p>
      {notice ? <Banner tone="ok" title={notice} /> : null}
      {change ? (
        <ChangeSecretForm
          change={change}
          credentials={credentials}
          onDone={(m) => {
            endChange();
            setNotice(m);
          }}
        />
      ) : (
        <form onSubmit={submit} aria-label={t('session.signIn')}>
          {error ? <RefusalMessage error={error} /> : null}
          <Field label={t('session.userId')} name="userId" inputRef={idRef} autoComplete="username" isRequired autoFocus />
          <Field label={t('session.password')} name="password" type="password" inputRef={pwRef} autoComplete="off" isRequired />
          <Button type="submit" variant="primary" isDisabled={busy}>
            {t('session.signIn')}
          </Button>
        </form>
      )}
    </div>
  );
}

/** Why a sign-on through the platform came back without a proof (the server's reason codes; features/session/platform.ts). */
const SIGNON_ERRORS: Readonly<Record<string, string>> = {
  CORE_UNREACHABLE: 'The platform could not be reached. Try again in a moment.',
  CORE_REFUSED: 'The platform did not sign you in.',
  STATE_UNKNOWN: 'The sign-in took too long or was started elsewhere. Sign in again.',
  TOKEN_INVALID: 'The platform\'s answer could not be verified. Nothing was done.',
};

/**
 * Phase B slice 2, the platform build: sign-in through the platform's core. The button sends the page to core; back here,
 * the proof /cb handed the page (platform-signon.ts) is posted once with the device proof.
 */
export function PlatformLogin() {
  const boot = useBoot();
  // The sign-on that just came back from core, taken once (a proof is used once).
  const [back] = useState(() => takePendingLogin());
  const note = back && !back.proof ? (SIGNON_ERRORS[back.error ?? ''] ?? 'The sign-in through the platform did not complete.') : null;
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(back?.proof != null);
  const started = useRef(false);
  useEffect(() => {
    const proofText = back?.proof;
    if (started.current || !proofText || !boot.deviceKey) return;
    started.current = true;
    const key = boot.deviceKey;
    void (async () => {
      try {
        const body = { method: 'PLATFORM' as const, signonProof: proofText };
        const proof = await deviceProof(key, 'POST', '/api/session/login', body);
        if (!proof.ok) {
          setError(proof.error);
          return;
        }
        const r = await api.call(routes.session.login, { body: { ...body, proof: proof.proof } });
        if (r.ok) boot.setSession(r.value);
        else setError(r.error);
      } finally {
        setBusy(false);
      }
    })();
  }, [back, boot]);
  return (
    <div className={cls('center')}>
      <brand.SignInBrand edition={EDITION} />
      <h1>{t('session.signIn')}</h1>
      <p className={cls('muted')}>
        {installationLabel(boot.meta?.installation)} · {boot.device?.deviceCode}
      </p>
      {note ? <Banner tone="warning" title={note} /> : null}
      {error ? <RefusalMessage error={error} /> : null}
      <Button variant="primary" isDisabled={busy} onPress={startPlatformSignIn}>
        Sign in through the platform
      </Button>
    </div>
  );
}

export function KioskLogin() {
  const { boot, error, setError, change, endChange, touchChange, credentials, notice, setNotice, busy, login } = useLogin(identity.KEEP_BADGE_MS);
  const [step, setStep] = useState<'badge' | 'pin'>('badge');
  const [who, setWho] = useState<string | null>(null);
  // R3.11: why the previous session of this kiosk ended, when the server said so (its person signed in elsewhere); shown
  // until someone signs in here (the screen then goes).
  const [ended] = useState(() => sessionEndNotice());
  useEffect(() => () => setSessionEndNotice(null), []);
  const [demo, setDemo] = useState<DemoDeviceView | null>(null);
  // The badge waits for its PIN (at most KEEP_BADGE_MS); when it is wiped, the screen goes back to the badge step.
  const onKept = useCallback((kept: boolean) => {
    if (kept) return;
    setStep('badge');
    setWho(null);
  }, []);
  const badge = identity.useKeptBadge(onKept);
  useEffect(() => () => badge().clear(), [badge]);

  useEffect(() => {
    if (!boot.meta?.demo) return;
    void api.call(routes.session.demoDevices).then((r) => {
      if (r.ok) setDemo(r.value.devices.find((d) => d.deviceCode === boot.device?.deviceCode) ?? null);
    });
  }, [boot.meta?.demo, boot.device?.deviceCode]);
  const demoBadges = useMemo(() => demoBadgesOf(demo), [demo]);

  // The ui-kit BadgePrompt hands over a badge UID only (a reader's burst, or a demo badge): text that cannot be a badge
  // never reaches the sign-in (review F56, T1).
  const tapped = (uid: string) => {
    badge().keep(uid);
    setWho(demoBadges.find((b) => badgeUidOf(b.badgeUid) === uid)?.legalName ?? null);
    setError(null);
    setNotice(null);
    setStep('pin');
  };

  const onPin = (pin: string) => {
    const uid = badge().take();
    setStep('badge');
    // A badge wiped meanwhile (its time ran out) is never replaced by an empty identifier.
    if (uid) void login('BADGE_PIN', uid, pin);
  };

  return (
    <div className={cls('center')}>
      <brand.SignInBrand edition={EDITION} />
      <h1>{t('session.signIn')}</h1>
      <p className={cls('muted')}>
        {installationLabel(boot.meta?.installation)} · {boot.device?.deviceCode} · room {boot.device?.roomCode ?? '?'}
      </p>
      {ended ? (
        <div data-testid="session-end-notice">
          <Banner tone="info" title={ended} />
        </div>
      ) : null}
      {notice ? <Banner tone="ok" title={notice} /> : null}
      {error ? <RefusalMessage error={error} /> : null}
      {change ? (
        <ChangeSecretForm
          change={change}
          credentials={credentials}
          onActivity={touchChange}
          demoBadges={demoBadges}
          onDone={(m) => {
            endChange();
            setNotice(m);
          }}
        />
      ) : step === 'badge' ? (
        <identity.BadgePrompt reason={t('session.tapToSignIn')} timeoutSeconds={null} busy={busy} demoBadges={demoBadges} onTap={tapped} />
      ) : (
        <>
          <p>{who ? `${who}: ${t('session.enterPin')}` : t('session.enterPin')}</p>
          <identity.PinPad label={t('session.enterPin')} onSubmit={onPin} disabled={busy} />
          <Button
            onPress={() => {
              badge().clear();
              setStep('badge');
            }}
          >
            {t('common.cancel')}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The role choice of a session that holds several roles (C0-4). A session whose account holds no role that is valid
 * now (a grant still waiting for approval, expired or revoked) is told so and who handles role grants, and is offered
 * only to sign out (F10: it used to see the heading and nothing else). The server refuses such a sign-in (NO_ROLE) and
 * ends such a session at its next request (F36); this screen covers a session whose last grant ended meanwhile.
 */
export function RoleChoice() {
  const boot = useBoot();
  const [error, setError] = useState<CallError | null>(null);
  const roles = boot.session?.roles ?? [];
  const choose = async (roleCode: string) => {
    const r = await api.call(routes.session.chooseRole, { body: { roleCode } });
    if (r.ok) boot.setSession(r.value);
    else setError(r.error);
  };
  return (
    <div className={cls('center')}>
      <h1>{t('session.chooseRole')}</h1>
      {error ? <RefusalMessage error={error} /> : null}
      {roles.length === 0 ? (
        <>
          <Banner tone="warning" title={t('session.noRole')}>
            <p>
              <strong>{t('refusal.why')}:</strong> {t('session.noRoleWhy')}
            </p>
            <p>
              <strong>{t('refusal.whoCanHelp')}:</strong> {t('session.noRoleWho')}
            </p>
          </Banner>
          <Button variant="primary" onPress={() => void boot.signOut()}>
            {t('session.signOut')}
          </Button>
        </>
      ) : (
        <div className={cls('row')}>
          {roles.map((role) => (
            <Button key={role} variant="primary" onPress={() => void choose(role)}>
              {role}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
