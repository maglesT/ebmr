/**
 * The state of one pending entry under its form (module C4): waiting for the tap, saving, saved, refused (the
 * refusal panel), stale (whether the refusal is recorded, and what changed), discarded; and the blocking NOT SAVED
 * notice (decision D1; DI-28).
 * A discarded entry that had been sent is never said to be unsent: it may be in the record, and the notice says
 * what a late answer showed.
 */
import { Banner, floor } from '@ebmr/ui-kit';
import { st } from '../text.ts';
import type { PendingCall } from '../usePendingCall.ts';
import { NotSavedNotice } from './NotSavedNotice.tsx';

function DiscardedNotice({ call }: { call: PendingCall }) {
  const { context, discardedSent } = call;
  const reason = context.discardReason;
  if (!reason) return null;
  const entry = context.summary ? <p>{floor.ft('notSaved.entry', { summary: context.summary })}</p> : null;
  if (discardedSent) {
    const title = discardedSent === 'RECORDED' ? st('discarded.recorded') : discardedSent === 'NOT_RECORDED' ? st('discarded.notRecorded') : reason === 'SESSION_CHANGED' ? st('discarded.unknown.SESSION_CHANGED') : st('discarded.unknown.DISCARDED');
    return (
      <Banner tone={discardedSent === 'UNKNOWN' ? 'warning' : 'info'} title={title}>
        {entry}
      </Banner>
    );
  }
  return (
    <>
      <Banner tone="warning" title={floor.ft(`pending.discarded.${reason}`)}>
        {entry}
      </Banner>
      {reason === 'SWITCH_USER' && context.refusal ? <floor.RefusalPanel refusal={context.refusal.refusal} correlationId={context.refusal.correlationId} /> : null}
    </>
  );
}

/**
 * A stale answer (409), with what changed. The run command's own refusal ENG-STALE is recorded in the test run as a
 * refused row that uses none of the scale readings the entry names (Phase 2 exit review F58, F58.1; DI-34, DI-32). Any
 * other stale answer (a badge tap too old or already used, the run moved on while the entry was being written, a package
 * imported already) came before anything was written: the notice says so, with the server's own words.
 */
function StaleNotice({ context }: { context: floor.PendingEntryContext }) {
  const refusal = context.refusal?.refusal;
  const recorded = refusal?.code === 'ENG-STALE';
  return (
    <Banner tone="warning" title={floor.ft(recorded ? 'pending.stale' : 'pending.staleNotRecorded')}>
      {!recorded && refusal ? <p>{refusal.whatHappened}</p> : null}
      <ul data-testid="stale-changes">
        {context.changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </Banner>
  );
}

/**
 * `keepSavedNote`: the "Saved" note stays while the component is shown, even once the step has moved past the save (a
 * dialog whose note is the result of its one send). Otherwise the note goes then (PendingCall.savedNoteExpired).
 */
export function EntryStatus({ call, keepSavedNote = false }: { call: PendingCall; keepSavedNote?: boolean }) {
  const { state, context } = call;
  return (
    <>
      {state === 'awaitingTap' ? <Banner tone="info" title={floor.ft('pending.awaitingTap')} /> : null}
      {state === 'sending' ? (
        <p role="status" aria-live="polite">
          {floor.ft('pending.sending')}
        </p>
      ) : null}
      {state === 'saved' && (keepSavedNote || !call.savedNoteExpired) ? <Banner tone="ok" title={`${floor.ft('pending.saved')}: ${context.summary}`} /> : null}
      {state === 'refused' && context.refusal ? <floor.RefusalPanel refusal={context.refusal.refusal} correlationId={context.refusal.correlationId} /> : null}
      {state === 'stale' ? <StaleNotice context={context} /> : null}
      {state === 'discarded' ? <DiscardedNotice call={call} /> : null}
      <NotSavedNotice isOpen={state === 'notSaved'} summary={context.summary} tapRequired={call.tapRequired} refusal={call.resendRefusal} onResend={call.resend} onDiscard={call.discard} />
    </>
  );
}
