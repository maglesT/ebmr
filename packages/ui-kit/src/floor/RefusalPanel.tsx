/**
 * RefusalPanel (module C4): a refusal in plain language (plan section 4): what happened, why (the engine's or
 * kernel's own message), the rule code and controls, what you can do, and who can help. The panel only shows
 * what the server said; it adds no judgement of its own.
 */
import type { Refusal } from '@ebmr/api-contract';
import { AlertTriangle, Ban } from 'lucide-react';
import { t } from '../i18n/index.ts';
import { fcls } from './classes.ts';
import { roleTitle } from './format.ts';
import { StaleMirrorNotice, staleMirrorOf } from './StaleMirror.tsx';
import { ft } from './messages.ts';

export interface RefusalPanelProps {
  refusal: Refusal;
  correlationId?: string;
}

const SERIOUS = new Set<Refusal['kind']>(['AUTH_FAILED', 'LOCKED', 'NOT_SAVED', 'INDEPENDENCE', 'BLOCKED_BY_EXCEPTION', 'CONTENT_CHANGED']);

export function RefusalPanel({ refusal, correlationId }: RefusalPanelProps) {
  const serious = SERIOUS.has(refusal.kind);
  const Icon = serious ? Ban : AlertTriangle;
  // Phase 6 slice 6a: a refusal over stale mirrored data says which mirror, how old and whom to call.
  const mirror = staleMirrorOf(refusal.code, refusal.why);
  return (
    <div className={fcls('refusal')} data-tone={serious ? 'error' : 'warning'} role="alert" data-testid="refusal" data-code={refusal.code}>
      <p className={fcls('refusalTitle')}>
        <Icon aria-hidden="true" size="1.3em" />
        <span>{refusal.whatHappened}</span>
      </p>
      {refusal.why ? (
        <p>
          <strong>{t('refusal.why')}:</strong> {refusal.why}
        </p>
      ) : null}
      {mirror ? <StaleMirrorNotice mirror={mirror} /> : null}
      {refusal.whatYouCanDo.length > 0 ? (
        <>
          <p className={fcls('sectionTitle')}>{t('refusal.whatYouCanDo')}</p>
          <ul className={fcls('refusalList')}>
            {refusal.whatYouCanDo.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
      {refusal.whoCanHelp.length > 0 ? (
        <>
          <p className={fcls('sectionTitle')}>{t('refusal.whoCanHelp')}</p>
          <ul className={fcls('refusalList')} data-testid="who-can-help">
            {refusal.whoCanHelp.map((w) => (
              <li key={w}>{roleTitle(w)}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className={fcls('refusalMeta')}>
        {ft('refusal.rule')}: {refusal.code}
        {refusal.controls.length > 0 ? ` · ${ft('refusal.controls')}: ${refusal.controls.join(', ')}` : ''}
        {correlationId ? ` · ${ft('refusal.reference')}: ${correlationId}` : ''}
      </p>
    </div>
  );
}
