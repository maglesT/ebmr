/**
 * The step screen (module C4; plan sections 9 and 12, screen 15): the run header, the stage outline, and the
 * step card with the instruction as issued, the block renderer, exceptions, signatures and one primary action.
 * Everything shown is the server's view; what can be done is the server's answer.
 */
import { Link, useNavigate } from '@tanstack/react-router';
import { Banner, Button, floor } from '@ebmr/ui-kit';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { wcls } from '../classes.ts';
import { useRouteParams } from '../params.ts';
import { StepExceptions } from '../components/Exceptions.tsx';
import { RunHeader } from '../components/RunHeader.tsx';
import { SignedResult } from '../components/SignedResult.tsx';
import { StepActionBar, useStepActions } from '../components/StepActions.tsx';
import { voidableAttempts } from '../dialogs/VoidAttemptDialog.tsx';
import { useRunView, useStepView } from '../queries.ts';
import { rendererFor } from '../renderers/registry.ts';
import { st } from '../text.ts';
import { useLeaveGuard } from '../unsettled.ts';
import { useSignedAction } from '../useSignedAction.ts';
import type { RunView, StepScreenView } from '@ebmr/api-contract';

function StepCard({ view, runView }: { view: StepScreenView; runView: RunView | undefined }) {
  const navigate = useNavigate();
  const signed = useSignedAction(view.run.runId);
  const { perform, dialogs, busy, openVoid } = useStepActions(view, runView, signed);
  // DI-24: an attempt is voided with a reason (never deleted); offered here when the server lists no void action itself.
  const voidOffered = !view.actions.some((a) => a.action === 'VOID_ATTEMPT') && voidableAttempts(view).length > 0;
  const { Renderer } = rendererFor(view);
  return (
    <div className={wcls('screen')}>
      <aside className={wcls('side')}>
        {runView ? (
          <floor.StatusOutline
            stages={runView.stages}
            currentStepKey={view.step.stepKey}
            stageKey={view.run.stage?.stageKey ?? null}
            onSelect={(stepKey) => void navigate({ to: '/runs/$runId/steps/$stepKey', params: { runId: view.run.runId, stepKey } })}
          />
        ) : null}
        <Link to="/runs/$runId" params={{ runId: view.run.runId }} className={wcls('link')}>
          {st('outline.overview')}
        </Link>
        <Link to="/cockpit" className={wcls('link')}>
          {st('back.cockpit')}
        </Link>
      </aside>
      <article className={wcls('card')} aria-label={`Step ${view.step.number} ${view.step.title}`} data-testid="step-card" data-step={view.step.stepKey}>
        <floor.StepHeader step={view.step} />
        <SignedResult result={signed.result} />
        <Renderer view={view} />
        <StepExceptions view={view} perform={perform} busy={busy} />
        {view.signatures.length > 0 ? (
          <section className={wcls('section')} aria-label={st('signatures.title')}>
            <h2 className={wcls('sectionTitle')}>{st('signatures.title')}</h2>
            <floor.SignatureList label={st('signatures.title')} signatures={view.signatures} />
          </section>
        ) : null}
        {voidOffered ? (
          <Button onPress={openVoid} isDisabled={busy}>
            {st('void.open')}
          </Button>
        ) : null}
        <StepActionBar view={view} perform={perform} busy={busy} />
        {dialogs}
      </article>
    </div>
  );
}

export function StepScreenPage() {
  const params = useRouteParams();
  const runId = params['runId'] ?? '';
  const stepKey = params['stepKey'] ?? '';
  const step = useStepView(runId, stepKey);
  const run = useRunView(runId);
  const held = useLeaveGuard();
  if (step.isPending) return <p>{st('loading')}</p>;
  if (!step.data) return step.error ? <RefusalMessage error={step.error.error} /> : null;
  const view = step.data;
  const connected = !(step.error && step.error.error.kind === 'NETWORK');
  return (
    <>
      <RunHeader run={view.run} connected={connected} />
      {held ? <Banner tone="warning" title={st('leave.held')} /> : null}
      {step.error ? <RefusalMessage error={step.error.error} /> : null}
      <StepCard key={`${view.run.runId}:${view.step.stepKey}`} view={view} runView={run.data} />
    </>
  );
}
