/**
 * RefusalNotice (module C1): a refusal as a banner, in plain language: what happened, why, what you can do, who can
 * help. Used by the signature dialog, the lock screen and the badge prompt.
 */
import type { RefusalEnvelope } from '@ebmr/api-contract';
import { Banner } from '../primitives/Banner.tsx';

export function RefusalNotice({ envelope, tone = 'error' }: { envelope: RefusalEnvelope; tone?: 'error' | 'warning' }) {
  const r = envelope.refusal;
  return (
    <Banner tone={tone} title={r.whatHappened}>
      {r.why ? <p>{`Why: ${r.why}`}</p> : null}
      {r.whatYouCanDo.length ? <p>{`What you can do: ${r.whatYouCanDo.join(' ')}`}</p> : null}
      {r.whoCanHelp.length ? <p>{`Who can help: ${r.whoCanHelp.join(', ')}`}</p> : null}
    </Banner>
  );
}
