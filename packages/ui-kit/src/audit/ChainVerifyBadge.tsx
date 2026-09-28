/**
 * ChainVerifyBadge (module C1; DI-23, INV-08): the result of the server recomputing every hash of one audit chain,
 * as colour + icon + word, with the problems named when the chain is broken.
 */
import type { ChainVerificationView } from '@ebmr/api-contract';
import { Button } from '../primitives/Button.tsx';
import { StatusChip } from '../primitives/StatusChip.tsx';
import { icls } from '../identity/classes.ts';

export interface ChainVerifyBadgeProps {
  result: ChainVerificationView | null;
  busy: boolean;
  onVerify: () => void;
}

export function ChainVerifyBadge({ result, busy, onVerify }: ChainVerifyBadgeProps) {
  return (
    <div className={icls('stack')} role="group" aria-label="Chain verification">
      <div className={icls('row')}>
        <Button onPress={onVerify} isDisabled={busy}>
          {busy ? 'Verifying…' : 'Verify chain'}
        </Button>
        {result ? (
          <span aria-live="polite">
            <StatusChip tone={result.ok ? 'ok' : 'error'} label={result.ok ? `Chain intact: ${result.events} entries verified` : `Chain broken: ${result.problems.length} problem(s)`} />
          </span>
        ) : null}
      </div>
      {result ? <p className={icls('muted')}>{`Verified at ${result.verifiedAt.text}`}</p> : null}
      {result && !result.ok ? (
        <ul>
          {result.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
