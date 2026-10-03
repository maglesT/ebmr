/**
 * What became of a signature the floor asked the ceremony for (module C4): signed (who, what, when), refused (the
 * refusal panel) or not confirmed (a lost answer the signatures read again did not show). Shown on the step card and
 * on the run overview.
 */
import { Banner, floor } from '@ebmr/ui-kit';
import { st } from '../text.ts';
import type { SignedActionResult } from '../useSignedAction.ts';

export function SignedResult({ result }: { result: SignedActionResult }) {
  if (!result) return null;
  switch (result.status) {
    case 'SIGNED': {
      const m = result.manifestation;
      return <Banner tone="ok" title={st('sign.done', { meaning: m.meaningText, name: floor.personLine(m.signer), at: m.signedAt.text })} />;
    }
    case 'REFUSED':
      return <floor.RefusalPanel refusal={result.refusal.refusal} correlationId={result.refusal.correlationId} />;
    case 'NOT_CONFIRMED':
      return <Banner tone="warning" title={st('sign.notConfirmed')} />;
  }
}
