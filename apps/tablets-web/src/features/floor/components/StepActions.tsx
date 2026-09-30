/**
 * The step card's actions (module C4): the server's action list becomes one primary action and a "More" menu.
 * Unavailable actions stay visible, greyed, with the server's reason (DI-34). Signature actions go through the
 * ceremony port with an ENGINE_COMMAND action; the aggregate is the view's signable (batch_step), the stage's
 * (batch_stage) or batch_exception:<runId>:<exceptionId>, and the meaning is always the action's own.
 */
import { useState } from 'react';
import type { ActionView, RunView, SignedIntent, StepScreenView } from '@ebmr/api-contract';
import { Banner, floor } from '@ebmr/ui-kit';
import { HoldBatchDialog, LinkDeviationDialog, RaiseExceptionDialog, ReleaseHoldDialog } from '../dialogs/CommandDialogs.tsx';
import { DispositionDialog, HoldPointDialog, StageSignOffDialog } from '../dialogs/SignDialogs.tsx';
import { st, actionLabel } from '../text.ts';
import { useRunCommand } from '../usePendingCall.ts';
import type { useSignedAction } from '../useSignedAction.ts';
import { EntryStatus } from './EntryStatus.tsx';

type Signed = ReturnType<typeof useSignedAction>;

const RECORDING = new Set<ActionView['action']>(['RECORD_DATA', 'RECORD_ENTRY']);
/** Engine commands classified LATER in the contract: no intent exists for them in A1. */
const LATER = new Set<ActionView['action']>(['COMPLETE_LOOP_ITERATION']);

export const actionId = (a: Pick<ActionView, 'action' | 'target'>) => `${a.action}|${a.target ?? ''}`;

type Open =
  | { kind: 'RAISE_EXCEPTION' }
  | { kind: 'ATTACH_DEVIATION'; exception: string }
  | { kind: 'HOLD_BATCH' }
  | { kind: 'RELEASE_HOLD'; hold: string }
  | { kind: 'DISPOSITION_HOLD_POINT' }
  | { kind: 'SIGN_OFF_STAGE'; action: ActionView }
  | { kind: 'DISPOSITION_EXCEPTION'; action: ActionView }
  | null;

export function useStepActions(view: StepScreenView, runView: RunView | undefined, signed: Signed) {
  const [open, setOpen] = useState<Open>(null);
  const start = useRunCommand(view.run.runId, view.step.stepKey, st('tap.reason.START_STEP', { number: view.step.number }));
  const stepKey = view.step.stepKey;
  const version = view.run.version;

  const signStep = (a: ActionView, intent: SignedIntent, title: string) => {
    if (!view.signable || !a.meaning) return;
    void signed.sign({ aggregateType: view.signable.aggregateType, aggregateId: view.signable.aggregateId, meaning: a.meaning, intent, expectedVersion: version, title });
  };
  const stageOf = (a: ActionView) => {
    const key = a.target ?? view.run.stage?.stageKey ?? null;
    return runView?.stages.find((s) => s.stageKey === key) ?? null;
  };

  const perform = (a: ActionView) => {
    const vars = { number: view.step.number, title: view.step.title };
    switch (a.action) {
      case 'START_STEP':
        start.send({ type: 'START_STEP', stepKey }, version, view);
        return;
      case 'SIGN_PERFORMED':
        signStep(a, { type: 'SIGN_PERFORMED', stepKey }, st('sign.title.SIGN_PERFORMED', vars));
        return;
      case 'VERIFY':
        signStep(a, { type: 'VERIFY', stepKey, meaning: 'VERIFIED' }, st('sign.title.VERIFY', vars));
        return;
      case 'WITNESS':
        signStep(a, { type: 'VERIFY', stepKey, meaning: 'WITNESSED' }, st('sign.title.WITNESS', vars));
        return;
      case 'DISPOSITION_HOLD_POINT':
        setOpen({ kind: 'DISPOSITION_HOLD_POINT' });
        return;
      case 'SIGN_OFF_STAGE':
      case 'DISPOSITION_EXCEPTION':
        setOpen({ kind: a.action, action: a });
        return;
      case 'RAISE_EXCEPTION':
      case 'HOLD_BATCH':
        setOpen({ kind: a.action });
        return;
      case 'ATTACH_DEVIATION':
        setOpen({ kind: 'ATTACH_DEVIATION', exception: a.target ?? view.exceptions.find((e) => e.status === 'OPEN')?.exceptionId ?? '' });
        return;
      case 'RELEASE_HOLD':
        if (a.target) setOpen({ kind: 'RELEASE_HOLD', hold: a.target });
        return;
      default:
        return;
    }
  };

  const close = () => setOpen(null);
  const dialogs = (
    <>
      <RaiseExceptionDialog isOpen={open?.kind === 'RAISE_EXCEPTION'} onClose={close} runId={view.run.runId} expectedVersion={version} view={view} stepKey={stepKey} />
      <HoldBatchDialog isOpen={open?.kind === 'HOLD_BATCH'} onClose={close} runId={view.run.runId} expectedVersion={version} view={view} stepKey={stepKey} />
      {open?.kind === 'ATTACH_DEVIATION' ? (
        <LinkDeviationDialog
          isOpen
          onClose={close}
          runId={view.run.runId}
          expectedVersion={version}
          view={view}
          stepKey={stepKey}
          exception={view.exceptions.find((e) => e.exceptionId === open.exception) ?? { exceptionId: open.exception, title: open.exception }}
        />
      ) : null}
      {open?.kind === 'RELEASE_HOLD' ? <ReleaseHoldDialog isOpen onClose={close} runId={view.run.runId} expectedVersion={version} view={view} stepKey={stepKey} hold={open.hold} /> : null}
      {open?.kind === 'DISPOSITION_HOLD_POINT' ? (
        <HoldPointDialog
          isOpen
          onClose={close}
          dispositions={holdPointActions(view).map((a) => a.target ?? '')}
          unavailable={view.actions.filter((a) => a.action === 'DISPOSITION_HOLD_POINT' && !a.available && a.target !== null).map((a) => ({ disposition: a.target ?? '', reason: a.reason }))}
          onContinue={({ disposition, comment }) => {
            // Each decision is its own server action with its own meaning (release or not released): sign the chosen one.
            const a = holdPointActions(view).find((x) => x.target === disposition);
            close();
            if (!a) return;
            signStep(a, { type: 'DISPOSITION_HOLD_POINT', stepKey, disposition, ...(comment ? { comment } : {}) }, st('sign.title.DISPOSITION_HOLD_POINT', { number: view.step.number, title: view.step.title, disposition }));
          }}
        />
      ) : null}
      {open?.kind === 'SIGN_OFF_STAGE' ? (
        <StageSignOffDialog
          isOpen
          onClose={close}
          stage={stageOf(open.action)}
          onContinue={() => {
            const a = open.action;
            const stage = stageOf(a);
            close();
            if (!stage?.signable || !a.meaning) return;
            void signed.sign({
              aggregateType: stage.signable.aggregateType,
              aggregateId: stage.signable.aggregateId,
              meaning: a.meaning,
              intent: { type: 'SIGN_OFF_STAGE', stageKey: stage.stageKey },
              expectedVersion: version,
              title: st('sign.title.SIGN_OFF_STAGE', { number: stage.number, name: stage.name }),
            });
          }}
        />
      ) : null}
      {open?.kind === 'DISPOSITION_EXCEPTION' ? (
        <DispositionDialog
          isOpen
          onClose={close}
          exception={view.exceptions.find((e) => e.exceptionId === open.action.target) ?? { exceptionId: open.action.target ?? '', title: open.action.target ?? '' }}
          onContinue={({ outcome, justification }) => {
            const a = open.action;
            close();
            if (!a.target || !a.meaning) return;
            void signed.sign({
              aggregateType: 'batch_exception',
              aggregateId: `${view.run.runId}:${a.target}`,
              meaning: a.meaning,
              intent: { type: 'DISPOSITION_EXCEPTION', exception: a.target, outcome, justification },
              expectedVersion: version,
              title: st('sign.title.DISPOSITION_EXCEPTION', { title: view.exceptions.find((e) => e.exceptionId === a.target)?.title ?? a.target }),
            });
          }}
        />
      ) : null}
      <EntryStatus call={start} />
    </>
  );

  return { perform, dialogs, busy: start.busy || start.state === 'notSaved' || signed.busy };
}

/** The hold-point decisions the server offers now: one action per disposition (target), each with its own meaning. */
function holdPointActions(view: StepScreenView): ActionView[] {
  return view.actions.filter((a) => a.action === 'DISPOSITION_HOLD_POINT' && a.available && a.target !== null);
}

/** One bar entry for the hold-point decision (the dialog chooses among the server's per-disposition actions). */
function barActions(view: StepScreenView): ActionView[] {
  const holds = view.actions.filter((a) => a.action === 'DISPOSITION_HOLD_POINT');
  const shown = holds.find((a) => a.available) ?? holds[0];
  return view.actions.filter((a) => a.action !== 'DISPOSITION_HOLD_POINT' || a === shown);
}

/** Why an action cannot be taken from this screen, beyond the server's own reason. */
function localBlock(a: ActionView, view: StepScreenView): string | null {
  if (LATER.has(a.action)) return st('action.laterRelease');
  const signature = a.requires === 'SIGNATURE';
  if (signature && !a.meaning) return st('action.noMeaning');
  if (signature && (a.action === 'SIGN_PERFORMED' || a.action === 'VERIFY' || a.action === 'WITNESS' || a.action === 'DISPOSITION_HOLD_POINT') && !view.signable) return st('action.noSignable');
  return null;
}

/** Maps a server action to a bar entry: the server's availability and reason, plus what this screen cannot do yet. */
export function toBarAction(a: ActionView, view: StepScreenView): floor.BarAction {
  const block = localBlock(a, view);
  const exception = a.target ? view.exceptions.find((e) => e.exceptionId === a.target) : undefined;
  return { id: actionId(a), label: exception ? `${actionLabel(a)}: ${exception.title}` : actionLabel(a), isDisabled: !a.available || block !== null, reason: a.available ? block : a.reason, whoCanHelp: a.available ? [] : a.whoCanHelp };
}

export function StepActionBar({ view, perform, busy }: { view: StepScreenView; perform: (a: ActionView) => void; busy: boolean }) {
  const actions = barActions(view);
  const primaryAction = actions.find((a) => a.primary) ?? (actions.find((a) => a.action === 'DISPOSITION_HOLD_POINT' && view.actions.some((x) => x.action === a.action && x.primary)) ?? null);
  const toBar = (a: ActionView) => toBarAction(a, view);
  const primary = primaryAction && !RECORDING.has(primaryAction.action) ? toBar(primaryAction) : null;
  const more = actions.filter((a) => a !== primaryAction && !RECORDING.has(a.action)).map(toBar);
  const byId = new Map(view.actions.map((a) => [actionId(a), a]));
  return (
    <>
      {primaryAction && RECORDING.has(primaryAction.action) && !primaryAction.available && primaryAction.reason ? <Banner tone="info" title={primaryAction.reason} /> : null}
      <floor.PrimaryActionBar
        primary={primary}
        onPrimary={() => primaryAction && perform(primaryAction)}
        {...(primary ? {} : { hint: floor.ft('action.recordHint') })}
        more={more}
        onMore={(id) => {
          const a = byId.get(id);
          if (a) perform(a);
        }}
        busy={busy}
      />
    </>
  );
}
