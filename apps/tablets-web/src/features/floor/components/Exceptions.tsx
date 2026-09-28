/**
 * The exceptions of a step (module C4; PR-08): each with expected against actual, what to do, whether it
 * blocks and who it is routed to, and the actions the server offers on it (link a deviation for supervisors,
 * QA disposition), shown greyed with the server's reason when this person cannot take them.
 */
import type { ActionView, ExceptionView, StepScreenView } from '@ebmr/api-contract';
import { Button, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { actionLabel, st } from '../text.ts';

const ON_EXCEPTION = new Set<ActionView['action']>(['ATTACH_DEVIATION', 'DISPOSITION_EXCEPTION']);

export function ExceptionList({ exceptions, actions, perform, busy }: { exceptions: readonly ExceptionView[]; actions: readonly ActionView[]; perform?: (a: ActionView) => void; busy?: boolean }) {
  if (exceptions.length === 0) return null;
  return (
    <section className={wcls('section')} aria-label={st('exceptions.title')}>
      <h2 className={wcls('sectionTitle')}>{st('exceptions.title')}</h2>
      {exceptions.map((e) => {
        const mine = actions.filter((a) => ON_EXCEPTION.has(a.action) && (a.target === e.exceptionId || (a.target === null && exceptions.length === 1)));
        return (
          <floor.ExceptionBanner key={e.exceptionId} exception={e}>
            {perform && e.status === 'OPEN'
              ? mine.map((a) => (
                  <div key={`${a.action}-${a.target ?? ''}`} className={wcls('section')}>
                    <Button onPress={() => perform(a)} isDisabled={!a.available || (busy ?? false)}>
                      {actionLabel(a)}
                    </Button>
                    {!a.available && a.reason ? (
                      <p className={wcls('muted')} data-testid={`reason-${a.action}`}>
                        {floor.ft('action.notAvailable')}: {a.reason}
                      </p>
                    ) : null}
                  </div>
                ))
              : null}
          </floor.ExceptionBanner>
        );
      })}
    </section>
  );
}

export function StepExceptions({ view, perform, busy }: { view: StepScreenView; perform: (a: ActionView) => void; busy: boolean }) {
  return <ExceptionList exceptions={view.exceptions} actions={view.actions} perform={perform} busy={busy} />;
}
