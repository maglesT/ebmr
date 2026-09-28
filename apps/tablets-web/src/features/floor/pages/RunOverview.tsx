/**
 * Run overview and record (module C4; plan section 12, screen 13): stages and steps, the derived stage summary
 * and sign-off, exceptions, holds, timers (in the header), the timeline of every engine call (refusals
 * included), "Verify record" (the server replays the stored rows and reports identical or the first
 * difference) and the link to the run's audit trail.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { routes, type ActionView, type Result, type RouteResponse } from '@ebmr/api-contract';
import { Banner, Button, floor } from '@ebmr/ui-kit';
import { api } from '../../../api/client.ts';
import { useApiQuery } from '../../../api/hooks.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useRouteParams } from '../params.ts';
import { ExceptionList } from '../components/Exceptions.tsx';
import { RunHeader } from '../components/RunHeader.tsx';
import { HoldBatchDialog, RaiseExceptionDialog, ReleaseHoldDialog } from '../dialogs/CommandDialogs.tsx';
import { useRunView } from '../queries.ts';
import { actionLabel, st } from '../text.ts';

type Replay = Result<RouteResponse<typeof routes.execution.verifyReplay>>;

/** The audit trail viewer (C1) filtered on this run's chain. */
export function auditHref(chain: string): string {
  return `/audit?chain=${encodeURIComponent(chain)}`;
}

function ReplayResult({ replay }: { replay: Replay }) {
  if (!replay.ok) return <RefusalMessage error={replay.error} />;
  const r = replay.value;
  return (
    <div data-testid="replay-result">
      {r.identical ? (
        <Banner tone="ok" title={st('run.identical', { rows: r.rows })}>
          <p>{st('run.checked', { at: r.checkedAt.text })}</p>
        </Banner>
      ) : (
        <Banner tone="error" title={r.firstDifference ? st('run.different', { ...r.firstDifference }) : st('run.different', { seq: '?', field: '?', expected: '?', actual: '?' })}>
          <p>{st('run.checked', { at: r.checkedAt.text })}</p>
        </Banner>
      )}
      {r.invariantViolations.length > 0 ? <Banner tone="error" title={st('run.violations', { list: r.invariantViolations.join('; ') })} /> : null}
    </div>
  );
}

function Timeline({ runId }: { runId: string }) {
  const timeline = useApiQuery(routes.execution.timeline, { params: { runId } });
  if (!timeline.data) return timeline.error ? <RefusalMessage error={timeline.error.error} /> : null;
  return (
    <table className={wcls('table')} aria-label={st('run.timeline')}>
      <thead>
        <tr>
          <th scope="col">{st('timeline.seq')}</th>
          <th scope="col">{st('timeline.kind')}</th>
          <th scope="col">{st('timeline.at')}</th>
          <th scope="col">{st('timeline.who')}</th>
          <th scope="col">{st('timeline.what')}</th>
        </tr>
      </thead>
      <tbody>
        {timeline.data.entries.map((e) => (
          <tr key={e.seq}>
            <td>{e.seq}</td>
            <td>{e.kind}</td>
            <td>{e.at.text}</td>
            <td>{e.actor ? floor.personLine(e.actor) : 'System'}</td>
            <td>
              {e.summary}
              {e.accepted ? null : <strong> {st('timeline.refused', { why: e.refusal ?? '' })}</strong>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Open = { kind: 'HOLD_BATCH' } | { kind: 'RAISE_EXCEPTION' } | { kind: 'RELEASE_HOLD'; hold: string } | null;

export function RunOverviewPage() {
  const params = useRouteParams();
  const runId = params['runId'] ?? '';
  const run = useRunView(runId);
  const navigate = useNavigate();
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [open, setOpen] = useState<Open>(null);

  if (run.isPending) return <p>{st('loading')}</p>;
  if (!run.data) return run.error ? <RefusalMessage error={run.error.error} /> : null;
  const view = run.data;

  const verify = async () => {
    setReplaying(true);
    try {
      setReplay(await api.call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    } finally {
      setReplaying(false);
    }
  };
  const perform = (a: ActionView) => {
    if (a.action === 'HOLD_BATCH') setOpen({ kind: 'HOLD_BATCH' });
    else if (a.action === 'RAISE_EXCEPTION') setOpen({ kind: 'RAISE_EXCEPTION' });
    else if (a.action === 'RELEASE_HOLD' && a.target) setOpen({ kind: 'RELEASE_HOLD', hold: a.target });
  };
  const runActions = view.actions.filter((a) => a.action === 'HOLD_BATCH' || a.action === 'RAISE_EXCEPTION' || (a.action === 'RELEASE_HOLD' && a.target));
  const close = () => setOpen(null);

  return (
    <>
      <RunHeader run={view.header} connected={!(run.error && run.error.error.kind === 'NETWORK')} />
      <h1>{st('run.title', { batch: view.header.batchNumber })}</h1>
      <div className={wcls('row')}>
        <Button variant="primary" onPress={() => void verify()} isDisabled={replaying}>
          {st('run.verify')}
        </Button>
        <a href={auditHref(view.auditChain)} className={wcls('link')}>
          {st('run.audit')}
        </a>
        {runActions.map((a) => (
          <span key={`${a.action}-${a.target ?? ''}`}>
            <Button onPress={() => perform(a)} isDisabled={!a.available}>
              {actionLabel(a)}
            </Button>
            {!a.available && a.reason ? <span className={wcls('muted')}> {a.reason}</span> : null}
          </span>
        ))}
      </div>
      {replay ? <ReplayResult replay={replay} /> : null}

      <section className={wcls('section')}>
        <floor.StatusOutline stages={view.stages} onSelect={(stepKey) => void navigate({ to: '/runs/$runId/steps/$stepKey', params: { runId, stepKey } })} />
        {view.stages.map((s) =>
          s.summary || s.signOff ? (
            <div key={s.stageKey} className={wcls('section')} data-testid={`stage-${s.stageKey}`}>
              <h2 className={wcls('sectionTitle')}>{st('header.stage', { number: s.number, name: s.name })}</h2>
              {s.summary ? (
                <p>
                  <strong>{st(`run.stageSummary.${s.summary.statement}`)}</strong>
                  {s.summary.exceptions.length ? ` · ${st('dialog.signOff.exceptions', { list: s.summary.exceptions.join(', ') })}` : ''}
                  {s.summary.deviations.length ? ` · ${st('dialog.signOff.deviations', { list: s.summary.deviations.join(', ') })}` : ''}
                </p>
              ) : null}
              {s.signOff ? <floor.SignatureList label={st('signatures.title')} signatures={[s.signOff]} /> : null}
            </div>
          ) : null,
        )}
      </section>

      <ExceptionList exceptions={view.exceptions} actions={view.actions} />

      <section className={wcls('section')} aria-label={st('run.holds')}>
        <h2 className={wcls('sectionTitle')}>{st('run.holds')}</h2>
        {view.holds.length === 0 ? <p className={wcls('muted')}>{st('run.noHolds')}</p> : null}
        <ul className={wcls('entries')}>
          {view.holds.map((h) => (
            <li key={h.holdId} className={wcls('entry')}>
              <strong>{h.type === 'QA' ? st('dialog.hold.QA') : st('dialog.hold.SUPERVISOR')}</strong>: {h.reason} · {h.placedBy ? floor.personLine(h.placedBy) : 'System'} · {h.at.text}
              {h.released ? <div>{st('run.holdReleased', { name: floor.personLine(h.released.by), at: h.released.at.text, reason: h.released.reason })}</div> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className={wcls('section')}>
        <h2 className={wcls('sectionTitle')}>{st('run.timeline')}</h2>
        <Timeline runId={runId} />
      </section>
      <Link to="/runs" className={wcls('link')}>
        {st('runs.title')}
      </Link>

      <HoldBatchDialog isOpen={open?.kind === 'HOLD_BATCH'} onClose={close} runId={runId} expectedVersion={view.header.version} stepKey={null} />
      <RaiseExceptionDialog isOpen={open?.kind === 'RAISE_EXCEPTION'} onClose={close} runId={runId} expectedVersion={view.header.version} stepKey={null} />
      {open?.kind === 'RELEASE_HOLD' ? <ReleaseHoldDialog isOpen onClose={close} runId={runId} expectedVersion={view.header.version} stepKey={null} hold={open.hold} /> : null}
    </>
  );
}
