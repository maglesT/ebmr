/**
 * The real ScaleCaptureSlot (module C5), supplied to the step screen (C4) through app/ports.tsx: the live gauge of
 * the room's scale and one capture button for the slot's purpose (tare, gross or check).
 *
 * A capture is a trigger: the gateway takes a stable weight, journals and uploads it, and the server answers with
 * the ReadingView of the stored reading. The slot hands that reading (its id) to the step screen; the entry that
 * commits it claims the reading by id. The browser never sends a weight, a device or a time.
 * With the scale offline the slot says so and points to the manual path, which needs a second person. When several of
 * the slot's scales are online, each is offered and the person chooses the one they weigh on (nothing pre-selected).
 */
import { useState } from 'react';
import { routes, type ReadingView, type RefusalEnvelope } from '@ebmr/api-contract';
import { Banner, Button, floor } from '@ebmr/ui-kit';
import { api } from '../../api/client.ts';
import { useApiQuery } from '../../api/hooks.ts';
import type { ScaleCaptureSlotProps } from '../../app/ports.tsx';
import styles from './devices.module.css';
import { LiveScaleGauge } from './LiveScaleGauge.tsx';
import { useLiveReading } from './live.ts';
import { dt } from './messages.ts';

const c = (name: string): string => styles[name] ?? '';

export function RefusalText({ envelope }: { envelope: RefusalEnvelope }) {
  const r = envelope.refusal;
  return (
    <Banner tone={r.kind === 'NOT_ENABLED' ? 'warning' : 'error'} title={r.whatHappened}>
      {r.why ? <p>{r.why}</p> : null}
      {r.whatYouCanDo.length > 0 ? (
        <ul>
          {r.whatYouCanDo.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </Banner>
  );
}

/** Asks the server for a capture; resolves with the reading or the refusal. */
export async function requestCapture(deviceCode: string, purpose: 'TARE' | 'GROSS' | 'CHECK'): Promise<{ reading: ReadingView } | { refusal: RefusalEnvelope }> {
  const res = await api.call(routes.devices.capture, { params: { code: deviceCode }, body: { purpose } });
  if (res.ok) return { reading: res.value };
  if (res.error.kind === 'REFUSAL') return { refusal: res.error.envelope };
  return {
    refusal: {
      refusal: {
        code: res.error.kind,
        kind: 'NOT_SAVED',
        whatHappened: 'The scale could not be reached.',
        why: res.error.kind === 'NETWORK' || res.error.kind === 'PROTOCOL' ? res.error.message : '',
        controls: [],
        whatYouCanDo: ['Try again. If the scale stays unreachable, enter the weights by hand; a second person must then verify the step.'],
        whoCanHelp: [],
      },
      correlationId: 'client',
      retryable: true,
    },
  };
}

export function ScaleSlot({ deviceCodes, purpose, onCaptured, disabled, band }: ScaleCaptureSlotProps) {
  const scales = useApiQuery(routes.devices.scales, { query: {} }, { refetchInterval: 5000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const known = (scales.data?.scales ?? []).filter((s) => deviceCodes.includes(s.deviceCode));
  const onlineScales = known.filter((s) => s.status === 'ONLINE');
  // Several online scales: the person names the one they weigh on; one: that one; none: the first, shown offline.
  const choice = onlineScales.length > 1 ? (
    <floor.ChoiceGroup label={dt('slot.choose')} options={onlineScales.map((s) => ({ value: s.deviceCode, label: s.deviceCode }))} value={chosen} onChange={setChosen} isDisabled={disabled === true} />
  ) : null;
  const scale = onlineScales.length > 1 ? (onlineScales.find((s) => s.deviceCode === chosen) ?? null) : (onlineScales[0] ?? known[0] ?? null);
  const online = scale?.status === 'ONLINE';
  const live = useLiveReading(online && scale ? scale.deviceCode : null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RefusalEnvelope | null>(null);
  const [last, setLast] = useState<ReadingView | null>(null);

  if (scales.isPending) return <p className={c('bandText')}>{dt('slot.checking')}</p>;
  if (choice && !scale) return <div className={c('slot')}>{choice}</div>;
  if (!scale) {
    return (
      <Banner tone="info" title={dt('slot.noScale')}>
        <p>{dt('slot.noScaleWhy')}</p>
      </Banner>
    );
  }
  if (!online) {
    return (
      <Banner tone="warning" title={dt('slot.offline')}>
        <p>{dt('slot.offlineWhy', { device: scale.deviceCode })}</p>
      </Banner>
    );
  }

  const capture = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const out = await requestCapture(scale.deviceCode, purpose);
      if ('reading' in out) {
        setLast(out.reading);
        onCaptured(out.reading);
      } else {
        setRefusal(out.refusal);
        if (out.refusal.refusal.code === 'SCALE_OFFLINE') void scales.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={c('slot')}>
      {choice}
      <LiveScaleGauge deviceCode={scale.deviceCode} sample={live.sample} unit={scale.unit} {...(band ? { band } : {})} />
      <div className={c('actions')}>
        <Button variant="primary" onPress={() => void capture()} isDisabled={disabled === true || busy}>
          {busy ? dt('capture.busy') : dt(`capture.${purpose}`)}
        </Button>
        {last ? (
          <span role="status" aria-live="polite">
            {dt('capture.done', { value: last.value, unit: last.unit, device: last.deviceCode })}
          </span>
        ) : null}
      </div>
      {refusal ? <RefusalText envelope={refusal} /> : null}
    </div>
  );
}
