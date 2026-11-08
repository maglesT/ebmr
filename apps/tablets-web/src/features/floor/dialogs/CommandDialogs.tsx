/**
 * The plain-intent dialogs of the floor (module C4): raise an exception, link a deviation (supervisors; lifts
 * an action-limit block, PR-08), hold the batch and release a hold. Who may do it is the server's decision; the
 * dialogs only collect the words.
 *
 * Each dialog's words and choice live in a form mounted only while the dialog is open, and a session change
 * (switch, lock, sign-out) empties them: nothing one person typed or chose is offered to the next person, nor to
 * the same person on a later opening; nothing is pre-selected (INV-40, DI-14). While the person has typed or chosen
 * something not yet sent, a reload or closing the tab asks first (useDraftGuard, review F63).
 */
import { useState } from 'react';
import { routes, type CallError, type ExceptionView, type StepScreenView } from '@ebmr/api-contract';
import { Button, Field, floor } from '@ebmr/ui-kit';
import { api } from '../../../api/client.ts';
import { RefusalMessage } from '../../../app/refusal.tsx';
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
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.RAISE_EXCEPTION')} intent={intent} draft={description !== '' || severity !== null} {...p}>
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

/** `gmp`: a GMP batch, whose deviation link names a deviation record of this installation linked to the batch (recipe-core 0601). */
export function LinkDeviationDialog({ isOpen, ...p }: Base & { exception: DeviationTarget; stepKey: string | null; gmp: boolean }) {
  return (
    <CommandDialog title={st('dialog.deviation.title', { title: p.exception.title })} isOpen={isOpen}>
      <LinkDeviationForm {...p} />
    </CommandDialog>
  );
}

function LinkDeviationForm({ exception, stepKey, gmp, ...p }: FormBase & { exception: DeviationTarget; stepKey: string | null; gmp: boolean }) {
  const [ref, setRef] = useTyped();
  const intent = nonEmpty(ref) ? ({ type: 'ATTACH_DEVIATION', exception: exception.exceptionId, deviationRef: ref.trim() } as const) : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.ATTACH_DEVIATION')} intent={intent} draft={ref !== ''} {...p}>
      <Field label={st('dialog.deviation.ref')} name="deviationRef" value={ref} onChange={setRef} description={st('dialog.deviation.help')} isRequired autoComplete="off" />
      {gmp ? <RaiseBatchDeviation runId={p.runId} title={exception.title} onRaised={setRef} /> : null}
    </CommandBody>
  );
}

/**
 * Owner report item 2: on a GMP batch the link names a deviation record of this installation linked to the batch
 * (recipe-core 0601, EBMR-EXE-600), and with the deviation screens off (EBMR_DISCONNECT) nothing else raises one. The
 * served routes raiseDeviation and linkDeviation (api-contract disconnected.ts keeps both) raise it here and link it to
 * the batch; its reference fills the field. The person chooses the classification and writes the risk rationale.
 */
function RaiseBatchDeviation({ runId, title, onRaised }: { runId: string; title: string; onRaised: (ref: string) => void }) {
  const [classification, setClassification] = useChoice();
  const [rationale, setRationale] = useTyped();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CallError | null>(null);
  const [raised, setRaised] = useState<string | null>(null);
  const ready = (classification === 'MINOR' || classification === 'MAJOR' || classification === 'CRITICAL') && rationale.trim().length >= 10;
  const raise = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await api.call(routes.quality.raiseDeviation, { body: { kind: 'DEVIATION', title: title.slice(0, 200), classification, riskRationale: rationale.trim() } });
    const linked = r.ok ? await api.call(routes.quality.linkDeviation, { params: { deviationId: r.value.deviationId }, body: { subjectKind: 'BATCH', subjectId: runId } }) : null;
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (linked && !linked.ok) return setError(linked.error);
    setRaised(r.value.ref);
    onRaised(r.value.ref);
  };
  if (raised !== null) return <p data-testid="deviation-raised">{st('dialog.deviation.raised', { ref: raised })}</p>;
  return (
    <section aria-label={st('dialog.deviation.raise')}>
      <h3>{st('dialog.deviation.raise')}</h3>
      <floor.ChoiceGroup
        label={st('dialog.deviation.classification')}
        options={[
          { value: 'MINOR', label: st('dialog.deviation.MINOR') },
          { value: 'MAJOR', label: st('dialog.deviation.MAJOR') },
          { value: 'CRITICAL', label: st('dialog.deviation.CRITICAL') },
        ]}
        value={classification}
        onChange={setClassification}
      />
      <Field label={st('dialog.deviation.rationale')} name="riskRationale" value={rationale} onChange={setRationale} description={st('dialog.deviation.rationaleHelp')} autoComplete="off" />
      {error ? <RefusalMessage error={error} /> : null}
      <Button onPress={() => void raise()} isDisabled={!ready || busy}>
        {st('dialog.deviation.raiseButton')}
      </Button>
    </section>
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
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.HOLD_BATCH')} intent={intent} draft={holdType !== null || reason !== ''} {...p}>
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
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.RELEASE_HOLD')} intent={intent} draft={reason !== ''} {...p}>
      <Field label={st('dialog.release.reason')} name="reason" value={reason} onChange={setReason} isRequired autoComplete="off" />
    </CommandBody>
  );
}
