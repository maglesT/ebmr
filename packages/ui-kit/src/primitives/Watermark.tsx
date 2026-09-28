/**
 * The TEST, NOT GMP watermark (DI-05): an amber band at the top of every sandbox screen and a faint diagonal
 * mark over the page. The band text is read by screen readers; the overlay is decorative.
 */
import { t } from '../i18n/index.ts';
import { cls } from './classes.ts';

export interface WatermarkProps {
  /** The kernel's watermark text, e.g. "TEST, NOT GMP". */
  text: string;
  notice?: string;
}

export function WatermarkBand({ text, notice }: WatermarkProps) {
  return (
    <div className={cls('band')} role="note" aria-label={text} data-testid="watermark-band">
      {text}
      {notice ? <span style={{ fontWeight: 500, letterSpacing: 0 }}> · {notice}</span> : <span style={{ fontWeight: 500, letterSpacing: 0 }}> · {t('watermark.notice')}</span>}
    </div>
  );
}

export function WatermarkOverlay({ text }: WatermarkProps) {
  return (
    <div className={cls('overlayText')} aria-hidden="true" data-testid="watermark-overlay">
      <span>{text}</span>
    </div>
  );
}
