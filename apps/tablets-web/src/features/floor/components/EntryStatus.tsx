/**
 * The state of one pending entry under its form (module C4): waiting for the tap, saving, saved, refused (the
 * refusal panel), stale (what changed), discarded; and the blocking NOT SAVED notice (decision D1; DI-28).
 */
import { Banner, floor } from '@ebmr/ui-kit';
import type { PendingCall } from '../usePendingCall.ts';

export function EntryStatus({ call }: { call: PendingCall }) {
  const { state, context } = call;
  return (
    <>
      {state === 'awaitingTap' ? <Banner tone="info" title={floor.ft('pending.awaitingTap')} /> : null}
      {state === 'sending' ? (
        <p role="status" aria-live="polite">
          {floor.ft('pending.sending')}
        </p>
      ) : null}
      {state === 'saved' ? <Banner tone="ok" title={`${floor.ft('pending.saved')}: ${context.summary}`} /> : null}
      {state === 'refused' && context.refusal ? <floor.RefusalPanel refusal={context.refusal.refusal} correlationId={context.refusal.correlationId} /> : null}
      {state === 'stale' ? (
        <Banner tone="warning" title={floor.ft('pending.stale')}>
          <ul data-testid="stale-changes">
            {context.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {state === 'discarded' && context.discardReason ? (
        <>
          <Banner tone="warning" title={floor.ft(`pending.discarded.${context.discardReason}`)}>
            {context.summary ? <p>{floor.ft('notSaved.entry', { summary: context.summary })}</p> : null}
          </Banner>
          {context.discardReason === 'SWITCH_USER' && context.refusal ? <floor.RefusalPanel refusal={context.refusal.refusal} correlationId={context.refusal.correlationId} /> : null}
        </>
      ) : null}
      <floor.NotSavedDialog isOpen={state === 'notSaved'} summary={context.summary} tapRequired={call.tapRequired} onResend={call.resend} onDiscard={call.discard} />
    </>
  );
}
