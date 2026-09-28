/**
 * ExceptionBanner (module C4): an exception in the step card as the server raised it: expected against actual,
 * what to do, whether it blocks, and who it is routed to (PR-08). Actions (link a deviation, disposition) come
 * as children from the screen, which takes them from the server's action list.
 */
import type { ExceptionView } from '@ebmr/api-contract';
import type { ReactNode } from 'react';
import { StatusChip } from '../primitives/StatusChip.tsx';
import { fcls } from './classes.ts';
import { enumText, roleTitle, severityTone } from './format.ts';
import { ft } from './messages.ts';

export interface ExceptionBannerProps {
  exception: ExceptionView;
  children?: ReactNode;
}

export function ExceptionBanner({ exception: e, children }: ExceptionBannerProps) {
  return (
    <section className={fcls('exception')} data-blocking={String(e.blocking && e.status === 'OPEN')} aria-label={e.title} data-testid={`exception-${e.exceptionId}`}>
      <div className={fcls('exceptionHead')}>
        <StatusChip tone={severityTone(e)} label={enumText('exception.severity', e.severity)} />
        <StatusChip tone={e.status === 'OPEN' ? 'warning' : 'ok'} label={enumText('exception.status', e.status)} />
        <h2 className={fcls('exceptionTitle')}>{e.title}</h2>
      </div>
      <dl className={fcls('facts')}>
        {e.expected !== null ? (
          <>
            <dt>{ft('exception.expected')}</dt>
            <dd>{e.expected}</dd>
          </>
        ) : null}
        {e.actual !== null ? (
          <>
            <dt>{ft('exception.actual')}</dt>
            <dd>{e.actual}</dd>
          </>
        ) : null}
        <dt>{ft('exception.whatToDo')}</dt>
        <dd>{e.whatToDo}</dd>
        <dt>{ft('exception.routedTo')}</dt>
        <dd>{e.routedTo.map(roleTitle).join(', ')}</dd>
      </dl>
      <p>
        <strong>{e.blocking ? ft('exception.blocking') : ft('exception.notBlocking')}</strong>
      </p>
      {e.deviationRef ? <p>{ft('exception.deviation', { ref: e.deviationRef })}</p> : null}
      <p className={fcls('muted')}>
        {e.raisedBy ? ft('exception.raisedBy', { name: e.raisedBy.legalName, at: e.raisedAt.text }) : ft('exception.raised', { at: e.raisedAt.text })}
        {e.controls.length > 0 ? ` · ${e.controls.join(', ')}` : ''}
      </p>
      {children}
    </section>
  );
}
