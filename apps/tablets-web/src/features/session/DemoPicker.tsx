/**
 * The demo device picker (/demo/devices; decision D6): exists only on demo databases with EBMR_DEMO=1. It
 * imports a seeded DEMO-ONLY terminal key into this browser as non-extractable.
 */
import { useEffect, useState } from 'react';
import { routes, type CallError, type DemoDeviceView } from '@ebmr/api-contract';
import { Banner, Button, StatusChip, t } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { cls } from '../../app/classes.ts';
import { useBoot } from '../../app/boot.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { generateDeviceKey, importDemoKey } from '../../device/keystore.ts';
import { terminalKeyOf } from '../../api/page-binding.ts';

export function DemoPicker() {
  const boot = useBoot();
  const [devices, setDevices] = useState<DemoDeviceView[] | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.call(routes.session.demoDevices).then((r) => {
      if (r.ok) setDevices(r.value.devices);
      else setError(r.error);
    });
  }, []);

  const choose = async (d: DemoDeviceView) => {
    setBusy(true);
    await importDemoKey(d.privateKeyPkcs8, d.publicKeySpki, d.deviceCode);
    if (window.location.pathname === '/demo/devices') window.history.replaceState(null, '', '/');
    boot.restart();
  };

  return (
    <div className={cls('center')}>
      <h1>{t('device.pickTitle')}</h1>
      <Banner tone="info" title={t('device.pickHelp')} />
      {error ? <RefusalMessage error={error} /> : null}
      {devices === null && !error ? <p>{t('app.loading')}</p> : null}
      <ul className={cls('deviceList')} aria-label="Demo terminals">
        {(devices ?? []).map((d) => (
          <li key={d.deviceCode} className={cls('deviceCard')}>
            <div className={cls('row')}>
              <strong>{d.deviceCode}</strong>
              <StatusChip tone={d.deviceClass === 'PERSONAL' ? 'info' : 'pending'} label={d.deviceClass === 'PERSONAL' ? 'Office PC' : `Kiosk, room ${d.roomCode ?? '?'}`} />
            </div>
            <p className={cls('muted')}>{d.description}</p>
            {d.personas.length ? <p className={cls('muted')}>Used by: {d.personas.map((p) => `${p.legalName} (${p.role})`).join(', ')}</p> : null}
            <Button variant="primary" isDisabled={busy} onPress={() => void choose(d)} aria-label={`${t('device.use')} ${d.deviceCode}`}>
              {t('device.use')}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The browser is not an enrolled terminal. It shows this browser's key fingerprint (the SHA-256 of its public key, as the
 * device register holds it), so the administrator can register it: on the device screens, or for the first terminal of a
 * platform installation with `ebmr first-terminal`. A browser without a key creates one here; the private key never
 * leaves the browser.
 */
export function NotEnrolled({ problem }: { problem: string | null }) {
  const boot = useBoot();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (boot.deviceKey) void terminalKeyOf(boot.deviceKey.publicKeySpki).then((fp) => live && setFingerprint(fp));
    return () => {
      live = false;
    };
  }, [boot.deviceKey]);
  const createKey = async () => {
    setBusy(true);
    setKeyError(null);
    try {
      // generateDeviceKey keeps the key in this browser (IndexedDB); the reload identifies with it.
      await generateDeviceKey('browser terminal');
      window.location.reload();
    } catch (error) {
      setKeyError(`This browser could not keep a terminal key (${error instanceof Error ? error.message : String(error)}). A private window cannot; open the site in a normal window.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cls('center')}>
      <Banner tone="warning" title={t('device.notEnrolled')}>
        <p>{problem ?? t('device.notEnrolledHelp')}</p>
      </Banner>
      {keyError ? <Banner tone="error" title={keyError} /> : null}
      {fingerprint ? (
        <p data-testid="terminal-fingerprint">
          This browser&apos;s key fingerprint: <code>{fingerprint}</code>
        </p>
      ) : null}
      {boot.deviceKey ? (
        <Button onPress={() => void boot.forgetTerminal()}>{t('device.forget')}</Button>
      ) : (
        <Button isDisabled={busy} onPress={() => void createKey()}>
          Create this browser&apos;s terminal key
        </Button>
      )}
    </div>
  );
}
