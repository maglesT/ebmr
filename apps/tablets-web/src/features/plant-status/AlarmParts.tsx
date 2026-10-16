/** Shared parts of the alarm screens (DI-49): an alarm's reading against its limit, and its acknowledgment or the act. */
import type { PlantAlarmView } from '@ebmr/api-contract';
import { StatusChip } from '@ebmr/ui-kit';
import { AcknowledgeAlarm } from './AcknowledgeAlarm.tsx';
import { words } from './reads.ts';

/** The value against the limit, as the source sent them (decimal text with unit). */
export function reading(a: PlantAlarmView): string {
  const v = a.value ? `${a.value.value} ${a.value.unit}` : '';
  const l = a.limit ? `${words(a.limit.kind)} limit${a.limit.value !== null ? ` ${a.limit.value} ${a.limit.unit ?? ''}` : ''}` : '';
  return [v, l].filter((x) => x !== '').join(' against ');
}

export function Flags({ a }: { a: PlantAlarmView }) {
  return (
    <>
      {a.gmpCritical ? <StatusChip tone="error" label="GMP-critical" /> : null}
      {a.deviationRequired ? <StatusChip tone="warning" label="Deviation required" /> : null}
    </>
  );
}

/** The acknowledgment as recorded, or the act when there is none yet. */
export function Acknowledgement({ a }: { a: PlantAlarmView }) {
  const k = a.acknowledgement;
  if (!k) return <AcknowledgeAlarm alarm={a} />;
  return (
    <span data-testid={`ack-${a.alarmId}`}>
      {k.at.text}, {k.by.legalName}: {k.actionTaken}
      {k.comment ? `. Comment: ${k.comment}` : ''}
      {k.deviationRef ? `. Deviation ${k.deviationRef}` : ''}
    </span>
  );
}
