/**
 * The line station display (PR-35): what runs on a line (or room) now, in large text for a screen at the line: the
 * product and its name, the batch, the stage, the packaging order and the artwork set. Read again every 30 seconds.
 */
import { routes } from '@ebmr/api-contract';
import { Button } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useRouteParams } from '../floor/params.ts';
import { words } from './reads.ts';

const big = { fontSize: '2.25rem', lineHeight: 1.3, margin: '0.25rem 0' } as const;

export function LineStationPage() {
  const code = useRouteParams()['code'] ?? '';
  const q = useApiQuery(routes.equipmentDisplays.lineStation, { params: { code } }, { refetchInterval: 30_000 });
  const v = q.data;
  return (
    <div data-testid="line-station">
      <h1 style={{ fontSize: '3rem' }}>{v ? `${v.code} ${v.name}` : code}</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {v ? (
        <>
          <p style={big}>State: {v.state ? words(v.state) : 'No state'}</p>
          {v.batch ? (
            <dl data-testid="line-station-batch" style={{ fontSize: '2.25rem', lineHeight: 1.3 }}>
              <dt>Product</dt>
              <dd>
                <strong>{v.batch.product}</strong>
                {v.batch.productName ? ` ${v.batch.productName}` : ''}
              </dd>
              <dt>Batch</dt>
              <dd>
                <strong>{v.batch.batchRef}</strong>
              </dd>
              <dt>Stage</dt>
              <dd>{words(v.batch.stage)}</dd>
              <dt>Packaging order</dt>
              <dd>{v.batch.packagingOrder ?? 'None'}</dd>
              <dt>Artwork set</dt>
              <dd>{v.batch.artworkSet ?? 'None'}</dd>
              <dt>Since</dt>
              <dd>{v.batch.since.text}</dd>
            </dl>
          ) : (
            <p style={big} data-testid="line-station-idle">
              No batch on this line.
            </p>
          )}
          <p>
            As read at {v.readAt.text}.{' '}
            <Button onPress={() => void q.refetch()} isDisabled={q.isFetching}>
              Refresh
            </Button>
          </p>
        </>
      ) : null}
    </div>
  );
}
