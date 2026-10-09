/**
 * /devices/scales (sandbox): the scales of the terminal's room with their live gauge, and a check weight whose
 * stored reading is shown in full: weight, scale, gateway, the raw line from the instrument, the scale's time with
 * its trust, and the server's recorded time (DI-32). A check weight stays in the scale log; no batch record uses it.
 */
import { useState } from 'react';
import { routes, type ReadingView, type RefusalEnvelope, type ScaleStatusView } from '@ebmr/api-contract';
import { Banner, Button, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import styles from './devices.module.css';
import { LiveScaleGauge } from './LiveScaleGauge.tsx';
import { useLiveReading } from './live.ts';
import { dt } from './messages.ts';
import { RefusalText, requestCapture } from './ScaleSlot.tsx';

const c = (name: string): string => styles[name] ?? '';

function ReadingFacts({ reading }: { reading: ReadingView }) {
  return (
    <dl className={c('facts')} data-testid="reading-facts">
      <dt>{dt('scales.value')}</dt>
      <dd>
        {reading.value} {reading.unit}
      </dd>
      <dt>{dt('scales.device')}</dt>
      <dd>{reading.deviceCode}</dd>
      <dt>{dt('scales.gateway')}</dt>
      <dd>{reading.gatewayCode}</dd>
      <dt>{dt('scales.raw')}</dt>
      <dd className={c('mono')} data-testid="reading-raw">
        {reading.raw}
      </dd>
      <dt>{reading.trust === 'DEVICE_SYNCED' ? dt('scales.sourceSynced') : dt('scales.source')}</dt>
      <dd>{reading.sourceTime?.text ?? '—'}</dd>
      <dt>{dt('scales.recorded')}</dt>
      <dd>{reading.recordedAt.text}</dd>
    </dl>
  );
}

function ScaleCard({ scale }: { scale: ScaleStatusView }) {
  const online = scale.status === 'ONLINE';
  const live = useLiveReading(online ? scale.deviceCode : null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<ReadingView | null>(null);
  const [refusal, setRefusal] = useState<RefusalEnvelope | null>(null);
  const check = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const out = await requestCapture(scale.deviceCode, 'CHECK');
      if ('reading' in out) setReading(out.reading);
      else setRefusal(out.refusal);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={c('slot')} aria-label={scale.deviceCode}>
      <div className={c('gaugeHead')}>
        <h2>{scale.deviceCode}</h2>
        <StatusChip tone={online ? 'ok' : scale.status === 'UNKNOWN' ? 'neutral' : 'error'} label={dt(`scales.status.${scale.status}`)} />
      </div>
      {online ? (
        <>
          <LiveScaleGauge deviceCode={scale.deviceCode} sample={live.sample} unit={scale.unit} />
          <div className={c('actions')}>
            <Button variant="primary" onPress={() => void check()} isDisabled={busy}>
              {busy ? dt('capture.busy') : dt('capture.CHECK')}
            </Button>
          </div>
        </>
      ) : (
        <Banner tone="warning" title={dt('slot.offline')}>
          <p>{dt('slot.offlineWhy', { device: scale.deviceCode })}</p>
        </Banner>
      )}
      {refusal ? <RefusalText envelope={refusal} /> : null}
      {reading ? (
        <>
          <h3>{dt('scales.last')}</h3>
          <ReadingFacts reading={reading} />
        </>
      ) : null}
    </section>
  );
}

export function ScalesPage() {
  const scales = useApiQuery(routes.devices.scales, { query: {} }, { refetchInterval: 5000 });
  return (
    <div className={c('page')}>
      <h1>{dt('scales.title')}</h1>
      <p>{dt('scales.intro')}</p>
      {scales.isPending ? <p>{dt('slot.checking')}</p> : null}
      {scales.data && scales.data.scales.length === 0 ? <p>{dt('scales.none')}</p> : null}
      {scales.data?.scales.map((s) => <ScaleCard key={s.deviceCode} scale={s} />)}
    </div>
  );
}
