/**
 * NotSavedDialog (module C4; decision D1; DI-28): the blocking notice for an entry whose answer was lost in
 * transit. The entry is not shown as recorded. The person either sends it again (same idempotency key, a fresh
 * badge tap: if the first attempt did commit, the server replays its result, so nothing is recorded twice) or
 * discards it and checks what the record holds. It cannot be dismissed any other way.
 */
import { Button } from '../primitives/Button.tsx';
import { Dialog } from '../primitives/Dialog.tsx';
import { fcls } from './classes.ts';
import { ft } from './messages.ts';

export interface NotSavedDialogProps {
  isOpen: boolean;
  /** Plain words for the unsent entry, e.g. "Blend time: 15 min". */
  summary: string;
  /** Kiosk: the resend needs a fresh badge tap. */
  tapRequired: boolean;
  onResend: () => void;
  onDiscard: () => void;
}

export function NotSavedDialog({ isOpen, summary, tapRequired, onResend, onDiscard }: NotSavedDialogProps) {
  return (
    <Dialog title={tapRequired ? ft('notSaved.title') : ft('notSaved.titleOffice')} isOpen={isOpen} isDismissable={false} role="alertdialog">
      <p>{ft('notSaved.body')}</p>
      <p className={fcls('notSavedEntry')} data-testid="not-saved-entry">
        {ft('notSaved.entry', { summary })}
      </p>
      <div className={fcls('buttonRow')}>
        <Button variant="primary" onPress={onResend} autoFocus>
          {ft('notSaved.resend')}
        </Button>
        <Button variant="danger" onPress={onDiscard}>
          {ft('notSaved.discard')}
        </Button>
      </div>
    </Dialog>
  );
}
