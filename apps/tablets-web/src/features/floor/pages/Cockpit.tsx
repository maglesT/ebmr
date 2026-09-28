/**
 * Operator cockpit, "What you can do now" (module C4; plan section 12, screen 14): the work queue of this
 * terminal's room from /api/work-queue. Each item shows the action the server offers; an item that is not
 * available now stays visible, greyed, with the server's reason (DI-34).
 */
import { Link } from '@tanstack/react-router';
import { routes } from '@ebmr/api-contract';
import { StatusChip, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useFloorSession } from '../session.tsx';
import { actionLabel, st } from '../text.ts';

export function CockpitPage() {
  const session = useFloorSession();
  const queue = useApiQuery(routes.execution.workQueue, {}, { refetchInterval: 15_000 });
  return (
    <>
      <h1>{st('cockpit.title')}</h1>
      {session.roomCode ? <p className={wcls('muted')}>{st('cockpit.room', { room: session.roomCode })}</p> : null}
      {queue.isPending ? <p>{st('loading')}</p> : null}
      {queue.error ? <RefusalMessage error={queue.error.error} /> : null}
      {queue.data && queue.data.items.length === 0 ? <p>{st('cockpit.empty')}</p> : null}
      <ul className={wcls('list')} aria-label={st('cockpit.title')}>
        {queue.data?.items.map((item) => (
          <li key={`${item.runId}:${item.stepKey}`} className={wcls('item')} data-available={String(item.action.available)} data-testid={`work-${item.stepKey}`}>
            <h2 className={wcls('itemTitle')}>
              <span>
                {item.number} {item.title}
              </span>
              <StatusChip tone={floor.stepTone(item.status)} label={item.statusText} />
            </h2>
            <p>
              <strong>{item.batchNumber}</strong> · {item.product.name} · {item.stage}
              {item.room ? ` · ${item.room}` : ''}
            </p>
            <p>
              <strong>{actionLabel(item.action)}</strong>
              {item.action.available ? null : (
                <span data-testid="work-reason">
                  {' '}
                  — {floor.ft('action.notAvailable')}: {item.action.reason ?? ''}
                </span>
              )}
            </p>
            <Link
              to="/runs/$runId/steps/$stepKey"
              params={{ runId: item.runId, stepKey: item.stepKey }}
              className={`${wcls('link')} ${item.action.available ? wcls('linkPrimary') : ''}`}
            >
              {item.action.available ? st('cockpit.open', { number: item.number }) : st('cockpit.view', { number: item.number })}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
