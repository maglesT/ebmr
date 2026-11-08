/**
 * The markets of an issued batch (Phase 4 slice 4c; outline 3.3.3): the batch's market set as the server reads it, the
 * market-add evaluation for a market (release.batchMarketAdd: MET, UNMET_RECOVERABLE or UNMET_FINAL with the database's
 * reasons and evidence), the signed addition under a change record and the signed removal with a linked deviation
 * (BATCH_MARKET_ACT through esig.describe and the ceremony). A packaging order is planned only for markets in the set.
 * The browser computes no outcome or set.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { routes, type ReleaseMarket } from '@ebmr/api-contract';
import { Field, floor } from '@ebmr/ui-kit';
import { useApiQuery } from '../../api/hooks.ts';
import { ActButton, ActResult, Section, useSignedAct } from '../../app/acts.tsx';
import { RefusalMessage } from '../../app/refusal.tsx';
import { useOffered } from '../../app/roles.ts';
import { useRouteParams } from '../floor/params.ts';
import { MarketAddEvaluation } from './MarketTabs.tsx';
import { RELEASE_READS, words } from './reads.ts';
import { DeviationBatch } from '../quality/BatchDeviation.tsx';

// India is never added or removed (INV-28: every batch is made under an Indian licence; the database refuses it).
const MARKETS: readonly ReleaseMarket[] = ['US', 'EU'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function BatchMarketsPage() {
  const batchId = useRouteParams()['batchId'] ?? '';
  const batch = useApiQuery(routes.review.batch, { params: { batchId } });
  const qa = useOffered('QA');
  const [choice, setChoice] = useState('');
  const market = MARKETS.find((m) => m === choice);
  const b = batch.data;
  return (
    <DeviationBatch batchId={batchId}>
      <h1>Markets of batch {b ? b.batchNumber : batchId}</h1>
      {batch.error ? <RefusalMessage error={batch.error.error} /> : null}
      {b ? (
        <p data-testid="batch-markets">
          {b.product}, {words(b.recordKind)} record ·{' '}
          <Link to="/review/$batchId" params={{ batchId }}>
            review of the record
          </Link>{' '}
          · markets now: {b.markets.join(', ')}
        </p>
      ) : null}
      <floor.ChoiceGroup label="Market" options={MARKETS.map((m) => ({ value: m, label: m }))} value={choice} onChange={setChoice} />
      {market && b ? <BatchMarket key={market} batchId={batchId} batchNumber={b.batchNumber} market={market} inSet={b.markets.includes(market)} offered={qa} /> : null}
    </DeviationBatch>
  );
}

function BatchMarket({ batchId, batchNumber, market, inSet, offered }: { batchId: string; batchNumber: string; market: ReleaseMarket; inSet: boolean; offered: boolean }) {
  const q = useApiQuery(routes.release.batchMarketAdd, { params: { batchId }, query: { market } });
  const [ref, setRef] = useState('');
  const signed = useSignedAct(RELEASE_READS);
  const id = UUID.test(ref.trim()) ? ref.trim() : null;
  return (
    <>
      <Section title={`Market-add evaluation for ${market}`} testId="batch-market-add">
        {q.error ? <RefusalMessage error={q.error.error} /> : null}
        {q.data ? <MarketAddEvaluation evaluation={q.data} testId={`batch-market-add-eval-${market}`} /> : null}
      </Section>
      {offered && !inSet ? (
        <Section title={`Add ${market} to the batch's markets`} testId="batch-market-add-act">
          <Field name="batchChangeRecord" label="Change record (id)" value={ref} onChange={setRef} />
          <ActButton
            label={`Sign the addition of ${market}`}
            onPress={() => id && signed.sign({ kind: 'BATCH_MARKET_ACT', act: 'MARKET_ADD', batchId, input: { market, changeRecordId: id } }, `Add market ${market} to batch ${batchNumber} under change record ${id}`)}
            disabled={q.data === undefined || id === null || signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </Section>
      ) : null}
      {offered && inSet ? (
        <Section title={`Remove ${market} from the batch's markets`} testId="batch-market-remove-act">
          <Field name="batchRemoveDeviation" label="Deviation (id)" value={ref} onChange={setRef} />
          <ActButton
            primary={false}
            label={`Sign the removal of ${market}`}
            onPress={() => id && signed.sign({ kind: 'BATCH_MARKET_ACT', act: 'MARKET_REMOVE', batchId, input: { market, deviationId: id } }, `Remove market ${market} from batch ${batchNumber}, deviation ${id}`)}
            disabled={id === null || signed.busy}
          />
          <ActResult error={signed.error} outcome={signed.outcome} />
        </Section>
      ) : null}
    </>
  );
}
