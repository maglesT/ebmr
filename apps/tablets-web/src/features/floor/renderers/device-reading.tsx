/**
 * The device-to-entry path on the step screen (Phase 4 slice 1b and 1c, D-P4-10): a SETPOINT_READBACK, ACTUAL or ALARM
 * entry taken from the equipment names one recent reading of the process device the step is bound to, and nothing
 * else. The reading's tag, value, unit and quality are shown as the server lists them (devices.processReadings) and the
 * server copies them into the entry from the stored reading; the browser never types them. A reading already used, or
 * outside the step's window, is listed but cannot be picked (the database refuses it anyway).
 */
import { routes, type BlockEntryFormView, type StepScreenView } from '@ebmr/api-contract';
import { Button, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';

/** The entry kinds that stand on a process reading when their source is EQUIPMENT. */
export const DEVICE_ENTRY_KINDS: readonly string[] = ['SETPOINT_READBACK', 'ACTUAL', 'ALARM'];

/** Whether a block entry form can take its value from the equipment (its schema names the source and the reading). */
export function isDeviceEntry(def: BlockEntryFormView): boolean {
  const source = def.schema.fields['source'];
  return DEVICE_ENTRY_KINDS.includes(def.kind) && source?.type === 'string' && (source.enum ?? []).includes('EQUIPMENT') && 'readingId' in def.schema.fields;
}

export function DeviceReadingPicker({ view, value, onChange, disabled }: { view: StepScreenView; value: string | null; onChange: (readingId: string) => void; disabled: boolean }) {
  const q = useApiQuery(routes.devices.processReadings, { query: { batchId: view.run.runId, stepKey: view.step.stepKey } }, { staleTime: 0 });
  const d = q.data;
  return (
    <div className={wcls('section')} data-testid="device-readings">
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {d && d.deviceCode === null ? <p>{st('device.noDevice')}</p> : null}
      {d && d.deviceCode !== null ? (
        <>
          <p className={wcls('muted')}>{st('device.readings', { device: d.deviceCode, seconds: d.windowSeconds })}</p>
          {d.readings.length === 0 ? <p>{st('device.none')}</p> : null}
          {d.readings.length > 0 ? (
            <floor.ChoiceGroup
              label={st('device.pick')}
              description={st('device.fromServer')}
              isDisabled={disabled}
              options={d.readings
                .filter((r) => !r.used && r.current)
                .map((r) => ({ value: r.readingId, label: st('device.reading', { tag: r.tag, value: r.value, unit: r.unit, kind: r.kind, quality: r.quality, at: r.receivedAt.text }) }))}
              value={value}
              onChange={onChange}
            />
          ) : null}
          <ul aria-label={st('device.pick')} className={wcls('muted')}>
            {d.readings
              .filter((r) => r.used || !r.current)
              .map((r) => (
                <li key={r.readingId}>
                  {st('device.reading', { tag: r.tag, value: r.value, unit: r.unit, kind: r.kind, quality: r.quality, at: r.receivedAt.text })}: {r.used ? st('device.used') : st('device.old')}
                </li>
              ))}
          </ul>
        </>
      ) : null}
      <Button onPress={() => void q.refetch()} isDisabled={disabled || q.isFetching}>
        {st('device.refresh')}
      </Button>
    </div>
  );
}
