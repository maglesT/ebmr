/**
 * Dialogs that lead to a signature (module C4): the hold-point decision, the stage sign-off with its derived
 * summary (G-02: "completed per MBR" or "with deviations", never typed) and the QA disposition of an exception.
 * They collect the choice, close, and the screen then asks the ceremony (C1) for the signature.
 * The choice and the words live in a form mounted only while the dialog is open and are emptied by a session
 * change, so nothing one person chose or typed is offered to the next person (INV-40, DI-14). While something is chosen
 * or typed, a reload or closing the tab asks first (useDraftGuard, review F63).
 */
import { useState } from 'react';
import type { ExceptionView, RunView } from '@ebmr/api-contract';
import { Button, Dialog, Field, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { useSessionChange } from '../session.tsx';
import { st, stEnum } from '../text.ts';
import { useDraftGuard } from '../unsettled.ts';

export interface UnavailableDecision {
  disposition: string;
  reason: string | null;
}

interface HoldPointProps {
  isOpen: boolean;
  onClose: () => void;
  dispositions: readonly string[];
  unavailable?: readonly UnavailableDecision[];
  onContinue: (d: { disposition: string; comment: string }) => void;
}

/**
 * The hold-point decision. Only the decisions the server offers now can be chosen; the others are listed with the
 * server's reason (e.g. a release waits for QA's decision on open exceptions; DI-34).
 */
export function HoldPointDialog({ isOpen, onClose, ...p }: HoldPointProps) {
  return (
    <Dialog title={st('dialog.holdPoint.title')} isOpen={isOpen} onOpenChange={(o) => (o ? null : onClose())}>
      {isOpen ? <HoldPointForm onClose={onClose} {...p} /> : null}
    </Dialog>
  );
}

function HoldPointForm({ onClose, dispositions, unavailable = [], onContinue }: Omit<HoldPointProps, 'isOpen'>) {
  const [disposition, setDisposition] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  useSessionChange(() => {
    setDisposition(null);
    setComment('');
  });
  // Chosen or typed and not yet signed: a reload asks first (F63). The form goes when the dialog closes.
  useDraftGuard(disposition !== null || comment !== '');
  return (
    <div className={wcls('dialogBody')}>
      <floor.ChoiceGroup label={st('dialog.holdPoint.disposition')} options={dispositions.map((d) => ({ value: d, label: stEnum('disposition', d) }))} value={disposition} onChange={setDisposition} />
      {unavailable.length > 0 ? (
        <ul className={wcls('entries')} data-testid="unavailable-decisions">
          {unavailable.map((u) => (
            <li key={u.disposition} className={wcls('muted')}>
              {st('dialog.holdPoint.unavailable', { decision: stEnum('disposition', u.disposition), reason: u.reason ?? '' })}
            </li>
          ))}
        </ul>
      ) : null}
      <Field label={st('dialog.holdPoint.comment')} name="comment" value={comment} onChange={setComment} autoComplete="off" />
      <div className={wcls('row')}>
        <Button variant="primary" isDisabled={!disposition} onPress={() => disposition && onContinue({ disposition, comment: comment.trim() })}>
          {st('dialog.holdPoint.sign')}
        </Button>
        <Button onPress={onClose}>{st('dialog.cancel')}</Button>
      </div>
    </div>
  );
}

type Stage = RunView['stages'][number];

export function StageSignOffDialog({ isOpen, onClose, stage, onContinue }: { isOpen: boolean; onClose: () => void; stage: Stage | null; onContinue: () => void }) {
  const summary = stage?.summary ?? null;
  return (
    <Dialog title={stage ? st('dialog.signOff.title', { number: stage.number, name: stage.name }) : st('action.SIGN_OFF_STAGE')} isOpen={isOpen} onOpenChange={(o) => (o ? null : onClose())}>
      <div className={wcls('dialogBody')}>
        <p className={wcls('muted')}>{st('dialog.signOff.summary')}</p>
        {summary ? (
          <div data-testid="stage-summary">
            <p>
              <strong>{st(`run.stageSummary.${summary.statement}`)}</strong>
            </p>
            <p>{st('dialog.signOff.exceptions', { list: summary.exceptions.length ? summary.exceptions.join(', ') : st('dialog.signOff.none') })}</p>
            <p>{st('dialog.signOff.deviations', { list: summary.deviations.length ? summary.deviations.join(', ') : st('dialog.signOff.none') })}</p>
          </div>
        ) : (
          <p>{st('dialog.signOff.noSummary')}</p>
        )}
        <div className={wcls('row')}>
          <Button variant="primary" onPress={onContinue} isDisabled={!stage?.signable}>
            {st('dialog.signOff.sign')}
          </Button>
          <Button onPress={onClose}>{st('dialog.cancel')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

type DispositionOutcome = 'NO_IMPACT' | 'DEVIATION_RAISED';

interface DispositionProps {
  isOpen: boolean;
  onClose: () => void;
  exception: Pick<ExceptionView, 'exceptionId' | 'title'>;
  onContinue: (d: { outcome: DispositionOutcome; justification: string }) => void;
}

export function DispositionDialog({ isOpen, onClose, exception, onContinue }: DispositionProps) {
  return (
    <Dialog title={st('dialog.disposition.title', { title: exception.title })} isOpen={isOpen} onOpenChange={(o) => (o ? null : onClose())}>
      {isOpen ? <DispositionForm onClose={onClose} onContinue={onContinue} /> : null}
    </Dialog>
  );
}

function DispositionForm({ onClose, onContinue }: Pick<DispositionProps, 'onClose' | 'onContinue'>) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [justification, setJustification] = useState('');
  useSessionChange(() => {
    setOutcome(null);
    setJustification('');
  });
  useDraftGuard(outcome !== null || justification !== '');
  const ready = (outcome === 'NO_IMPACT' || outcome === 'DEVIATION_RAISED') && justification.trim().length > 0;
  return (
    <div className={wcls('dialogBody')}>
      <floor.ChoiceGroup
        label={st('dialog.disposition.outcome')}
        options={[
          { value: 'NO_IMPACT', label: st('dialog.disposition.NO_IMPACT') },
          { value: 'DEVIATION_RAISED', label: st('dialog.disposition.DEVIATION_RAISED') },
        ]}
        value={outcome}
        onChange={setOutcome}
      />
      <Field label={st('dialog.disposition.justification')} name="justification" value={justification} onChange={setJustification} isRequired autoComplete="off" />
      <div className={wcls('row')}>
        <Button
          variant="primary"
          isDisabled={!ready}
          onPress={() => (outcome === 'NO_IMPACT' || outcome === 'DEVIATION_RAISED') && onContinue({ outcome, justification: justification.trim() })}
        >
          {st('dialog.disposition.sign')}
        </Button>
        <Button onPress={onClose}>{st('dialog.cancel')}</Button>
      </div>
    </div>
  );
}
