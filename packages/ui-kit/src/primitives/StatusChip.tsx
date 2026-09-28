/** A state shown as colour + icon + word, never colour alone (outline 7.4). */
import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, FlaskConical, Info, type LucideIcon } from 'lucide-react';
import type { StateTone } from '../tokens/tokens.ts';
import { cls } from './classes.ts';

const ICONS: Readonly<Record<StateTone, LucideIcon>> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  error: Ban,
  info: Info,
  neutral: CircleDashed,
  pending: Clock,
  test: FlaskConical,
};

export interface StatusChipProps {
  tone: StateTone;
  /** The word; always shown. */
  label: string;
}

export function StatusChip({ tone, label }: StatusChipProps) {
  const Icon = ICONS[tone];
  return (
    <span className={cls('chip')} data-tone={tone} style={{ color: `var(--ebmr-${tone}-fg)`, background: `var(--ebmr-${tone}-bg)`, borderColor: `var(--ebmr-${tone}-border)` }}>
      <Icon aria-hidden="true" size="1em" />
      <span>{label}</span>
    </span>
  );
}
