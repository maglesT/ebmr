/**
 * The links from a GMP batch's run and step screens to the batch's other screens (R10 #13): its output containers and,
 * for a packaging order, its line completion (coding, labels, inspection) and its bulk and finished lot. The sandbox's
 * test runs have none of these screens.
 */
import { Link } from '@tanstack/react-router';
import type { RunHeaderView } from '@ebmr/api-contract';
import { wcls } from '../classes.ts';
import { isGmpFloor } from '../family.ts';
import { st } from '../text.ts';

export function BatchLinks({ run }: { run: Pick<RunHeaderView, 'runId' | 'recordKind'> }) {
  if (!isGmpFloor()) return null;
  const batchId = run.runId;
  return (
    <>
      <Link to="/review/$batchId/containers" params={{ batchId }} className={wcls('link')} data-testid="containers-link">
        {st('links.containers')}
      </Link>
      {run.recordKind === 'PACKAGING' ? (
        <>
          <Link to="/labels/packaging/$batchId" params={{ batchId }} className={wcls('link')} data-testid="line-completion-link">
            {st('links.lineCompletion')}
          </Link>
          <Link to="/planning/packaging/$batchId" params={{ batchId }} className={wcls('link')} data-testid="bulk-link">
            {st('links.bulk')}
          </Link>
        </>
      ) : null}
    </>
  );
}
