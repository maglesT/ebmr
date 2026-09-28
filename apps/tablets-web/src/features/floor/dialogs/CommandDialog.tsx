/**
 * A dialog that sends one plain intent (module C4): raise an exception, link a deviation, hold the batch,
 * release a hold. The intent goes through the same pendingEntry path as every entry (badge tap on a kiosk,
 * fixed idempotency key, NOT SAVED with resend). The dialog cannot be closed while the entry is on its way or
 * not saved.
 */
import type { ReactNode } from 'react';
import type { ClientIntent, StepScreenView } from '@ebmr/api-contract';
import { Button, Dialog, t } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { EntryStatus } from '../components/EntryStatus.tsx';
import { st } from '../text.ts';
import { useRunCommand } from '../usePendingCall.ts';

export interface CommandDialogProps {
  title: string;
  isOpen: boolean;
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

export function CommandDialog({ title, isOpen, onClose, runId, viewStepKey, reason, intent, expectedVersion, view, children }: CommandDialogProps) {
  return (
    <Dialog title={title} isOpen={isOpen} isDismissable={false}>
      {isOpen ? (
        <CommandBody onClose={onClose} runId={runId} viewStepKey={viewStepKey} reason={reason} intent={intent} expectedVersion={expectedVersion} {...(view ? { view } : {})}>
          {children}
        </CommandBody>
      ) : null}
    </Dialog>
  );
}

function CommandBody({ onClose, runId, viewStepKey, reason, intent, expectedVersion, view, children }: Omit<CommandDialogProps, 'title' | 'isOpen'>) {
  const cmd = useRunCommand(runId, viewStepKey, reason);
  const unsettled = cmd.busy || cmd.state === 'notSaved';
  const done = cmd.state === 'saved';
  return (
    <div className={wcls('dialogBody')}>
      {done ? null : children}
      <EntryStatus call={cmd} />
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
