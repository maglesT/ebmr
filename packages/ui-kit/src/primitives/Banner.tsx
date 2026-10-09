import type { ReactNode } from 'react';
import { AlertTriangle, Ban, CheckCircle2, FlaskConical, Info } from 'lucide-react';
import type { StateTone } from '../tokens/tokens.ts';
import { cls } from './classes.ts';

export interface BannerProps {
  tone: Extract<StateTone, 'ok' | 'warning' | 'error' | 'info' | 'test'>;
  title: string;
  children?: ReactNode;
  /** Assertive for blocking problems (e.g. NOT SAVED), polite otherwise. */
  live?: 'polite' | 'assertive';
}

const ICONS = { ok: CheckCircle2, warning: AlertTriangle, error: Ban, info: Info, test: FlaskConical } as const;

export function Banner({ tone, title, children, live }: BannerProps) {
  const Icon = ICONS[tone];
  return (
    <div
      className={cls('banner')}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={live ?? (tone === 'error' ? 'assertive' : 'polite')}
      data-tone={tone}
      style={{ color: `var(--ebmr-${tone}-fg)`, background: `var(--ebmr-${tone}-bg)`, borderColor: `var(--ebmr-${tone}-border)` }}
    >
      <Icon aria-hidden="true" size="1.4em" />
      <div>
        <p className={cls('bannerTitle')}>{title}</p>
        {children}
      </div>
    </div>
  );
}
