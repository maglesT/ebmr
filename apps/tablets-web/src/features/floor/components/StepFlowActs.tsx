/**
 * The flow decisions of a step on the step screen (Phase 7 slice 7l, requirement R1: every block demonstrable on the
 * screens):
 *  - an alternative a person chooses (OPERATOR_CHOICE): the step lies in one of its branches; the authorised person
 *    (the roles the master names) chooses a branch with a reason (CHOOSE_ALTERNATIVE, DI-34, PR-13);
 *  - a loop iteration: once the step of the iteration is completed, a person ends the iteration and the engine decides
 *    from the loop's exit condition whether another iteration follows (COMPLETE_LOOP_ITERATION, INV-19).
 * Each is one command of the signed-in person (a fresh badge tap on a shared terminal); what is offered is the server's
 * (StepScreenView alternative and loop) and the engine decides: its refusal is shown in its own words.
 */
import { useState } from 'react';
import type { StepScreenView } from '@ebmr/api-contract';
import { Button, Field, floor, StatusChip } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { EntryStatus } from './EntryStatus.tsx';
import { useRunCommand } from '../usePendingCall.ts';

export function StepFlowActs({ view }: { view: StepScreenView }) {
  return (
    <>
      {view.alternative ? <AlternativeChoice view={view} alternative={view.alternative} /> : null}
      {view.loop ? <LoopIteration view={view} loop={view.loop} /> : null}
    </>
  );
}

type Alternative = NonNullable<StepScreenView['alternative']>;
type Loop = NonNullable<StepScreenView['loop']>;

function AlternativeChoice({ view, alternative }: { view: StepScreenView; alternative: Alternative }) {
  const [branch, setBranch] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const clear = () => {
    setBranch(null);
    setReason('');
  };
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, `choosing a branch of ${alternative.construct}`, { onSaved: clear });
  const chosen = alternative.branches.find((b) => b.id === alternative.chosen);
  const locked = cmd.busy || cmd.state === 'notSaved';
  const choose = () => {
    if (!branch || reason.trim() === '') return;
    cmd.send({ type: 'CHOOSE_ALTERNATIVE', construct: alternative.construct, ...(alternative.context !== '' ? { context: alternative.context } : {}), branch, reason: reason.trim() }, view.run.version, view);
  };
  return (
    <section className={wcls('section')} aria-label="Branch of the process" data-testid="alternative-choice">
      <h2 className={wcls('sectionTitle')}>Branch of the process</h2>
      {chosen ? (
        <StatusChip tone="ok" label={`Branch chosen: ${chosen.name}`} />
      ) : (
        <>
          <p className={wcls('muted')}>This step belongs to a branch of the process that is chosen by {alternative.roles.join(' or ').toLowerCase().replace(/_/g, ' ')}, with the reason.</p>
          <floor.ChoiceGroup label="Branch" options={alternative.branches.map((b) => ({ value: b.id, label: b.name }))} value={branch} onChange={setBranch} isDisabled={locked} />
          <Field name="branch-reason" label="Reason for the choice" value={reason} onChange={setReason} isDisabled={locked} autoComplete="off" />
          <Button variant="secondary" onPress={choose} isDisabled={locked || branch === null || reason.trim() === ''}>
            Choose the branch
          </Button>
        </>
      )}
      <EntryStatus call={cmd} />
    </section>
  );
}

function LoopIteration({ view, loop }: { view: StepScreenView; loop: Loop }) {
  const cmd = useRunCommand(view.run.runId, view.step.stepKey, `ending iteration ${loop.iteration} of ${loop.name}`);
  const ready = view.step.status === 'COMPLETED';
  return (
    <section className={wcls('section')} aria-label="Loop iteration" data-testid="loop-iteration">
      <h2 className={wcls('sectionTitle')}>
        {loop.name}: iteration {loop.iteration}
      </h2>
      {loop.completed ? (
        <StatusChip tone="ok" label={`Iteration ${loop.iteration} ended`} />
      ) : (
        <>
          <p className={wcls('muted')}>{ready ? 'The step of this iteration is completed: end the iteration; the exit condition decides whether another follows.' : 'Complete the step first; then end the iteration.'}</p>
          <Button variant="secondary" onPress={() => cmd.send({ type: 'COMPLETE_LOOP_ITERATION', stepKey: view.step.stepKey }, view.run.version, view)} isDisabled={!ready || cmd.busy || cmd.state === 'notSaved'}>
            End iteration {loop.iteration}
          </Button>
        </>
      )}
      <EntryStatus call={cmd} />
    </section>
  );
}
