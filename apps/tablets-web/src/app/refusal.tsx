/** Shows a refusal in plain language: what happened, why, what you can do, who can help (plan section 4). */
import { describeCallError, type CallError } from '@ebmr/api-contract';
import { Banner, floor, t } from '@ebmr/ui-kit';

/**
 * Declutter D1: the server refused the route because its function is not part of Batchwright (410 DISCONNECTED, on the
 * platform build or a server started with EBMR_DISCONNECT=1). A panel of a disconnected function embedded in a kept
 * screen renders nothing then, instead of an error.
 */
export function isDisconnected(error: CallError | undefined | null): boolean {
  return error?.kind === 'REFUSAL' && error.status === 410 && error.envelope.refusal.code === 'DISCONNECTED';
}

export function RefusalMessage({ error }: { error: CallError }) {
  if (error.kind !== 'REFUSAL') return <Banner tone="error" title={describeCallError(error)} />;
  const r = error.envelope.refusal;
  // Phase 6 slice 6a: a refusal over stale mirrored data says which mirror, how old and whom to call.
  const mirror = floor.staleMirrorOf(r.code, r.why);
  return (
    <Banner tone={r.kind === 'LOCKED' || r.kind === 'AUTH_FAILED' || r.kind === 'NOT_SAVED' ? 'error' : 'warning'} title={r.whatHappened}>
      {r.why ? (
        <p>
          <strong>{t('refusal.why')}:</strong> {r.why}
        </p>
      ) : null}
      {mirror ? <floor.StaleMirrorNotice mirror={mirror} /> : null}
      {r.whatYouCanDo.length ? (
        <p>
          <strong>{t('refusal.whatYouCanDo')}:</strong> {r.whatYouCanDo.join(' ')}
        </p>
      ) : null}
      {r.whoCanHelp.length ? (
        <p>
          <strong>{t('refusal.whoCanHelp')}:</strong> {r.whoCanHelp.join(', ')}
        </p>
      ) : null}
    </Banner>
  );
}
