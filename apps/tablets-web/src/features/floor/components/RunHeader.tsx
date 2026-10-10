/**
 * The fixed run header of the floor screens (module C4): product, TEST- batch, market badges, batch status,
 * stage, room, equipment, timers with display countdowns, scale, connection, last saved and who is signed in.
 * Every time shown is the server's site-time text; countdowns come from server instants and the monotonic
 * display clock (app/clock.ts), never from the browser's wall clock.
 */
import { useEffect, useState } from 'react';
import type { RunHeaderView } from '@ebmr/api-contract';
import { StatusChip, floor } from '@ebmr/ui-kit';
import { secondsUntil } from '../../../app/clock.ts';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';

/** Re-renders every second (display countdowns only). */
function useSecondTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/** The browser's own view of the network (display only). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export function RunHeader({ run, connected }: { run: RunHeaderView; connected: boolean }) {
  const running = run.timers.some((t) => t.status === 'RUNNING' || t.status === 'WARNING');
  useSecondTick(running);
  const online = useOnline() && connected;
  return (
    <section className={wcls('runHeader')} aria-label={`Batch ${run.batchNumber}`} data-testid="run-header">
      <div className={wcls('headerRow')}>
        <span className={wcls('headerProduct')}>{run.product.name}</span>
        <span className={wcls('batch')} data-testid="batch-number">
          {run.batchNumber}
        </span>
        {run.markets.map((m) => (
          <StatusChip key={m} tone="neutral" label={m} />
        ))}
        <StatusChip tone={floor.stepTone(run.status)} label={run.statusText} />
        {run.watermark ? <StatusChip tone="test" label={run.watermark.text} /> : null}
      </div>
      <div className={wcls('headerRow')}>
        {run.stage ? <span className={wcls('headerItem')}>{st('header.stage', { number: run.stage.number, name: run.stage.name })}</span> : null}
        {run.room ? (
          <span className={wcls('headerItem')}>
            <span className={wcls('headerLabel')}>{st('header.room')}</span> {run.room}
          </span>
        ) : null}
        {run.equipment.length > 0 ? (
          <span className={wcls('headerItem')}>
            <span className={wcls('headerLabel')}>{st('header.equipment')}</span> {run.equipment.map((e) => `${e.code} ${e.name}`).join(', ')}
          </span>
        ) : null}
        {run.scale ? <StatusChip tone={run.scale.status === 'ONLINE' ? 'ok' : 'error'} label={st('reading.scale', { device: run.scale.deviceCode, status: run.scale.status })} /> : null}
      </div>
      {run.timers.length > 0 ? (
        <div className={wcls('headerRow')}>
          {run.timers.map((timer) => (
            <floor.TimerChip key={timer.constraint} timer={timer} secondsToMin={timer.minAt ? secondsUntil(timer.minAt.us) : null} secondsToMax={timer.maxAt ? secondsUntil(timer.maxAt.us) : null} />
          ))}
        </div>
      ) : null}
      <div className={wcls('headerRow')}>
        <StatusChip tone={online ? 'ok' : 'error'} label={online ? st('header.online') : st('header.offline')} />
        <span className={wcls('headerItem')}>
          <span className={wcls('headerLabel')}>{st('header.lastSaved')}</span> {run.lastSavedAt ? run.lastSavedAt.text : st('header.never')}
        </span>
        {run.identity ? (
          <span className={wcls('headerItem')} data-testid="run-identity">
            <span className={wcls('headerLabel')}>{st('header.you')}</span> {floor.personLine(run.identity)}
          </span>
        ) : null}
        <span className={wcls('muted')}>{st('header.mbr', { family: run.mbr.familyCode, version: run.mbr.versionNumber, revision: run.mbr.revision })}</span>
      </div>
    </section>
  );
}
