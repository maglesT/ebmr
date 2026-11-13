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
import { useApiQuery } from '../../../api/hooks.ts';
import { useCommand } from '../../../app/acts.tsx';
import { useDeviationsLinked } from '../../../app/boot.tsx';
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
  const [classification, setClassification] = useChoice();
  const [rationale, setRationale] = useTyped();
  const linked = useDeviationsLinked();
  // Owner retest item 8: on a GMP batch without the Deviations link, a deviation not raised yet is raised, linked to the
  // batch and attached to the exception by the one Send (one command, one transaction): nothing is left raised and
  // unattached. A number typed wins; the raise is offered only while the number is empty.
  const raising = gmp && !linked && ref.trim() === '';
  const raise =
    raising && (classification === 'MINOR' || classification === 'MAJOR' || classification === 'CRITICAL') && rationale.trim().length >= 10
      ? { classification: classification as 'MINOR' | 'MAJOR' | 'CRITICAL', riskRationale: rationale.trim() }
      : null;
  const intent = nonEmpty(ref)
    ? ({ type: 'ATTACH_DEVIATION', exception: exception.exceptionId, deviationRef: ref.trim() } as const)
    : raise
      ? ({ type: 'ATTACH_DEVIATION', exception: exception.exceptionId, raise } as const)
      : null;
  return (
    <CommandBody viewStepKey={stepKey} reason={st('tap.reason.ATTACH_DEVIATION')} intent={intent} draft={ref !== '' || classification !== null || rationale !== ''} {...p}>
      <Field label={st('dialog.deviation.ref')} name="deviationRef" value={ref} onChange={setRef} description={st(gmp && !linked ? 'dialog.deviation.helpOrRaise' : 'dialog.deviation.help')} isRequired={!(gmp && !linked)} autoComplete="off" />
      {gmp && linked ? <LinkDeviationNumber runId={p.runId} number={ref.trim()} /> : null}
      {gmp && !linked ? <BatchDeviations runId={p.runId} onUse={setRef} /> : null}
      {raising ? (
        <section aria-label={st('dialog.deviation.raise')} data-testid="deviation-raise">
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
          <p>{st('dialog.deviation.raiseOnSend')}</p>
        </section>
      ) : null}
    </CommandBody>
  );
}

/**
 * Owner retest item 8: the open deviations already linked to this batch (one raised before whose attachment never
 * happened, such as DEV-SITE-1-2026-00004 on the demo), each with a button that puts its number in the field, so it is
 * attached instead of raising another.
 */
function BatchDeviations({ runId, onUse }: { runId: string; onUse: (ref: string) => void }) {
  const list = useApiQuery(routes.quality.deviations, { query: { batchId: runId, kind: 'DEVIATION' } }, { retry: false });
  const open = (list.data?.deviations ?? []).filter((d) => d.state !== 'CLOSED' && d.state !== 'CANCELLED');
  if (open.length === 0) return null;
  return (
    <section aria-label={st('dialog.deviation.ofBatch')} data-testid="batch-deviations">
      <h3>{st('dialog.deviation.ofBatch')}</h3>
      <ul>
        {open.map((d) => (
          <li key={d.deviationId} data-testid={`batch-deviation-${d.ref}`}>
            {d.ref}: {d.title}{' '}
            <Button onPress={() => onUse(d.ref)}>{st('dialog.deviation.use')}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Platform slice 2: with a Deviations link the deviation is raised in the Deviations product; the batch stores only its
 * number (quality.linkDeviationNumber, which checks the number is one Deviations publishes).
 */
function LinkDeviationNumber({ runId, number }: { runId: string; number: string }) {
  // On a shared kiosk the link carries the person's fresh badge tap (INV-40); useCommand asks for it.
  const linkCmd = useCommand(routes.quality.linkDeviationNumber, [], st('dialog.deviation.linkNumber'));
  const busy = linkCmd.busy;
  const error: CallError | null = linkCmd.error;
  const [linkedNumber, setLinkedNumber] = useState<string | null>(null);
  const link = async () => {
    if (number === '') return;
    if (await linkCmd.run({ params: { batchId: runId }, body: { number } })) setLinkedNumber(number);
  };
  if (linkedNumber !== null && linkedNumber === number) return <p data-testid="deviation-number-linked">{st('dialog.deviation.numberLinked', { ref: linkedNumber })}</p>;
  return (
    <section aria-label={st('dialog.deviation.linkNumber')}>
      <h3>{st('dialog.deviation.linkNumber')}</h3>
      {error ? <RefusalMessage error={error} /> : null}
      <Button onPress={() => void link()} isDisabled={number === '' || busy}>
        {st('dialog.deviation.linkNumberButton')}
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
