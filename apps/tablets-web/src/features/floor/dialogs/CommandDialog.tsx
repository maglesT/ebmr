/**
 * A dialog that sends one plain intent (module C4): raise an exception, link a deviation, hold the batch,
 * release a hold. The intent goes through the same pendingEntry path as every entry (badge tap on a kiosk,
 * fixed idempotency key, NOT SAVED with resend). The dialog cannot be closed while the entry is on its way or
 * not saved. The form lives inside the open dialog only (see CommandDialog).
 */
import type { ReactNode } from 'react';
import type { ClientIntent, StepScreenView } from '@ebmr/api-contract';
import { Button, Dialog, t } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { st } from '../text.ts';
import { useRunCommand } from '../usePendingCall.ts';

export interface CommandBodyProps {
  onClose: () => void;
  runId: string;
  /** The step whose view comes back (null for run-level intents). */
  viewStepKey: string | null;
  /** What the badge prompt says. */
  reason: string;
  /** The intent to send, or null while the person has not given everything. */
  intent: ClientIntent | null;
  expectedVersion: number;
  view?: StepScreenView;
  children: ReactNode;
}

/**
 * The dialog frame. What is inside (the form with the person's words and choice, and its pending entry) is mounted
 * only while the dialog is open, so every opening starts empty: nothing one person typed or chose is kept for the
 * next opening, by them or by the next person on a shared terminal (INV-40, DI-14).
 */
export function CommandDialog({ title, isOpen, children }: { title: string; isOpen: boolean; children: ReactNode }) {
  return (
    <Dialog title={title} isOpen={isOpen} isDismissable={false}>
      {isOpen ? children : null}
    </Dialog>
  );
}

export function CommandBody({ onClose, runId, viewStepKey, reason, intent, expectedVersion, view, children }: CommandBodyProps) {
  const cmd = useRunCommand(runId, viewStepKey, reason);
  const unsettled = cmd.busy || cmd.state === 'notSaved';
  // Done once saved, for as long as the dialog is open: a newer view of the step (the poll, another person's entry) never
  // brings the form back with the same words and Send enabled (F57; a second Send would be a duplicate exception or hold).
  const done = cmd.state === 'saved';
  return (
    <div className={wcls('dialogBody')}>
      {done ? null : children}
      <EntryStatus call={cmd} keepSavedNote />
      <div className={wcls('row')}>
        {done ? null : (
          <Button variant="primary" onPress={() => intent && cmd.send(intent, expectedVersion, view)} isDisabled={!intent || unsettled}>
            {st('dialog.send')}
          </Button>
        )}
        <Button onPress={onClose} isDisabled={unsettled}>
          {done ? t('common.close') : st('dialog.cancel')}
        </Button>
      </div>
    </div>
  );
}
