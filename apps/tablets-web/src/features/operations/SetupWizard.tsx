/**
 * The first-run set-up of a new installation (Phase 7 slice 7g-4; decision 0025 point 2; kernel 1375). Shown by the
 * shell instead of the sign-in while the installation has no administrator. The installation's kind (GMP or sandbox) was
 * fixed when it was provisioned and is shown, never chosen; the site's time zone in force is shown and confirmed (the
 * process owner changes it afterwards under a change record, D-P7g4-3). The person gives the set-up token the installer
 * printed, the site's code and name, the first system administrator and process owner (two persons) with their first
 * passwords (changed at their first sign-in), and asks the server to generate the e-signature seal key when it has a
 * place for one. This browser becomes the administrator's console: a new device key is made here and kept by the browser,
 * and only its public key is sent. The database decides everything (the token, the names, the two persons); a refusal
 * is shown in its words and nothing is created.
 */
import { useRef, useState } from 'react';
import { routes, type CallError, type SetupDoneView } from '@ebmr/api-contract';
import { Banner, Button, Field, StatusChip, takeSecret } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import { useBoot } from '../../app/boot.tsx';
import { cls } from '../../app/classes.ts';
import { installationLabel, isSandbox } from '../../app/installation.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { generateDeviceKey } from '../../device/keystore.ts';

const MIN_PASSWORD = 12;

interface PersonFields {
  legalName: string;
  loginName: string;
}

export function SetupWizard() {
  const boot = useBoot();
  const state = useApiQuery(routes.operations.setupState);
  const sandbox = isSandbox(boot.meta?.installation);
  const [site, setSite] = useState({ code: boot.meta?.site.code ?? '', name: '' });
  const [admin, setAdmin] = useState<PersonFields>({ legalName: '', loginName: '' });
  const [owner, setOwner] = useState<PersonFields>({ legalName: '', loginName: '' });
  const [seal, setSeal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [done, setDone] = useState<SetupDoneView | null>(null);
  const token = useRef<HTMLInputElement>(null);
  const adminPw = useRef<HTMLInputElement>(null);
  const adminPw2 = useRef<HTMLInputElement>(null);
  const ownerPw = useRef<HTMLInputElement>(null);
  const ownerPw2 = useRef<HTMLInputElement>(null);
  const s = state.data;

  if (done) {
    return (
      <div className={cls('center')} data-testid="setup-done">
        <h1>The installation is set up</h1>
        <Banner tone="ok" title={`Site ${done.siteCode}, time zone ${done.siteZone}.`}>
          <p>
            The system administrator {done.administratorLogin} and the process owner {done.processOwnerLogin} sign in with their first passwords on this browser (terminal{' '}
            {done.consoleDeviceCode}); each chooses a new password at the first sign-in.
          </p>
          <p>{done.sealKeyId ? `The e-signature seal key ${done.sealKeyId} was generated and registered.` : 'No seal key was generated: signatures are refused until one is configured.'}</p>
          <p>Next: the administrator registers the terminals and the people (requests their roles), and the process owner approves the role grants.</p>
        </Banner>
        <Button variant="primary" onPress={() => boot.restart()}>
          Go to the sign-in
        </Button>
      </div>
    );
  }

  const submit = async () => {
    setProblem(null);
    setError(null);
    const t = takeSecret(token);
    const a1 = takeSecret(adminPw);
    const a2 = takeSecret(adminPw2);
    const o1 = takeSecret(ownerPw);
    const o2 = takeSecret(ownerPw2);
    if (t.trim().length < 32) return setProblem('Give the set-up token the installer printed.');
    if (a1.length < MIN_PASSWORD || o1.length < MIN_PASSWORD) return setProblem(`Each first password has at least ${String(MIN_PASSWORD)} characters.`);
    if (a1 !== a2) return setProblem('The two entries of the administrator\'s first password differ.');
    if (o1 !== o2) return setProblem('The two entries of the process owner\'s first password differ.');
    if (!s) return setProblem('The set-up state could not be read.');
    setBusy(true);
    try {
      // This browser's new terminal key; only its public key leaves the browser.
      const key = await generateDeviceKey(`${sandbox ? 'TEST-' : ''}BOOTSTRAP-CONSOLE-1`);
      const r = await api.call(routes.operations.setup, {
        body: {
          token: t.trim(),
          site: { code: site.code.trim(), name: site.name.trim(), zone: s.siteZone },
          administrator: { legalName: admin.legalName.trim(), loginName: admin.loginName.trim(), password: a1 },
          processOwner: { legalName: owner.legalName.trim(), loginName: owner.loginName.trim(), password: o1 },
          consoleSpki: key.publicKeySpki,
          generateSealKey: s.sealKey === 'GENERATE' && seal,
        },
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone(r.value);
    } catch (e) {
      setProblem(`This browser could not make its terminal key: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const filled = site.code.trim() !== '' && site.name.trim() !== '' && admin.legalName.trim() !== '' && admin.loginName.trim() !== '' && owner.legalName.trim() !== '' && owner.loginName.trim() !== '';
  return (
    <div className={cls('center')} data-testid="setup-wizard">
      <h1>Set up this installation</h1>
      <p>
        This installation is new: nobody can sign in yet. Set up the site and its first two accounts. The installation is{' '}
        <StatusChip tone={sandbox ? 'test' : 'info'} label={installationLabel(boot.meta?.installation)} /> {s?.demo ? <StatusChip tone="warning" label="demo installation" /> : null}: its kind was
        fixed when it was installed.
      </p>
      {state.error ? <RefusalMessage error={state.error.error} /> : null}
      {s && !s.tokenIssued ? (
        <Banner tone="warning" title="No set-up token is open.">
          <p>The installer prints a one-time set-up token; it is valid for a limited time. Run the installer again to print a new one.</p>
        </Banner>
      ) : null}
      <fieldset>
        <legend>1. The set-up token</legend>
        <Field name="setup-token" label="Set-up token (printed by the installer)" type="password" inputRef={token} autoComplete="off" />
      </fieldset>
      <fieldset>
        <legend>2. The site</legend>
        <Field name="site-code" label="Site code" value={site.code} onChange={(v) => setSite({ ...site, code: v.toUpperCase() })} description="Letters, digits, hyphens; for example BLR-1." />
        <Field name="site-name" label="Site name" value={site.name} onChange={(v) => setSite({ ...site, name: v })} />
        <p data-testid="setup-zone">
          Time zone: <strong>{s?.siteZone ?? '…'}</strong>. Every recorded time is shown in it. The process owner changes it after the set-up under an approved change
          record, before the first GMP record.
        </p>
      </fieldset>
      {sandbox ? <Banner tone="test" title="In the sandbox every name is a test label: legal names start with TEST- and user IDs with test-." /> : null}
      <fieldset>
        <legend>3. The system administrator</legend>
        <p>Manages accounts, terminals and the server. Never creates or approves GMP data.</p>
        <Field name="admin-name" label="Administrator's legal name" value={admin.legalName} onChange={(v) => setAdmin({ ...admin, legalName: v })} />
        <Field name="admin-login" label="Administrator's user ID" value={admin.loginName} onChange={(v) => setAdmin({ ...admin, loginName: v })} />
        <Field name="admin-password" label="Administrator's first password" type="password" inputRef={adminPw} autoComplete="new-password" />
        <Field name="admin-password-2" label="Administrator's first password again" type="password" inputRef={adminPw2} autoComplete="new-password" />
      </fieldset>
      <fieldset>
        <legend>4. The process owner</legend>
        <p>Owns the GMP process: approves the role grants the administrator requests. A different person from the administrator.</p>
        <Field name="owner-name" label="Process owner's legal name" value={owner.legalName} onChange={(v) => setOwner({ ...owner, legalName: v })} />
        <Field name="owner-login" label="Process owner's user ID" value={owner.loginName} onChange={(v) => setOwner({ ...owner, loginName: v })} />
        <Field name="owner-password" label="Process owner's first password" type="password" inputRef={ownerPw} autoComplete="new-password" />
        <Field name="owner-password-2" label="Process owner's first password again" type="password" inputRef={ownerPw2} autoComplete="new-password" />
      </fieldset>
      <fieldset>
        <legend>5. The e-signature seal key</legend>
        {s?.sealKey === 'GENERATE' ? (
          <label>
            <input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} /> Generate the seal key now (kept by the server in its configured key file)
          </label>
        ) : s?.sealKey === 'PRESENT' ? (
          <p>The server already holds a seal key file.</p>
        ) : (
          <p>The server has no seal key path configured: signatures are refused until one is (a key-management service in production).</p>
        )}
      </fieldset>
      <p>This browser becomes the administrator&apos;s terminal (a new key is made and kept here).</p>
      {problem ? <Banner tone="error" title={problem} /> : null}
      {error ? <RefusalMessage error={error} /> : null}
      <Button variant="primary" onPress={() => void submit()} isDisabled={busy || !filled}>
        Set up the installation
      </Button>
    </div>
  );
}
