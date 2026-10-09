/**
 * The blocking NOT SAVED notice of the floor (module C4; decision D1; DI-28): the kit's NotSavedDialog title and
 * buttons, with the floor's own body line: after a lost answer it is not known whether the entry is in the record
 * (the first send may have committed), so the notice never says it is not. After a resend whose refusal says
 * nothing about the entry's key (a PIN not accepted, a locked session, another person's badge...), it also shows
 * that refusal and that the first send's outcome is still unknown. The notice stays until an answer speaks for
 * the entry or the person discards it; it cannot be dismissed any other way. (The kit's dialog takes no extra
 * content, and its body line says the entry is not in the record until it is sent again; see the C4 notes.)
 */
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Button, Dialog, floor } from '@ebmr/ui-kit';
import { wcls } from '../classes.ts';
import { st } from '../text.ts';

export interface NotSavedNoticeProps {
  isOpen: boolean;
  summary: string;
  tapRequired: boolean;
  /** The refusal of the last resend, when it said nothing about the first send. */
  refusal: RefusalEnvelope | null;
  onResend: () => void;
  onDiscard: () => void;
}

export function NotSavedNotice({ isOpen, summary, tapRequired, refusal, onResend, onDiscard }: NotSavedNoticeProps) {
  return (
    <Dialog title={tapRequired ? floor.ft('notSaved.title') : floor.ft('notSaved.titleOffice')} isOpen={isOpen} isDismissable={false} role="alertdialog">
      <p data-testid="not-saved-body">{st('notSaved.body')}</p>
      <p data-testid="not-saved-entry">{floor.ft('notSaved.entry', { summary })}</p>
      {refusal ? (
        <div data-testid="not-saved-resend-refused">
          <p>
            <strong>{st('notSaved.resendRefused')}</strong>
          </p>
          <floor.RefusalPanel refusal={refusal.refusal} correlationId={refusal.correlationId} />
        </div>
      ) : null}
      <div className={wcls('row')}>
        <Button variant="primary" onPress={onResend} autoFocus>
          {floor.ft('notSaved.resend')}
        </Button>
        <Button variant="danger" onPress={onDiscard}>
          {floor.ft('notSaved.discard')}
        </Button>
      </div>
    </Dialog>
  );
}
