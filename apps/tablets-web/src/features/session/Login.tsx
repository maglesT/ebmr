/**
 * Sign-in (plan section 5): user ID and password on office PCs; badge (keyboard-wedge reader, or the demo
 * badge drawer) and PIN on the keypad at kiosks; the first-login secret change; the role choice.
 *
 * Secrets stay in uncontrolled inputs or refs, are cleared after sending, and never enter React state, caches
 * or storage. Every call carries a device proof. A password, PIN or badge field is a ui-kit Field of type
 * 'password', which renders a native uncontrolled SecretInput (never a react-aria TextField, whose state would
 * keep the typed secret and write it back into the field and its value attribute on the next render).
 * The first-login change keeps the identifier (a badge UID on kiosks) and the server's change ticket in a ref
 * until the change ends; React state holds only which kind of secret is changed. At the kiosk, the badge tapped waits
 * for its PIN in a KeptBadge held by a ref for at most KEEP_BADGE_MS: a person who walks away at the PIN step leaves
 * nothing behind, and the screen asks for a badge again.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { routes, type CallError, type DemoDeviceView, type LoginMethod } from '@ebmr/api-contract';
import { Banner, Button, Field, identity, t } from '@ebmr/ui-kit';
import { api, deviceProof } from '../../api/client.ts';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { installationLabel } from '../../app/installation.ts';
import { RefusalMessage } from '../../app/refusal.tsx';

/** What the screen shows during a first-login change (no secret). */
interface ChangeState {
  method: LoginMethod;
  kind: 'PASSWORD' | 'PIN';
}

/** Who changes a secret and the server's change ticket: kept in a ref, never in React state; wiped when the change ends. */
interface ChangeCredentials {
  identifier: string;
  ticket: string;
}

function useLogin() {
  const boot = useBoot();
  const [error, setError] = useState<CallError | null>(null);
  const [change, setChangeState] = useState<ChangeState | null>(null);
  const credentials = useRef<ChangeCredentials | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      credentials.current = null;
    },
    [],
  );

  /** Ends a first-login change (done or cancelled): the identifier and the ticket are wiped with it. */
  const endChange = () => {
    credentials.current = null;
    setChangeState(null);
  };

  const login = async (method: LoginMethod, identifier: string, secret: string) => {
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
        credentials.current = { identifier, ticket: details['changeTicket'] };
        setChangeState({ method, kind: details['kind'] === 'PIN' ? 'PIN' : 'PASSWORD' });
        return;
      }
      setError(r.error);
    } finally {
      setBusy(false);
    }
  };
  return { boot, error, setError, change, endChange, credentials, notice, setNotice, busy, login };
}

function ChangeSecretForm({ change, credentials, onDone }: { change: ChangeState; credentials: RefObject<ChangeCredentials | null>; onDone: (message: string | null) => void }) {
  const boot = useBoot();
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const kindWord = change.kind === 'PIN' ? 'PIN' : 'password';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const a = first.current?.value ?? '';
    const b = second.current?.value ?? '';
    if (first.current) first.current.value = '';
    if (second.current) second.current.value = '';
    if (a !== b) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    const held = credentials.current;
    if (!boot.deviceKey || !held || !a) return;
    const body = { method: change.method, identifier: held.identifier, changeTicket: held.ticket, newSecret: a, kind: change.kind };
    setError(null);
    const proof = await deviceProof(boot.deviceKey, 'POST', '/api/session/change-secret', body);
    if (!proof.ok) {
      setError(proof.error);
      return;
    }
    const r = await api.call(routes.session.changeSecret, { body: { ...body, proof: proof.proof } });
    if (r.ok) onDone(`Your new ${kindWord} is set. Sign in with it now.`);
    else setError(r.error);
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label={t('session.changeSecret', { kind: kindWord })}>
      <h2>{t('session.changeSecret', { kind: kindWord })}</h2>
      {error ? <RefusalMessage error={error} /> : null}
      {mismatch ? <Banner tone="warning" title={t('session.secretsDiffer')} /> : null}
      <Field label={t('session.newSecret', { kind: kindWord })} name="newSecret" type="password" inputRef={first} autoComplete="new-password" isRequired inputMode={change.kind === 'PIN' ? 'numeric' : 'text'} />
      <Field label={t('session.repeatSecret', { kind: kindWord })} name="repeatSecret" type="password" inputRef={second} autoComplete="new-password" isRequired inputMode={change.kind === 'PIN' ? 'numeric' : 'text'} />
      <div className={cls('row')}>
        <Button type="submit" variant="primary">
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

function PinPad({ onSubmit, disabled }: { onSubmit: (pin: string) => void; disabled: boolean }) {
  const pin = useRef('');
  const [length, setLength] = useState(0);
  const press = (d: string) => {
    if (pin.current.length >= 12) return;
    pin.current += d;
    setLength(pin.current.length);
  };
  const clear = () => {
    pin.current = '';
    setLength(0);
  };
  const ok = () => {
    const value = pin.current;
    clear();
    onSubmit(value);
  };
  return (
    <div role="group" aria-label={t('session.enterPin')}>
      <div className={cls('dots')} aria-live="polite" aria-label={`${length} digits entered`}>
        {'•'.repeat(length)}
      </div>
      <div className={cls('keypad')}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Button key={d} className={cls('key')} onPress={() => press(d)} isDisabled={disabled}>
            {d}
          </Button>
        ))}
        <Button className={cls('key')} onPress={clear} isDisabled={disabled} aria-label="Clear">
          C
        </Button>
        <Button className={cls('key')} onPress={() => press('0')} isDisabled={disabled}>
          0
        </Button>
        <Button className={cls('key')} variant="primary" onPress={ok} isDisabled={disabled || length === 0} aria-label="OK">
          OK
        </Button>
      </div>
    </div>
  );
}

export function KioskLogin() {
  const { boot, error, setError, change, endChange, credentials, notice, setNotice, busy, login } = useLogin();
  const badgeRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'badge' | 'pin'>('badge');
  const [who, setWho] = useState<string | null>(null);
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

  const tapped = (uid: string, name: string | null) => {
    badge().keep(uid);
    setWho(name);
    setError(null);
    setStep('pin');
  };

  const onBadge = (e: FormEvent) => {
    e.preventDefault();
    const uid = badgeRef.current?.value.trim() ?? '';
    if (badgeRef.current) badgeRef.current.value = '';
    if (uid) tapped(uid, null);
  };

  const onPin = (pin: string) => {
    const uid = badge().take();
    setStep('badge');
    // A badge wiped meanwhile (its time ran out) is never replaced by an empty identifier.
    if (uid) void login('BADGE_PIN', uid, pin);
  };

  return (
    <div className={cls('center')}>
      <h1>{t('session.signIn')}</h1>
      <p className={cls('muted')}>
        {installationLabel(boot.meta?.installation)} · {boot.device?.deviceCode} · room {boot.device?.roomCode ?? '?'}
      </p>
      {notice ? <Banner tone="ok" title={notice} /> : null}
      {error ? <RefusalMessage error={error} /> : null}
      {change ? (
        <ChangeSecretForm
          change={change}
          credentials={credentials}
          onDone={(m) => {
            endChange();
            setNotice(m);
          }}
        />
      ) : step === 'badge' ? (
        <form onSubmit={onBadge} aria-label={t('session.tapBadge')}>
          <Field label={t('session.badge')} name="badge" type="password" inputRef={badgeRef} autoComplete="off" autoFocus description={t('session.tapBadge')} />
          <Button type="submit" variant="primary" isDisabled={busy}>
            {t('common.continue')}
          </Button>
        </form>
      ) : (
        <>
          <p>{who ? `${who}: ${t('session.enterPin')}` : t('session.enterPin')}</p>
          <PinPad onSubmit={onPin} disabled={busy} />
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
      {demo && step === 'badge' && !change ? (
        <section className={cls('drawer')} aria-label="Demo badge reader">
          <h2>Demo badge reader (DEMO-ONLY)</h2>
          <div className={cls('row')}>
            {demo.personas
              .filter((p) => p.badgeUid)
              .map((p) => (
                <Button key={p.loginName} onPress={() => tapped(p.badgeUid ?? '', p.legalName)}>
                  Tap {p.legalName}
                </Button>
              ))}
          </div>
        </section>
      ) : null}
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
