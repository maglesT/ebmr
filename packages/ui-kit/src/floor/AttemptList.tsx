/**
 * AttemptList (module C4): the values the record holds for one item, as the server returned them after commit:
 * the value with its unit, who entered it and when (server site time), how it was captured (typed, from a
 * device with its raw line, scanned, computed) and the server's limit verdict. Nothing here is computed in the
 * browser; before a value is committed it does not appear (DI-28).
 */
import type { DataValueWire, FieldView } from '@ebmr/api-contract';
import { StatusChip } from '../primitives/StatusChip.tsx';
import type { StateTone } from '../tokens/tokens.ts';
import { fcls } from './classes.ts';
import { enumText, personLine } from './format.ts';
import { ft } from './messages.ts';

export type AttemptData = FieldView['attempts'][number];

/** A stored value as text with its unit (the server's text; no arithmetic). */
export function valueText(v: DataValueWire | null, fallback: string): string {
  if (!v) return fallback;
  switch (v.kind) {
    case 'DECIMAL':
      return `${v.value} ${v.unit}`;
    case 'COUNT':
      return v.value;
    case 'BOOLEAN':
      return v.value ? ft('checklist.answer.YES') : ft('checklist.answer.NO');
    case 'CATEGORY':
    case 'TEXT':
      return v.value;
    case 'SERIES':
      return `${v.values.join(', ')} ${v.unit}`;
    case 'INSTANT':
      return fallback;
  }
}

function verdictTone(v: NonNullable<AttemptData['verdict']>): StateTone {
  if (v.failed) return 'error';
  switch (v.tier) {
    case null:
      return 'ok';
    case 'ALERT':
      return 'pending';
    case 'INTERNAL_ACTION':
      return 'warning';
    default:
      return 'error';
  }
}

function sourceText(a: AttemptData): string {
  if (a.source.mode === 'DEVICE') return `${ft('attempt.source.DEVICE', { device: a.source.deviceCode ?? '' })}${a.source.raw ? ` "${a.source.raw}"` : ''}`;
  if (a.source.mode === 'SCAN' && a.source.code) return `${ft('attempt.source.SCAN')} ${a.source.code}`;
  return enumText('attempt.source', a.source.mode);
}

export interface AttemptListProps {
  label: string;
  attempts: readonly AttemptData[];
}

export function AttemptList({ label, attempts }: AttemptListProps) {
  if (attempts.length === 0) return null;
  return (
    <ul className={fcls('attempts')} aria-label={label}>
      {attempts.map((a) => (
        <li key={`${a.pointId}-${a.attempt}-${a.version}`} className={fcls('attempt')} data-status={a.status} data-testid={`attempt-${a.pointId}`}>
          <span className={fcls('attemptValue')}>{a.shown ?? valueText(a.value, a.echo)}</span>
          {a.verdict ? <StatusChip tone={verdictTone(a.verdict)} label={ft('attempt.verdict', { text: a.verdict.text })} /> : null}
          {a.status !== 'VALID' ? <StatusChip tone="neutral" label={enumText('attempt.status', a.status)} /> : null}
          <div className={fcls('attemptMeta')}>
            {personLine(a.by)} · {a.at.text} · {sourceText(a)}
            {a.flags.length > 0 ? ` · ${a.flags.join(', ')}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}
