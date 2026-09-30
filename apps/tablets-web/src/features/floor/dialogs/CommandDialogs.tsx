/**
 * The plain-intent dialogs of the floor (module C4): raise an exception, link a deviation (supervisors; lifts
 * an action-limit block, PR-08), hold the batch and release a hold. Who may do it is the server's decision; the
 * dialogs only collect the words.
 *
 * Each dialog's words and choice live in a form mounted only while the dialog is open, and a session change
 * (switch, lock, sign-out) empties them: nothing one person typed or chose is offered to the next person, nor to
 * the same person on a later opening; nothing is pre-selected (INV-40, DI-14).
 */
import { useState } from 'react';
import type { ExceptionView, StepScreenView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useSessionChange } from '../session.tsx';
import { st } from '../text.ts';
import { CommandBody, CommandDialog } from './CommandDialog.tsx';

interface FormBase {
  onClose: () => void;
  runId: string;
  expectedVersion: number;
  view?: StepScreenView;
}

interface Base extends FormBase {
  isOpen: boolean;
}

const nonEmpty = (s: string) => s.trim().length > 0;

/** A text the person types, emptied on a session change. */
function useTyped(): [string, (v: string) => void] {
  const [value, setValue] = useState('');
  useSessionChange(() => setValue(''));
  return [value, setValue];
}

/** A choice the person makes (nothing pre-selected), cleared on a session change. */
function useChoice(): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState<string | null>(null);
  useSessionChange(() => setValue(null));
  return [value, setValue];
}

export function RaiseExceptionDialog({ isOpen, ...p }: Base & { stepKey: string | null }) {
  return (
    <CommandDialog title={st('dialog.exception.title')} isOpen={isOpen}>
      <RaiseExceptionForm {...p} />
    </CommandDialog>
  );
}

function RaiseExceptionForm({ stepKey, ...p }: FormBase & { stepKey: string | null }) {
  const [description, setDescription] = useTyped();
  const [severity, setSeverity] = useChoice();
  const intent =
    nonEmpty(description) && (severity === 'ALERT' || severity === 'ACTION')
      ? ({ type: 'RAISE_EXCEPTION', ...(stepKey ? { stepKey } : {}), description: description.trim(), severity } as const)
      : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.RAISE_EXCEPTION')} intent={intent} {...p}>
      <Field label={st('dialog.exception.description')} name="description" value={description} onChange={setDescription} isRequired autoComplete="off" />
      <floor.ChoiceGroup
        label={st('dialog.exception.severity')}
        options={[
          { value: 'ALERT', label: st('dialog.exception.ALERT') },
          { value: 'ACTION', label: st('dialog.exception.ACTION') },
        ]}
        value={severity}
        onChange={setSeverity}
      />
    </CommandBody>
  );
}

type DeviationTarget = ExceptionView | { exceptionId: string; title: string };

export function LinkDeviationDialog({ isOpen, ...p }: Base & { exception: DeviationTarget; stepKey: string | null }) {
  return (
    <CommandDialog title={st('dialog.deviation.title', { title: p.exception.title })} isOpen={isOpen}>
      <LinkDeviationForm {...p} />
    </CommandDialog>
  );
}

function LinkDeviationForm({ exception, stepKey, ...p }: FormBase & { exception: DeviationTarget; stepKey: string | null }) {
  const [ref, setRef] = useTyped();
  const intent = nonEmpty(ref) ? ({ type: 'ATTACH_DEVIATION', exception: exception.exceptionId, deviationRef: ref.trim() } as const) : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.ATTACH_DEVIATION')} intent={intent} {...p}>
      <Field label={st('dialog.deviation.ref')} name="deviationRef" value={ref} onChange={setRef} description={st('dialog.deviation.help')} isRequired autoComplete="off" />
    </CommandBody>
  );
}

export function HoldBatchDialog({ isOpen, ...p }: Base & { stepKey: string | null }) {
  return (
    <CommandDialog title={st('dialog.hold.title')} isOpen={isOpen}>
      <HoldBatchForm {...p} />
    </CommandDialog>
  );
}

function HoldBatchForm({ stepKey, ...p }: FormBase & { stepKey: string | null }) {
  const [holdType, setHoldType] = useChoice();
  const [reason, setReason] = useTyped();
  const intent = (holdType === 'SUPERVISOR' || holdType === 'QA') && nonEmpty(reason) ? ({ type: 'HOLD_BATCH', holdType, reason: reason.trim() } as const) : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.HOLD_BATCH')} intent={intent} {...p}>
      <floor.ChoiceGroup
        label={st('dialog.hold.type')}
        options={[
          { value: 'SUPERVISOR', label: st('dialog.hold.SUPERVISOR') },
          { value: 'QA', label: st('dialog.hold.QA') },
        ]}
        value={holdType}
        onChange={setHoldType}
      />
      <Field label={st('dialog.hold.reason')} name="reason" value={reason} onChange={setReason} isRequired autoComplete="off" />
    </CommandBody>
  );
}

export function ReleaseHoldDialog({ isOpen, ...p }: Base & { hold: string; stepKey: string | null }) {
  return (
    <CommandDialog title={st('dialog.release.title')} isOpen={isOpen}>
      <ReleaseHoldForm {...p} />
    </CommandDialog>
  );
}

function ReleaseHoldForm({ hold, stepKey, ...p }: FormBase & { hold: string; stepKey: string | null }) {
  const [reason, setReason] = useTyped();
  const intent = nonEmpty(reason) ? ({ type: 'RELEASE_HOLD', hold, reason: reason.trim() } as const) : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.RELEASE_HOLD')} intent={intent} {...p}>
      <Field label={st('dialog.release.reason')} name="reason" value={reason} onChange={setReason} isRequired autoComplete="off" />
    </CommandBody>
  );
}
