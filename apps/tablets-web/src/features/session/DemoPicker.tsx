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
import { importDemoKey } from '../../device/keystore.ts';

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

export function NotEnrolled({ problem }: { problem: string | null }) {
  const boot = useBoot();
  return (
    <div className={cls('center')}>
      <Banner tone="warning" title={t('device.notEnrolled')}>
        <p>{problem ?? t('device.notEnrolledHelp')}</p>
      </Banner>
      {boot.deviceKey ? (
        <Button onPress={() => void boot.forgetTerminal()}>{t('device.forget')}</Button>
      ) : null}
    </div>
  );
}
