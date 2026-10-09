/**
 * LiveScaleGauge (module C5): the live weight of a scale as the site gateway displays it, labelled "live, not
 * recorded", with a stability indicator (colour + icon + word) and, when the step gives one, a tolerance band.
 * Display only: nothing shown here is recorded or sent; the captured reading and the engine decide.
 */
import { StatusChip } from '@ebmr/ui-kit';
import type { StateTone } from '@ebmr/ui-kit';
import styles from './devices.module.css';
import { gaugeGeometry, type Band } from './decimal.ts';
import { dt, type DevicesMessageKey } from './messages.ts';
import type { LiveSample } from './live.ts';

const c = (name: string): string => styles[name] ?? '';

const STATUS: Readonly<Record<LiveSample['status'], { tone: StateTone; key: DevicesMessageKey }>> = {
  OK: { tone: 'ok', key: 'gauge.stable' },
  UNSTABLE: { tone: 'pending', key: 'gauge.settling' },
  OVERLOAD: { tone: 'error', key: 'gauge.overload' },
  UNDERLOAD: { tone: 'error', key: 'gauge.underload' },
  OFFLINE: { tone: 'error', key: 'gauge.offline' },
  ERROR: { tone: 'error', key: 'gauge.error' },
};

export interface LiveScaleGaugeProps {
  deviceCode: string;
  sample: LiveSample | null;
  unit: string | null;
  band?: Band;
}

export function LiveScaleGauge({ deviceCode, sample, unit, band }: LiveScaleGaugeProps) {
  const status = sample ? STATUS[sample.status] : null;
  const shownUnit = sample?.unit ?? unit ?? '';
  const usableBand = band && band.unit === shownUnit ? band : undefined;
  const geo = gaugeGeometry(sample?.value ?? null, usableBand);
  const valueText = sample?.value ? `${sample.value} ${shownUnit}` : '—';
  return (
    <section className={c('gauge')} aria-label={dt('gauge.label', { device: deviceCode })} data-testid={`gauge-${deviceCode}`}>
      <div className={c('gaugeHead')}>
        <span>
          <strong>{deviceCode}</strong> <span className={c('notRecorded')}>{dt('gauge.notRecorded')}</span>
        </span>
        {status ? <StatusChip tone={status.tone} label={dt(status.key)} /> : <StatusChip tone="neutral" label={dt('gauge.waiting')} />}
      </div>
      <div className={c('value')} data-testid="live-value">
        {valueText}
      </div>
      {geo ? (
        <>
          <div className={c('bar')} aria-hidden="true">
            {geo.lowPct !== null && geo.highPct !== null ? <div className={c('range')} style={{ left: `${geo.lowPct}%`, width: `${geo.highPct - geo.lowPct}%` }} /> : null}
            {geo.targetPct !== null ? <div className={c('target')} style={{ left: `${geo.targetPct}%` }} /> : null}
            {geo.valuePct !== null ? <div className={c('marker')} style={{ left: `${geo.valuePct}%` }} /> : null}
          </div>
          <p className={c('bandText')}>
            {usableBand?.low !== undefined && usableBand.high !== undefined ? dt('gauge.band', { low: usableBand.low, high: usableBand.high, unit: usableBand.unit }) : null}
            {usableBand?.target !== undefined ? ` ${dt('gauge.target', { target: usableBand.target, unit: usableBand.unit })}` : null}
            {geo.position ? ` · ${dt(geo.position === 'IN' ? 'gauge.in' : geo.position === 'BELOW' ? 'gauge.below' : 'gauge.above')}` : null}
          </p>
        </>
      ) : null}
    </section>
  );
}
