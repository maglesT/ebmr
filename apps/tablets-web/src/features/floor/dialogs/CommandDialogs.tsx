/**
 * The plain-intent dialogs of the floor (module C4): raise an exception, link a deviation (supervisors; lifts
 * an action-limit block, PR-08), hold the batch and release a hold. Who may do it is the server's decision; the
 * dialogs only collect the words.
 */
import { useState } from 'react';
import type { ExceptionView, StepScreenView } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { st } from '../text.ts';
import { CommandDialog } from './CommandDialog.tsx';

interface Base {
  isOpen: boolean;
  onClose: () => void;
  runId: string;
  expectedVersion: number;
  view?: StepScreenView;
}

const nonEmpty = (s: string) => s.trim().length > 0;

export function RaiseExceptionDialog({ stepKey, ...p }: Base & { stepKey: string | null }) {
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<string | null>(null);
  const intent =
    nonEmpty(description) && (severity === 'ALERT' || severity === 'ACTION')
      ? ({ type: 'RAISE_EXCEPTION', ...(stepKey ? { stepKey } : {}), description: description.trim(), severity } as const)
      : null;
  return (
    <CommandDialog title={st('dialog.exception.title')} viewStepKey={stepKey} reason={st('tap.reason.RAISE_EXCEPTION')} intent={intent} {...p}>
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
    </CommandDialog>
  );
}

export function LinkDeviationDialog({ exception, stepKey, ...p }: Base & { exception: ExceptionView | { exceptionId: string; title: string }; stepKey: string | null }) {
  const [ref, setRef] = useState('');
  const intent = nonEmpty(ref) ? ({ type: 'ATTACH_DEVIATION', exception: exception.exceptionId, deviationRef: ref.trim() } as const) : null;
  return (
    <CommandDialog title={st('dialog.deviation.title', { title: exception.title })} viewStepKey={stepKey} reason={st('tap.reason.ATTACH_DEVIATION')} intent={intent} {...p}>
      <Field label={st('dialog.deviation.ref')} name="deviationRef" value={ref} onChange={setRef} description={st('dialog.deviation.help')} isRequired autoComplete="off" />
    </CommandDialog>
  );
}

export function HoldBatchDialog({ stepKey, ...p }: Base & { stepKey: string | null }) {
  const [holdType, setHoldType] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const intent = (holdType === 'SUPERVISOR' || holdType === 'QA') && nonEmpty(reason) ? ({ type: 'HOLD_BATCH', holdType, reason: reason.trim() } as const) : null;
  return (
    <CommandDialog title={st('dialog.hold.title')} viewStepKey={stepKey} reason={st('tap.reason.HOLD_BATCH')} intent={intent} {...p}>
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
    </CommandDialog>
  );
}

export function ReleaseHoldDialog({ hold, stepKey, ...p }: Base & { hold: string; stepKey: string | null }) {
  const [reason, setReason] = useState('');
  const intent = nonEmpty(reason) ? ({ type: 'RELEASE_HOLD', hold, reason: reason.trim() } as const) : null;
  return (
    <CommandDialog title={st('dialog.release.title')} viewStepKey={stepKey} reason={st('tap.reason.RELEASE_HOLD')} intent={intent} {...p}>
      <Field label={st('dialog.release.reason')} name="reason" value={reason} onChange={setReason} isRequired autoComplete="off" />
    </CommandDialog>
  );
}
