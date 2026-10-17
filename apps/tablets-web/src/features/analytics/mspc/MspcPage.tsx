/**
 * The multivariate monitoring screen (Phase 6A slice 6A-3; /analytics/mspc?product&family; D-6A-11, D-6A-3-*): for a
 * product and MBR family, the T-squared and Q charts of the newest scoring run against the reference set in force, the
 * scores plot, and the batches with their statistics (a batch links to its contributions, which drill to its batch
 * record). Below, the model candidates the runner fitted, the batches each leaves out and why, and the reference set in
 * force that carries its model; QA makes a candidate the reference set under a change record approved for
 * ANALYTICS_REFERENCE (DI-09, DI-52). Advisory only: decisions are taken on the batch records.
 */
import { useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { routes, type MspcCandidatesView, type MspcChartView } from '@ebmr/api-contract';
import { Field, StatusChip } from '@ebmr/ui-kit';
import { useApiQuery } from '../../../api/hooks.ts';
import { ActButton, ActResult, Section, useCommand } from '../../../app/acts.tsx';
import { RefusalMessage } from '../../../app/refusal.tsx';
import { useOffered } from '../../../app/roles.ts';
import { ANALYTICS_READS, AdvisoryBand, Stat } from '../shared.tsx';
import { LimitPlot, ScoresPlot } from './plots.tsx';

type Query = { product: string; family: string };
const MSPC_READS = [...ANALYTICS_READS, routes.analyticsMspc.chart.id, routes.analyticsMspc.candidates.id, routes.analyticsMspc.batch.id];

function searchOf(search: unknown): Query {
  const s = (typeof search === 'object' && search !== null ? search : {}) as Record<string, unknown>;
  const t = (k: string): string => (typeof s[k] === 'string' ? s[k] : '');
  return { product: t('product'), family: t('family') };
}

function Chart({ v }: { v: MspcChartView }) {
  const label = (b: MspcChartView['batches'][number]) => b.batchNumber;
  const t2Above = (b: MspcChartView['batches'][number]) => b.t2 > (b.t2Limit ?? (b.reference ? v.limits.t2Reference ?? v.limits.t2 : v.limits.t2));
  return (
    <>
      <AdvisoryBand v={v} />
      <p data-testid="analytics-mspc-model">
        <StatusChip tone="ok" label={`Reference set ${v.referenceSet} in force`} /> {v.components.toString()} components of {v.variables.length.toString()} variables ({v.variables.join(', ')}),
        explaining {v.explainedVariance.map((e) => `${(100 * e).toFixed(0)} %`).join(' + ')} of the variance; limits at {(100 * v.limits.confidence).toFixed(0)} %.
      </p>
      <LimitPlot
        testId="analytics-mspc-t2"
        title="Hotelling T-squared"
        points={v.batches.map((b) => ({ label: label(b), value: b.t2, above: t2Above(b), reference: b.reference }))}
        limits={[{ value: v.limits.t2, label: 'limit (new)' }, ...(v.limits.t2Reference !== undefined ? [{ value: v.limits.t2Reference, label: 'limit (ref.)' }] : [])]}
      />
      <LimitPlot
        testId="analytics-mspc-q"
        title="Q residual (SPE)"
        points={v.batches.map((b) => ({ label: label(b), value: b.q, above: b.q > v.limits.q, reference: b.reference }))}
        limits={[{ value: v.limits.q, label: 'limit' }]}
      />
      <ScoresPlot testId="analytics-mspc-scores" points={v.batches.map((b) => ({ label: label(b), scores: b.scores, flagged: b.flagged, reference: b.reference }))} />
      <Section title="Flags" testId="analytics-mspc-flags">
        {v.flags.length === 0 ? <p>No batch outside the reference set is beyond a limit.</p> : (
          <ul>
            {v.flags.map((f) => (
              <li key={f.flagId} data-testid={`analytics-mspc-flag-${f.rule}`}>
                <strong>{f.rule}</strong> {f.subjectLabel}{f.disposition ? ` · dispositioned: ${f.disposition.verdict}` : ' · open'}
                <ul>{f.reasons.map((r, k) => <li key={k}>{r.text}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
        <p><Link to="/analytics/flags">Disposition the open flags</Link></p>
      </Section>
      <Section title="Batches" testId="analytics-mspc-batches">
        <table>
          <thead><tr><th>Batch</th><th>Completed</th><th>Reference</th><th>T-squared</th><th>Q</th><th>Flagged</th></tr></thead>
          <tbody>
            {v.batches.map((b) => (
              <tr key={b.batchId} data-testid={`analytics-mspc-batch-${b.batchId}`}>
                <td>{b.drill ? <Link to={b.drill}>{b.batchNumber}</Link> : b.batchNumber}</td>
                <td>{b.completedAt?.text ?? ''}</td>
                <td>{b.reference ? 'reference' : 'new'}</td>
                <td><Stat value={b.t2} /></td>
                <td><Stat value={b.q} /></td>
                <td>{b.flagged ? 'yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function Candidate({ c }: { c: MspcCandidatesView['candidates'][number] }) {
  const qa = useOffered('QA');
  const set = useCommand(routes.analyticsConfig.setReferenceSet, MSPC_READS);
  const [cr, setCr] = useState('');
  const [reason, setReason] = useState('');
  const ok = cr.trim() !== '' && reason.trim() !== '' && (c.batchIds?.length ?? 0) > 0;
  return (
    <li data-testid={`mspc-candidate-${c.outputId}`}>
      <strong>{c.product} · {c.family}</strong>: {c.batches.toString()} reference batches, {c.components.toString()} components
      {c.variables ? ` of ${c.variables.join(', ')}` : ''}, fitted {c.fittedAt.text}, model {c.modelSha256.slice(0, 12)}…{' '}
      {c.limits ? <>(T-squared limit <Stat value={c.limits.t2} />, Q limit <Stat value={c.limits.q} />) </> : null}
      {c.referenceSet ? <span data-testid="mspc-candidate-in-force">reference set {c.referenceSet} in force</span> : <span>not a reference set</span>}
      {c.skipped.length > 0 ? <ul>{c.skipped.map((s) => <li key={`${s.subject}-${s.reason}`}>Left out: {s.reason}</li>)}</ul> : null}
      {qa && !c.referenceSet ? (
        <div>
          <Field name={`mspcCr-${c.outputId}`} label="Change-record number (ANALYTICS_REFERENCE)" value={cr} onChange={setCr} />
          <Field name={`mspcReason-${c.outputId}`} label="Reason" value={reason} onChange={setReason} />
          <ActButton
            label="Make it the reference set"
            disabled={!ok || set.busy}
            onPress={() => (ok ? set.run({
              body: {
                method: 'MSPC.PCA', scope: { product: c.product, family: c.family }, batchIds: c.batchIds ?? [], candidateOutput: c.outputId, status: 'EFFECTIVE',
                changeRecord: cr.trim(), reason: reason.trim(),
              },
            }) : undefined)}
          />
          <ActResult error={set.error} done={set.done} label="The reference set is in force under the change record." />
        </div>
      ) : null}
    </li>
  );
}

export function MspcPage() {
  const initial = searchOf(useSearch({ strict: false }));
  const [form, setForm] = useState<Query>(initial);
  const [asked, setAsked] = useState<Query | null>(initial.product && initial.family ? initial : null);
  const chart = useApiQuery(routes.analyticsMspc.chart, { query: asked ?? { product: '-', family: '-' } }, { enabled: asked !== null });
  const cands = useApiQuery(routes.analyticsMspc.candidates);
  const ok = form.product.trim() !== '' && form.family.trim() !== '';
  return (
    <>
      <h1>Multivariate monitoring</h1>
      {asked === null ? <AdvisoryBand v={{ method: null, dataAgeSeconds: 0 }} /> : null}
      <p>A batch whose combination of critical values departs from the reference batches, even when every value is within its own limits.</p>
      <Section title="Which product" testId="analytics-mspc-filter">
        <Field name="mspcProduct" label="Product code" value={form.product} onChange={(product) => setForm({ ...form, product })} />
        <Field name="mspcFamily" label="MBR family" value={form.family} onChange={(family) => setForm({ ...form, family })} />
        <ActButton label="Show" disabled={!ok} onPress={() => setAsked({ product: form.product.trim(), family: form.family.trim() })} />
      </Section>
      {chart.error ? <RefusalMessage error={chart.error.error} /> : null}
      {chart.data ? <Chart v={chart.data} /> : null}
      <Section title="Model candidates" testId="mspc-candidates">
        {cands.error ? <RefusalMessage error={cands.error.error} /> : null}
        {cands.data && cands.data.candidates.length === 0 ? <p>No candidate yet: a product and family need at least 15 released batches without a critical deviation.</p> : null}
        <ul>{cands.data?.candidates.map((c) => <Candidate key={c.outputId} c={c} />)}</ul>
      </Section>
    </>
  );
}
