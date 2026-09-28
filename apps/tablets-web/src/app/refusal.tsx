/** Shows a refusal in plain language: what happened, why, what you can do, who can help (plan section 4). */
import { describeCallError, type CallError } from '@ebmr/api-contract';
import { Banner, t } from '@ebmr/ui-kit';

export function RefusalMessage({ error }: { error: CallError }) {
  if (error.kind !== 'REFUSAL') return <Banner tone="error" title={describeCallError(error)} />;
  const r = error.envelope.refusal;
  return (
    <Banner tone={r.kind === 'LOCKED' || r.kind === 'AUTH_FAILED' || r.kind === 'NOT_SAVED' ? 'error' : 'warning'} title={r.whatHappened}>
      {r.why ? (
        <p>
          <strong>{t('refusal.why')}:</strong> {r.why}
        </p>
      ) : null}
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
