/**
 * Run overview and record (module C4; plan section 12, screen 13): stages and steps, the derived stage summary
 * and sign-off, exceptions, holds, timers (in the header), the timeline of every engine call (refusals
 * included), "Verify record" (the server replays the stored rows and reports identical or the first
 * difference) and the link to the run's audit trail. An exception raised at no step has no step screen: the actions the
 * server offers on it (link a deviation, QA's disposition through the signature ceremony) are taken here (T3).
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
import { BatchLinks } from '../components/BatchLinks.tsx';
import { ExceptionList } from '../components/Exceptions.tsx';
import { RunHeader } from '../components/RunHeader.tsx';
import { SignedResult } from '../components/SignedResult.tsx';
import { MergeContainers } from '../components/StepFloorActs.tsx';
import { HoldBatchDialog, LinkDeviationDialog, RaiseExceptionDialog, ReleaseHoldDialog } from '../dialogs/CommandDialogs.tsx';
import { DispositionDialog } from '../dialogs/SignDialogs.tsx';
import { isGmpFloor } from '../family.ts';
import { useFloorRead, useRunView } from '../queries.ts';
import { useLeaveGuard } from '../unsettled.ts';
import { useSignedAction } from '../useSignedAction.ts';
import { actionLabel, st } from '../text.ts';
import { useScreensOff } from '../../../app/disconnected.tsx';
import { Section } from '../../../app/acts.tsx';
import { DefineForm } from '../../../app/define-form.tsx';
import { useOffered } from '../../../app/roles.ts';

type Replay = Result<RouteResponse<typeof routes.execution.verifyReplay>>;
type RunResultExport = Result<RouteResponse<typeof routes.execution.exportRunResult>>;

/**
 * Slice 7h (decision D-P7R-16): the test-run result written for GMP (write-once in to-gmp, named by its hash), with its
 * file offered for download when the GMP host does not share the exchange folder.
 */
function RunResultExported({ exported }: { exported: RunResultExport }) {
  if (!exported.ok) return <RefusalMessage error={exported.error} />;
  const r = exported.value;
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(r.fileText)}`;
  return (
    <div data-testid="run-result-export" data-passed={r.passed ? 'yes' : 'no'}>
      <Banner tone={r.passed ? 'ok' : 'warning'} title={st(r.passed ? 'run.exportPassed' : 'run.exportFailed', { file: r.fileName })}>
        <p>
          <a href={href} download={r.fileName} className={wcls('link')}>
            {st('run.exportDownload')}
          </a>
        </p>
      </Banner>
    </div>
  );
}

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

/**
 * "What you can do now" in this GMP batch for this terminal's room (batches.workQueue; slice 7g-5): each step with the
 * action the server offers, greyed with its reason when not available now (DI-34), as on the cockpit.
 */
/**
 * R2 (hosted-demo trials): a packaging order's line completion (coding and label specimens, line stops, the post-use
 * inspection) and its serial pools, from the order's own overview on the floor. Shown only for a batch with packaging
 * steps (the server's packaging view lists them).
 */
function PackagingLinks({ batchId }: { batchId: string }) {
  const off = useScreensOff();
  const q = useApiQuery(routes.labels.packaging, { params: { batchId } }, { retry: false });
  if (!q.data || q.data.steps.length === 0) return null;
  return (
    <section className={wcls('section')} aria-label="Packaging line" data-testid="packaging-links">
      <h2 className={wcls('sectionTitle')}>Packaging line</h2>
      <p>
        <Link to="/labels/packaging/$batchId" params={{ batchId }} className={wcls('link')}>
          Line completion (coding, labels, post-use inspection)
        </Link>
        {off('/serialisation') ? null : (
          <>
            {' '}
            ·{' '}
            <Link to="/serialisation/batches/$batchId" params={{ batchId }} className={wcls('link')}>
              Serial pools
            </Link>
          </>
        )}
      </p>
    </section>
  );
}

/**
 * The intermediate lot of a complete processing batch of the API edition, posted in quarantine by the stores (API plan
 * A2, C1; IN-05 (a), PR-45): the server says whether the batch posts one (header.postsIntermediateLot), the database
 * checks it again. The quantity is the person's; once posted the lot is given back by its code with a link to it, and the
 * post is not offered again on this screen (the database allows one intermediate lot per batch).
 */
function IntermediateLot({ batchId }: { batchId: string }) {
  const stores = useOffered('STORES');
  const [answer, setAnswer] = useState<{ lotId: string; lotCode: string } | null>(null);
  if (answer) {
    return (
      <Section title="Intermediate lot" testId="intermediate-lot">
        <p data-testid="intermediate-lot-posted">
          Intermediate lot{' '}
          <Link to="/quality/lots/$lotId" params={{ lotId: answer.lotId }}>
            {answer.lotCode}
          </Link>{' '}
          posted in quarantine
        </p>
      </Section>
    );
  }
  if (!stores) return null;
  return (
    <Section title="Intermediate lot" testId="intermediate-lot">
      <DefineForm
        title="Post the intermediate lot"
        route={routes.specifications.postIntermediateLot}
        fixed={{ batchId }}
        refresh={[routes.quality.lots.id, routes.batches.batch.id]}
        submitLabel="Post the intermediate lot in quarantine"
        onDone={(r) => setAnswer({ lotId: r.lotId, lotCode: r.lotCode })}
        fields={[
          { name: 'quantity', label: 'Intermediate quantity', kind: 'decimal' },
          { name: 'unit', label: 'Unit', kind: 'text', description: 'e.g. kg' },
        ]}
      />
    </Section>
  );
}

function BatchWorkQueue({ batchId }: { batchId: string }) {
  const queue = useApiQuery(routes.batches.workQueue, { params: { batchId } }, { refetchInterval: 15_000 });
  return (
    <section className={wcls('section')} aria-label={st('run.queue')} data-testid="batch-work-queue">
      <h2 className={wcls('sectionTitle')}>{st('run.queue')}</h2>
      {queue.error ? <RefusalMessage error={queue.error.error} /> : null}
      {queue.data && queue.data.items.length === 0 ? <p className={wcls('muted')}>{st('run.queueEmpty')}</p> : null}
      <ul className={wcls('list')}>
        {queue.data?.items.map((item) => (
          <li key={item.stepKey} className={wcls('item')} data-available={String(item.action.available)} data-testid={`batch-work-${item.stepKey}`}>
            <Link to="/runs/$runId/steps/$stepKey" params={{ runId: batchId, stepKey: item.stepKey }} className={`${wcls('link')} ${item.action.available ? wcls('linkPrimary') : ''}`}>
              {item.number} {item.title}
            </Link>{' '}
            · {item.stage} · <strong>{actionLabel(item.action)}</strong>
            {item.action.available ? null : <span className={wcls('muted')}> — {floor.ft('action.notAvailable')}: {item.action.reason ?? ''}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Timeline({ runId }: { runId: string }) {
  const timeline = useFloorRead(routes.execution.timeline, { params: { runId } });
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
            <td>{e.actor ? floor.personLine(e.actor) : st('timeline.system')}</td>
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

type Open =
  | { kind: 'HOLD_BATCH' }
  | { kind: 'RAISE_EXCEPTION' }
  | { kind: 'RELEASE_HOLD'; hold: string }
  | { kind: 'ATTACH_DEVIATION'; exception: string }
  | { kind: 'DISPOSITION_EXCEPTION'; action: ActionView }
  | null;

export function RunOverviewPage() {
  const params = useRouteParams();
  const runId = params['runId'] ?? '';
  const run = useRunView(runId);
  const navigate = useNavigate();
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [exported, setExported] = useState<RunResultExport | null>(null);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const held = useLeaveGuard();
  const signed = useSignedAction(runId);

  if (run.isPending) return <p>{st('loading')}</p>;
  if (!run.data) return run.error ? <RefusalMessage error={run.error.error} /> : null;
  const view = run.data;

  const verify = async () => {
    setReplaying(true);
    try {
      // The replay check of this installation's family (D-S6-1): /api/batches/:batchId/verify-replay on GMP.
      setReplay(isGmpFloor() ? await api.call(routes.batches.verifyReplay, { params: { batchId: runId }, body: {} }) : await api.call(routes.execution.verifyReplay, { params: { runId }, body: {} }));
    } finally {
      setReplaying(false);
    }
  };
  const exportResult = async () => {
    setExporting(true);
    try {
      setExported(await api.call(routes.execution.exportRunResult, { params: { runId }, body: {} }));
    } finally {
      setExporting(false);
    }
  };
  const perform = (a: ActionView) => {
    if (a.action === 'HOLD_BATCH') setOpen({ kind: 'HOLD_BATCH' });
    else if (a.action === 'RAISE_EXCEPTION') setOpen({ kind: 'RAISE_EXCEPTION' });
    else if (a.action === 'RELEASE_HOLD' && a.target) setOpen({ kind: 'RELEASE_HOLD', hold: a.target });
    else if (a.action === 'ATTACH_DEVIATION' && a.target) setOpen({ kind: 'ATTACH_DEVIATION', exception: a.target });
    else if (a.action === 'DISPOSITION_EXCEPTION' && a.target) setOpen({ kind: 'DISPOSITION_EXCEPTION', action: a });
  };
  const exceptionNamed = (id: string) => view.exceptions.find((e) => e.exceptionId === id) ?? { exceptionId: id, title: id };
  const runActions = view.actions.filter((a) => a.action === 'HOLD_BATCH' || a.action === 'RAISE_EXCEPTION' || (a.action === 'RELEASE_HOLD' && a.target));
  const close = () => setOpen(null);

  return (
    <>
      <RunHeader run={view.header} connected={!(run.error && run.error.error.kind === 'NETWORK')} />
      <h1>{st('run.title', { batch: view.header.batchNumber })}</h1>
      {held ? <Banner tone="warning" title={st('leave.held')} /> : null}
      <div className={wcls('row')}>
        <Button variant="primary" onPress={() => void verify()} isDisabled={replaying}>
          {st('run.verify')}
        </Button>
        {isGmpFloor() ? null : (
          <Button onPress={() => void exportResult()} isDisabled={exporting}>
            {st('run.exportResult')}
          </Button>
        )}
        <a href={auditHref(view.auditChain)} className={wcls('link')}>
          {st('run.audit')}
        </a>
        {/* R10 #13: the batch's containers and, for a packaging order, its line completion and bulk. */}
        <BatchLinks run={view.header} />
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
      {exported ? <RunResultExported exported={exported} /> : null}
      <SignedResult result={signed.result} />

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

      {isGmpFloor() ? <BatchWorkQueue batchId={runId} /> : null}
      {isGmpFloor() ? <PackagingLinks batchId={runId} /> : null}
      {isGmpFloor() && view.header.postsIntermediateLot ? <IntermediateLot batchId={runId} /> : null}
      {/* Phase 7 slice 7g (WP4): a merge of two scanned containers of the batch. */}
      {isGmpFloor() ? <MergeContainers /> : null}

      <ExceptionList exceptions={view.exceptions} actions={view.actions} perform={perform} busy={signed.busy} />

      <section className={wcls('section')} aria-label={st('run.holds')}>
        <h2 className={wcls('sectionTitle')}>{st('run.holds')}</h2>
        {view.holds.length === 0 ? <p className={wcls('muted')}>{st('run.noHolds')}</p> : null}
        <ul className={wcls('entries')}>
          {view.holds.map((h) => (
            <li key={h.holdId} className={wcls('entry')}>
              <strong>{h.type === 'QA' ? st('dialog.hold.QA') : st('dialog.hold.SUPERVISOR')}</strong>: {h.reason} · {h.placedBy ? floor.personLine(h.placedBy) : st('timeline.system')} · {h.at.text}
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
      {open?.kind === 'ATTACH_DEVIATION' ? (
        <LinkDeviationDialog isOpen onClose={close} runId={runId} expectedVersion={view.header.version} stepKey={null} exception={exceptionNamed(open.exception)} />
      ) : null}
      {open?.kind === 'DISPOSITION_EXCEPTION' ? (
        <DispositionDialog
          isOpen
          onClose={close}
          exception={exceptionNamed(open.action.target ?? '')}
          onContinue={({ outcome, justification }) => {
            const a = open.action;
            close();
            if (!a.target || !a.meaning) return;
            void signed.sign({
              aggregateType: 'batch_exception',
              aggregateId: `${runId}:${a.target}`,
              meaning: a.meaning,
              intent: { type: 'DISPOSITION_EXCEPTION', exception: a.target, outcome, justification },
              expectedVersion: view.header.version,
              title: st('sign.title.DISPOSITION_EXCEPTION', { title: exceptionNamed(a.target).title }),
            });
          }}
        />
      ) : null}
    </>
  );
}
