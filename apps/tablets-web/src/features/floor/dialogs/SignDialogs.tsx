/**
 * Dialogs that lead to a signature (module C4): the hold-point decision, the stage sign-off with its derived
 * summary (G-02: "completed per MBR" or "with deviations", never typed) and the QA disposition of an exception.
 * They collect the choice, close, and the screen then asks the ceremony (C1) for the signature.
 */
import { useState } from 'react';
import type { ExceptionView, RunView } from '@ebmr/api-contract';
import { Button, Dialog, Field, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';

const DISPOSITION_WORDS: Readonly<Record<string, string>> = { RELEASED: 'Released', REJECTED: 'Rejected (not released)' };

export function HoldPointDialog({ isOpen, onClose, dispositions, onContinue }: { isOpen: boolean; onClose: () => void; dispositions: readonly string[]; onContinue: (d: { disposition: string; comment: string }) => void }) {
  const [disposition, setDisposition] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  return (
    <Dialog title={st('dialog.holdPoint.title')} isOpen={isOpen} onOpenChange={(o) => (o ? null : onClose())}>
      <div className={wcls('dialogBody')}>
        <floor.ChoiceGroup label={st('dialog.holdPoint.disposition')} options={dispositions.map((d) => ({ value: d, label: DISPOSITION_WORDS[d] ?? d }))} value={disposition} onChange={setDisposition} />
        <Field label={st('dialog.holdPoint.comment')} name="comment" value={comment} onChange={setComment} autoComplete="off" />
        <div className={wcls('row')}>
          <Button variant="primary" isDisabled={!disposition} onPress={() => disposition && onContinue({ disposition, comment: comment.trim() })}>
            {st('dialog.holdPoint.sign')}
          </Button>
          <Button onPress={onClose}>{st('dialog.cancel')}</Button>
        </div>
      </div>
    </Dialog>
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

export function DispositionDialog({ isOpen, onClose, exception, onContinue }: { isOpen: boolean; onClose: () => void; exception: Pick<ExceptionView, 'exceptionId' | 'title'>; onContinue: (d: { outcome: 'NO_IMPACT' | 'DEVIATION_RAISED'; justification: string }) => void }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const [justification, setJustification] = useState('');
  const ready = (outcome === 'NO_IMPACT' || outcome === 'DEVIATION_RAISED') && justification.trim().length > 0;
  return (
    <Dialog title={st('dialog.disposition.title', { title: exception.title })} isOpen={isOpen} onOpenChange={(o) => (o ? null : onClose())}>
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
    </Dialog>
  );
}
