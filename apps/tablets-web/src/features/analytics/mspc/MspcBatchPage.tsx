/**
 * A batch's multivariate score (Phase 6A slice 6A-3; /analytics/mspc/batches/:batchId): its T-squared and Q against
 * the limits of its reference set, each variable's recorded value (the source's decimal text, or a subgroup item's
 * readings) and its contributions, largest first, as bars and a table, and its flags. It drills to the batch record,
 * where decisions are taken. Advisory only.
 */
import { Link, useParams } from '@tanstack/react-router';
import { routes, type MspcBatchView } from '@ebmr/api-contract';
import { useApiQuery } from '../../../api/hooks.ts';
import { Section } from '../../../app/acts.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { AdvisoryBand, Stat } from '../shared.tsx';
import { ContributionBars } from './plots.tsx';

function Score({ v }: { v: MspcBatchView }) {
  const t2Limit = v.reference ? (v.limits.t2Reference ?? v.limits.t2) : v.limits.t2;
  return (
    <>
      <AdvisoryBand v={v} />
      <p data-testid="analytics-mspc-batch-stats">
        {v.batchNumber}{v.product ? ` (${v.product} · ${v.family ?? ''})` : ''}{v.reference ? ', a reference batch' : ''}: T-squared <Stat value={v.t2} /> against <Stat value={t2Limit} />, Q{' '}
        <Stat value={v.q} /> against <Stat value={v.limits.q} /> ({(100 * v.limits.confidence).toFixed(0)} %).
      </p>
      <p>{v.drill ? <Link to={v.drill} data-testid="analytics-mspc-batch-record">Open the batch record</Link> : 'The batch record is not available here.'}</p>
      <ContributionBars testId="analytics-mspc-contributions" rows={v.contributions} />
      <Section title="Contributions" testId="analytics-mspc-contribution-table">
        <table>
          <thead><tr><th>Variable</th><th>Recorded value</th><th>T-squared contribution</th><th>Q contribution</th></tr></thead>
          <tbody>
            {v.contributions.map((c) => (
              <tr key={c.variable}>
                <td>{c.variable}</td>
                <td>{c.value ?? (c.readings ? `mean of ${c.readings.join(', ')}` : '')}</td>
                <td><Stat value={c.t2} /></td>
                <td><Stat value={c.q} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Flags" testId="analytics-mspc-batch-flags">
        {v.flags.length === 0 ? <p>No flag.</p> : <ul>{v.flags.map((f) => <li key={f.flagId}><strong>{f.rule}</strong>: {f.reasons.map((r) => r.text).join('; ')}</li>)}</ul>}
      </Section>
    </>
  );
}

export function MspcBatchPage() {
  const params: Record<string, unknown> = useParams({ strict: false });
  const batchId = typeof params['batchId'] === 'string' ? params['batchId'] : '';
  const q = useApiQuery(routes.analyticsMspc.batch, { params: { batchId } }, { enabled: batchId !== '' });
  return (
    <>
      <h1>Multivariate score of a batch</h1>
      {q.error ? <RefusalMessage error={q.error.error} /> : null}
      {q.data ? <Score v={q.data} /> : null}
      <p><Link to="/analytics/mspc">Multivariate monitoring</Link></p>
    </>
  );
}
